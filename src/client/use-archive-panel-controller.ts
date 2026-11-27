/**
 * 归档档面板控制器：详情读路、解除归档、移入座位，以及从面板搬回来的接线（键盘光标 / 下钻包装 /
 * 活动行 / 孩子分派 / 导航面）——面板只剩布局。选中面走 `use-panel-selection.ts` 的归档那一台；
 * 与回收站控制器各持一份状态（ADR-0060 决定第 4 条），但读同一份实现。
 * 失效：自救动作只戳 `invalidateArchive()`（不直呼 reload）；归档的移入回收站走既有移入座位，归档查询
 * 订阅同一条修订；详情账本作废挂在选中面的 `onGone` 上。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ArchiveRowWire, ArchiveSubagentWire } from '../shared/wire.js'
import type { BusyGate } from './busy-gate.js'
import type { Translate } from './copy.js'
import type { ArchiveDetailLike, SessionDeleteRemote } from './remote.js'
import { invalidateArchive } from './archive-store.js'
import { displayNameOf } from './trash-view.js'
import type { ArchiveDetailSubject } from './use-archive-detail-reader.js'
import { childSubjectOf, useArchiveDetailReader } from './use-archive-detail-reader.js'
import { archiveRowsOf, type ArchiveQuery } from './use-archive-query.js'
import { usePanelSelection } from './use-panel-selection.js'
import { useGuardedLoadOlder, type PanelTabController } from './use-panel-tab.js'
import { usePanelChildView } from './use-panel-child-view.js'
import { deleteSessionFromMenu, deleteSessionsFromBatch, unarchiveFromArchiveTab } from './write-seats.js'

/** 归档档离清单的孩子视图：父仍是清单选中那条已归档行，看的却是它的一个子会话。 */
export interface ArchiveChildView {
  readonly parentSessionId: string
  readonly child: ArchiveSubagentWire
}

export interface ArchivePanelController
  extends PanelTabController<ArchiveRowWire, ArchiveDetailSubject, ArchiveDetailLike> {
  /** 当前活动行：选中行优先；没有选中时回落到光标，光标行被收走就落空（不拿旧行冒充）。 */
  readonly activeId: string | null
  /** 正在看哪个孩子（离清单的详情导航态；null = 看清单选中那条）。单级是设计。 */
  readonly childView: ArchiveChildView | null
  select: (row: ArchiveRowWire) => Promise<void>
  selectRow: (row: ArchiveRowWire, options?: { drill?: boolean }) => Promise<void>
  prefetch: (sessionId: string) => void
  /** 单条/批量解除归档：`/apply` 的 `unarchive`，无确认框（幂等）、无撤销座位。 */
  unarchive: (ids: readonly string[]) => Promise<void>
  /** 单条/批量移入回收站：即执行，成功发撤销，失败按行落原文。 */
  deleteOne: (row: ArchiveRowWire) => Promise<void>
  deleteMany: (ids: readonly string[]) => Promise<void>
}

export function useArchivePanelController(input: {
  /** `progress` 不在这里读：slice 按「自己读或向下转发的」收——座位吃 `OneShotDeps`（含认领轮询那一格）。 */
  deps: Pick<SessionDeleteRemote, 'archiveDetail' | 'applyOutcomes' | 'progress'>
  gate: BusyGate
  query: ArchiveQuery
  ordered: readonly ArchiveRowWire[]
  /** 归档档是否在眼前：不活动时详情主体落空（没有读需求，生命周期只订失效不读）。 */
  active: boolean
  /** 分栏态：`selectRow` 的「drill 或分栏才真正选中」要它。归档档没有独立 `drilled` 位（选中即窄档
   *  下钻），所以布局事实必须进控制器——两台孪生控制器的 `select` 契约因此不同。 */
  split: boolean
  t: Translate
}): ArchivePanelController {
  const { deps, gate, query, ordered, active, split, t } = input
  const { reload } = query
  const canAutoSelect = active && split
  const rows = archiveRowsOf(query.list)
  const [childView, setChildView] = useState<ArchiveChildView | null>(null)

  /**
   * 选中面（`use-panel-selection.ts` 的归档那一台）：清场与宽档自动选中都走 layout 阶段，与回收站读
   * 同一份实现（ADR-0050 的「不露未选中那一帧」靠这条阶段判据）。
   */
  const { selected, actionFailure, pick, drop, clearRowFailures, setRowFailures } =
    usePanelSelection<ArchiveRowWire>({
      rows,
      idOf: (row) => row.sessionId,
      ordered,
      canAutoSelect,
      // 选清单行 = 离开孩子视图；读哪一条仍由下方的读路按同一个 id 判。
      onPick: (row) => {
        setChildView(null)
        return reader.ensure(row.sessionId)
      },
      // 那一行被清单收走：丢详情账本 + 收分页现场、作废在飞读数（选中 id 由选中面清）。
      onGone: (sessionId) => { reader.forget(sessionId); reader.reset(sessionId) },
    })
  const present = useCallback(
    (sessionId: string): boolean => rows?.some((row) => row.sessionId === sessionId) ?? false,
    [rows],
  )
  /** 详情主体：档位在眼前才有读需求；孩子视图开着就是孩子；不活动交 null = 生命周期只记修订。 */
  const subject: ArchiveDetailSubject | null = !active || selected === null
    ? null
    : childView === null ? selected : childSubjectOf(childView.child)
  /** 根判据认**在不在清单**，不认「id 是否与选中不同」：清单行自己已归档，首读/预取都不需要根；仅离
   *  清单的 id 带上选中行做只读根（`pick` 与 `onPick` 同拍跑，那时 `selected` 还停在上一行）。 */
  const rootOf = useCallback(
    (sessionId: string): string | undefined =>
      present(sessionId) ? undefined : selected?.sessionId,
    [present, selected],
  )
  const reader = useArchiveDetailReader({
    deps,
    active,
    subject,
    present,
    topLevel: childView === null,
    rootOf,
  })
  const {
    detail: detailState,
    canNavigate,
    ensure,
    prefetch,
    loadOlder: loadOlderDetail,
    retry,
    forget: forgetDetail,
    reset: resetDetail,
  } = reader

  const [cursorId, setCursorId] = useState<string | null>(null)

  /** 活动行：选中优先；没有选中时光标接上，光标行已被收走就落空。 */
  const activeId = selected?.sessionId
    ?? (cursorId !== null && (rows?.some((row) => row.sessionId === cursorId) ?? false) ? cursorId : null)

  /**
   * 记光标，并在「drill 或分栏」时真正选中并读详情：窄档方向键只移光标（不选中、不读详情），
   * Enter/Space 或宽档才真正下钻。
   */
  const selectRow = useCallback(async (
    row: ArchiveRowWire,
    options?: { drill?: boolean },
  ): Promise<void> => {
    setCursorId(row.sessionId)
    if (options?.drill === true || split) await pick(row)
  }, [split, pick])

  const loadOlder = useGuardedLoadOlder(canNavigate, loadOlderDetail)

  /** 父行被清单换版收走（解除归档 / 移入回收站 / 语料消失）⇒ 孩子视图失去只读根：关掉并丢账本。 */
  useEffect(() => {
    if (childView === null || rows === null) return
    if (rows.some((row) => row.sessionId === childView.parentSessionId)) return
    forgetDetail(childView.child.sessionId)
    resetDetail(childView.child.sessionId)
    setChildView(null)
  }, [rows, childView, forgetDetail, resetDetail])

  const openChild = useCallback(async (sessionId: string): Promise<void> => {
    // 保持期这一支整个不接受导航（判据问 `canNavigate`，与回收站同一条）；孩子视图里也不再开下一层。
    if (!canNavigate || childView !== null) return
    // ADR-0061 寻址：这个 id 若就是清单里的一行，选那一行看详情，不开第二条导航道。
    const rowInList = rows?.find((row) => row.sessionId === sessionId)
    if (rowInList !== undefined) { await pick(rowInList); return }
    if (selected === null) return
    const kids = detailState.kind === 'ready' ? detailState.detail.subagents : undefined
    const child = kids?.find((candidate) => candidate.sessionId === sessionId)
    if (child === undefined) return
    setChildView({ parentSessionId: selected.sessionId, child })
    await ensure(child.sessionId)
  }, [canNavigate, rows, pick, selected, childView, detailState, ensure])

  /** 孩子视图的收口（状态仍在本控制器，ADR-0060 第 4 条）：收尾顺序、返回两程与导航面
   *  共用 `use-panel-child-view.ts`（ADR-0055 单级判据）。 */
  const parentTitle = useCallback((row: ArchiveRowWire): string => displayNameOf(row, t), [t])
  const { closeChild, back, detailNav } = usePanelChildView<ArchiveChildView, ArchiveRowWire>({
    childView,
    setChildView,
    selected,
    parentTitle,
    openChild,
    prefetchChild: prefetch,
    onClose: (child) => { resetDetail(child.child.sessionId) },
    backWithoutChild: drop,
  })

  const unarchive = useCallback(async (ids: readonly string[]): Promise<void> => {
    const run = await unarchiveFromArchiveTab({
      deps,
      ids,
      gate,
      // 自救动作只戳失效台（不直呼 reload）：旁路观察的同轮变化合并进同一次读。
      refresh: () => { invalidateArchive(); return Promise.resolve() },
      // 行失败是面板的本地状态：座位在 apply 前清这一批的旧原文（被挡回也清过）、跑完按 id 铺回。
      failureSink: { clear: clearRowFailures, set: setRowFailures },
    })
    // 被闸挡回的那一趟什么都没跑：成败由在飞那一趟说（旧原文已经清过）。
    if (run.kind === 'blocked') return
  }, [deps, gate, clearRowFailures, setRowFailures])

  const deleteOne = useCallback(async (row: ArchiveRowWire): Promise<void> => {
    await deleteSessionFromMenu(
      deps,
      {
        sessionId: row.sessionId,
        title: displayNameOf(row, t),
        failureSink: { clear: clearRowFailures, set: setRowFailures },
        // 将清单重读包进同一枚闸，免得新清单还没落地时按钮先亮起导致重按撞 already-gone。
        refresh: () => reload(),
      },
      gate,
    )
  }, [deps, gate, t, clearRowFailures, setRowFailures, reload])

  const deleteMany = useCallback(async (ids: readonly string[]): Promise<void> => {
    const run = await deleteSessionsFromBatch(
      deps,
      ids,
      gate,
      { clear: clearRowFailures, set: setRowFailures },
      () => reload(),
    )
    // 被闸挡回的那一趟什么都没跑：成败由在飞那一趟说（行内旧原文已在 apply 前清过）。
    if (run.kind === 'blocked') return
  }, [deps, gate, clearRowFailures, setRowFailures, reload])

  return {
    busy: gate.busy,
    selected,
    activeId,
    childView,
    detail: detailState,
    canNavigate,
    loadingOlder: reader.loadingOlder,
    olderFailure: reader.olderFailure,
    actionFailure,
    detailNav,
    select: pick,
    selectRow,
    back,
    prefetch,
    openChild,
    closeChild,
    loadOlder,
    retry,
    unarchive,
    deleteOne,
    deleteMany,
  }
}
