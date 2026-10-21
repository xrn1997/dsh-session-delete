import type { TrashEntry } from '../trash/entry.js'
import { groupOf } from '../trash/groups.js'
import type { CoreDeps } from '../deps.js'
import { verbError } from './errors.js'
import { executeRemoval, planTrashRemoval } from './permanent-removal.js'

/**
 * 彻底删除：从回收站里**真的**抹掉一条（或整组、或整站），并连带那些"还留在盘上、没被带走"的后代。
 *
 * 与另外两个动词的关系（ADR-0002）：它的 interface 只有"一个条目 id（或缺席 = 清空）"，
 * 批量的快照与"已被同批前一条带走"的判据不在这里（归 `verbs/batch.ts`）。
 *
 * **这条动词只做两件事：选目标、拿计划交给执行器**。量目录、筛盘上后代、活体准入与"先退归档集、
 * 再摘账本、最后删目录"的顺序都住 `verbs/permanent-removal.ts`——计划只读，执行器只写，计划就是
 * 执行前的闸（别在这里再长出一段手写步骤）。
 *
 * **这条动词不做回滚**：目录删掉就没有"退回去"这回事（2026-10-19 `f2a7757`：删到一半失败时已删目录不回滚；
 * 带部分计数的 `details` 回执只属于 `orphan-clean`，purge 的 `removed` / `freedBytes` 仍只在成功回执里给）。
 * 对应地，`kind:'trash'` 的计划失败时执行器只抛那一步的 `io` 与原文、不带 details。
 */
export function purgeTrash(deps: CoreDeps) {
  return async function purgeTrash(
    entryId?: string,
    /** **只读**清册快照：批量层已经读过一次就递下来（ADR-0002）；收缩归批量层，动词不碰它。 */
    snapshot?: readonly TrashEntry[],
  ): Promise<{ removed: number; freedBytes: number }> {
    const all = snapshot ?? await deps.manifest.list()
    // 点的是父那一行 ⇒ **整组**一起清（孩子是跟着父进来的，不该在父被彻底删除后单独留在回收站里）；
    // 点的是孩子那一行（清单不单独列它，只有手工/降级路径会走到）⇒ 只清它这一棵（含它的盘上后代）。
    // 「这一组有谁」读 `trash/groups.ts`（ADR-0001）——与 `/list` 的装配、与恢复、与批量幂等判据同一条判据。
    const targets: readonly TrashEntry[] = entryId === undefined ? all : groupOf(all, entryId)
    if (entryId !== undefined && targets.length === 0) throw verbError('trash-empty', `回收站里没有这一条：${entryId}`)

    // 计划只读：活体准入在**一切写之前**（任一在跑就整条拒绝、零副作用）。盘上后代按**全部清册 id**
    // 排除（跟着父进来的孩子不按"盘上残留"再删一遍）；`sessionQuery` 缺席时端口回 `{ available: false }`
    // ⇒ 这次只清清册里的那部分，盘上残留留给 `GET /orphans` 兜底（与 delete 的降级一致，不折成失败）。
    return await executeRemoval(deps, await planTrashRemoval(deps, all, targets, { admission: 'live' }))
  }
}
