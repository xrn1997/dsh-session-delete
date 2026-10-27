/**
 * 插件设置页「维护」卡的手动编排：孤儿会话 + 孤儿附件，各一组读数、提示与动作。
 *
 * 三条承重规矩：
 * - **没有自动扫描**：本 module 不挂 `useEffect`、没有定时器；只有用户点「检查 / 查看并清理 / 清理」
 *   才发请求。挂载只交初始态（报告 `null` = 尚未检查）。
 * - **读不到就说读不到**：两份报告失败都回 `null` + 原文，不折成「没有发现」。
 * - **清理后必重查**：报告说的是"报告那一刻"的盘；清完立刻重读。回执里的中性 / 失败 / 部分计数
 *   先读出来、重查之后再上屏——重查成功会清掉旧提示，顺序反了会把这一趟的后果吞掉。
 *
 * 写动作走既有的两段：孤儿会话是 `/apply` 的 `orphan-clean`（回执判读复用 `receipt.ts` 的读法），
 * 孤儿附件是聚合的 `POST /attachment-clean`（回执就是 `AttachmentCleanupWire` 本身）。
 * 面板的 `useTrashQuery` 与本 hook 互不引用：维护卡是手动面，面板是挂载即读的清单面。
 */
import { useCallback, useState } from 'react'
import type { Translate } from './copy.js'
import { attachmentSkippedSentence, readReceipt, summarizeReceipt } from './receipt.js'
import {
  callRemote,
  type AttachmentCleanupWire,
  type AttachmentOrphanReportWire,
  type OrphanReportWire,
  type SessionDeleteRemote,
} from './remote.js'
import { createLatestWins } from './store.js'
import { fileSizeText } from './ui/format.js'

/** 维护卡只需要这四段：两份报告 + 孤儿会话的批量写 + 孤儿附件的聚合写。 */
export type MaintenanceDeps = Pick<
  SessionDeleteRemote,
  'scanOrphans' | 'applyOutcomes' | 'scanAttachmentOrphans' | 'cleanAttachmentOrphans'
>

/** 一段在飞的动作：检查只读，清理会写。状态行靠它分开说「检查中…」与「清理中…」；`null` = 空闲。 */
export type MaintenancePhase = 'scanning' | 'cleaning'

export interface Maintenance {
  /* ── 孤儿会话 ───────────────────────────────────────────── */
  readonly orphanReport: OrphanReportWire | null
  readonly orphanFailure: string | null
  /** 「这一组已经不在」不是失败：单独一条中性提示。 */
  readonly orphanNotice: string | null
  /** 上一趟孤儿会话清理顺带清掉的附件读数（`.dsh` 内独占图片副本）。重查读不出来，和
   *  `orphanNotice` 一样是过去那一趟的回执；下一次检查 / 清理会被收掉。 */
  readonly orphanAttachmentNotice: string | null
  readonly orphanConfirm: boolean
  readonly orphanBusy: boolean
  /** 在飞的是检查还是清理；`null` = 空闲。写动作在飞时状态行据此说「清理中…」。 */
  readonly orphanPhase: MaintenancePhase | null
  /** 手动检查（`GET /orphans`）。失败回 `null` + 原文，不折成零条。 */
  scanOrphans(): Promise<void>
  /** 「查看并清理」：先收掉旧提示再开确认框。 */
  openOrphanPreview(): void
  /** `/apply` 的 `orphan-clean`：清完必重查；中性 / 失败 / 部分计数按回执说。 */
  cleanOrphans(): Promise<void>
  setOrphanConfirm(open: boolean): void

  /* ── 孤儿附件 ───────────────────────────────────────────── */
  readonly attachmentReport: AttachmentOrphanReportWire | null
  readonly attachmentFailure: string | null
  /** 上一趟清理的回执（已清 / 跳过 / 逐文件失败），重查读不出来。 */
  readonly attachmentNotice: string | null
  readonly attachmentConfirm: boolean
  readonly attachmentBusy: boolean
  /** 在飞的是检查还是清理；`null` = 空闲。 */
  readonly attachmentPhase: MaintenancePhase | null
  /** 手动检查（`GET /attachment-orphans`）。 */
  scanAttachmentOrphans(): Promise<void>
  /** 「查看并清理」：先收掉旧提示再开确认框。 */
  openAttachmentPreview(): void
  /** `POST /attachment-clean`：清完必重查；`removed` / `failed` / `skipped` 按回执说。 */
  cleanAttachmentOrphans(): Promise<void>
  setAttachmentConfirm(open: boolean): void
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

export function useMaintenance({ deps, t }: { deps: MaintenanceDeps; t: Translate }): Maintenance {
  /* ── 孤儿会话：读数、提示、确认与忙碌 ───────────────────── */
  const [orphanReport, setOrphanReport] = useState<OrphanReportWire | null>(null)
  const [orphanFailure, setOrphanFailure] = useState<string | null>(null)
  const [orphanNotice, setOrphanNotice] = useState<string | null>(null)
  const [orphanAttachmentNotice, setOrphanAttachmentNotice] = useState<string | null>(null)
  const [orphanConfirm, setOrphanConfirm] = useState(false)
  const [orphanPhase, setOrphanPhase] = useState<MaintenancePhase | null>(null)
  const orphanBusy = orphanPhase !== null
  const [orphanLatest] = useState(createLatestWins)

  /**
   * 一次孤儿检查（不碰 busy / phase）。交回这张票是否仍是赢家：清理后的重查被后发的检查顶掉时，
   * 由赢家负责把读数与 busy 一起收尾，输家什么都不落地。
   */
  const rescanOrphans = useCallback(async (): Promise<boolean> => {
    const ticket = orphanLatest.issue()
    const outcome = await callRemote(() => deps.scanOrphans())
    if (!ticket.current) return false
    // 新一次检查是新的只读快照：上一趟清理的附件回执一起收掉，不冒充这一次的读数。
    setOrphanAttachmentNotice(null)
    if (!outcome.ok) {
      setOrphanReport(null)
      setOrphanNotice(null)
      setOrphanConfirm(false)
      setOrphanFailure(t('trash.orphans.failure', { message: outcome.failure.message }))
      return true
    }
    setOrphanReport(outcome.value)
    setOrphanFailure(null)
    setOrphanNotice(null)
    return true
  }, [deps, orphanLatest, t])

  const scanOrphans = useCallback(async (): Promise<void> => {
    setOrphanPhase('scanning')
    const current = await rescanOrphans()
    if (current) setOrphanPhase(null)
  }, [rescanOrphans])

  const cleanOrphans = useCallback(async (): Promise<void> => {
    const report = orphanReport
    if (report === null || report.roots.length === 0) {
      setOrphanConfirm(false)
      return
    }
    const roots = report.roots
    setOrphanPhase('cleaning')
    setOrphanFailure(null)
    setOrphanNotice(null)
    setOrphanAttachmentNotice(null)
    const outcome = await callRemote(() => deps.applyOutcomes('orphan-clean', roots))
    setOrphanConfirm(false)
    if (!outcome.ok) {
      // 没拿到回执：先重查（旧报告不再可信），再把这一趟的原文摆上去。
      const current = await rescanOrphans()
      if (!current) return
      setOrphanFailure(t('trash.orphans.failure', { message: outcome.failure.message }))
      setOrphanPhase(null)
      return
    }
    // 回执读法只住 `receipt.ts`：not-found 是 neutral，missing/io 是真失败，部分计数从 details 取。
    const { summary } = summarizeReceipt(readReceipt('orphan-clean', roots, outcome.value))
    // 重查先落地：它会在成功时清掉旧提示；这一趟的后果必须在它之后才摆。
    const current = await rescanOrphans()
    if (!current) return
    if (summary.neutralIds.length > 0) {
      setOrphanNotice(t('trash.orphans.cleanGone', { count: summary.neutralIds.length }))
    }
    if (summary.failed.length > 0) {
      const message = summary.failed[0]!.error.message
      const base = t('trash.orphans.cleanFailed', { count: summary.failed.length, message })
      const partial = summary.partial.removed > 0 || summary.partial.freedBytes > 0
        ? ` ${t('trash.orphans.cleanPartial', {
          removed: summary.partial.removed,
          size: fileSizeText(summary.partial.freedBytes),
        })}`
        : ''
      setOrphanFailure(`${base}${partial}`)
    }
    // 这一趟顺带清的图片副本也是用户要看见的后果：与孤儿附件段同一套回执句子。
    if (summary.attachmentCleanup !== undefined) {
      setOrphanAttachmentNotice(attachmentCleanupNotice(summary.attachmentCleanup, t))
    }
    setOrphanPhase(null)
  }, [deps, orphanReport, rescanOrphans, t])

  const openOrphanPreview = useCallback((): void => {
    setOrphanFailure(null)
    setOrphanNotice(null)
    setOrphanConfirm(true)
  }, [])

  /* ── 孤儿附件：读数、提示、确认与忙碌 ───────────────────── */
  const [attachmentReport, setAttachmentReport] = useState<AttachmentOrphanReportWire | null>(null)
  const [attachmentFailure, setAttachmentFailure] = useState<string | null>(null)
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null)
  const [attachmentConfirm, setAttachmentConfirm] = useState(false)
  const [attachmentPhase, setAttachmentPhase] = useState<MaintenancePhase | null>(null)
  const attachmentBusy = attachmentPhase !== null
  const [attachmentLatest] = useState(createLatestWins)

  const rescanAttachments = useCallback(async (): Promise<boolean> => {
    const ticket = attachmentLatest.issue()
    const outcome = await callRemote(() => deps.scanAttachmentOrphans())
    if (!ticket.current) return false
    if (!outcome.ok) {
      setAttachmentReport(null)
      setAttachmentNotice(null)
      setAttachmentConfirm(false)
      setAttachmentFailure(t('maintenance.attachments.scanFailed', { message: outcome.failure.message }))
      return true
    }
    setAttachmentReport(outcome.value)
    setAttachmentFailure(null)
    setAttachmentNotice(null)
    return true
  }, [attachmentLatest, deps, t])

  const scanAttachmentOrphans = useCallback(async (): Promise<void> => {
    setAttachmentPhase('scanning')
    const current = await rescanAttachments()
    if (current) setAttachmentPhase(null)
  }, [rescanAttachments])

  const cleanAttachmentOrphans = useCallback(async (): Promise<void> => {
    const report = attachmentReport
    if (report === null || report.count === 0) {
      setAttachmentConfirm(false)
      return
    }
    setAttachmentPhase('cleaning')
    setAttachmentFailure(null)
    setAttachmentNotice(null)
    const outcome = await callRemote(() => deps.cleanAttachmentOrphans())
    setAttachmentConfirm(false)
    // 清理成功后旧报告已经过期：先收掉，别让 106 挂在横幅上冒充"没清"；
    // 重查回来再落真实的 0/剩余数（若重查失败则走失败块，不保留旧读数）。
    if (outcome.ok && outcome.value.failed === 0 && outcome.value.skipped === undefined) {
      setAttachmentReport({ count: 0, totalBytes: 0, items: [] })
    }
    const current = await rescanAttachments()
    if (!current) return
    if (!outcome.ok) {
      // 清理顶层失败没有"件数"可说：本地化前缀 + 服务端原文（引用源读不出、盘上忙…）。
      setAttachmentFailure(t('maintenance.attachments.cleanError', { message: outcome.failure.message }))
      setAttachmentPhase(null)
      return
    }
    setAttachmentNotice(attachmentCleanupNotice(outcome.value, t))
    setAttachmentPhase(null)
  }, [attachmentReport, deps, rescanAttachments, t])

  const openAttachmentPreview = useCallback((): void => {
    setAttachmentFailure(null)
    setAttachmentNotice(null)
    setAttachmentConfirm(true)
  }, [])

  return {
    orphanReport,
    orphanFailure,
    orphanNotice,
    orphanAttachmentNotice,
    orphanConfirm,
    orphanBusy,
    orphanPhase,
    scanOrphans,
    openOrphanPreview,
    cleanOrphans,
    setOrphanConfirm,

    attachmentReport,
    attachmentFailure,
    attachmentNotice,
    attachmentConfirm,
    attachmentBusy,
    attachmentPhase,
    scanAttachmentOrphans,
    openAttachmentPreview,
    cleanAttachmentOrphans,
    setAttachmentConfirm,
  }
}
