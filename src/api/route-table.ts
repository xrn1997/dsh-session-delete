/**
 * 路由表（ADR-0004）：段名 → { 方法, 纯度, 读面, body, 处理 }。一条记录，两个消费者。
 *
 * 一致性要求：
 * - 该纯的判成写 ⇒ 探测/正文读/扫描被堵在串行链后；
 * - 该写的判成纯 ⇒ 写动作绕开到达序链，与对账交错；
 * - body 该读没读 ⇒ 下游拿到 null；读两遍 ⇒ 流已被消费。
 *
 * 这张表不放 shared/wire.ts：处理函数会 import 动词与 node:fs，而浏览器半要 import wire.ts。
 * 段名与动作仍住 wire.ts；这张表只回答“怎么处理”。
 */
import { PARAMS, ROUTES, type ApplyAction } from '../shared/wire.js'
import type { DeleteDeps } from '../deps.js'
import type { TrashEntry } from '../trash/entry.js'
import { applyActions } from '../verbs/batch.js'
import { routeError } from '../verbs/errors.js'
import { reportOrphans, loadOrphanGroups } from '../verbs/orphan-subagents.js'
import { purgeTrash } from '../verbs/purge-trash.js'
import { readTrashDetail } from '../trash/detail.js'
import { cleanOrphanImageAttachments } from '../trash/attachments.js'
import { readAttachmentResponse } from './attachment.js'
import { reportAttachmentOrphans } from './attachment-orphans.js'
import { assembleTrashRows } from './trash-rows.js'

/** 请求体：`json` 才读下来（GET 一律不读；读两遍会把流消费掉）。 */
export type BodyKind = 'none' | 'json'
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

export interface RouteSpec {
  readonly method: 'GET' | 'POST'
  readonly body: BodyKind
  readonly purity: Purity
  readonly read: ReadKind
  /** 响应形态：`json` 走信封（`{ok:true,value}`）；`binary` 直接把处理函数的 `BinaryResponse` 写出去。 */
  readonly response: 'json' | 'binary'
  run(deps: DeleteDeps, body: JsonBody, read: RouteRead, query: URLSearchParams): Promise<unknown>
}

/** 必填的非空字符串字段（缺、空串、类型不对都是**同一句话**：说清是哪个字段）。 */
function requireString(body: JsonBody, field: string): string {
  const value = body?.[field]
  if (typeof value !== 'string' || value === '') {
    throw routeError('bad-request', 400, `请求体需带非空字符串字段 ${field}`)
  }
  return value
}

/** `/detail` 的分页游标：缺省 = 从尾部取；给了就必须是非负整数（负数、小数、字符串都算请求不对）。 */
function optionalCursor(body: JsonBody): number | undefined {
  const value = body?.[PARAMS.before]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw routeError('bad-request', 400, `请求体字段 ${PARAMS.before} 需是非负整数`)
  }
  return value
}

/**
 * `/apply` 的五个动作与各自的**静态纯度**。一张表两个用途：动作名单由键派生，纯度也从同一格读——
 * 新增动作必须同时给出纯度，漏了编译不过；新加一个纯读动作也不会再静默落进 `chained`。
 */
const APPLY_ACTION_TABLE = {
  delete: 'chained',
  restore: 'chained',
  purge: 'chained',
  count: 'pure',
  'orphan-clean': 'chained',
} satisfies Record<ApplyAction, 'pure' | 'chained'>

export const APPLY_ACTIONS = Object.keys(APPLY_ACTION_TABLE) as readonly ApplyAction[]

/** 认不认得这个动作：`/apply` 的纯度与拒否共用同一条判据，名单只有上面那一张。 */
function isApplyAction(value: unknown): value is ApplyAction {
  return typeof value === 'string' && Object.hasOwn(APPLY_ACTION_TABLE, value)
}

/** `/apply` 的动作：认不得的一律点名拒掉，不折成"空批量"糊弄过去。 */
function requireAction(body: JsonBody): ApplyAction {
  const value = body?.[PARAMS.action]
  if (!isApplyAction(value)) {
    throw routeError('bad-request', 400, `批量动作不认识：需是 ${APPLY_ACTIONS.join(' / ')} 之一`)
  }
  return value
}

/** `/apply` 的 id 组：必须是非空字符串数组（空数组不是"什么都不做"，是调用方自己没组好）。 */
function requireIdArray(body: JsonBody): string[] {
  const value = body?.[PARAMS.ids]
  if (!Array.isArray(value) || value.length === 0 || value.some(id => typeof id !== 'string' || id === '')) {
    throw routeError('bad-request', 400, `请求体需带 ${PARAMS.ids}：非空字符串组成的非空数组`)
  }
  return value as string[]
}

/**
 * 九个段名各一行。`Record<段名, RouteSpec>` 是闸：`wire.ts` 加了段名而这里没加，编译不过。
 */
export const ROUTE_TABLE: Record<(typeof ROUTES)[keyof typeof ROUTES], RouteSpec> = {
  [ROUTES.list]: {
    method: 'GET',
    body: 'none',
    purity: 'chained',
    read: 'list',
    response: 'json',
    // 「读清单」=「对账 + 读」：语义归 `src/trash/ledger.ts` 的 `list()`（清单以 `session-trash/` 里的目录为准）。
    // 读面由这一行选好，处理函数只消费 `read`，不再自己挑 `list()` / `raw()`。
    run: async (deps, _body, read) => assembleTrashRows(deps, await read.rows()),
  },
  [ROUTES.ping]: {
    method: 'GET',
    body: 'none',
    purity: 'pure',
    read: 'none',
    response: 'json',
    // 客户端探测专用的最便宜一问：不碰清册、不碰盘、不进链。它的**信封**就是答案（"路由在、
    // 依赖接上了、映射生效了"），不是清单里此刻有几条——拿它当健康检查等于每次页面加载都跑一遍对账。
    run: async () => 'pong',
  },
  [ROUTES.attachment]: {
    method: 'GET',
    body: 'none',
    purity: 'pure',
    read: 'none',
    response: 'binary',
    // 全仓唯一的二进制段：读宿主附件库里的一个文件（图片 / 普通文件），不碰清册、不排队。
    // 闸（id / kind / 20 MiB / 魔数）都住 `src/api/attachment.ts`；这里只声明"它怎么被处理"。
    run: async (deps, _body, _read, query) => readAttachmentResponse(deps, query),
  },
  [ROUTES.attachmentOrphans]: {
    method: 'GET',
    body: 'none',
    purity: 'pure',
    read: 'none',
    response: 'json',
    // 纯读：扫活动会话 + 全部回收站目录 + storages/cache 的图片引用，再对附件库 `objects` 列表；
    // 回数量/字节 + 供预览的对象清单，不碰清册、不进链。引用源读不出 ⇒ 处理函数抛 io（不折成 0）。
    run: async (deps) => reportAttachmentOrphans(deps),
  },
  [ROUTES.attachmentClean]: {
    method: 'POST',
    body: 'none',
    purity: 'chained',
    read: 'none',
    response: 'json',
    // 写动作：先扫引用源（决定删哪些），再逐文件删；必须排在到达序链上，不能与删除/清空交错。
    // 不读清册（read: none）——孤儿附件与回收站行无关，`AttachmentCleanupWire` 原样回执。
    run: async (deps) => cleanOrphanImageAttachments(deps),
  },
  [ROUTES.orphans]: {
    method: 'GET',
    body: 'none',
    purity: 'pure',
    read: 'raw',
    response: 'json',
    // 纯读的 `/orphans` 段：扫语料（`sessionQuery.listSessions`，live ∪ 持久化）+ 读清册 **raw 索引**，把"父既不在
    // 语料也不在回收站"的那些组量一遍字节。**不动任何一个字节**（不对账、不写行），也不排队。
    // 清理走 `/apply` 的 `orphan-clean`：那条先对账再扫（写动作必须排在到达序链上）。
    run: async (deps, _body, read) => reportOrphans(await loadOrphanGroups(deps, await read.rows())),
  },
  [ROUTES.apply]: {
    method: 'POST',
    body: 'json',
    purity: (body) => {
      const action = body?.[PARAMS.action]
      return isApplyAction(action) ? APPLY_ACTION_TABLE[action] : 'chained'
    },
    read: 'none',
    response: 'json',
    // `count` 不碰清册也不动文件（它问的是**还在盘上**的会话），和详情一样走豁免；
    // 其余四个都是写动作（`delete` / `restore` / `purge` / `orphan-clean`）——前三个动清册，
    // `orphan-clean` 先对账、再摘归档/账本并删盘上那些没有清册行的目录——都必须排在链上。
    // 写动词的读面归动词自己（谁写谁读），路由只在读动作上选面。
    run: async (deps, body) => applyActions(deps, requireAction(body), requireIdArray(body)),
  },
  [ROUTES.empty]: {
    method: 'POST',
    body: 'none',
    purity: 'chained',
    read: 'list',
    response: 'json',
    // 清空回收站：聚合回执，不按条回——这是它与 `/apply` 唯一的区别，也是它单独一段的理由。
    // **先对账再清**：手工搬进 `session-trash/` 的那一格在清册里还没有行，只按 raw 索引清就会
    // 在它走后仍留一个点不开的目录；`read` 交回的那一份就是"这里此刻真的有的一切"。
    run: async (deps, _body, read) => {
      // 直接把这一份当快照递给 purge，不再读第二遍清册。
      const rows = await read.rows()
      return await purgeTrash(deps)(undefined, rows)
    },
  },
  [ROUTES.detail]: {
    method: 'POST',
    body: 'json',
    purity: 'pure',
    read: 'raw',
    response: 'json',
    // 读单条详情也走 POST：`requireString`、请求栅栏、错误映射这一整套都挂在同一张路由表上
    // （`body:'json'` 决定它在处理前预读一次请求体）；改成 GET query 只是把同一道栅栏再写一遍
    // （栅栏只写一遍——段名的方法 / 纯度 / 读面 / body 就住这张表，ADR-0004）。
    // 读的是清册 **raw 索引**（`read` 的 raw 面），**不对账**：本段声明为 pure、不进到达序链，而对账会写
    // 清册行（写动作必须排在链上）。行在 raw 里而目录不在时详情自己判 `io`，不靠对账把行摘掉。
    run: async (deps, body, read) =>
      readTrashDetail({ fs: deps.fs, rows: () => read.rows(), home: deps.home })(
        requireString(body, PARAMS.entryId),
        optionalCursor(body),
      ),
  },
}

/** 段名 → 那一行；不认识的段名回 `undefined`（调用方抛 404，并带出原路径）。 */
export function routeOf(rest: string): RouteSpec | undefined {
  return (ROUTE_TABLE as Record<string, RouteSpec | undefined>)[rest]
}
