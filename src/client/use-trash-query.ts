/**
 * 清册读数与无主子会话的取数编排。
 *
 * 三条承重规矩：
 * - 最新票：在飞的 list / orphans 旧响应不许盖掉新状态。
 * - 先清单后扫描：/orphans 判“父没了”依赖 /list 对账后的清册。
 * - 读不到就说读不到：/orphans 的 io 是失败，不折成“零条残留”。
 *
 * 清理（/apply 的 orphan-clean）与扫描共用同一份报告和同一枚 busy 闸。
 */
import { useCallback, useRef, useState } from 'react'
import type { BusyGate } from './busy-gate.js'
import { callRemote, type OrphanReportWire, type SessionDeleteRemote, type TrashEntryLike } from './remote.js'
import { clearUndoNotice } from './undo-notices.js'
import type { WriteOutcome } from './write.js'
import { cleanOrphansFromPanel } from './write-seats.js'
import { createLatestWins } from './store.js'
import type { Translate } from './copy.js'
import type { ApplyAction } from '../shared/wire.js'
import { fileSizeText } from './ui/format.js'

export type TrashQueryDeps = Pick<SessionDeleteRemote, 'list' | 'scanOrphans' | 'applyOutcomes' | 'emptyTrash'>

/** 一次清单读的结局：`stale` = 被后发的读顶掉（什么都没落地，调用方不许拿它当失败清场）。 */
type ReloadResult = 'ok' | 'failed' | 'stale'

/** 清单的唯一状态：加载中 / 有行 / 未知。`unknown` 不向下游交出任何行——旧行不许继续可操作。 */
export type TrashListState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly rows: readonly TrashEntryLike[] }
  | { readonly status: 'unknown'; readonly failure: string }

/** 清单状态对视图的**唯一解读**：行、失败原文、加载中与空态一次交出。
 *  面板与控制器不再各自从 `status` 反推——"未知"不是"空"，也不许把失败折成空态。 */
export interface TrashListView {
  readonly rows: readonly TrashEntryLike[] | null
  readonly failure: string | null
  readonly loading: boolean
  readonly empty: boolean
}

export function listView(list: TrashListState): TrashListView {
  switch (list.status) {
    case 'loading':
      return { rows: null, failure: null, loading: true, empty: false }
    case 'unknown':
      return { rows: null, failure: list.failure, loading: false, empty: false }
    case 'ready':
      return { rows: list.rows, failure: null, loading: false, empty: list.rows.length === 0 }
  }
}

export interface TrashQuery {
  readonly list: TrashListState
  /** `null` = 还没扫到；失败时也置回 `null`（不拿空报告冒充干净）。 */
  readonly orphanReport: OrphanReportWire | null
  readonly orphanFailure: string | null
  /** 「这一组已经不在」不是失败：单独一条中性提示。 */
  readonly orphanNotice: string | null
  readonly orphanConfirm: boolean
  setOrphanConfirm(open: boolean): void
  /** 「查看并清理」：把上一条失败/中性提示清掉再开预览框（旧提示不该跟新一次预览并排出现）。 */
  openOrphanPreview(): void
  /** 先读清单、成了再扫残留；挂载与显式「重试」用它。 */
  refreshAll(): Promise<void>
  /** 写后/失效：只重读清单；是否顺带重扫残留由这次的 `outcome` 从 action / ids / 当前清单自行派生
   *  （判据住 `needsOrphanRescan`）。失效通告不带 outcome：报告未知或非空才重扫。输给后发读时由赢家补扫；
   *  清单读失败时清空报告与提示。 */
  refreshAfterWrite(outcome?: WriteOutcome<ApplyAction>): Promise<void>
  /** 清理那批无主子会话（一段 `/apply` 的第五个动作），逐条结果落成"已不在了 / N 组未清理"。 */
  cleanOrphans(): Promise<void>
  /** 清空回收站（聚合回执）：成功就熄掉撤销横幅并重读，失败就把清单置为未知并摆上原文。交回是否成功。 */
  emptyTrash(): Promise<boolean>
}

export function useTrashQuery({
  deps,
  t,
  gate,
}: {
  deps: TrashQueryDeps
  t: Translate
  /** 面板的一枚全局闸：清空与无主子会话清理这两条写动作把整趟包在里面（面板的 `busy`）。 */
  gate: BusyGate
}): TrashQuery {
  const [list, setList] = useState<TrashListState>({ status: 'loading' })
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

  /** 清单的同步只读镜像：`refreshAfterWrite` 要在发下一次读**之前**按"当前清单"判要不要强制重扫，
   *  又不能让回调跟着渲染期 state 换代。 */
  const listRef = useRef<TrashListState>({ status: 'loading' })
  const setListState = useCallback((next: TrashListState): void => {
    listRef.current = next
    setList(next)
  }, [])

  const [reloadLatest] = useState(createLatestWins)
  const reloadRows = useCallback(async (): Promise<ReloadResult> => {
    const ticket = reloadLatest.issue()
    const outcome = await callRemote(() => deps.list())
    // 输给后发的读：这一次什么都没落地，别让调用方把它当"读失败"去清场。
    if (!ticket.current) return 'stale'
    if (!outcome.ok) {
      setListState({ status: 'unknown', failure: outcome.failure.message })
      return 'failed'
    }
    setListState({ status: 'ready', rows: outcome.value })
    return 'ok'
  }, [deps, reloadLatest, setListState])

  const [orphanLatest] = useState(createLatestWins)
  /** 强制重扫标记：先记再读清单；这次读输给后发读时，由赢家消费，强制不丢。 */
  const pendingForcedRescan = useRef(false)

  /** 清单这一拍读失败：清掉报告与提示、作废在飞的旧扫描（晚到的读数不能把报告写回来），
   *  并丢掉挂起的强制重扫（报告已回 null，下一次成功刷新本来就会重扫）。 */
  const clearOrphanState = useCallback((): void => {
    orphanLatest.invalidate()
    pendingForcedRescan.current = false
    setReport(null)
    setOrphanFailure(null)
    setOrphanNotice(null)
    setOrphanConfirm(false)
  }, [orphanLatest, setReport])

  const rescanOrphans = useCallback(async (): Promise<void> => {
    const ticket = orphanLatest.issue()
    const outcome = await callRemote(() => deps.scanOrphans())
    if (!ticket.current) return
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
  }, [deps, orphanLatest, setReport, t])

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
   * 写后与失效通告：清单必重读；要不要顺带重扫残留由 `needsOrphanRescan` 从这次的 outcome 派生：
   * purge 与 orphan-clean 总要扫（撤掉的父、被带走的孩子都可能留下新孤儿，报告为空也只是这一拍为空）；
   * delete 与组根恢复可以省——孩子跟着父走，报告为空时扫了也只会得到空报告。**报告 `null` 不是"空的"**：
   * 它表示从没扫到（挂载刷新被顶掉 / 扫描失败），这时重扫是唯一能把未知变成已知的路；失效通告没有
   * outcome，仍按报告未知或非空才扫。
   * 强制重扫先记标记再读清单：若这次读输给后发的 refresh，赢家会看到标记并补扫，强制不丢。
   * 清单读失败时清空报告与提示：这一拍不知道盘上长什么样，旧读数不能继续当现状。
   */
  const refreshAfterWriteInternal = useCallback(async (forceRescan: boolean): Promise<void> => {
    if (forceRescan) pendingForcedRescan.current = true
    const listed = await reloadRows()
    if (listed === 'stale') return
    if (listed === 'failed') {
      clearOrphanState()
      return
    }
    const pending = pendingForcedRescan.current
    pendingForcedRescan.current = false
    if (pending) {
      await rescanOrphans()
      return
    }
    const current = orphanReportRef.current
    if (current === null || current.totalSessions > 0) await rescanOrphans()
  }, [clearOrphanState, reloadRows, rescanOrphans])

  const refreshAfterWrite = useCallback(
    (outcome?: WriteOutcome<ApplyAction>): Promise<void> => {
      const current = listView(listRef.current).rows
      return refreshAfterWriteInternal(outcome !== undefined && needsOrphanRescan(outcome, current))
    },
    [refreshAfterWriteInternal],
  )

  // 清空是**聚合回执**、不是 `/apply` 座位：`emptyTrash` 自己包闸（别在外面再套一层，双套会让外层 busy 提前落下）。
  const emptyTrash = useCallback((): Promise<boolean> => gate.around(async () => {
    const outcome = await callRemote(() => deps.emptyTrash())
    if (!outcome.ok) {
      // 清空失败在这块界面上的落点就是"清单未知"：回收站此刻是什么样我们不知道，旧行也不能继续可操作。
      // 同时作废在飞的清单读——晚到的旧读不能把这一拍又盖回 ready。
      reloadLatest.invalidate()
      setListState({ status: 'unknown', failure: outcome.failure.message })
      clearOrphanState()
      return false
    }
    // 清空把所有落点一起清了：还挂着的横幅是一条注定失败的「撤销」，先收掉再重读（判据与现场住
    // `undo-notices.ts`；逐条 purge 那一路由 settlement 的 purge 支熄灭，ADR-0013）。失败不熄——
    // 回收站还在，撤销仍是可做的动作。
    clearUndoNotice()
    await refreshAfterWriteInternal(true)
    return true
  }), [gate, deps, clearOrphanState, refreshAfterWriteInternal, reloadLatest, setListState])

  const cleanOrphans = useCallback(async (): Promise<void> => {
    if (orphanReport === null || orphanReport.roots.length === 0) {
      setOrphanConfirm(false)
      return
    }
    setOrphanFailure(null)
    setOrphanNotice(null)
    // 先刷新再落提示：清完一批之后"还剩哪些残留"本身就是这次动作的后果，反过来会把旧报告摆在新盘上。
    // `orphan-clean` 的 outcome 总会强制重扫（连带盘上后代），不需要调用方另传标记。
    const settle = (outcome: WriteOutcome<'orphan-clean'>): Promise<void> => {
      setOrphanConfirm(false)
      return refreshAfterWrite(outcome)
    }
    // 闸与整趟（apply → 收尾 → 重读）归座位；本地仍判回执：`not-found` = 这一组已经不在了（中性提示，
    // 不计入未清理）；真失败（含请求了却没回的 id）把服务端在 `details` 里给的部分计数说出来。
    const outcome = await cleanOrphansFromPanel({
      deps,
      ids: orphanReport.roots,
      gate,
      refreshAfterWrite: settle,
    })
    if (!outcome.ok) {
      setOrphanFailure(t('trash.orphans.failure', { message: outcome.failure.message }))
      return
    }
    const summary = outcome.summary
    const gone = summary.neutralIds
    const failed = summary.failed
    if (gone.length > 0) setOrphanNotice(t('trash.orphans.cleanGone', { count: gone.length }))
    if (failed.length > 0) {
      const message = failed[0]!.error.message
      const base = t('trash.orphans.cleanFailed', { count: failed.length, message })
      const partial = summary.partial.removed > 0 || summary.partial.freedBytes > 0
        ? ` ${t('trash.orphans.cleanPartial', { removed: summary.partial.removed, size: fileSizeText(summary.partial.freedBytes) })}`
        : ''
      setOrphanFailure(`${base}${partial}`)
    }
  }, [deps, gate, orphanReport, refreshAfterWrite, t])

  return {
    list,
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
    refreshAll,
    refreshAfterWrite,
    cleanOrphans,
    emptyTrash,
  }
}

/**
 * 写后要不要强制重扫残留：只看这次写的动作、它请求的 id 与**发读前**的清单。
 * - purge / orphan-clean 总要扫：语料缺席时故意留下的盘上后代、被带走父行留下的孩子，报告为空也可能是新孤儿。
 * - restore 只在清单未知（不知道恢复的是什么）、清单里已经找不到这个 id（这一拍不能断言它不是孩子），
 *   或恢复的是露面的孩子（父行已摘，回到语料后可能无主）时扫；组根恢复把孩子一起带回，不新增孤儿。
 * - delete / count 不扫。新动作必须在这里选一条，别静默落到"不扫"。裁决见 ADR-0016。
 */
function needsOrphanRescan(
  outcome: WriteOutcome<ApplyAction>,
  entries: readonly TrashEntryLike[] | null,
): boolean {
  switch (outcome.action) {
    case 'purge':
    case 'orphan-clean':
      return true
    case 'restore': {
      if (entries === null) return true
      const byId = new Map(entries.map((entry) => [entry.id, entry]))
      return outcome.ids.some((id) => {
        const entry = byId.get(id)
        return entry === undefined || entry.parentEntryId !== undefined
      })
    }
    case 'delete':
    case 'count':
      return false
    default: {
      const _never: never = outcome.action
      return _never
    }
  }
}
