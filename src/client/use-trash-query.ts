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
import { failureMessage, isFailureVerdict } from './receipt.js'
import { runWrite } from './write.js'
import type { Translate } from './copy.js'
import { fileSizeText } from './ui/format.js'

export type TrashQueryDeps = Pick<SessionDeleteRemote, 'list' | 'scanOrphans' | 'applyOutcomes' | 'emptyTrash'>

/** 一次清单读的结局：`stale` = 被后发的读顶掉（什么都没落地，调用方不许拿它当失败清场）。 */
export type ReloadResult = 'ok' | 'failed' | 'stale'

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
  /** 只重读清单（对账 + 读）。交回**这一次读的结局**：落地 / 读失败 / 被后发的读顶掉。
   *  残留报告与提示的联动不在这里；组合清场归 `refreshAll` / `refreshAfterWrite`。 */
  reloadRows(): Promise<ReloadResult>
  /** 只扫残留。调用方负责先让清单对过账（`refreshAll` / `refreshAfterWrite` 已经排好序）。 */
  rescanOrphans(): Promise<void>
  /** 先读清单、成了再扫残留；挂载与显式「重试」用它。 */
  refreshAll(): Promise<void>
  /** 写后/失效：只重读清单；报告未知（从未扫到 / 扫描失败）或非空时顺带重扫，已扫过且为空才省。
   *  `rescan:true` 强制重扫（输给后发读时由赢家补扫）。清单读失败时清空报告与提示。 */
  refreshAfterWrite(options?: { rescan?: boolean }): Promise<void>
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
  /** 报告的同步只读镜像：`refreshAfterWrite` 需要区分「未知」与「已有读数」，又不把 identity 绑在 state 上。 */
  const orphanReportRef = useRef<OrphanReportWire | null>(null)
  const setReport = useCallback((report: OrphanReportWire | null): void => {
    orphanReportRef.current = report
    setOrphanReport(report)
  }, [])

  const reloadSeq = useRef(0)
  const reloadRows = useCallback(async (): Promise<ReloadResult> => {
    const seq = ++reloadSeq.current
    const outcome = await callRemote(() => deps.list())
    // 输给后发的读：这一次什么都没落地，别让调用方把它当"读失败"去清场。
    if (seq !== reloadSeq.current) return 'stale'
    if (!outcome.ok) {
      setListFailure(outcome.failure.message)
      setEntries(null)
      return 'failed'
    }
    setListFailure(null)
    setEntries(outcome.value)
    return 'ok'
  }, [deps])

  const orphanScanSeq = useRef(0)
  /** 强制重扫标记：先记再读清单；这次读输给后发读时，由赢家消费，强制不丢。 */
  const pendingForcedRescan = useRef(false)

  /** 清单这一拍读失败：清掉报告与提示、作废在飞的旧扫描（晚到的读数不能把报告写回来），
   *  并丢掉挂起的强制重扫（报告已回 null，下一次成功刷新本来就会重扫）。 */
  const clearOrphanState = useCallback((): void => {
    orphanScanSeq.current += 1
    pendingForcedRescan.current = false
    setReport(null)
    setOrphanFailure(null)
    setOrphanNotice(null)
    setOrphanConfirm(false)
  }, [setReport])

  const rescanOrphans = useCallback(async (): Promise<void> => {
    const seq = ++orphanScanSeq.current
    const outcome = await callRemote(() => deps.scanOrphans())
    if (seq !== orphanScanSeq.current) return
    if (!outcome.ok) {
      setReport(null)
      setOrphanNotice(null)
      setOrphanConfirm(false)
      setOrphanFailure(t('trash.orphans.failure', { message: outcome.failure.message }))
      return
    }
    setReport(outcome.value)
    setOrphanFailure(null)
    setOrphanNotice(null)
  }, [deps, setReport, t])

  /** 显式全量刷新：清单读失败时连残留报告一起清掉（这一拍不知道盘上长什么样）；被顶掉则让位。
   *  它总要扫残留，所以顺手消费掉之前挂起的强制重扫。 */
  const refreshAll = useCallback(async (): Promise<void> => {
    const listed = await reloadRows()
    if (listed === 'stale') return
    if (listed === 'failed') {
      clearOrphanState()
      return
    }
    pendingForcedRescan.current = false
    await rescanOrphans()
  }, [clearOrphanState, reloadRows, rescanOrphans])

  /**
   * 写后与失效通告：清单必重读；残留只在「已经扫到过且为空」时省。
   * 删除 / 整组恢复把父带进/带出回收站时孩子跟着走，orphan-clean 连带盘上后代，报告为空时重扫只会得到
   * 空报告——这一笔可以省。**报告 `null` 不是"空的"**：它表示从没扫到（挂载刷新被顶掉 / 扫描失败），
   * 这时重扫是唯一能把未知变成已知的路。**例外**：purge / 清空在语料缺席（`available:false`）时故意
   * 留下盘上后代，父行没了之后它们就是新孤儿；单独恢复一条露面的孩子（父行已摘）也可能把它变成孤儿。
   * 这些写动作用 `rescan:true` 强制重扫。
   * `rescan:true` 先记标记再读清单：若这次读输给后发的 refresh，赢家会看到标记并补扫，强制不丢。
   * 清单读失败时清空报告与提示：这一拍不知道盘上长什么样，旧读数不能继续当现状。
   */
  const refreshAfterWrite = useCallback(async (options: { rescan?: boolean } = {}): Promise<void> => {
    if (options.rescan === true) pendingForcedRescan.current = true
    const listed = await reloadRows()
    if (listed === 'stale') return
    if (listed === 'failed') {
      clearOrphanState()
      return
    }
    const forced = pendingForcedRescan.current
    pendingForcedRescan.current = false
    if (forced) {
      await rescanOrphans()
      return
    }
    const current = orphanReportRef.current
    if (current === null || current.totalSessions > 0) await rescanOrphans()
  }, [clearOrphanState, reloadRows, rescanOrphans])

  const emptyTrash = useCallback((): Promise<boolean> => around(async () => {
    const outcome = await callRemote(() => deps.emptyTrash())
    if (!outcome.ok) {
      // 清空失败在这块界面上的落点就是"清单读不到"那一格：回收站此刻是什么样我们不知道
      setListFailure(outcome.failure.message)
      return false
    }
    await refreshAfterWrite({ rescan: true })
    return true
  }), [around, deps, refreshAfterWrite])

  const cleanOrphans = useCallback((): Promise<void> => {
    if (orphanReport === null || orphanReport.roots.length === 0) {
      setOrphanConfirm(false)
      return Promise.resolve()
    }
    return around(async () => {
      setOrphanFailure(null)
      setOrphanNotice(null)
      // 先刷新再落提示：清完一批之后"还剩哪些残留"本身就是这次动作的后果，反过来会把旧报告摆在新盘上。
      const settle = (): Promise<void> => {
        setOrphanConfirm(false)
        return refreshAfterWrite({ rescan: true })
      }
      const outcome = await runWrite({
        deps,
        action: 'orphan-clean',
        ids: orphanReport.roots,
        refresh: settle,
      })
      if (!outcome.ok) {
        setOrphanFailure(t('trash.orphans.failure', { message: outcome.failure.message }))
        return
      }
      // 回执的判读只走 `runWrite` 交回的 receipt：`not-found` = 这一组已经不在了（中性提示，不计入未清理）；
      // 真失败（含请求了却没回的 id）把服务端在 `details` 里给的部分计数说出来。
      const receipt = outcome.receipt
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
  }, [around, deps, orphanReport, refreshAfterWrite, t])

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
    reloadRows,
    rescanOrphans,
    refreshAll,
    refreshAfterWrite,
    cleanOrphans,
    emptyTrash,
  }
}

/** 失败 `details` 里的非负数字（`orphan-clean` 的部分回执 `removed` / `freedBytes`）；其余一律当 0。 */
function detailNumber(details: Record<string, unknown> | undefined, key: string): number {
  const value = details?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
