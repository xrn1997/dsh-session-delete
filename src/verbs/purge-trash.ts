import type { TrashEntry } from '../trash/entry.js'
import type { RemovalDeps } from '../deps.js'
import { verbError } from './errors.js'
import { executeRemoval, planTrashRemoval } from './permanent-removal.js'

/**
 * 彻底删除：从回收站里**真的**抹掉一条（或整组、或整站），并连带那些"还留在盘上、没被带走"的后代。
 *
 * 与另外两个动词的关系（ADR-0002）：它的 interface 是"这一组目标 + 一份只读清册快照
 *（targets 缺席 = 清空）"；目标由 `verbs/batch-carried.ts` 按组语义算好，批量的"已被同批前一条
 * 带走"判据不在这里。`requestedId` 是唯一的例外参数，但它**不参与任何判据**：只是让
 * `trash-empty` 的原文点得出用户点的是哪一条（原文要上屏，点名承重），批量语义仍在批量层。
 *
 * **这条动词只做两件事：拿目标、把计划交给执行器**。量目录、筛盘上后代、活体准入与"先退归档集、
 * 再摘账本、最后删目录"的顺序都住 `verbs/permanent-removal.ts`——计划只读，执行器只写，计划就是
 * 执行前的闸（别在这里再长出一段手写步骤）。
 *
 * **这条动词不做回滚**：目录删掉就没有"退回去"这回事（2026-10-19 `f2a7757`：删到一半失败时已删目录不回滚；
 * 带部分计数的 `details` 回执只属于 `orphan-clean`，purge 的 `removed` / `freedBytes` 仍只在成功回执里给）。
 * 对应地，`kind:'trash'` 的计划失败时执行器只抛那一步的 `io` 与原文、不带 details。
 */
export function purgeTrash(deps: RemovalDeps) {
  return async function purgeTrash(
    /** 这一组（只读）；`undefined` = 清空。批量层由 `batch-carried.ts` 的 `claimOf` 给出，直调者
     *  按 `trash/groups.ts` 的 `groupOf` 自己算；ghost 父的组只有孩子（不含 `requestedId`），照样清
     *  这一组。 */
    targets: readonly TrashEntry[] | undefined,
    /** **只读**清册快照：批量层已经读过一次就递下来；收缩归 `batch-carried.ts`，动词不碰它。 */
    rows: readonly TrashEntry[],
    /** 只用于 `trash-empty` 的原文要点名用户点的那一条；不参与任何判据（批量语义归 `batch-carried.ts`）。 */
    requestedId?: string,
  ): Promise<{ removed: number; freedBytes: number }> {
    const selected = targets ?? rows
    if (targets !== undefined && selected.length === 0) {
      throw verbError('trash-empty', requestedId === undefined ? '回收站里没有这一条' : `回收站里没有这一条：${requestedId}`)
    }

    // 计划只读：活体准入在**一切写之前**（任一在跑就整条拒绝、零副作用）。盘上后代按**清册里还在的 id**
    // 排除（跟着父进来的孩子不按"盘上残留"再删一遍）；`sessionQuery` 缺席时端口回 `{ available: false }`
    // ⇒ 这次只清清册里的那部分，盘上残留留给 `GET /orphans` 兜底（与 delete 的降级一致，不折成失败）。
    return await executeRemoval(deps, await planTrashRemoval(deps, rows, selected))
  }
}
