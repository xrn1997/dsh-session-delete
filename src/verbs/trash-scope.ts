import type { TrashEntry } from '../trash/entry.js'
import type { CoreDeps } from '../deps.js'
import type { PurgeStatsWire } from '../shared/wire.js'
import { createShrinkingView } from '../trash/shrinking-view.js'
import { trashEmpty } from '../errors.js'
import { planTrashRemoval, type RemovalExecutor } from './permanent-removal.js'

/**
 * **清册作用域**：purge 这条写路径的「拿目标」owner。调用方交进一份清册快照（报告与 orphan-clean 入口不经作用域），
 * 快照与**收缩视图实例**从此归本模块、**不外露**（持有机制住 `createShrinkingView`，判据仍住 `groups.ts`）。
 *
 * 彻底删除：这里只做两件事——拿目标、把计划交给执行器；删的能力**不在这个作用域手里**（收 `CoreDeps`，
 * 够不着 `removeDir`，执行器由调用方按调用点注入）。量目录、筛盘上后代、活体准入与「先退归档集、再摘账本、
 * 最后删目录」的顺序都住 `permanent-removal.ts`，别在这里再长出一段手写步骤。
 * **不做回滚**：目录删掉就没有退回去这回事；带部分计数的 `details` 回执只属于 `orphan-clean`。
 * 回执里的 `attachments` 原样来自执行器（附件失败只计数、不改 `removed`/`freedBytes`）；carried 幂等回执**不带**
 * `attachments`——那一趟没有读数，缺席与 0 是两件事。
 */
export interface TrashScope {
  /** purge 这一组；已被同批带走 ⇒ `{removed:0,freedBytes:0}`；absent（原始快照里就认不出）⇒
   *  `trash-empty`，原文点名 id。 */
  purge(id: string): Promise<PurgeStatsWire>
  /** 清空：全部行一组。 */
  purgeAll(): Promise<PurgeStatsWire>
}

export function createTrashScope(
  deps: CoreDeps,
  rows: readonly TrashEntry[],
  execute: RemovalExecutor,
): TrashScope {
  // 收缩视图的**实例**留在这份作用域里、不外露：唯一观察面是后续 `purge` 看见的当前视图。
  const view = createShrinkingView(rows)

  /** 拿目标、把计划交给执行器：`targets` 缺席（`undefined`）= 清空。计划只读——活体准入在**一切写之前**；
   *  盘上后代按**当前视图里还在的 id** 排除；`sessionQuery` 缺席时只清清册那部分，盘上残留留给 `GET /orphans` 兜底。 */
  async function purgeGroup(targets: readonly TrashEntry[] | undefined, requestedId?: string): Promise<PurgeStatsWire> {
    const current = view.view()
    const selected = targets ?? current
    if (targets !== undefined && selected.length === 0) {
      throw trashEmpty(requestedId)
    }
    return await execute(await planTrashRemoval(deps, current, selected))
  }

  return {
    purge: async (id) => {
      const claim = view.claim(id)
      // 幂等只留给 carried；absent（用户点了条幽灵 id、或对账刚摘掉它）照样响亮报 trash-empty。
      if (claim.verdict === 'carried') return { removed: 0, freedBytes: 0 }
      const stats = await purgeGroup(claim.verdict === 'fresh' ? claim.group : [], id)
      view.take(id)
      return stats
    },
    purgeAll: async () => {
      // `undefined` 是「清空」契约：空清册照样回 {removed:0}，不落进单条的 trash-empty。
      const stats = await purgeGroup(undefined)
      // 清空即收缩到底：同一 scope 上再接 purge 应走 carried 幂等，而不是把已清的行再清一遍。
      view.takeAll()
      return stats
    },
  }
}
