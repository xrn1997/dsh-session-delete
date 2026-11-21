/** 孤儿附件的报告段（`GET /attachment-orphans`）：数量/字节 + 预览对象清单（条数由 `orphanPreviewLimit` 限）。
 *  扫描跳过时**报告必须失败**——回 0 会让界面说「没有孤儿」，而这类失败是「不知道」。
 *  清理走 `POST /attachment-clean`，路由直接接 `cleanOrphanImageAttachments`。 */
import { scanOrphanImageAttachments, type AttachmentReadDeps } from '../trash/attachments.js'
import type { SessionDeleteConfig } from '../config.js'
import type { AttachmentOrphanReportWire } from '../shared/wire.js'
import { verbError } from '../errors.js'

/** 报告比扫描多读一只旋钮（预览条数）；扫描本体仍只认 `maxJsonRefBytes`。 */
export interface AttachmentOrphanReportDeps extends AttachmentReadDeps {
  config: AttachmentReadDeps['config'] & Pick<SessionDeleteConfig, 'orphanPreviewLimit'>
}

export async function reportAttachmentOrphans(deps: AttachmentOrphanReportDeps): Promise<AttachmentOrphanReportWire> {
  const plan = await scanOrphanImageAttachments(deps)
  if (plan.skipped !== undefined) throw verbError('io', plan.skipped)
  const limit = deps.config.orphanPreviewLimit
  return {
    count: plan.entries.length,
    totalBytes: plan.bytes,
    items: plan.entries
      .slice(0, limit)
      .map((entry) => ({ attachmentId: entry.id, bytes: entry.bytes })),
  }
}
