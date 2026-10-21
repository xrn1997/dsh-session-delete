/**
 * **路由表**（ADR-0004）：段名 → `{ 方法, 纯度, body, 处理 }`。一条记录，两个消费者。
 *
 * 此前"同一条请求该过哪几道判断"的知识散在两个函数里：`dispatch()` 里六个 `if` 各调一次
 * `requireMethod`，`purityOf()` 里另一组 `if` 决定"要不要进到达序链"，两处靠**注释**维持一致。
 * 不一致的两种后果都不好在测试里撞见：
 * - 该纯的判成写 ⇒ 一次探测/大正文读/扫描把删除按钮堵在串行链后面；
 * - 该写的判成纯 ⇒ 写动作绕开到达序链，与对账交错，回收站出现"目录在、行是降级元数据"的世界；
 * - body 该读没读 ⇒ 下游拿到 `null`；读了两遍 ⇒ 请求流已被消费（Node 的流只能消费一次）。
 *
 * 为什么这张表**不在** `shared/wire.ts`：处理函数会 import 动词与 `node:fs`，而浏览器半要 import
 * `wire.ts`——值 import 会把 Node 半拖进客户端 bundle，正好撞上 `tsdown` 的纯度门。段名与动作仍住
 * `wire.ts`（两半的共同契约），这张表只回答"怎么处理"。
 */
import { PARAMS, ROUTES, type ApplyAction } from '../shared/wire.js'
import type { DeleteDeps } from '../deps.js'
import { applyActions } from '../verbs/batch.js'
import { routeError } from '../verbs/errors.js'
import { reportOrphans, loadOrphanGroups } from '../verbs/orphan-subagents.js'
import { purgeTrash } from '../verbs/purge-trash.js'
import { readTrashDetail } from '../trash/detail.js'
import { reconcileTrash } from '../trash/reconcile.js'
import { assembleTrashRows } from './trash-rows.js'

/** 请求体：`json` 才读下来（GET 一律不读；读两遍会把流消费掉）。 */
export type BodyKind = 'none' | 'json'
/** 到达序：`pure` 不进链；`chained` 进链；函数形式给 `/apply` 用（`count` 是纯读）。 */
export type Purity = 'pure' | 'chained' | ((body: JsonBody) => 'pure' | 'chained')
type JsonBody = Record<string, unknown> | null

export interface RouteSpec {
  readonly method: 'GET' | 'POST'
  readonly body: BodyKind
  readonly purity: Purity
  run(deps: DeleteDeps, body: JsonBody): Promise<unknown>
}

/** 必填的非空字符串字段（缺、空串、类型不对都是**同一句话**：说清是哪个字段）。 */
function requireString(body: JsonBody, field: string): string {
  const value = body?.[field]
  if (typeof value !== 'string' || value === '') {
    throw routeError('bad-request', 400, `请求体需带非空字符串字段 ${field}`)
  }
  return value
}

/**
 * `/apply` 的五个动作。**运行期那张表由类型派生**：少一个动作编译不过、多一个也是——
 * 不再靠"两张表同进同退"的注释。
 */
const APPLY_ACTION_TABLE = {
  delete: true,
  restore: true,
  purge: true,
  count: true,
  'orphan-clean': true,
} satisfies Record<ApplyAction, true>

export const APPLY_ACTIONS = Object.keys(APPLY_ACTION_TABLE) as readonly ApplyAction[]

/** `/apply` 的动作：认不得的一律点名拒掉，不折成"空批量"糊弄过去。 */
function requireAction(body: JsonBody): ApplyAction {
  const value = body?.[PARAMS.action]
  if (typeof value !== 'string' || !(APPLY_ACTIONS as readonly string[]).includes(value)) {
    throw routeError('bad-request', 400, `批量动作不认识：需是 ${APPLY_ACTIONS.join(' / ')} 之一`)
  }
  return value as ApplyAction
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
 * 六个段名各一行。`Record<段名, RouteSpec>` 是闸：`wire.ts` 加了段名而这里没加，编译不过。
 */
export const ROUTE_TABLE: Record<(typeof ROUTES)[keyof typeof ROUTES], RouteSpec> = {
  [ROUTES.list]: {
    method: 'GET',
    body: 'none',
    purity: 'chained',
    // 「读清单」=「对账 + 读」：清单以 `session-trash/` 里的目录为准修回一致（口径见 `reconcile.ts`）
    run: async (deps) => assembleTrashRows(deps, await reconcileTrash(deps)),
  },
  [ROUTES.ping]: {
    method: 'GET',
    body: 'none',
    purity: 'pure',
    // 客户端探测专用的最便宜一问：不碰清册、不碰盘、不进链。它的**信封**就是答案（"路由在、
    // 依赖接上了、映射生效了"），不是清单里此刻有几条——拿它当健康检查等于每次页面加载都跑一遍对账。
    run: async () => 'pong',
  },
  [ROUTES.orphans]: {
    method: 'GET',
    body: 'none',
    purity: 'pure',
    // 纯读的第六段：扫语料（`sessionQuery.listSessions`，live ∪ 持久化）+ 读清册，把"父既不在语料也不在
    // 回收站"的那些组量一遍字节。**不动任何一个字节**，也不排队。清理走 `/apply` 的 `orphan-clean`。
    run: async (deps) => reportOrphans(await loadOrphanGroups(deps)),
  },
  [ROUTES.apply]: {
    method: 'POST',
    body: 'json',
    // `count` 不碰清册也不动文件（它问的是**还在盘上**的会话），和详情一样走豁免；
    // 其余四个都是写动作（`delete` / `restore` / `purge` / `orphan-clean`）——前三个动清册，
    // `orphan-clean` 先对账、再摘归档/账本并删盘上那些没有清册行的目录——都必须排在链上。
    purity: (body) => (body?.[PARAMS.action] === 'count' ? 'pure' : 'chained'),
    // 一组 id 上的同一个动作：单条就是长度为 1 的批量，逐条回结果。
    run: async (deps, body) => applyActions(deps, requireAction(body), requireIdArray(body)),
  },
  [ROUTES.empty]: {
    method: 'POST',
    body: 'none',
    purity: 'chained',
    // 清空回收站：聚合回执，不按条回——这是它与 `/apply` 唯一的区别，也是它单独一段的理由。
    // **先对账再清**（2026-10-19）：手工搬进 `session-trash/` 的那一格在清册里还没有行，只按清册清就会
    // 在它走后仍留一个点不开的目录；对账交回的那一份就是"这里此刻真的有的一切"。
    run: async (deps) => {
      // 对账交回的那一份就是"这里此刻真的有的一切"：直接当快照递给 purge，不再读第二遍清册。
      const rows = await reconcileTrash(deps)
      return await purgeTrash(deps)(undefined, rows)
    },
  },
  [ROUTES.detail]: {
    method: 'POST',
    body: 'json',
    purity: 'pure',
    // 读单条详情也走 POST：`requireString`、同源栅栏、错误映射这一整套都挂在同一张路由表上
    // （`body:'json'` 决定它在处理前预读一次请求体）；改成 GET query 只是把同一道栅栏再写一遍
    // （栅栏只写一遍——段名的方法 / 纯度 / body 就住这张表，ADR-0004）。
    run: async (deps, body) => readTrashDetail(deps)(requireString(body, PARAMS.entryId)),
  },
}

/** 段名 → 那一行；不认识的段名回 `undefined`（调用方抛 404，并带出原路径）。 */
export function routeOf(rest: string): RouteSpec | undefined {
  return (ROUTE_TABLE as Record<string, RouteSpec | undefined>)[rest]
}
