/**
 * 归档档面板控制器（`use-archive-panel-controller.ts`）：详情读路、解除归档、删除座位，以及**从面板
 * 搬回来的接线**（键盘光标 / 下钻包装 `selectRow` / 活动行 `activeId` / 孩子分派 `openChild` /
 * 导航面 `detailNav`）——面板只剩布局。选中面（选中行、清单换版清场、宽档自动选中、失败落点）走
 * `use-panel-selection.ts` 的归档那一台。与回收站控制器**各持一份状态**（ADR-0060 决定第 4 条），
 * 但**读同一份实现**：分的是状态，不是判据。
 *
 * 失效接线（ADR-0060 决定第 4 条的三条来源）：
 * - 自救动作（解除归档）后只戳 `invalidateArchive()`（**不**直呼 reload；A1 随后的同一变化
 *   合并进同一次读，latest-wins 只管旧响应不盖新态）；
 * - 归档档删除落地走的是既有删除座位（`write-seats.ts`）：座位只戳回收站修订，归档查询
 *   订阅同一条修订——恢复一条已归档会话让它**回「归档」**（`wasArchived` 保留，ADR-0008）；
 * - 归档详情账本的作废挂在选中面的 `onGone` 上（那一行被清单收走时）；详情读失败只坏该行详情，
 *   不冻结清单与动作。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ArchiveRowWire, ArchiveSubagentWire } from '../shared/wire.js'
import type { BusyGate } from './busy-gate.js'
import type { Translate } from './copy.js'
import { requestDelete } from './delete-confirm.js'
import { requestDeleteBatch } from './batch-confirm.js'
import type { ArchiveDetailLike, SessionDeleteRemote } from './remote.js'
import { invalidateArchive } from './archive-store.js'
import { displayNameOf } from './trash-view.js'
import type { ArchiveDetailSubject } from './use-archive-detail-reader.js'
import { childSubjectOf, useArchiveDetailReader } from './use-archive-detail-reader.js'
import type { DetailState } from './use-detail-reader.js'
import type { DetailNav } from './session-detail.js'
import type { ArchiveQuery } from './use-archive-query.js'
import { usePanelSelection } from './use-panel-selection.js'
import { unarchiveFromArchiveTab } from './write-seats.js'

/** 归档档离清单的孩子视图：父仍是清单选中那条已归档行，看的却是它的一个子会话。 */
export interface ArchiveChildView {
  readonly parentSessionId: string
  readonly child: ArchiveSubagentWire
}

export interface ArchivePanelController {
  readonly busy: boolean
  readonly selected: ArchiveRowWire | null
  /** 当前活动行（说「详情正画着这一条」）：选中行优先；没有选中（窄档方向键只移光标）时回落到
   *  光标，光标行已被清单收走就落空（不拿旧行冒充）。清单的活动高亮与导航落点都读它。 */
  readonly activeId: string | null
  /** 正在看哪个孩子（离清单的详情导航态；null = 看清单选中那条）。单级是设计。 */
  readonly childView: ArchiveChildView | null
  readonly detail: DetailState<ArchiveDetailSubject, ArchiveDetailLike>
  /** 「保持期拒绝导航/跳转」判据（`use-detail-reader` 的唯一出口）：`openChild` / `loadOlder` 的守卫
   *  与详情栏 `disabled` 都只问它，不再各自重推保持。 */
  readonly canNavigate: boolean
  readonly loadingOlder: boolean
  readonly olderFailure: string | null
  /** 失败原文按行落：不冻结清单与动作，行内各自显示。 */
  readonly actionFailure: Readonly<Record<string, string>>
  /** 详情的导航面（开孩子 / 预取 / 回父）：面板只转交，不自己拼（判据住控制器，与回收站同款）。 */
  readonly detailNav: DetailNav
  select: (row: ArchiveRowWire) => Promise<void>
  /** 记光标；`drill`（Enter/Space 那一下）或分栏（`split`）时才真正选中并读详情——窄档方向键只移光标。 */
  selectRow: (row: ArchiveRowWire, options?: { drill?: boolean }) => Promise<void>
  /** 窄档返回：孩子视图先回父，再按一次交还清单；宽档无此步。 */
  back: () => void
  /** 意图预取（清单行与孩子行同一条）：只热身账本，读哪一条的根由 `rootOf` 判。 */
  prefetch: (sessionId: string) => void
  /** 打开父详情里的一个孩子；id 若就是清单里的一行（已归档会话本体）⇒ 选那一行、不进孩子视图
   *  （ADR-0061 寻址）。否则进只读孩子视图（父行做只读根）。单级：孩子视图里不再开下一层。 */
  openChild: (sessionId: string) => Promise<void>
  /** 回到父详情（孩子视图开着时）。 */
  closeChild: () => void
  loadOlder: () => Promise<void>
  retry: () => void
  /** 单条/批量解除归档：`/apply` 的 `unarchive`，无确认框（幂等）、无撤销座位。 */
  unarchive: (ids: readonly string[]) => Promise<void>
  /** 单删：`requestDelete({ sessionId, title: 显示名 })` → `DeleteConfirmHost`
   *  （「含 N 个子会话」仍走 `applyOne('count', sessionId)`，归档会话在语料里读得到）。 */
  requestDeleteOne: (row: ArchiveRowWire) => void
  /** 批删：`requestDeleteBatch(items)` → `BatchConfirmHost`，落地走 `deleteSessionsFromBatch`。
   *  不交选中集收缩钩子：宿主侧栏的 picks 与这一档无关，勾选面由清单换版自己剔（`use-list-selection.ts`）。 */
  requestDeleteMany: (items: readonly { sessionId: string; title: string }[]) => void
}

export function useArchivePanelController(input: {
  deps: Pick<SessionDeleteRemote, 'archiveDetail' | 'applyOutcomes'>
  gate: BusyGate
  query: ArchiveQuery
  /** 屏幕上的可见顺序（只含展开的组）：宽档自动选中第一条走这一份。 */
  ordered: readonly ArchiveRowWire[]
  /** 归档档是否在眼前：不活动时详情主体落空（没有读需求，生命周期只订失效不读）。 */
  active: boolean
  /** 分栏态（原住面板的 `archiveSplit`）：`selectRow` 的「drill 或分栏才真正选中」要它。
   *  归档档没有回收站那样的独立 `drilled` 位（选中即窄档下钻），所以布局事实必须进控制器；
   *  两台孪生控制器的 `select` 契约因此不同——回收站的 drill 由调用方交，归档的由 `split` 补。 */
  split: boolean
  t: Translate
}): ArchivePanelController {
  const { deps, gate, query, ordered, active, split, t } = input
  /** 自动选中只在「档位在眼前 + 分栏有清单」时发生：由两个已经传进来的事实派生，不另收一个入参。 */
  const canAutoSelect = active && split
  const rows = query.list.status === 'ready' ? query.list.rows : null
  /** 离清单的孩子视图：父仍是 `selected`，详情主体换成孩子。两档状态各一份（ADR-0060 第 4 条）。 */
  const [childView, setChildView] = useState<ArchiveChildView | null>(null)

  /**
   * 选中面（`use-panel-selection.ts` 的归档那一台）：清场与宽档自动选中都走 layout 阶段，
   * 与回收站读同一份实现——ADR-0050 的「不露未选中那一帧」靠的就是这一条阶段判据。
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
  /** 详情主体：档位在眼前才有读需求；孩子视图开着就是孩子；父行被清单收走的那一拍先落空，
   *  effect 随后收孩子视图。不活动交 null = 生命周期只记修订、不发起读。 */
  const subject: ArchiveDetailSubject | null = !active || selected === null
    ? null
    : childView === null ? selected : childSubjectOf(childView.child)
  /** 根判据认**在不在清单**，不认「id 是否与选中不同」：清单行自己已归档，首读/预取都不需要根；
   *  仅离清单的 id（孩子视图的孩子）带上选中行做只读根。`pick` 与 `onPick` 同拍跑，那时 `selected`
   *  还停在上一行——按后者判会让新行首读掺进旧根（服务端今天短路了也无碍，契约噪音仍是噪音）。 */
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

  /** 清单上的键盘光标（原住面板的 `archiveCursorId`）：只随 `selectRow` 走，与选中是两条账。 */
  const [cursorId, setCursorId] = useState<string | null>(null)

  /** 活动行（原住面板的 `archiveActiveId`）：选中优先；没有选中（窄档方向键只移光标）时光标接上，
   *  光标行已被清单收走就落空（不拿旧行冒充）。 */
  const activeId = selected?.sessionId
    ?? (cursorId !== null && (rows?.some((row) => row.sessionId === cursorId) ?? false) ? cursorId : null)

  /**
   * 记光标，并在「drill 或分栏」时真正选中并读详情（原住面板的 `archiveSelect`）：窄档方向键只移
   * 光标（不选中、不读详情），Enter/Space（drill）或宽档（split）才真正下钻看详情。
   */
  const selectRow = useCallback(async (
    row: ArchiveRowWire,
    options?: { drill?: boolean },
  ): Promise<void> => {
    setCursorId(row.sessionId)
    if (options?.drill === true || split) await pick(row)
  }, [split, pick])

  /**
   * 更早一页（守卫问 `canNavigate`，保持期一趟都不发）：那一帧画的是上一条的正文，翻页会把它的
   * 游标读进新主体（ADR-0049）。分页机制本体在读路。
   */
  const loadOlder = useCallback(async (): Promise<void> => {
    if (!canNavigate) return
    await loadOlderDetail()
  }, [canNavigate, loadOlderDetail])

  /** 父行被清单换版收走（解除归档 / 删除 / 语料消失）⇒ 孩子视图失去只读根：关掉并丢账本。 */
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
    // ADR-0061 寻址：这个 id 若就是清单里的一行（已归档会话本体就在清单上），选那一行看详情，
    // 不开第二条导航道——清单可达的就不进孩子视图。
    const rowInList = rows?.find((row) => row.sessionId === sessionId)
    if (rowInList !== undefined) { await pick(rowInList); return }
    if (selected === null) return
    const kids = detailState.kind === 'ready' ? detailState.detail.subagents : undefined
    const child = kids?.find((candidate) => candidate.sessionId === sessionId)
    if (child === undefined) return
    setChildView({ parentSessionId: selected.sessionId, child })
    await ensure(child.sessionId)
  }, [canNavigate, rows, pick, selected, childView, detailState, ensure])

  const closeChild = useCallback((): void => {
    if (childView !== null) resetDetail(childView.child.sessionId)
    setChildView(null)
  }, [childView, resetDetail])

  const back = useCallback((): void => {
    if (childView !== null) { closeChild(); return }
    drop()
  }, [childView, closeChild, drop])

  /**
   * 详情的导航面（与回收站同款，判据住控制器，面板只转交）：
   * - 孩子视图没开（主体是清单选中那条）⇒ `onOpenChild` / `onPrefetchChild` 在场、`parentContext` 缺席；
   *   孩子视图里不再开下一层（单级），入口只在这半边交出。
   * - 孩子视图开着 ⇒ `onOpenChild` / `onPrefetchChild` 缺席、`parentContext` 交回父：title 是**选中行的
   *   显示名**（`displayNameOf`，label 优先；未命名兜底也在那条），onBack 收孩子视图。
   * - `selected` 为 null（清单换版把父行收走的那一帧）⇒ `parentContext` 缺席：返回键不能指着不存在的父。
   */
  const detailNav = useMemo<DetailNav>(() => {
    if (childView === null) {
      return {
        onOpenChild: (childId: string): void => { void openChild(childId) },
        onPrefetchChild: (childId: string): void => { prefetch(childId) },
      }
    }
    if (selected === null) return {}
    return { parentContext: { title: displayNameOf(selected, t), onBack: closeChild } }
  }, [childView, selected, openChild, closeChild, prefetch, t])

  const unarchive = useCallback(async (ids: readonly string[]): Promise<void> => {
    // 行失败是面板的本地状态：进门前清这一批的旧原文，落定后按 outcome 回填——座位只交结局。
    clearRowFailures(ids)
    const run = await unarchiveFromArchiveTab({
      deps,
      ids,
      gate,
      // 自救动作只戳失效台（不直呼 reload）：A1 的同轮变化合并进同一次读。
      refresh: () => { invalidateArchive(); return Promise.resolve() },
    })
    // 被闸挡回的那一趟什么都没跑：成败由在飞那一趟说。
    if (run.kind === 'blocked') return
    setRowFailures(run.value.failures)
  }, [deps, gate, clearRowFailures, setRowFailures])

  const requestDeleteOne = useCallback((row: ArchiveRowWire): void => {
    requestDelete({ sessionId: row.sessionId, title: displayNameOf(row, t) })
  }, [t])

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
    // 选中/返回/预取/批删没有自己的判据：原样转交选中面、读路与批量确认框那一面，不包一层空壳。
    select: pick,
    selectRow,
    back,
    prefetch,
    openChild,
    closeChild,
    loadOlder,
    retry,
    unarchive,
    requestDeleteOne,
    requestDeleteMany: requestDeleteBatch,
  }
}
