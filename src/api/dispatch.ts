/**
 * `/dsh-session-delete-api` 前缀路由的**内部分发**（薄线的 Node 半）——**只管传输**。
 *
 * 为什么是这一条路（裁决，不是偏好）：浏览器侧 `remote.<namespace>` 只能由**生成的 Typert 远程
 * 描述符贡献**经 `ctx.remote.$mount(...)` 挂上，而盒内那份装配清单是**写死的 25 条官方包**、
 * 全宿主没有任何"按包发现再挂载"的动态机制 ⇒ 第三方要那个命名空间，
 * 只能自挂自（要生成物 + `zod` + 改包布局），代价与收益完全不成比例。改用宿主**自己的 web server**
 * 开一条插件专属前缀路由：真相/账本/判据全在宿主那边，这一层只搬运。
 *
 * 本文件只剩三件事：**栅栏 → 查表 → 信封**。
 *  - "这个段名该用什么方法、纯不纯、要不要预读 body、怎么处理"全在 `api/route-table.ts` 那一张表里
 *    （ADR-0004）；这里一个字都不再重复（此前方法判断与纯度判断分居两个函数、靠注释保持一致）。
 *  - 一行里放什么（清册行 → 线上行）归 `api/trash-rows.ts`。
 *  - 前面四条口径（不依赖 Cordis / 信封与浏览器半同形 / 状态语义 / 同源栅栏）与到达序链（口径 ⑤）
 *    仍住这里，因为它们是**传输**的事。
 *
 * 信封（口径 ②）：`{ok:true,value}` / `{ok:false,error:{code,message,details?}}`。
 * `error.code` 走 `src/remote/map-error.ts` 的**同一张表**（src/shared/wire.ts 的五个码），原文进
 * `error.message`，结构化附带物进可选的 `error.details`。
 *
 * HTTP 状态不是第二套语义（口径 ③）：**操作失败**时状态一律 200（含 `ok:false`）——我们与浏览器半之间的
 * 契约是信封本身，判断成败只看 `ok`。**请求本身不对**才用 4xx（400 请求体 / 405 方法 / 404 未知路由），
 * 同源栅栏拒的是**请求**而不是操作，回 403；浏览器半先解信封再看状态。
 *
 * 同源栅栏（口径 ④）：本机回环上一条能删会话的写口不能被任意网页用 simple request CSRF 打——没有栅栏时
 * `content-type: text/plain` 的跨源 POST 不触发预检、直接生效。放行的形状见 {@link isTrustedRequest}。
 *
 * 到达序链（口径 ⑤）：`list`（含对账）与写动作都是"读清单 + 动文件 + 写清单"的多步，交错跑会互相踩
 * ——删除刚把目录搬进回收站、行还没写上时，对账抢先把这行按目录"重建"出来，再被真实行覆盖成降级
 * 元数据。串行的代价只是排队（单进程单用户，毫秒级）；纯读不占这条链（哪几个段名纯、哪个动作纯，
 * 由路由表说，不在这里列）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { toRemoteFailure } from '../remote/map-error.js'
import { SESSION_DELETE_API_PREFIX } from '../shared/wire.js'
import { routeError } from '../verbs/errors.js'
import type { DeleteDeps } from '../deps.js'
import { routeOf, type BodyKind, type Purity } from './route-table.js'

/** 请求体字节上限：这条通道只收几个 id，1MiB 是"够用且不给自己开一条内存放大器"的量级。 */
const JSON_BODY_MAX_BYTES = 1024 * 1024

/** 回环地址的三种写法（IPv4 / IPv6 / IPv4-mapped IPv6）。 */
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1']

/**
 * 桌面壳那条路（asar `/lib/main.js` 的 `forwardWebRequest`）：渲染进程从 `dsh-app://app/` 加载，
 * 页面里对**非静态路径**的请求（`/`、`/index.html`、`/assets/*`、`/plugins/…` 之外的一切——包括
 * 我们这条前缀路由）都由 `protocol.handle("dsh-app")` 转给宿主自己的 web server；转发前它把
 * `host` / `origin` / `cookie` / `sec-fetch-site` 四个头**删掉**、换上一枚宿主自己的 cookie，路径与
 * 查询串原样带走（逐字：`for (const name of ["host","origin","cookie","sec-fetch-site"]) headers.delete(name)`）。
 * ⇒ 桌面版打到我们这条路由上的请求是**没有 `Origin`** 的，`Referer` 则保留（同源请求照常带，
 * 页面就住在 `dsh-app://app/`）。壳自己在上游只放行 `origin ∈ {null, "dsh-app://app"}`。
 */
const DESKTOP_APP_SCHEME = 'dsh-app:'
const DESKTOP_APP_HOST = 'app'

/**
 * 「这是桌面壳自己的页面吗」。**必须按 `protocol` + `host` 判，不能比 `URL.origin`**：`dsh-app:`
 * 不是 WHATWG 的 special scheme，`new URL('dsh-app://app/').origin` 是字符串 `"null"`（Node 实测），
 * 拿它跟字面量比永远为假 ⇒ 栅栏会把真机上的每一次请求都挡成 403，所有入口一个都不出现。
 *
 * 这个判据为什么不可能被外人伪造：`Origin` 与 `Referer` 都是 forbidden header，网页改不了，
 * 只能是浏览器/壳自己带上；而 `dsh-app://app` 只可能是桌面壳自己的页面。
 */
function isDesktopShellUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === DESKTOP_APP_SCHEME && url.host === DESKTOP_APP_HOST
  } catch {
    return false
  }
}

type JsonBody = Record<string, unknown> | null

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

/** 失败信封：码与原文都来自 `toRemoteFailure`（本插件唯一的错误映射表）。
 *  **状态语义（2026-10-17 错误面对齐）**：**请求本身不对**不再伪装成 200——请求体不对 400、方法不对 405、
 *  未知路由 404、栅栏拒 403（它们不是"一次办成的操作"，是"这条请求不归我办/你没资格办"）。
 *  **操作失败**仍回 200 + 信封。浏览器半先解信封再看状态，所以 4xx 上带的信封照样读得出原文；
 *  `code` 一律折成 `sessiondelete/io`，那三个路由标签（`bad-request` / `bad-method` / `not-found-route`）
 *  是**抛出处给读代码的人看的站点名**，不许冒充 `src/shared/wire.ts` 的五个动词码上客户端。 */
function writeFailure(res: ServerResponse, error: unknown, status?: number): void {
  const carried = (error as { httpStatus?: unknown })?.httpStatus
  writeJson(res, status ?? (typeof carried === 'number' ? carried : 200), { ok: false, error: toRemoteFailure(error) })
}

/**
 * 同源栅栏（见文件头 ④）。看 `origin` 而不只看 `referer` 的理由：恶意页
 * `<meta name="referrer" content="no-referrer">` 能让 Referer 缺席，但浏览器对跨源请求**总是**发 Origin。
 *
 * 放行的三种形状，各自都是"浏览器/壳自动带上、网页改不了"的那种：
 * ① `Origin` 与 `Host` 同源（浏览器直接打开宿主那行 URL）；② `Origin` 是桌面壳的 `dsh-app://app`
 * （壳自己在上游也只放行这个 origin）；③ `Referer` 是桌面壳的 `dsh-app://app`（**真机那条路**：
 * 壳把 `Origin` 删掉了、只留下 Referer，见 {@link isDesktopShellUrl}）。两者都缺席 = 本机工具 /
 * curl（注释即此承诺）。**恶意网页拿不到 ②③ 里的任何一个**：那两个头都是 forbidden header、
 * 页面伪造不了；而**写口（POST）在任何跨源形态下都必带 Origin** ⇒ 两个头全缺席就等于本机工具。
 * 唯一的缝是跨源 `no-cors` 的 **GET**（Referer 被 `no-referrer` 掐掉、Origin 也不带）——它够得到
 * 那几个 GET（`list` 会先对账写清册，`ping` / `orphans` 才是纯读），而 no-cors 的回包是 opaque、
 * 页面读不出内容 ⇒ 不构成泄露（`orphans` 那份报告也只报数量/字节，不含正文）。
 */
function isTrustedRequest(req: IncomingMessage): boolean {
  if (!LOOPBACK.includes(req.socket.remoteAddress ?? '')) return false
  const host = req.headers.host
  const origin = req.headers.origin
  if (origin !== undefined && !isDesktopShellUrl(origin)) {
    try { if (new URL(origin).host !== host) return false } catch { return false }
  }
  const referer = req.headers.referer
  if (referer === undefined) return true
  if (isDesktopShellUrl(referer)) return true
  try { return new URL(referer).host === host } catch { return false }
}

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

export function createApiHandler(deps: DeleteDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  /**
   * 到达序串行链（文件头 ⑤）：路由表里 `purity === 'chained'` 的请求一个跑完再放下一个。
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
    if (!isTrustedRequest(req)) {
      writeFailure(res, new Error('非受信来源'), 403)
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
      const task = (): Promise<unknown> => spec.run(deps, body)
      writeOk(res, await (isPure(spec.purity, body) ? task() : throughChain(task)))
    } catch (error) {
      writeFailure(res, error)
    }
  }
}
