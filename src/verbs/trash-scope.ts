import type { TrashEntry } from '../trash/entry.js'
import type { RemovalDeps } from '../deps.js'
import type { PurgeStatsWire } from '../shared/wire.js'
import { claimOf, withoutGroup } from '../trash/groups.js'
import { trashEmpty } from './errors.js'
import { loadOrphanGroups, type OrphanGroup } from './orphan-subagents.js'
import { executeRemoval, planTrashRemoval } from './permanent-removal.js'

/**
 * **清册作用域（trash scope）**：purge 这条写路径的「拿目标」owner。调用方把一份选好读面的清册
 * 快照交进来（写入口 = 真相读；报告入口不经作用域——`/orphans` 直接把 raw 快照交 `loadOrphanGroups`。
 * 选哪一格是路由行 / 批量层的事，ADR-0012 的边界不在这里翻），快照与**收缩视图**从此归本模块、
 * **不外露**：三态判据与按组收缩都仍读 `trash/groups.ts` 的 `claimOf` / `withoutGroup`，这里只**持有**
 * 那份视图，不抄第二遍判据。三个成员的输入输出以 `CONTEXT.md` 的「清册作用域」与下面各成员的
 * 注释为准，头注不重写一遍表面契约。
 *
 * 彻底删除：从回收站里**真的**抹掉一组（或整站），并连带那些"还留在盘上、没被带走"的后代。
 * **这里只做两件事：拿目标、把计划交给执行器**。量目录、筛盘上后代、活体准入与"先退归档集、
 * 再摘账本、最后删目录"的顺序都住 `verbs/permanent-removal.ts`——计划只读，执行器不再量、只在第一笔
 * 写前补一次只读的活体复查，计划是执行前的第一道闸（别在这里再长出一段手写步骤）。
 *
 * **不做回滚**：目录删掉就没有"退回去"这回事（删到一半失败时已删目录不回滚；带部分计数的
 * `details` 回执只属于 `orphan-clean`，purge 的 `removed` / `freedBytes` 仍只在成功回执里给）。
 * 对应地，`kind:'trash'` 的计划失败时执行器只抛那一步的 `io` 与原文、不带 details。
 *
 * 回执里的 `attachments` 原样来自执行器：独占图片在会话目录删完之后才清，附件失败只计数、不改
 * `removed` / `freedBytes`（`skipped` = 有候选或剩余引用源读不出、这一轮部分或整体没清，原因上屏）。
 * 「已被同批前一条带走」的幂等回执**不带** `attachments`——那一趟没有附件读数，缺席与 0 是两件事，
 * 不拿零冒充"清过"（与旧批量回执同形）。
 */
export interface TrashScope {
  /** purge 这一组；已被同批带走 ⇒ `{removed:0,freedBytes:0}`；absent（原始快照里就认不出）⇒
   *  `trash-empty`，原文点名 id。 */
  purge(id: string): Promise<PurgeStatsWire>
  /** 清空：全部行一组。 */
  purgeAll(): Promise<PurgeStatsWire>
  /** 点名根的无主组（根两边去 `session-` 前缀再比）；roots 缺席 = 全量。 */
  orphanGroups(roots?: readonly string[]): Promise<readonly OrphanGroup[]>
}

export function createTrashScope(deps: RemovalDeps, rows: readonly TrashEntry[]): TrashScope {
  // 原始快照（三态判据的"整批开始前的样子"）与会收缩的当前视图：`take` 过的那一组不再出现在里面。
  const original = rows
  let current = [...rows]

  /** 拿目标、把计划交给执行器：`targets` 缺席（`undefined`）= 清空。计划只读——活体准入在**一切写
   *  之前**（任一在跑就整条拒绝、零副作用）。盘上后代按**当前视图里还在的 id** 排除（跟着父进来的
   *  孩子不按"盘上残留"再删一遍）；`sessionQuery` 缺席时端口回 `{ available: false }` ⇒ 这次只清
   *  清册里的那部分，盘上残留留给 `GET /orphans` 兜底（与 delete 的降级一致，不折成失败）。 */
  async function purgeGroup(targets: readonly TrashEntry[] | undefined, requestedId?: string): Promise<PurgeStatsWire> {
    const selected = targets ?? current
    if (targets !== undefined && selected.length === 0) {
      throw trashEmpty(requestedId)
    }
    return await executeRemoval(deps, await planTrashRemoval(deps, current, selected))
  }

  /** 收缩是内部闭包、不外露：唯一的观察面是后续 `purge` / `purgeAll` / `orphanGroups` 看见的当前视图。 */
  const take = (id: string): void => {
    current = withoutGroup(current, id)
  }

  return {
    purge: async (id) => {
      const claim = claimOf(original, current, id)
      // 幂等只留给 carried；absent（用户点了条幽灵 id、或对账刚摘掉它）照样响亮报 trash-empty。
      if (claim.verdict === 'carried') return { removed: 0, freedBytes: 0 }
      const stats = await purgeGroup(claim.verdict === 'fresh' ? claim.group : [], id)
      // 清完才收缩（失败时视图不动，下一次重试还能看见这一组）。
      take(id)
      return stats
    },
    purgeAll: async () => {
      // `undefined` 是「清空」契约：空清册照样回 {removed:0}，不落进单条的 trash-empty。
      const stats = await purgeGroup(undefined)
      // 清空即收缩到底：同一 scope 上再接 purge 应走 carried 幂等，而不是把已清的行再清一遍。
      current = []
      return stats
    },
    orphanGroups: (roots) => loadOrphanGroups(deps, current, roots),
  }
}
