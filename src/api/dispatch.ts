/**
 * /dsh-session-delete-api 的分发核心：只负责路由记录的执行。
 *
 * 传输适配器只有 `src/api/connection-route.ts` 一个：全部段名注册到宿主 `connection.fetch.register`
 * 的 exact Fetch 路由（`Request` / `Response`），Host/Origin/浏览器认证由宿主 `/api` bridge 完成
 * （ADR-0033）。`Request` 的字节闸 / JSON 解析、`Response` 的头与失败信封都归适配器；
 * 这里只收已经解析好的请求，做查表 → 按段注入窄面 → 跑处理 → 回结果。
 *
 * 纯度、body 声明、读面与方法仍住 `src/api/route-table.ts` 与 `src/shared/wire.ts`；这里只按判据执行。
 *
 * - 请求本身不对用 4xx（400 请求体 / 405 方法 / 404 未知路由）；操作失败回 200 + {ok:false,error}。
 *   浏览器半先解信封，再看状态。宿主 exact route 已在 handler 之前把未声明方法 / 路径回 404，
 *   所以 405 / 未知路由 404 只在适配器直调时可达（`tests/connection-route.test.ts` 钉防御分支）。
 * - `purity` 为 chained 的请求串行执行，避免读清册/动文件/写清册交错；整个进程共用一条到达序链。
 */
import { SESSION_DELETE_API_PREFIX } from '../shared/wire.js'
import { FS_CORE_METHODS, FS_REMOVAL_METHODS, fsSlice } from '../ports/fs-port.js'
import { routeError } from '../errors.js'
import type { CoreDeps, DeleteDeps } from '../deps.js'
import {
  routeOf,
  type BinaryResponse,
  type JsonBody,
  type Purity,
  type RouteRead,
  type RouteSlice,
  type RouteSpec,
  type SliceDeps,
} from './route-table.js'

/** 适配器归一后的一次请求：`rest` 是插件前缀之后的段名（如 `/list`）。 */
export interface ApiInput {
  readonly method: string
  readonly rest: string
  readonly search: URLSearchParams
  readonly body: JsonBody
}

/** 适配器归一后的一次响应：JSON 信封或二进制字节，状态码与头由适配器写。 */
export type ApiResult =
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'binary'; readonly body: BinaryResponse }

function requireMethod(method: string, want: string, route: string): void {
  if (method !== want) throw routeError('bad-method', 405, `方法不允许：${method}（${SESSION_DELETE_API_PREFIX}${route} 需 ${want}）`)
}

/** 段名的 404 与方法的 405 只在这里判一次；空段名按插件前缀显示，避免 404 原文出现一个空串。 */
export function resolveRoute(method: string, rest: string): RouteSpec {
  const spec = routeOf(rest)
  if (spec === undefined) {
    throw routeError('not-found-route', 404, `未知路由：${method} ${rest === '' ? SESSION_DELETE_API_PREFIX : rest}`)
  }
  requireMethod(method, spec.method, rest)
  return spec
}

function isPure(purity: Purity, body: JsonBody): boolean {
  return typeof purity === 'function' ? purity(body) === 'pure' : purity === 'pure'
}

/**
 * 全量面按行收窄（ADR-0032）：组合根装出的 {@link DeleteDeps} 只交给 `/apply`；每一段只拿到
 * 自己声明的那一格（路由表的 `slice`）。收窄是**运行期事实**，不是类型投影：`core` 的 fs 由
 * `FS_CORE_METHODS` 现切，删除能力根本不在对象上。
 */
function coreDepsOf(full: DeleteDeps): CoreDeps {
  return {
    fs: fsSlice(full.fs, FS_CORE_METHODS),
    host: full.host,
    ledger: full.ledger,
    home: full.home,
    presence: full.presence,
    config: full.config,
  }
}

/** `removal` 保留删除能力，但不带会话删除的时钟；`full` 只给 `/apply`。fs 与 `core` 同一条：
 *  按 `FS_CORE_METHODS + FS_REMOVAL_METHODS` 现切——ADR-0032 的收窄是运行期事实，不是把
 *  `full.fs` 的类型改一改。 */
function removalOf(full: DeleteDeps, core: CoreDeps): SliceDeps['removal'] {
  return {
    ...core,
    host: full.host,
    fs: fsSlice(full.fs, [...FS_CORE_METHODS, ...FS_REMOVAL_METHODS]),
  }
}

/** 五格只建一次：收窄对象在 dispatcher 构造期固定，请求路径只做引用选择。 */
export function slicesOf(full: DeleteDeps): SliceDeps {
  const core = coreDepsOf(full)
  return {
    core,
    removal: removalOf(full, core),
    full,
    attachment: { ...core, attachments: full.attachments },
    // `/config` 只多这两件；`exactOptionalPropertyTypes` 下用条件展开，不把 undefined 写进可选键。
    config: {
      ...core,
      ...(full.configEditor === undefined ? {} : { configEditor: full.configEditor }),
      ...(full.entry === undefined ? {} : { entry: full.entry }),
    },
  }
}

/** 按行选格：`spec.slice` 与 {@link SliceDeps} 的键同域，查表结果的类型由 `S` 直接给出。 */
function depsFor<S extends RouteSlice>(spec: { readonly slice: S }, slices: SliceDeps): SliceDeps[S] {
  return slices[spec.slice]
}

/** 分发函数：查段 → 方法闸 → 读面 → 处理。 */
export type Dispatch = (input: ApiInput) => Promise<ApiResult>

/** 路由执行器：查段 → 方法闸 → 读面 → 处理；返回归一结果。组合根只建一次。 */
export function createDispatcher(deps: DeleteDeps): Dispatch {
  const slices = slicesOf(deps)
  /**
   * 到达序串行链：`purity === 'chained'` 的请求一个跑完再放下一个。
   * `tail` 由构造保证**永不 reject**（每个任务自己的失败留在交回给那次请求的那个 promise 上），
   * 所以一次失败不会卡死链。
   */
  let tail: Promise<void> = Promise.resolve()
  const throughChain = <T>(task: () => Promise<T>): Promise<T> => {
    const started = tail.then(task)
    tail = started.then(() => undefined, () => undefined)
    return started
  }

  return async function dispatch(input: ApiInput): Promise<ApiResult> {
    const spec = resolveRoute(input.method, input.rest)
    // body 由适配器读好再进来：`apply` 的纯读判断与处理共用这一份（流不能被消费两遍）。
    const rowDeps = depsFor(spec, slices)
    const task = (): Promise<unknown> => {
      if (spec.response === 'binary') return spec.run(rowDeps, input.search)
      // 读面只交得出去的行（`list` / `raw`）才建这一面：`none` 行的 run 签名里没有它，
      // 分发器也就不为一行造一个没人叫得动的拒约。
      if (spec.read === 'none') return spec.run(rowDeps, input.body)
      let rowsPromise: ReturnType<RouteRead['rows']> | undefined
      const read: RouteRead = {
        rows() {
          rowsPromise ??= spec.read === 'list' ? deps.ledger.list() : deps.ledger.raw()
          return rowsPromise
        },
      }
      return spec.run(rowDeps, input.body, read)
    }
    const result = await (isPure(spec.purity, input.body) ? task() : throughChain(task))
    if (spec.response === 'binary') return { kind: 'binary', body: result as BinaryResponse }
    return { kind: 'json', status: 200, body: { ok: true, value: result } }
  }
}
