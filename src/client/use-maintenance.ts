/**
 * 插件设置页「维护」卡的手动编排：孤儿会话 + 孤儿附件两段。
 *
 * 状态机本身（报告 / 失败 / 中性提示 / 确认框 / 在飞档位 / 最新票 / 清完必重查）收在
 * `src/client/use-maintenance-section.ts` 的泛型段 module 里，两段各实例化一次；这一层只剩薄 glue：
 * 各段自己的远程调用、"没活可干"的判据与回执拼句。三条承重规矩（没有自动扫描 / 挂载只交初始态 /
 * 没有定时器）由段 module 保证，这一层同样不挂 effect。
 *
 * 写动作走既有的两段：孤儿会话是 `/apply` 的 `orphan-clean`（回执判读复用 `receipt.ts` 的读法），
 * 孤儿附件是聚合的 `POST /attachment-clean`（回执就是 `AttachmentCleanupWire` 本身）。
 * 面板的 `useTrashQuery` 与本 hook 互不引用：维护卡是手动面，面板是挂载即读的清单面。
 */
import { useState } from 'react'
import type { Translate } from './copy.js'
import { attachmentSkippedSentence, readReceipt, summarizeReceipt, type ReceiptSummary } from './receipt.js'
import {
  callRemote,
  type AttachmentCleanupWire,
  type AttachmentOrphanReportWire,
  type OrphanReportWire,
  type SessionDeleteRemote,
} from './remote.js'
import type { ApplyOutcome } from '../shared/wire.js'
import { fileSizeText } from './ui/format.js'
import { useMaintenanceSection, type MaintenanceSectionView } from './use-maintenance-section.js'

/** 维护卡只需要这四段：两份报告 + 孤儿会话的批量写 + 孤儿附件的聚合写。 */
export type MaintenanceDeps = Pick<
  SessionDeleteRemote,
  'scanOrphans' | 'applyOutcomes' | 'scanAttachmentOrphans' | 'cleanAttachmentOrphans'
>

export interface Maintenance {
  /** 孤儿会话段 + 它独有的第二回执：这一趟清理顺带清掉的附件读数（`.dsh` 内独占图片副本）。
   *  重查读不出来，和段的 `notice` 一样是过去那一趟的回执；下一次检查 / 清理会被收掉。 */
  readonly orphans: MaintenanceSectionView<OrphanReportWire> & { readonly attachmentNotice: string | null }
  readonly attachments: MaintenanceSectionView<AttachmentOrphanReportWire>
}

/**
 * 附件清理回执 → 一句上屏的话。跳过半句与面板共用同一判据（`receipt.ts` 的
 * `attachmentSkippedSentence`），这里只接非跳过的后半句：
 * - 有逐文件失败：未清件数与已清件数都在句里。
 * - 全清干净且没有失败：只说清了几件；一件都没动就是 `null`（不拿"清了 0 件"占一行）。
 */
function attachmentCleanupNotice(a: AttachmentCleanupWire, t: Translate): string | null {
  const skipped = attachmentSkippedSentence(a, t)
  if (skipped !== null) return skipped
  if (a.failed > 0) {
    return t('maintenance.attachments.cleanFailed', { count: a.failed, removed: a.removed })
  }
  return a.removed > 0
    ? t('maintenance.attachments.cleaned', { count: a.removed, size: fileSizeText(a.freedBytes) })
    : null
}

/** orphan-clean 回执里的"没清成"句：服务端原文 + 部分计数（"删了一半才炸"的那部分释放量）。
 *  首条失败由调用方在判过非空之后作为参数交进来——签名因此写明前提，函数体不必再赌 `failed[0]` 在。 */
function orphanCleanFailureSentence(
  summary: ReceiptSummary,
  first: ReceiptSummary['failed'][number],
  t: Translate,
): string {
  const message = first.error.message
  const base = t('trash.orphans.cleanFailed', { count: summary.failed.length, message })
  const partial = summary.partial.removed > 0 || summary.partial.freedBytes > 0
    ? ` ${t('trash.orphans.cleanPartial', {
      removed: summary.partial.removed,
      size: fileSizeText(summary.partial.freedBytes),
    })}`
    : ''
  return `${base}${partial}`
}

export function useMaintenance({ deps, t }: { deps: MaintenanceDeps; t: Translate }): Maintenance {
  /* ── 孤儿会话段：`GET /orphans` 读 + `/apply` 的 `orphan-clean` 写 ─────────── */
  const [orphanAttachmentNotice, setOrphanAttachmentNotice] = useState<string | null>(null)
  const orphans = useMaintenanceSection<OrphanReportWire, ApplyOutcome[]>({
    scan: async () => {
      // 新一次检查是新的只读快照：上一趟清理顺带清掉的附件回执一起收掉，不冒充这一次的读数。
      setOrphanAttachmentNotice(null)
      return callRemote(() => deps.scanOrphans())
    },
    clean: (report) => {
      if (report.roots.length === 0) return null
      setOrphanAttachmentNotice(null)
      return callRemote(() => deps.applyOutcomes('orphan-clean', report.roots))
    },
    scanFailureText: (message) => t('trash.orphans.failure', { message }),
    settle: (outcome, report) => {
      if (!outcome.ok) {
        return { failure: t('trash.orphans.failure', { message: outcome.failure.message }) }
      }
      // 回执判读只住 `receipt.ts`（三态判读与 partial 的累加语义都在那里）；这里只消费摘要。
      // 请求名单用**这一趟**点击那一刻的报告：状态机把它随回执一起交回来，段不自存"最近一次的名单"。
      const { summary } = summarizeReceipt(readReceipt('orphan-clean', report.roots, outcome.value))
      // 这一趟顺带清的图片副本也是用户要看见的后果：与孤儿附件段同一套回执句子。
      if (summary.attachmentCleanup !== undefined) {
        setOrphanAttachmentNotice(attachmentCleanupNotice(summary.attachmentCleanup, t))
      }
      const plan: { notice?: string; failure?: string } = {}
      if (summary.neutralIds.length > 0) {
        plan.notice = t('trash.orphans.cleanGone', { count: summary.neutralIds.length })
      }
      const firstFailed = summary.failed[0]
      if (firstFailed !== undefined) plan.failure = orphanCleanFailureSentence(summary, firstFailed, t)
      return plan
    },
  })

  /* ── 孤儿附件段：`GET /attachment-orphans` 读 + 聚合的 `POST /attachment-clean` 写 ── */
  const attachments = useMaintenanceSection<AttachmentOrphanReportWire, AttachmentCleanupWire>({
    scan: () => callRemote(() => deps.scanAttachmentOrphans()),
    clean: (report) => (report.count === 0 ? null : callRemote(() => deps.cleanAttachmentOrphans())),
    beforeRescan: (outcome) => {
      if (!outcome.ok) return null
      // 清理成功后旧报告已经过期：重查还在飞时先收成 0，别让旧横幅冒充"没清"；
      // 重查回来再落真实的 0/剩余数（若重查失败则走失败块，不保留旧读数）。
      const receipt = outcome.value
      return receipt.failed === 0 && receipt.skipped === undefined
        ? { count: 0, totalBytes: 0, items: [] }
        : null
    },
    scanFailureText: (message) => t('maintenance.attachments.scanFailed', { message }),
    settle: (outcome) => outcome.ok
      // 清理顶层失败没有"件数"可说：本地化前缀 + 服务端原文（引用源读不出、盘上忙…）。
      ? { notice: attachmentCleanupNotice(outcome.value, t) }
      : { failure: t('maintenance.attachments.cleanError', { message: outcome.failure.message }) },
  })

  return { orphans: { ...orphans, attachmentNotice: orphanAttachmentNotice }, attachments }
}
