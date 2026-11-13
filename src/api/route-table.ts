/**
 * 路由表（ADR-0004；deps 切片见 ADR-0032）：段名 → { 方法, 纯度, 读面, body, deps 切片, 处理 }。一条记录，两个消费者。
 *
 * 一致性要求：
 * - 该纯的判成写 ⇒ 探测/正文读/扫描被堵在串行链后；
 * - 该写的判成纯 ⇒ 写动作绕开到达序链，与对账交错；
 * - body 该读没读 ⇒ 下游拿到 null；读两遍 ⇒ 流已被消费；
 * - 切片声明宽了 ⇒ 危险能力（删目录 / 时钟）漏进读段的 run；窄了 ⇒ 写段的处理编译不过。
 *
 * 这张表不放 shared/wire.ts：处理函数会 import 动词与 node:fs，而浏览器半要 import wire.ts。
 * 段名、方法、请求体形状与字段组描述住 wire.ts（`ROUTES` 每项 `{ path, method, body }`，本表的 method /
 * body 由 `defineRoute` 从段名表那一格派生、不写第二份字面量；字段组描述 `BODY_GROUPS` 由本表的
 * 通用解析手消费）；这张表只回答“怎么处理”。
 */
import { BODY_GROUPS, PARAMS, ROUTES, type ApplyAction, type BodyFieldKind, type BodyGroup, type ParsedBody, type RouteBody, type RouteName } from '../shared/wire.js'
import type { ConfigEditorLike, CoreDeps, DeleteDeps, RemovalDeps } from '../deps.js'
import type { AttachmentsPort } from '../ports/attachments-port.js'
import type { TrashEntry } from '../trash/entry.js'
import { applyActions } from '../verbs/batch.js'
import { configPatchOf, readOrSaveConfig } from '../verbs/config.js'
import { routeError } from '../errors.js'
import { reportOrphans, loadOrphanGroups } from '../verbs/orphan-subagents.js'
import { createTrashScope } from '../verbs/trash-scope.js'
import { executeRemoval } from '../verbs/permanent-removal.js'
import { readTrashDetail } from '../trash/detail.js'
import { readArchiveDetail } from '../trash/archive-detail.js'
import { cleanOrphanImageAttachments } from '../trash/attachments.js'
import { cleanProjectionCacheOrphans, reportProjectionCacheOrphans } from '../trash/projection-cache.js'
import { readAttachmentResponse } from './attachment.js'
import { reportAttachmentOrphans } from './attachment-orphans.js'
import { assembleTrashRows } from './trash-rows.js'
import { assembleArchiveRows } from './archive-rows.js'

/** 请求体：`json` 才读下来（GET 一律不读；读两遍会把流消费掉）。 */
export type BodyKind = 'none' | 'json'

/** 段名表那一格 → 分发器要不要预读 JSON。`satisfies` 让每个 `RouteBody` 值都必须在这里有
 *  明确的一格：以后加一种 body，缺了映射就是编译错，不会被默认折成 JSON 预读。 */
const BODY_KIND = {
  none: 'none',
  query: 'none',
  config: 'json',
  entry: 'json',
  apply: 'json',
  sessionId: 'json',
} as const satisfies Record<RouteBody, BodyKind>

/** 读的是 wire 那一格（`ROUTES.x.body`），本表不写第二份：无字段与查询串段不读；
 *  带 JSON 字段的段（config / entry / apply）读一次。`defineRoute` 据此填行的 `body`。 */
export function bodyOf(route: { readonly body: RouteBody }): BodyKind {
  return BODY_KIND[route.body]
}

/** 到达序：`pure` 不进链；`chained` 进链；函数形式给 `/apply` 用（`count` 是纯读）。 */
export type Purity = 'pure' | 'chained' | ((body: JsonBody) => 'pure' | 'chained')
/** 清册读面：`none` = 不读；`list` = 真相读（先对账）；`raw` = 索引快照（不对账）。
 *  它与纯度是两条独立的轴：`count` 是 pure/不读，`detail` 是 pure/raw，`ping` 是 pure/不读。 */
export type ReadKind = 'none' | 'list' | 'raw'
export type JsonBody = Record<string, unknown> | null

/** 附件段的二进制落地：处理函数交回字节与安全头，分发器按它写 200（失败仍是 JSON 信封）。 */
export interface BinaryResponse {
  readonly body: Buffer
  readonly contentType: string
  readonly disposition: 'inline' | 'attachment'
  readonly filename?: string
}

/** 路由交给处理函数的读能力：读段与 `/empty` 只能从这一面取行，不能自己挑 `list()` / `raw()`（`/apply` 的写动词读面归动词自己）。 */
export interface RouteRead {
  rows(): Promise<readonly TrashEntry[]>
}

/** deps 切片（ADR-0032）：每一段只声明自己要的那一面。读与探测各段拿基础面，`attachment` 段另多一条
 *  宿主 `attachments` 读面，两个删盘段多删除能力，`/apply` 是唯一拿全量面的行，`/config` 只多
 *  configEditor + entry 两件（段的 run 里长出超面调用就是编译错；dispatch 也只按这一格注入，
 *  运行期收窄住 `src/api/dispatch.ts` 的 `slicesOf`）。 */
export type RouteSlice = 'core' | 'removal' | 'full' | 'attachment' | 'config'
/** 切片名 → 依赖面：{@link RouteSpec.run} 的 deps 参数类型与 `depsFor` 的返回类型都从这一格取。 */
export type SliceDeps = {
  core: CoreDeps
  removal: RemovalDeps
  full: DeleteDeps
  attachment: CoreDeps & { readonly attachments: AttachmentsPort }
  config: CoreDeps & { readonly configEditor?: ConfigEditorLike; readonly entry?: unknown }
}

interface BaseRouteSpec<S extends RouteSlice> {
  /** 这一行吃哪一格 deps：dispatch 按它注入，`run` 的 deps 参数类型也跟着它走。 */
  readonly slice: S
  readonly method: 'GET' | 'POST'
  readonly body: BodyKind
  readonly purity: Purity
  /** 同源取数闸（ADR-0033）：只有能被别的页面渲染消费的段需要；判据住 `src/api/connection-route.ts`。
   *  缺省不设闸——JSON 响应跨源读不到（没有 CORS），不需要它。 */
  readonly fetchGate?: 'same-origin'
}

/** `read: 'none'` 的 JSON 段：处理函数只拿请求体——没有读面可交，签名里也就不摆 `RouteRead`
 *  （none 行想看读面是编译错，不是运行期才炸的拒约）。 */
export interface NoReadJsonRouteSpec<S extends RouteSlice = RouteSlice> extends BaseRouteSpec<S> {
  readonly read: 'none'
  readonly response: 'json'
  /** 声明成函数属性而不是方法：方法签名是双变的，显式标注更宽的 deps 能绕过切片闸；属性按逆变校验。 */
  readonly run: (deps: SliceDeps[S], body: JsonBody) => Promise<unknown>
}

/** `read: 'list' | 'raw'` 的 JSON 段：处理函数拿请求体与读面；`query` 不在这里（段名表里只有二进制段需要查询串）。 */
export interface ReadJsonRouteSpec<S extends RouteSlice = RouteSlice> extends BaseRouteSpec<S> {
  readonly read: 'list' | 'raw'
  readonly response: 'json'
  /** 声明成函数属性而不是方法：方法签名是双变的，显式标注更宽的 deps 能绕过切片闸；属性按逆变校验。 */
  readonly run: (deps: SliceDeps[S], body: JsonBody, read: RouteRead) => Promise<unknown>
}

/** JSON 段（两种读面的并集）：`response` 是 `json` 的行都归它；按 `read` 再分成拿不拿读面两形。 */
export type JsonRouteSpec<S extends RouteSlice = RouteSlice> = NoReadJsonRouteSpec<S> | ReadJsonRouteSpec<S>

/** 二进制段：只有 `/attachment`；处理函数直接拿查询串，交回字节与安全头。 */
export interface BinaryRouteSpec<S extends RouteSlice = RouteSlice> extends BaseRouteSpec<S> {
  readonly read: 'none'
  readonly response: 'binary'
  readonly run: (deps: SliceDeps[S], query: URLSearchParams) => Promise<BinaryResponse>
}

export type RouteSpec<S extends RouteSlice = RouteSlice> = JsonRouteSpec<S> | BinaryRouteSpec<S>

/** 各行的并集（表的值类型）：每行由自己的 `slice` 与 `response` 字面量定型，`run` 的 deps 面随之收窄。 */
export type AnyRouteSpec = { [S in RouteSlice]: RouteSpec<S> }[RouteSlice]

/** 行的决定半（`defineRoute` 三个重载的入参）：只写 `slice` / 纯度 / 读面 / 处理——`name` 是段名，
 *  `method` 与 `body` 由 `defineRoute` 按 `name` 从段名表取，行里写不进第二份（写了就是编译错的
 *  多余属性）。none 行的 `run` 允许少写形参（探测段没有可读的入参，`/ping` 连请求体都不消费）。 */
interface NoneJsonDecision<S extends RouteSlice> {
  readonly slice: S
  readonly purity: Purity
  readonly read: 'none'
  readonly response?: 'json'
  readonly fetchGate?: 'same-origin'
  readonly run: (deps: SliceDeps[S], body: JsonBody) => Promise<unknown>
}

/** 读行的决定半。`run` 的形参数量**恰好**三参：TS 的函数赋值默认放行少参，而读行声明了读面、
 *  `run` 却少接一个形参就是「带读面声明却拿不到读面」的死接线——按 `R` 数形参，少一个、多一个
 *  都把 `run` 判成 `never`（编译错）。`R` 只从 `run` 推断，形参的上下文类型取 `R` 的约束
 *  （标准三参形），行体照常按它写。 */
type ReadJsonDecision<S extends RouteSlice, R extends (deps: SliceDeps[S], body: JsonBody, read: RouteRead) => Promise<unknown>> = {
  readonly slice: S
  readonly purity: Purity
  readonly read: 'list' | 'raw'
  readonly response?: 'json'
  readonly fetchGate?: 'same-origin'
  readonly run: R
} & (Parameters<R>['length'] extends 3 ? unknown : { readonly run: never })

/** 二进制行的决定半：同一条数参判据，`run` 恰好两参——`query` 是它的寻址入参，
 *  少接一个就只剩一个不会寻址的处理器。 */
type BinaryDecision<S extends RouteSlice, R extends (deps: SliceDeps[S], query: URLSearchParams) => Promise<BinaryResponse>> = {
  readonly slice: S
  readonly purity: Purity
  readonly read: 'none'
  readonly response: 'binary'
  readonly fetchGate?: 'same-origin'
  readonly run: R
} & (Parameters<R>['length'] extends 2 ? unknown : { readonly run: never })

/** 段名表的键（`list` / `ping` / …）：与 `RouteName`（每项的 `path`）是两个域——行文按键写、
 *  线上段名是它的 `path`，`defineRoute` 拿键去段名表取那一格。 */
type RouteKey = keyof typeof ROUTES

/** 段名键 → 行的条目：`name` 是这条目自己的段名键，组装器按它派生键——键与段名同一个字面量，错不开。 */
type RouteEntry<N extends RouteKey> = {
  readonly name: N
  readonly spec: AnyRouteSpec
}

/**
 * 一行路由 = 段名 + 决定半：`method` / `body` 从 `ROUTES[name]` 派生（投影只这一处，行里写不进第二份），
 * 纯度 / 读面 / 切片 / 处理由调用方给。三个重载按 `read` 与 `response` 分派 `run` 的形：
 * none 的 JSON 行只拿请求体（拿不到 `RouteRead`），`list` / `raw` 行多拿读面（恰好三参），
 * 二进制行拿查询串（恰好两参）——`read` 与 `response` 的组合三选一，坏组合没有重载收。
 * 交回条目（段名 + 行）而不是裸行：`createRouteTable` 按 `name` 派生键，行文里没有第二个可写错的段名。
 */
export function defineRoute<N extends RouteKey, S extends RouteSlice>(name: N, decision: NoneJsonDecision<S>): RouteEntry<N>
export function defineRoute<N extends RouteKey, S extends RouteSlice, R extends (deps: SliceDeps[S], body: JsonBody, read: RouteRead) => Promise<unknown>>(name: N, decision: ReadJsonDecision<S, R>): RouteEntry<N>
export function defineRoute<N extends RouteKey, S extends RouteSlice, R extends (deps: SliceDeps[S], query: URLSearchParams) => Promise<BinaryResponse>>(name: N, decision: BinaryDecision<S, R>): RouteEntry<N>
export function defineRoute(
  name: RouteKey,
  decision: NoneJsonDecision<RouteSlice>
    | ReadJsonDecision<RouteSlice, (deps: SliceDeps[RouteSlice], body: JsonBody, read: RouteRead) => Promise<unknown>>
    | BinaryDecision<RouteSlice, (deps: SliceDeps[RouteSlice], query: URLSearchParams) => Promise<BinaryResponse>>,
): RouteEntry<RouteKey> {
  const seg = ROUTES[name]
  return {
    name,
    spec: {
      ...decision,
      response: decision.response ?? 'json',
      method: seg.method,
      body: bodyOf(seg),
    } as NoReadJsonRouteSpec | ReadJsonRouteSpec | BinaryRouteSpec,
  }
}

/** 组装整张表：键从条目的段名派生（`ROUTES[name].path`）——行文里没有手写的键，
 *  缺键 / 多键 / 名不对号（这一格的 key 与 `defineRoute` 的段名不同源）都编译不过。 */
function createRouteTable(rows: { readonly [K in RouteKey]: RouteEntry<K> }): Record<RouteName, AnyRouteSpec> {
  return Object.fromEntries(
    Object.values(rows).map((entry) => [ROUTES[entry.name].path, entry.spec]),
  ) as Record<RouteName, AnyRouteSpec>
}

/**
 * `/apply` 的六个动作与各自的**静态纯度**。一张表三个用途：动作名单由键派生，纯度从同一格读，
 * 唯一识别器（`actionOf`）也只认这些键——新增动作必须同时给出纯度，漏了编译不过；
 * 新加一个纯读动作也不会再静默落进 `chained`。
 */
export const APPLY_ACTION_TABLE = {
  delete: 'chained',
  restore: 'chained',
  purge: 'chained',
  count: 'pure',
  'orphan-clean': 'chained',
  unarchive: 'chained',
} satisfies Record<ApplyAction, 'pure' | 'chained'>

export const APPLY_ACTIONS = Object.keys(APPLY_ACTION_TABLE) as readonly ApplyAction[]

/**
 * `/apply` 的动作：**全仓唯一识别器**——纯度函数与字段闸的动作拒否都从这里过，
 * 不各解析一遍动作。不抛：缺动作 / 不是字符串 / 不在名单，一律回 `undefined`；
 * 抛不抛、抛哪句话归通用解析手（{@link parseBody}）。
 */
function actionValueOf(value: unknown): ApplyAction | undefined {
  if (typeof value !== 'string' || !Object.hasOwn(APPLY_ACTION_TABLE, value)) return undefined
  return value as ApplyAction
}

function actionOf(body: JsonBody): ApplyAction | undefined {
  return actionValueOf(body?.[PARAMS.action])
}

/**
 * 请求字段组的**通用解析手**：wire 的描述（`BODY_GROUPS`，字段键 + 种类）→ typed 字段。
 * 必填串 / 可选串 / 游标 / 动作 / id 组五种读法收成 {@link readField} 的五条分支——描述里加一个
 * 字段不用再添一只手，`ParsedBody` 的类型与拒绝原文都从同一份描述派生。
 *
 * 按**描述的声明序**逐格读：`apply` 组先 `action` 后 `ids`，动作拒否必须先于 ids 栅栏
 * （`tests/route-table.test.ts` 的动作表用例靠这个顺序证明「已过识别器」，改描述或这里
 * 的读序前先回去核那句）。
 */
function parseBody<G extends BodyGroup>(body: JsonBody, group: G): ParsedBody<G> {
  const fields: Record<string, unknown> = {}
  for (const [field, kind] of Object.entries(group)) {
    fields[field] = readField(body, field, kind)
  }
  // 描述兑现成类型：运行期只有这里攒出来的格子，键按 `PARAMS` 常量写、种类被 `BodyGroup` 的类型闸收窄
  // （键↔`PARAMS` 的配对由 `tests/wire-shape.test.ts` 把守），用法对不上就是编译错，不必在运行期再验一遍。
  return fields as ParsedBody<G>
}

/** 描述里的一个字段读成它的值：五种种类各一句 400 原文（请求本身不对，不是操作失败），
 *  原文只住这一处——`tests/api.test.ts` 与 `tests/route-table.test.ts` 逐字钉着它们。 */
function readField(body: JsonBody, field: string, kind: BodyFieldKind): unknown {
  const value = body?.[field]
  switch (kind) {
    case 'requiredString':
      if (typeof value !== 'string' || value === '') {
        throw routeError('bad-request', 400, `请求体需带非空字符串字段 ${field}`)
      }
      return value
    case 'optionalString':
      if (value === undefined) return undefined
      if (typeof value !== 'string' || value === '') {
        throw routeError('bad-request', 400, `请求体字段 ${field} 需是非空字符串`)
      }
      return value
    case 'optionalCursor':
      // 缺省 = 不带这格；给了就必须是非负整数（负数、小数、字符串都算请求不对）。
      if (value === undefined) return undefined
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw routeError('bad-request', 400, `请求体字段 ${field} 需是非负整数`)
      }
      return value
    case 'action': {
      // 认不认得只问识别器（纯度那一枚 `actionOf` 与这里共用 `actionValueOf`）；读的是描述里的那一格，
      // 不是再按 `PARAMS.action` 取一遍——描述把动作种类挂到哪个键，就校验哪个键的值。
      // 认不得的一律点名拒掉，不折成"空批量"糊弄过去。
      const action = actionValueOf(value)
      if (action === undefined) {
        throw routeError('bad-request', 400, `批量动作不认识：需是 ${APPLY_ACTIONS.join(' / ')} 之一`)
      }
      return action
    }
    case 'idArray':
      // 空数组不是"什么都不做"，是调用方自己没组好。
      if (!Array.isArray(value) || value.length === 0 || value.some(id => typeof id !== 'string' || id === '')) {
        throw routeError('bad-request', 400, `请求体需带 ${field}：非空字符串组成的非空数组`)
      }
      return value
    default: {
      // 穷尽闸：`BodyFieldKind` 多出一种读法时，这里编译不过——新种类不许静默回 undefined。
      const _never: never = kind
      return _never
    }
  }
}

/**
 * 段名表逐行：键是段名（`createRouteTable` 按条目的段名派生成 `ROUTES[name].path`，行文里不手写键），
 * 值经 `defineRoute` 构造。`Record<段名, AnyRouteSpec>` 是闸：`wire.ts` 加了段名而这里没加，编译不过；
 * 每行的 `slice` 又把该行的 `run` 钉在自己那一格 deps 上（ADR-0032）。
 */
export const ROUTE_TABLE: Record<RouteName, AnyRouteSpec> = createRouteTable({
  list: defineRoute('list', {
    slice: 'core',
    purity: 'chained',
    read: 'list',
    response: 'json',
    // 「读清单」=「对账 + 读」：语义归 `src/trash/ledger.ts` 的 `list()`（清单以 `session-trash/` 里的目录为准）。
    // 读面由这一行选好，处理函数只消费 `read`，不再自己挑 `list()` / `raw()`。
    run: async (deps, _body, read) => assembleTrashRows(deps, await read.rows()),
  }),
  ping: defineRoute('ping', {
    slice: 'core',
    purity: 'pure',
    read: 'none',
    response: 'json',
    // 客户端探测专用的最便宜一问：不碰清册、不碰盘、不进链。它的**信封**就是答案（"路由在、
    // 依赖接上了、映射生效了"），不是清单里此刻有几条——拿它当健康检查等于每次页面加载都跑一遍对账。
    // eslint-disable-next-line @typescript-eslint/require-await -- `run` 的契约面是 Promise（路由处理器统一 await）；这一格没有可读的东西，同步字面量就是全部实现体——为一条写法规则把它改成同步值等于改契约。
    run: async () => 'pong',
  }),
  config: defineRoute('config', {
    slice: 'config',
    // 空体是读（与 detail 同法用 POST 表达一个读），只有写才进到达序链：`configEditor.edit`
    // 会让这一行重启，不能和删除 / 恢复交错。判据与动词共用 `src/verbs/config.ts` 的 `configPatchOf`。
    purity: (body) => configPatchOf(body) === undefined ? 'pure' : 'chained',
    read: 'none',
    response: 'json',
    // 校验（400）与 configEditor 缺席（io）都住 `src/verbs/config.ts`；这里只声明"怎么处理"。
    run: async (deps, body) => readOrSaveConfig(deps, body),
  }),
  attachment: defineRoute('attachment', {
    slice: 'attachment',
    purity: 'pure',
    read: 'none',
    response: 'binary',
    // 唯一能被别的页面当 <img> 渲染的段：同站不同端口的页面仍带宿主 cookie，字节 oracle 要在这里收口。
    fetchGate: 'same-origin',
    // 全仓唯一的二进制段：读宿主附件库里的一个文件（图片 / 普通文件），不碰清册、不排队。
    // 闸（id / kind / 可配置上限 / 宿主引用校验与服务缺席时的魔数 fallback）都住 `src/api/attachment.ts`；
    // 这里只声明"它怎么被处理"。
    run: async (deps, query) => readAttachmentResponse(deps, query),
  }),
  attachmentOrphans: defineRoute('attachmentOrphans', {
    slice: 'core',
    purity: 'pure',
    read: 'none',
    response: 'json',
    // 纯读：扫活动会话 + 全部回收站目录 + storages/cache 的图片引用，再对附件库 `objects` 列表；
    // 回数量/字节 + 供预览的对象清单，不碰清册、不进链。引用源读不出 ⇒ 处理函数抛 io（不折成 0）。
    run: async (deps) => reportAttachmentOrphans(deps),
  }),
  attachmentClean: defineRoute('attachmentClean', {
    slice: 'removal',
    purity: 'chained',
    read: 'none',
    response: 'json',
    // 写动作：先扫引用源（决定删哪些），再逐文件删；必须排在到达序链上，不能与删除/清空交错。
    // 不读清册（read: none）——孤儿附件与回收站行无关，`AttachmentCleanupWire` 原样回执。
    run: async (deps) => cleanOrphanImageAttachments(deps),
  }),
  projectionOrphans: defineRoute('projectionOrphans', {
    slice: 'core',
    purity: 'pure',
    read: 'raw',
    response: 'json',
    // 纯读：扫投影缓存记录（`session_projcache` 的键集）−（语料/持久化 ∪ 清册 raw 行 ∪ 回收站目录）。
    // **不动任何一个字节**；语料或缓存读面读不出 ⇒ 处理函数抛 io，不折成 0 条。
    run: async (deps, _body, read) => reportProjectionCacheOrphans(deps, await read.rows()),
  }),
  projectionClean: defineRoute('projectionClean', {
    slice: 'removal',
    purity: 'chained',
    read: 'raw',
    response: 'json',
    // 写动作：按路由交来的 raw 清册行 + 回收站目录现扫（不对账、不改写清册；幽灵行也是保护面），
    // 最后经宿主 storage domain 删记录。必须排在到达序链上，不能与删除/清空交错；
    // 报告与清理共用同一条判据，清理不信任旧报告。
    run: async (deps, _body, read) => cleanProjectionCacheOrphans(deps, await read.rows()),
  }),
  orphans: defineRoute('orphans', {
    slice: 'core',
    purity: 'pure',
    read: 'raw',
    response: 'json',
    // 纯读的 `/orphans` 段：扫语料（`sessionQuery.listSessions`，live ∪ 持久化）+ 读清册 **raw 索引**，把"父既不在
    // 语料也不在回收站"的那些组量一遍字节。**不动任何一个字节**（不对账、不写行），也不排队。
    // 清理走 `/apply` 的 `orphan-clean`：那条先对账再扫（写动作必须排在到达序链上）。
    run: async (deps, _body, read) => reportOrphans(await loadOrphanGroups(deps, await read.rows())),
  }),
  apply: defineRoute('apply', {
    slice: 'full',
    purity: (body) => {
      // 与字段闸的动作拒否同一个识别器（`actionOf`）：纯度认不得的动作判 chained（不插队先跑），
      // 交给 run 那一步响亮拒掉——两侧不许各解析一遍。
      const action = actionOf(body)
      return action === undefined ? 'chained' : APPLY_ACTION_TABLE[action]
    },
    read: 'none',
    response: 'json',
    // `count` 不碰清册也不动文件（它问的是**还在盘上**的会话），和详情一样走豁免；
    // 其余五个都是写动作（`delete` / `restore` / `purge` / `orphan-clean` / `unarchive`）——前三个动清册，
    // `orphan-clean` 先对账、再摘归档/账本并删盘上那些没有清册行的目录，`unarchive` 写 registry 归档集
    // ——都必须排在链上。
    // 写动词的读面归动词自己（谁写谁读），路由只在读动作上选面。
    run: async (deps, body) => {
      // typed 字段由通用解析手按 wire 的 `apply` 字段组描述读出（action 拒否与 ids 栅栏都住那里）。
      const fields = parseBody(body, BODY_GROUPS.apply)
      return applyActions(deps, fields.action, fields.ids)
    },
  }),
  empty: defineRoute('empty', {
    slice: 'removal',
    purity: 'chained',
    read: 'list',
    response: 'json',
    // 清空回收站：聚合回执，不按条回——这是它与 `/apply` 唯一的区别，也是它单独一段的理由。
    // **先对账再清**：手工搬进 `session-trash/` 的那一格在清册里还没有行，只按 raw 索引清就会
    // 在它走后仍留一个点不开的目录；`read` 交回的那一份就是"这里此刻真的有的一切"。
    run: async (deps, _body, read) => {
      // 直接把这一份当快照交进清册作用域，一次 purgeAll() 清空，不再读第二遍清册。
      // 删的能力住这一行的 `removal` 切片，按调用点注入给作用域（作用域只拿 CoreDeps）。
      return await createTrashScope(deps, await read.rows(), (plan) => executeRemoval(deps, plan)).purgeAll()
    },
  }),
  detail: defineRoute('detail', {
    slice: 'core',
    purity: 'pure',
    read: 'raw',
    response: 'json',
    // 读单条详情也走 POST：字段栅栏（通用解析手 `parseBody`）、请求栅栏、错误映射这一整套都挂在
    // 同一张路由表上（`bodyOf(ROUTES.detail)` 决定它在处理前预读一次请求体）；改成 GET query 只是
    // 把同一道栅栏再写一遍（栅栏只写一遍——纯度 / 读面 / body 就住这张表，方法投影自 wire 的段名表，
    // ADR-0004）。
    // 读的是清册 **raw 索引**（`read` 的 raw 面），**不对账**：本段声明为 pure、不进到达序链，而对账会写
    // 清册行（写动作必须排在链上）。行在 raw 里而目录不在时详情自己判 `io`，不靠对账把行摘掉。
    run: async (deps, body, read) => {
      const fields = parseBody(body, BODY_GROUPS.entry)
      return readTrashDetail({ fs: deps.fs, rows: () => read.rows(), home: deps.home })(
        fields.entryId,
        fields.before,
      )
    },
  }),
  archiveList: defineRoute('archiveList', {
    slice: 'core',
    purity: 'pure',
    read: 'none',
    response: 'json',
    // 纯读：归档集 ∩ 语料一次算好（标题/label/大小/最后活动的口径住 `api/archive-rows.ts`）。
    // 不读清册、不进链；`sessionQuery` 缺席由装配层折成 `ArchiveListWire` 的 `{available:false}`。
    run: async (deps) => assembleArchiveRows(deps),
  }),
  archiveDetail: defineRoute('archiveDetail', {
    slice: 'core',
    purity: 'pure',
    read: 'none',
    response: 'json',
    // 读单条归档详情：寻址只认 `sessionId`（红线：路径字段不过线）；目标自己已归档，
    // 或目标是可选 `rootSessionId` 那条已归档会话的 subagent 闭包成员。
    // 栅栏与 `/detail` 同一套（同一个通用解析手：必填串 + 游标），字段组多一格可选 `rootSessionId`
    // （描述在 wire 的 `sessionId` 组）；正文折叠复用 `DetailFold`。
    run: async (deps, body) => {
      const fields = parseBody(body, BODY_GROUPS.sessionId)
      return readArchiveDetail(deps)(fields.sessionId, fields.before, fields.rootSessionId)
    },
  }),
})

/** 段名 → 那一行；不认识的段名回 `undefined`（调用方抛 404，并带出原路径）。 */
export function routeOf(rest: string): RouteSpec | undefined {
  return (ROUTE_TABLE as Record<string, RouteSpec | undefined>)[rest]
}
