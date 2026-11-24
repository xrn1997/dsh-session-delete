import type { TrashEntry } from '../trash/entry.js'
import { createShrinkingView } from '../trash/shrinking-view.js'
import { type IdGroupClaim } from '../trash/groups.js'
import type { RemovalExecutor, RemovalPlan, RemovalStats } from './permanent-removal.js'

/**
 * **清册作用域**：purge 这条写路径的「拿目标」owner。调用方交进一份清册快照（报告与 orphan-clean 入口不经作用域），
 * 快照与**收缩视图实例**从此归本模块、**不外露**（持有机制住 `createShrinkingView`，判据仍住 `groups.ts`）。
 *
 * 批驱动面三件（一次批一扫的批驱动序第一步与执行步）：`claimAll` **输入序预裁决**——fresh 带整组 / carried / absent，
 * 演化循环住 `createShrinkingView` 的 `claimAll`（唯一一份，与 restore 的同批判据同一个家）；`runGroup` **只执行**
 * 一组的计划（计划由批驱动先做：一次批一扫要吃全部组的 `attachmentDirs`），**成功才**收缩视图——失败视图不动、
 * 下一轮还能认领（第二波补跑的前提）；`purgeAll` 全量一组只执行（批尾由 `/empty` 行驱动接）。
 *
 * 彻底删除：这里只做两件事——拿目标、把计划交给执行器；删的能力**不在这个作用域手里**（执行器由调用方按调用点注入，
 * 作用域连 `removeDir` 都够不着）。量目录、筛盘上后代、活体准入与「先退归档集、再摘账本、最后删目录」的顺序都住
 * `permanent-removal.ts`，别在这里再长出一段手写步骤。
 * **不做回滚**：目录删掉就没有退回去这回事；带部分计数的 `details` 回执只属于 `orphan-clean`。
 * 附件读数不在这一层：那是批级尾（`executeAttachmentTail`）的读数，由批驱动合成进逐条回执——carried 幂等回执
 * **不带** `attachments`，那一趟没有读数，缺席与 0 是两件事。
 */
export interface TrashScope {
  /** 一批 id 的输入序预裁决：`fresh` 带整组；carried / absent 没有组可交（判别联合不给误用的机会）。 */
  claimAll(ids: readonly string[]): readonly IdGroupClaim[]
  /** 把这一组的计划递交给执行器；**成功才**收缩视图（收缩面 = 计划里真删的行，不二次扩组）。 */
  runGroup(plan: RemovalPlan): Promise<RemovalStats>
  /** 清空：全部行当一组递进执行器；成功收缩到底（同一作用域再 claimAll 走 carried 幂等）。 */
  purgeAll(plan: RemovalPlan): Promise<RemovalStats>
}

export function createTrashScope(
  rows: readonly TrashEntry[],
  execute: RemovalExecutor,
): TrashScope {
  // 收缩视图的**实例**留在这份作用域里、不外露：唯一观察面是后续 `claimAll` 看见的当前视图。
  const view = createShrinkingView(rows)

  return {
    // 演化循环不在这里再抄一份：同批判据的唯一家住 `createShrinkingView` 的 `claimAll`（id 同条交回，不按下标配对）。
    claimAll: (ids) => view.claimAll(ids),
    runGroup: async (plan) => {
      const stats = await execute(plan)
      // 只摘掉本次计划实际删除的条目行：先子后父且子失败时，parent 自己的计划不含 kid，不能二次整组收缩误抹未删子。
      view.takeRows(plan.trash.map((row) => row.entry.id))
      return stats
    },
    purgeAll: async (plan) => {
      const stats = await execute(plan)
      view.takeAll()
      return stats
    },
  }
}
