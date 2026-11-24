/**
 * 清空回收站（`POST /empty`）的批驱动：全量一组 = 计划 → 一次批一扫 → 执行（逐行 tick）→ 批尾附件尾。
 *
 * 为什么住 verbs：这是与 `runPurgeBatch` 同构的一整段业务顺序（ADR-0070），路由表只回答「怎么处理」，
 * 不拥有批的驱动序。失败面也与批驱动同构——执行中途失败不回滚目录本身，批尾照走（只带走真删掉目录的独占
 * 副本）；原错误照抛，尾自己的失败并进 `details.rollbackFailures`，不掩盖原错误。k/N 按回收站行 tick：
 * `onRowDone` 随执行器注入，成功与失败行都各一次；`/apply` 按条目 tick 自己的进度、不传这个钩子，杜绝双计。
 */
import type { RemovalDeps } from '../deps.js'
import type { AttachmentCleanupWire } from '../shared/wire.js'
import type { TrashEntry } from '../trash/entry.js'
import { rollbackReason, withRollbackFailures } from '../errors.js'
import { planBatchImageAttachmentRemoval } from '../trash/attachments.js'
import {
  executeAttachmentTail,
  executeRemoval,
  planTrashRemoval,
  type AttachmentTailResult,
} from './permanent-removal.js'
import { createTrashScope } from './trash-scope.js'
import { writeProgress } from './write-progress.js'

/** `/empty` 的聚合回执（不按条回）：清掉的条数与字节 + 批尾附件读数。 */
export interface EmptyBatchResult {
  readonly removed: number
  readonly freedBytes: number
  readonly attachments: AttachmentCleanupWire
}

export async function runEmptyBatch(deps: RemovalDeps, rows: readonly TrashEntry[]): Promise<EmptyBatchResult> {
  // 清空一趟也报进度：身份就是当时那些行的 id、总数 = 当时行数，落定必回 idle。
  writeProgress.begin('empty', rows.map((row) => row.id), rows.length)
  try {
    const scope = createTrashScope(rows, (plan) => executeRemoval(deps, plan, { onRowDone: () => writeProgress.advance() }))
    const plan = await planTrashRemoval(deps, rows, rows)
    const batch = await planBatchImageAttachmentRemoval(deps, [{ id: 'empty', dirs: plan.attachmentDirs }])
    const outcome = await scope.purgeAll(plan).then(
      (stats) => ({ ok: true as const, stats }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    let tail: AttachmentTailResult
    try {
      tail = await executeAttachmentTail(deps, batch)
    } catch (tailError) {
      throw outcome.ok ? tailError : withRollbackFailures(outcome.error, [rollbackReason('附件尾失败', tailError)])
    }
    if (!outcome.ok) throw outcome.error
    return { removed: outcome.stats.removed, freedBytes: outcome.stats.freedBytes, attachments: tail.run }
  } finally {
    writeProgress.finish()
  }
}
