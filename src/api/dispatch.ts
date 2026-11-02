/**
 * /dsh-session-delete-api 的前缀路由分发：只负责传输。
 *
 * 四件事：请求栅栏 → 查路由表 → 按段注入窄面 → 回信封。纯度、body 预读与读面的判据都在
 * src/api/route-table.ts（方法也从那张表读，字面量家在 `shared/wire.ts` 的段名表；这里只按判据执行）；
 * 行投影在 src/api/trash-rows.ts。
 *
 * - 请求本身不对用 4xx（400 请求体 / 405 方法 / 404 未知路由 / 403 栅栏拒绝）；
 *   操作失败回 200 + {ok:false,error}。浏览器半先解信封，再看状态。
 * - 请求栅栏（归属 / 身份）归 `src/api/request-trust.ts`，这里只按它的裁决写 403。
 * - purity 为 chained 的请求串行执行，避免读清册/动文件/写清册交错。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { toRemoteFailure } from '../remote/map-error.js'
import { SESSION_DELETE_API_PREFIX } from '../shared/wire.js'
import { routeError } from '../verbs/errors.js'
import type { CoreDeps, DeleteDeps, RemovalDeps } from '../deps.js'
import { judgeRequest, type RequestTrustFacts } from './request-trust.js'
import {
  routeOf,
  type BinaryResponse,
  type BodyKind,
  type JsonBody,
  type Purity,
  type RouteRead,
  type RouteSlice,
  type SliceDeps,
} from './route-table.js'

/** 请求体字节上限：这条通道只收几个 id，1MiB 是"够用且不给自己开一条内存放大器"的量级。 */
const JSON_BODY_MAX_BYTES = 1024 * 1024

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

/**
 * 二进制响应（`/attachment` 专用）。四道头都是判据不是口味：
 * - `content-type` 由处理函数给（图片按魔数认，文件一律 octet-stream）；
 * - `content-length` 与字节数同源；
 * - `cache-control: private, no-store`：附件可能来自已删除会话，不许被任何中间层留下；
 * - `nosniff` + `attachment` 下载名：字节内容与类型不一致时浏览器不许改猜。
 *
 * **失败不走这里**：处理函数抛出的错误仍由 `writeFailure` 写 JSON 信封（图片的 `onError` 会换成
 * 占位；普通文件走 `<a download>`，没有页面内失败面）。
 */
function writeBinary(res: ServerResponse, body: BinaryResponse): void {
  const headers: Record<string, string> = {
    'content-type': body.contentType,
    'content-length': String(body.body.length),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  }
  if (body.filename !== undefined) {
    headers['content-disposition'] = `${body.disposition}; filename*=UTF-8''${encodeURIComponent(body.filename)}`
  } else if (body.disposition === 'attachment') {
    headers['content-disposition'] = 'attachment'
  }
  res.writeHead(200, headers)
  res.end(body.body)
}

/** 失败信封：码与原文都来自 `toRemoteFailure`（本插件唯一的错误映射表）。
 *  **状态语义**：**请求本身不对**不再伪装成 200——请求体不对 400、方法不对 405、
 *  未知路由 404、栅栏拒 403（它们不是"一次办成的操作"，是"这条请求不归我办/你没资格办"）。
 *  **操作失败**仍回 200 + 信封。浏览器半先解信封再看状态，所以 4xx 上带的信封照样读得出原文；
 *  `code` 一律折成 `sessiondelete/io`，那三个路由标签（`bad-request` / `bad-method` / `not-found-route`）
 *  是**抛出处给读代码的人看的站点名**，不许冒充 `src/shared/wire.ts` 的五个动词码上客户端。 */
function writeFailure(res: ServerResponse, error: unknown, status?: number): void {
  // 类型面说真话：`error` 是 `unknown`，强转出来的镜像只声明了可选字段，但运行时**可能**是
  // null / undefined（非 Error 抛出物），所以这里把镜像连同空值一起声明，`?.` 才是必要的。
  const carried = (error as { httpStatus?: unknown } | null | undefined)?.httpStatus
  writeJson(res, status ?? (typeof carried === 'number' ? carried : 200), { ok: false, error: toRemoteFailure(error) })
}

/** 栅栏拒绝的两种原文：归属不对（跨源 / 重绑 / 头不成形）与远程客户端没带宿主身份。
 *  两者都是 403，但客户端会上屏，原文要能告诉用户下一步做什么。 */
const UNTRUSTED_MESSAGE = '非受信来源'
const UNAUTHENTICATED_MESSAGE = '需要宿主的 Web 身份：请用 dsh web 打印的那一行 URL 打开页面后重试'

/** 流式读 body 并解析成 JSON 对象：空体回 `null`，超限 / 非法 JSON / 不是对象一律抛（→ 400 + 失败信封）。
 *  **请求本身不对**（400）与**那次操作读不到东西**（200 + 信封）是两件事：前者是调用方没组好请求，
 *  后者是盘上没有；把前者也写成 200，代理与日志里就再也分不出这两类。 */
async function readJsonBody(req: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buf.length
    if (size > JSON_BODY_MAX_BYTES) throw routeError('bad-request', 400, `请求体超过 ${JSON_BODY_MAX_BYTES} 字节上限`)
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw routeError('bad-request', 400, '请求体需为 JSON 对象')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw routeError('bad-request', 400, `请求体不是合法 JSON：${error.message}`)
    }
    throw error
  }
}

function requireMethod(method: string, want: string, route: string): void {
  if (method !== want) throw routeError('bad-method', 405, `方法不允许：${method}（${SESSION_DELETE_API_PREFIX}${route} 需 ${want}）`)
}

function isPure(purity: Purity, body: JsonBody): boolean {
  return typeof purity === 'function' ? purity(body) === 'pure' : purity === 'pure'
}

function readBodyFor(kind: BodyKind, req: IncomingMessage): Promise<JsonBody> | JsonBody {
  return kind === 'json' ? readJsonBody(req) : null
}

/**
 * 全量面按行收窄（ADR-0032）：组合根装出的 {@link DeleteDeps} 只交给 `/apply`；每一段只拿到
 * 自己声明的那一格（路由表的 `slice`）。收窄是**运行期事实**，不是类型投影：`core` 拿到的是
 * 新建的 `CoreFsPort` 面，`removeDir` / `removeFile` 根本不在对象上；`now` 也不在 `core` / `removal`
 * 上。三格逐行 `satisfies` 是闸：全量面必须结构满足每一格；`coreOf` 的 fs 字面量又逼着
 * `CoreFsPort` 新增方法时同步补进来——漏了编译不过，而不是等某个段的 `run` 静默拿到超面。
 */
function coreOf(full: DeleteDeps): CoreDeps {
  return {
    fs: {
      exists: (p) => full.fs.exists(p),
      ensureDir: (p) => full.fs.ensureDir(p),
      rename: (from, to) => full.fs.rename(from, to),
      sizeOfDir: (p) => full.fs.sizeOfDir(p),
      listFiles: (p) => full.fs.listFiles(p),
      listDirs: (p) => full.fs.listDirs(p),
      realpath: (p) => full.fs.realpath(p),
      readFile: (p) => full.fs.readFile(p),
      statFile: (p) => full.fs.statFile(p),
    },
    host: full.host,
    ledger: full.ledger,
    home: full.home,
    presence: full.presence,
  }
}

/** `removal` 保留删除能力，但不带会话删除的时钟；`full` 只给 `/apply`。 */
function removalOf(full: DeleteDeps): RemovalDeps {
  return {
    fs: full.fs,
    host: full.host,
    ledger: full.ledger,
    home: full.home,
    presence: full.presence,
  }
}

/** 三格只建一次：收窄对象在 handler 构造期固定，请求路径只做引用选择。 */
export function slicesOf(full: DeleteDeps): SliceDeps {
  return { core: coreOf(full), removal: removalOf(full), full }
}

/** 按行选格：`spec.slice` 与三格的键同域，查表结果的类型由 `S` 直接给出。 */
function depsFor<S extends RouteSlice>(spec: { readonly slice: S }, slices: SliceDeps): SliceDeps[S] {
  return slices[spec.slice]
}

export function createApiHandler(
  deps: DeleteDeps,
  trust: RequestTrustFacts,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const slices = slicesOf(deps)
  /**
   * 到达序串行链（见文件头）：路由表里 `purity === 'chained'` 的请求一个跑完再放下一个。
   * `tail` 由构造保证**永不 reject**（每个任务自己的失败留在交回给那次请求的那个 promise 上），
   * 所以一次失败不会卡死链。
   */
  let tail: Promise<void> = Promise.resolve()
  const throughChain = <T>(task: () => Promise<T>): Promise<T> => {
    const started = tail.then(task)
    tail = started.then(() => undefined, () => undefined)
    return started
  }
  return async function handle(req, res): Promise<void> {
    const verdict = judgeRequest(req, trust)
    if (verdict !== 'allowed') {
      writeFailure(res, new Error(verdict === 'untrusted' ? UNTRUSTED_MESSAGE : UNAUTHENTICATED_MESSAGE), 403)
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      if (!url.pathname.startsWith(SESSION_DELETE_API_PREFIX)) {
        throw routeError('not-found-route', 404, `未知路由：${url.pathname}`)
      }
      const rest = url.pathname.slice(SESSION_DELETE_API_PREFIX.length)
      const spec = routeOf(rest)
      if (spec === undefined) {
        throw routeError('not-found-route', 404, `未知路由：${req.method ?? 'GET'} ${rest === '' ? SESSION_DELETE_API_PREFIX : rest}`)
      }
      requireMethod(req.method ?? 'GET', spec.method, rest)
      // body 在这里读一次（`apply` 的纯读判断与处理共用这一份；流不能被消费两遍）
      const body = await readBodyFor(spec.body, req)
      const kind = spec.read
      let rowsPromise: ReturnType<RouteRead['rows']> | undefined
      const read: RouteRead = {
        rows() {
          if (kind === 'none') return Promise.reject(new Error('route read: none'))
          rowsPromise ??= kind === 'list' ? deps.ledger.list() : deps.ledger.raw()
          return rowsPromise
        },
      }
      const task = (): Promise<unknown> => spec.run(depsFor(spec, slices), body, read, url.searchParams)
      const result = await (isPure(spec.purity, body) ? task() : throughChain(task))
      // 只有处理函数成功返回才走二进制；抛错一律落上面那个 catch 的 JSON 信封。
      if (spec.response === 'binary') writeBinary(res, result as BinaryResponse)
      else writeOk(res, result)
    } catch (error) {
      writeFailure(res, error)
    }
  }
}
