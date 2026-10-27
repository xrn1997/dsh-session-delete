/**
 * 孤儿附件的报告段：`GET /attachment-orphans`。
 *
 * 报告把扫描计划折成数量/字节 + 对象清单（`id`/`bytes`，供设置页预览缩略图；最多
 * `ORPHAN_PREVIEW_LIMIT` 条，清理不受预览条数限制）。扫描跳过（引用源或对象列表读不出）时
 * **报告必须失败**——回一份 0 会让界面说"没有孤儿"，而这类失败恰恰是"不知道"，不是"没有"。
 * 清理是 `POST /attachment-clean`，由路由直接接到 `cleanOrphanImageAttachments`。
 */
import { scanOrphanImageAttachments, type AttachmentReadDeps } from '../trash/attachments.js'
import type { AttachmentOrphanReportWire } from '../shared/wire.js'
import { verbError } from '../verbs/errors.js'

/** 预览清单的上限：与详情附件的载荷闸同一量级。数量与字节仍按全量报告。 */
const ORPHAN_PREVIEW_LIMIT = 200

export async function reportAttachmentOrphans(deps: AttachmentReadDeps): Promise<AttachmentOrphanReportWire> {
  const plan = await scanOrphanImageAttachments(deps)
  if (plan.skipped !== undefined) throw verbError('io', plan.skipped)
  return {
    count: plan.entries.length,
    totalBytes: plan.bytes,
    items: plan.entries
      .slice(0, ORPHAN_PREVIEW_LIMIT)
      .map((entry) => ({ attachmentId: entry.id, bytes: entry.bytes })),
  }
}
