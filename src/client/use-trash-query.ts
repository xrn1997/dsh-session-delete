/**
 * 清册读数与无主子会话的**取数编排**。
 *
 * 它从 `trash-panel.tsx` 的函数体里整块搬出来，连同三条承重规矩：
 * ① **到达序号**：在飞的 `list` / `orphans` 不保证按发起顺序落地（对账耗时随盘上条目数摆动），
 *    后到的旧响应不许盖掉刚发生的动作带来的新状态；
 * ② **先清单后扫描**：`GET /orphans` 判"父没了"吃的是清册，而清册要由 `/list` 那次对账才与
 *    `session-trash/` 的目录持平——反过来接，刚被手工搬进回收站的父会被报成失踪父；
 * ③ **读不到就说读不到**：`/orphans` 回 `sessiondelete/io` 是一次**失败的检查**，不许折成"零条残留"。
 *
 * 清理（`/apply` 的 `orphan-clean`）也住这里：它与扫描共用同一份报告与同一组提示，"读"与"写"分家
 * 会让 `busy` 与重读顺序那条判据劈成两半。`busy` 本身不归它管——那是面板的一枚全局闸，通过
 * `around` 传进来（`around` 里跑的就是"这一趟还算忙"）。
 */
import { useCallback, useRef, useState } from 'react'
import { callRemote, type OrphanReportWire, type SessionDeleteRemote, type TrashEntryLike } from './remote.js'
import { failureMessage, isFailureVerdict, readReceipt } from './receipt.js'
import type { Translate } from './copy.js'
import { fileSizeText } from './ui/format.js'

export type TrashQueryDeps = Pick<SessionDeleteRemote, 'list' | 'scanOrphans' | 'applyOutcomes' | 'emptyTrash'>

export interface TrashQuery {
  /** `null` = 还没读到（第一次读或读失败）；与"空的"是两件事。 */
  readonly entries: readonly TrashEntryLike[] | null
  readonly listFailure: string | null
  /** `null` = 还没扫到；失败时也置回 `null`（不拿空报告冒充干净）。 */
  readonly orphanReport: OrphanReportWire | null
  readonly orphanFailure: string | null
  /** 「这一组已经不在」不是失败：单独一条中性提示。 */
  readonly orphanNotice: string | null
  readonly orphanConfirm: boolean
  setOrphanConfirm(open: boolean): void
  /** 「查看并清理」：把上一条失败/中性提示清掉再开预览框（旧提示不该跟新一次预览并排出现）。 */
  openOrphanPreview(): void
  /** 交回**这一次读数是否真的落地**：孤儿扫描吃的是对账后的清册，清单没读成就不能扫。 */
  reload(): Promise<boolean>
  scanOrphans(): Promise<void>
  /** "重读一遍" = 先对账并读清单，再扫残留；清单没读成就不扫。 */
  refresh(): Promise<void>
  /** 清理那批无主子会话（一段 `/apply` 的第五个动作），逐条结果落成"已不在了 / N 组未清理"。 */
  cleanOrphans(): Promise<void>
  /** 清空回收站（聚合回执）：成功就重读，失败就把原文摆到清单那块。交回是否成功。 */
  emptyTrash(): Promise<boolean>
}

export function useTrashQuery({
  deps,
  t,
  around,
}: {
  deps: TrashQueryDeps
  t: Translate
  /** 把"这一趟还算忙"的一枚全局闸套在一次动作外（面板的 `busy`）。 */
  around: <T>(task: () => Promise<T>) => Promise<T>
}): TrashQuery {
  const [entries, setEntries] = useState<readonly TrashEntryLike[] | null>(null)
  const [listFailure, setListFailure] = useState<string | null>(null)
  const [orphanReport, setOrphanReport] = useState<OrphanReportWire | null>(null)
  const [orphanFailure, setOrphanFailure] = useState<string | null>(null)
  const [orphanNotice, setOrphanNotice] = useState<string | null>(null)
  const [orphanConfirm, setOrphanConfirm] = useState(false)

  const reloadSeq = useRef(0)
  const reload = useCallback(async (): Promise<boolean> => {
    const seq = ++reloadSeq.current
    const outcome = await callRemote(() => deps.list())
    if (seq !== reloadSeq.current) return false
    if (!outcome.ok) {
      setListFailure(outcome.failure.message)
      setEntries(null)
      return false
    }
    setListFailure(null)
    setEntries(outcome.value)
    return true
  }, [deps])

  const orphanScanSeq = useRef(0)
  const scanOrphans = useCallback(async (): Promise<void> => {
    const seq = ++orphanScanSeq.current
    const outcome = await callRemote(() => deps.scanOrphans())
    if (seq !== orphanScanSeq.current) return
    if (!outcome.ok) {
      setOrphanReport(null)
      setOrphanNotice(null)
      setOrphanConfirm(false)
      setOrphanFailure(t('trash.orphans.failure', { message: outcome.failure.message }))
      return
    }
    setOrphanReport(outcome.value)
    setOrphanFailure(null)
    setOrphanNotice(null)
  }, [deps, t])

  const refresh = useCallback(async (): Promise<void> => {
    const listed = await reload()
    if (!listed) {
      setOrphanReport(null)
      setOrphanFailure(null)
      setOrphanNotice(null)
      setOrphanConfirm(false)
      return
    }
    await scanOrphans()
  }, [reload, scanOrphans])

  const emptyTrash = useCallback((): Promise<boolean> => around(async () => {
    const outcome = await callRemote(() => deps.emptyTrash())
    if (!outcome.ok) {
      // 清空失败在这块界面上的落点就是"清单读不到"那一格：回收站此刻是什么样我们不知道
      setListFailure(outcome.failure.message)
      return false
    }
    await refresh()
    return true
  }), [around, deps, refresh])

  const cleanOrphans = useCallback((): Promise<void> => {
    if (orphanReport === null || orphanReport.roots.length === 0) {
      setOrphanConfirm(false)
      return Promise.resolve()
    }
    return around(async () => {
      setOrphanFailure(null)
      setOrphanNotice(null)
      const outcome = await callRemote(() => deps.applyOutcomes('orphan-clean', orphanReport.roots))
      setOrphanConfirm(false)
      // 先刷新再落提示：清完一批之后"还剩哪些残留"本身就是这次动作的后果，反过来会把旧报告摆在新盘上。
      await refresh()
      if (!outcome.ok) {
        setOrphanFailure(t('trash.orphans.failure', { message: outcome.failure.message }))
        return
      }
      // 回执的判读只走 `readReceipt`：`not-found` = 这一组已经不在了（中性提示，不计入未清理）；
      // 真失败（含请求了却没回的 id）把服务端在 `details` 里给的部分计数说出来。
      const receipt = readReceipt('orphan-clean', orphanReport.roots, outcome.value)
      const failures = receipt.verdicts.filter(isFailureVerdict)
      const gone = failures.filter((verdict) => verdict.kind === 'neutral')
      const failed = failures.filter((verdict) => verdict.kind !== 'neutral')
      const partialRemoved = failed.reduce(
        (sum, verdict) => sum + detailNumber(verdict.kind === 'failed' ? verdict.error.details : undefined, 'removed'), 0)
      const partialBytes = failed.reduce(
        (sum, verdict) => sum + detailNumber(verdict.kind === 'failed' ? verdict.error.details : undefined, 'freedBytes'), 0)
      if (gone.length > 0) setOrphanNotice(t('trash.orphans.cleanGone', { count: gone.length }))
      if (failed.length > 0) {
        const message = failureMessage(failed[0]!)
        const base = t('trash.orphans.cleanFailed', { count: failed.length, message })
        const partial = partialRemoved > 0 || partialBytes > 0
          ? ` ${t('trash.orphans.cleanPartial', { removed: partialRemoved, size: fileSizeText(partialBytes) })}`
          : ''
        setOrphanFailure(`${base}${partial}`)
      }
    })
  }, [around, deps, orphanReport, refresh, t])

  return {
    entries,
    listFailure,
    orphanReport,
    orphanFailure,
    orphanNotice,
    orphanConfirm,
    setOrphanConfirm,
    openOrphanPreview: () => {
      setOrphanFailure(null)
      setOrphanNotice(null)
      setOrphanConfirm(true)
    },
    reload,
    scanOrphans,
    refresh,
    cleanOrphans,
    emptyTrash,
  }
}

/** 失败 `details` 里的非负数字（`orphan-clean` 的部分回执 `removed` / `freedBytes`）；其余一律当 0。 */
function detailNumber(details: Record<string, unknown> | undefined, key: string): number {
  const value = details?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
