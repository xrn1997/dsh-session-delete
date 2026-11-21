/** 路由表（ADR-0004；deps 切片见 ADR-0032）：段名 → { 方法, 纯度, 读面, body, deps 切片, 处理 }。
 *  该纯的判成写会堵住读段，该写的判成纯会让写动作绕开到达序链；误判由这张表与 `tests/route-table.test.ts` 兜。
 *  段名、方法、body 与字段组住 `shared/wire.ts`；这张表只回答「怎么处理」。 */
import { APPLY_ACTION_INDEX } from '../shared/apply-actions.js'
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

/** 段名表那一格 → 分发器要不要预读 JSON；`satisfies` 是闸，缺映射编译错。 */
const BODY_KIND = {
  none: 'none',
  query: 'none',
  config: 'json',
  entry: 'json',
  apply: 'json',
  sessionId: 'json',
} as const satisfies Record<RouteBody, BodyKind>

/** 读的是 wire 那一格（`ROUTES.x.body`）：无字段与查询串段不读，带 JSON 字段的段读一次。 */
export function bodyOf(route: { readonly body: RouteBody }): BodyKind {
  return BODY_KIND[route.body]
}

/** 到达序：`pure` 不进链；`chained` 进链；函数形式给 `/apply` 用（`count` 是纯读）。 */
export type Purity = 'pure' | 'chained' | ((body: JsonBody) => 'pure' | 'chained')
/** 清册读面：`none` 不读、`list` 先对账、`raw` 索引快照；与纯度是两条独立的轴。 */
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

/** deps 切片（ADR-0032）：每段只声明自己要的那一面；段的 run 里长出超面调用是编译错。
 *  dispatch 也只按这一格注入（运行期收窄住 `src/api/dispatch.ts` 的 `slicesOf`）。 */
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
  /** 同源取数闸（ADR-0033）：只有能被别的页面渲染消费的段需要，判据住 `connection-route.ts`。 */
  readonly fetchGate?: 'same-origin'
}

/** `read:'none'` 的 JSON 段：处理函数只拿请求体，签名里不摆 `RouteRead`。 */
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

/** 行的决定半：只写 `slice` / 纯度 / 读面 / 处理；`method` 与 `body` 由 `defineRoute` 从段名表取。
 *  none 行的 `run` 可少写形参（探测段没有可读的入参）。 */
interface NoneJsonDecision<S extends RouteSlice> {
  readonly slice: S
  readonly purity: Purity
  readonly read: 'none'
  readonly response?: 'json'
  readonly fetchGate?: 'same-origin'
  readonly run: (deps: SliceDeps[S], body: JsonBody) => Promise<unknown>
}

/** 读行：`run` 恰好三参——少接一个就是「带读面声明却拿不到读面」的死接线，多一个或少一个都判成 `never`。 */
type ReadJsonDecision<S extends RouteSlice, R extends (deps: SliceDeps[S], body: JsonBody, read: RouteRead) => Promise<unknown>> = {
  readonly slice: S
  readonly purity: Purity
  readonly read: 'list' | 'raw'
  readonly response?: 'json'
  readonly fetchGate?: 'same-origin'
  readonly run: R
} & (Parameters<R>['length'] extends 3 ? unknown : { readonly run: never })

/** 二进制行：`run` 恰好两参——`query` 是寻址入参，少接一个就只剩不会寻址的处理器。 */
type BinaryDecision<S extends RouteSlice, R extends (deps: SliceDeps[S], query: URLSearchParams) => Promise<BinaryResponse>> = {
  readonly slice: S
  readonly purity: Purity
  readonly read: 'none'
  readonly response: 'binary'
  readonly fetchGate?: 'same-origin'
  readonly run: R
} & (Parameters<R>['length'] extends 2 ? unknown : { readonly run: never })

/** 段名表的键：与 `RouteName`（每项的 `path`）是两个域，`defineRoute` 拿键去段名表取那一格。 */
type RouteKey = keyof typeof ROUTES

/** 段名键 → 行的条目：`name` 是这条目自己的段名键，组装器按它派生键——键与段名同一个字面量，错不开。 */
type RouteEntry<N extends RouteKey> = {
  readonly name: N
  readonly spec: AnyRouteSpec
}

/** 一行路由 = 段名 + 决定半：`method` / `body` 从 `ROUTES[name]` 派生，纯度 / 读面 / 切片 / 处理由调用方给。
 *  三个重载按 `read` 与 `response` 分派 `run` 的形；交回条目而不是裸行，行文里没有第二个可写错的段名。 */
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

/** 组装整张表：键从条目的段名派生，缺键 / 多键 / 名不对号都编译不过。 */
function createRouteTable(rows: { readonly [K in RouteKey]: RouteEntry<K> }): Record<RouteName, AnyRouteSpec> {
  return Object.fromEntries(
    Object.values(rows).map((entry) => [ROUTES[entry.name].path, entry.spec]),
  ) as Record<RouteName, AnyRouteSpec>
}

/** `/apply` 六个动作的静态纯度：动作名单由键派生，唯一识别器也只认这些键。
 *  事实源是 `src/shared/apply-actions.ts` 的 `APPLY_ACTION_INDEX`，这里只投影；`satisfies` 是编译闸。 */
export const APPLY_ACTION_TABLE = {
  delete: APPLY_ACTION_INDEX.delete.purity,
  restore: APPLY_ACTION_INDEX.restore.purity,
  purge: APPLY_ACTION_INDEX.purge.purity,
  count: APPLY_ACTION_INDEX.count.purity,
  'orphan-clean': APPLY_ACTION_INDEX['orphan-clean'].purity,
  unarchive: APPLY_ACTION_INDEX.unarchive.purity,
} satisfies Record<ApplyAction, 'pure' | 'chained'>

export const APPLY_ACTIONS = Object.keys(APPLY_ACTION_TABLE) as readonly ApplyAction[]

/** `/apply` 的动作：全仓唯一识别器，纯度函数与字段闸都从这里过。不抛：不认得一律回 `undefined`，
 *  抛不抛、抛哪句话归通用解析手（{@link parseBody}）。 */
function actionValueOf(value: unknown): ApplyAction | undefined {
  if (typeof value !== 'string' || !Object.hasOwn(APPLY_ACTION_TABLE, value)) return undefined
  return value as ApplyAction
}

function actionOf(body: JsonBody): ApplyAction | undefined {
  return actionValueOf(body?.[PARAMS.action])
}

/** 请求字段组的通用解析手：wire 的描述（`BODY_GROUPS`）→ typed 字段。
 *  按描述的声明序逐格读（`apply` 组先 `action` 后 `ids`，动作拒否必须先于 ids 栅栏）。 */
function parseBody<G extends BodyGroup>(body: JsonBody, group: G): ParsedBody<G> {
  const fields: Record<string, unknown> = {}
  for (const [field, kind] of Object.entries(group)) {
    fields[field] = readField(body, field, kind)
  }
  // 描述兑现成类型：键与种类已被 `BodyGroup` 收窄，用法对不上是编译错，运行期不必再验。
  return fields as ParsedBody<G>
}

/** 描述里的一个字段读成它的值：五种种类各一句 400 原文，原文只住这一处。 */
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
      // 认不认得只问识别器；认不得的一律点名拒掉，不折成「空批量」糊弄过去。
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

/** 段名表逐行：键由 `createRouteTable` 派生；`Record<段名, AnyRouteSpec>` 是闸，漏段编译不过。 */
export const ROUTE_TABLE: Record<RouteName, AnyRouteSpec> = createRouteTable({
  list: defineRoute('list', {
    slice: 'core',
    purity: 'chained',
    read: 'list',
    response: 'json',
    // 「读清单」=「对账 + 读」，语义归 `src/trash/ledger.ts` 的 `list()`；读面由这一行选好，处理函数只消费 `read`。
    run: async (deps, _body, read) => assembleTrashRows(deps, await read.rows()),
  }),
  ping: defineRoute('ping', {
    slice: 'core',
    purity: 'pure',
    read: 'none',
    response: 'json',
    // 客户端探测最便宜一问：信封本身就是答案（路由在、依赖接上），不碰清册与盘。
    // eslint-disable-next-line @typescript-eslint/require-await -- `run` 的契约面是 Promise（路由处理器统一 await）；这一格没有可读的东西，同步字面量就是全部实现体——为一条写法规则把它改成同步值等于改契约。
    run: async () => 'pong',
  }),
  config: defineRoute('config', {
    slice: 'config',
    // 空体是读，只有写才进到达序链（`configEditor.edit` 会让这一行重启，不能和删除交错）。
    purity: (body) => configPatchOf(body) === undefined ? 'pure' : 'chained',
    read: 'none',
    response: 'json',
    // 校验与 configEditor 缺席都住 `src/verbs/config.ts`；这里只声明怎么处理。
    run: async (deps, body) => readOrSaveConfig(deps, body),
  }),
  attachment: defineRoute('attachment', {
    slice: 'attachment',
    purity: 'pure',
    read: 'none',
    response: 'binary',
    // 唯一能被别的页面当 <img> 渲染的段：同站不同端口的页面仍带宿主 cookie，字节 oracle 要在这里收口。
    fetchGate: 'same-origin',
    // 全仓唯一的二进制段：闸都住 `api/attachment.ts`，这里只声明怎么被处理。
    run: async (deps, query) => readAttachmentResponse(deps, query),
  }),
  attachmentOrphans: defineRoute('attachmentOrphans', {
    slice: 'core',
    purity: 'pure',
    read: 'none',
    response: 'json',
    // 纯读：扫引用源与附件库，回数量/字节 + 预览清单；引用源读不出 ⇒ 抛 io，不折成 0。
    run: async (deps) => reportAttachmentOrphans(deps),
  }),
  attachmentClean: defineRoute('attachmentClean', {
    slice: 'removal',
    purity: 'chained',
    read: 'none',
    response: 'json',
    // 写动作：先扫引用源再逐文件删，必须排在到达序链上；不读清册。
    run: async (deps) => cleanOrphanImageAttachments(deps),
  }),
  projectionOrphans: defineRoute('projectionOrphans', {
    slice: 'core',
    purity: 'pure',
    read: 'raw',
    response: 'json',
    // 纯读：投影缓存键集 −（语料 ∪ 清册 raw ∪ 回收站目录），不动任何字节；读面读不出 ⇒ io。
    run: async (deps, _body, read) => reportProjectionCacheOrphans(deps, await read.rows()),
  }),
  projectionClean: defineRoute('projectionClean', {
    slice: 'removal',
    purity: 'chained',
    read: 'raw',
    response: 'json',
    // 写动作：按 raw 清册行 + 回收站目录现扫，不对账、不改写清册；必须进到达序链。
    run: async (deps, _body, read) => cleanProjectionCacheOrphans(deps, await read.rows()),
  }),
  orphans: defineRoute('orphans', {
    slice: 'core',
    purity: 'pure',
    read: 'raw',
    response: 'json',
    // 纯读：语料 + 清册 raw 索引，量「父既不在语料也不在回收站」的组字节，不动任何字节。
    // 清理走 `/apply` 的 `orphan-clean`（先对账再扫，写动作必须进链）。
    run: async (deps, _body, read) => reportOrphans(await loadOrphanGroups(deps, await read.rows())),
  }),
  apply: defineRoute('apply', {
    slice: 'full',
    purity: (body) => {
      // 与字段闸同一个识别器：认不得的动作判 chained，交给 run 响亮拒掉。
      const action = actionOf(body)
      return action === undefined ? 'chained' : APPLY_ACTION_TABLE[action]
    },
    read: 'none',
    response: 'json',
    // `count` 不碰清册也不动文件，和详情一样走豁免；其余五个是写动作，必须排在链上。
    // 写动词的读面归动词自己（谁写谁读），路由只在读动作上选面。
    run: async (deps, body) => {
      const fields = parseBody(body, BODY_GROUPS.apply)
      return applyActions(deps, fields.action, fields.ids)
    },
  }),
  empty: defineRoute('empty', {
    slice: 'removal',
    purity: 'chained',
    read: 'list',
    response: 'json',
    // 清空回收站：聚合回执，不按条回——这是它单独一段的理由。**先对账再清**：手工搬进
    // `session-trash/` 的那一格清册里还没有行，只按 raw 索引清会留下点不开的目录。
    run: async (deps, _body, read) => {
      // 直接把这一份当快照交进清册作用域，一次 purgeAll() 清空；删除能力按调用点注入。
      return await createTrashScope(deps, await read.rows(), (plan) => executeRemoval(deps, plan)).purgeAll()
    },
  }),
  detail: defineRoute('detail', {
    slice: 'core',
    purity: 'pure',
    read: 'raw',
    response: 'json',
    // 读单条详情走 POST：字段栅栏、请求栅栏与错误映射都挂同一张路由表（ADR-0004）。
    // 读清册 raw 索引、不对账：pure 不进链，行在 raw 里而目录不在时详情自己判 io。
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
    // 纯读：归档集 ∩ 语料一次算好；`sessionQuery` 缺席由装配层折成 `{available:false}`。
    run: async (deps) => assembleArchiveRows(deps),
  }),
  archiveDetail: defineRoute('archiveDetail', {
    slice: 'core',
    purity: 'pure',
    read: 'none',
    response: 'json',
    // 寻址只认 `sessionId`；目标自己已归档，或是 `rootSessionId` 那条已归档会话的闭包成员。
    // 栅栏与 `/detail` 同一套，字段组多一格可选 `rootSessionId`。
    run: async (deps, body) => {
      const fields = parseBody(body, BODY_GROUPS.sessionId)
      return readArchiveDetail(deps)(fields.sessionId, fields.before, fields.rootSessionId)
    },
  }),
})

/** 段名 → 那一行；不认识的段名回 `undefined`。必须问 `Object.hasOwn`：`constructor` 这类
 *  原型属性名会从索引读里「查到」一个函数，把未知路径判成已知路由。 */
export function routeOf(rest: string): RouteSpec | undefined {
  if (!Object.hasOwn(ROUTE_TABLE, rest)) return undefined
  return (ROUTE_TABLE as Record<string, RouteSpec | undefined>)[rest]
}
