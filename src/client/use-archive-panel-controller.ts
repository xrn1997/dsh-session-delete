/**
 * 归档档面板控制器（`use-archive-panel-controller.ts`）：详情读路、解除归档、删除座位。选中面
 * （选中行、清单换版清场、宽档自动选中、失败落点）走 `use-panel-selection.ts` 的归档那一台。
 * 与回收站控制器**各持一份状态**（ADR-0060 决定第 4 条），但**读同一份实现**：分的是状态，不是判据。
 *
 * 失效接线（ADR-0060 决定第 4 条的三条来源）：
 * - 自救动作（解除归档）后只戳 `invalidateArchive()`（**不**直呼 reload；A1 随后的同一变化
 *   合并进同一次读，latest-wins 只管旧响应不盖新态）；
 * - 归档档删除落地走的是既有删除座位（`write-seats.ts`）：座位只戳回收站修订，归档查询
 *   订阅同一条修订——恢复一条已归档会话让它**回「归档」**（`wasArchived` 保留，ADR-0008）；
 * - 归档详情账本的作废挂在选中面的 `onGone` 上（那一行被清单收走时）；详情读失败只坏该行详情，
 *   不冻结清单与动作。
 */
import { useCallback, useEffect, useState } from 'react'
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
import type { ArchiveQuery } from './use-archive-query.js'
import { usePanelSelection } from './use-panel-selection.js'
import { noPresentation } from './write-settlement.js'
import { runWrite } from './write.js'

/** 归档档离清单的孩子视图：父仍是清单选中那条已归档行，看的却是它的一个子会话。 */
export interface ArchiveChildView {
  readonly parentSessionId: string
  readonly child: ArchiveSubagentWire
}

export interface ArchivePanelController {
  readonly busy: boolean
  readonly selected: ArchiveRowWire | null
  /** 正在看哪个孩子（离清单的详情导航态；null = 看清单选中那条）。单级是设计。 */
  readonly childView: ArchiveChildView | null
  readonly detail: DetailState<ArchiveDetailSubject, ArchiveDetailLike>
  readonly loadingOlder: boolean
  readonly olderFailure: string | null
  /** 失败原文按行落：不冻结清单与动作，行内各自显示。 */
  readonly actionFailure: Readonly<Record<string, string>>
  select: (row: ArchiveRowWire) => Promise<void>
  /** 窄档返回：孩子视图先回父，再按一次交还清单；宽档无此步。 */
  back: () => void
  /** 意图预取（清单行与孩子行同一条）：只热身账本，读哪一条的根由 `rootOf` 判。 */
  prefetch: (sessionId: string) => void
  /** 打开父详情里的一个孩子（未归档孩子走只读根校验）。单级：孩子视图里不再开下一层。 */
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
  /** 宽档且清单有东西：与回收站同一条自动选中判据。 */
  canAutoSelect: boolean
  t: Translate
}): ArchivePanelController {
  const { deps, gate, query, ordered, canAutoSelect, t } = input
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
  /** 详情主体：孩子视图开着就是孩子；父行被清单收走的那一拍先落空，effect 随后收孩子视图。 */
  const subject: ArchiveDetailSubject | null = selected === null
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
    subject,
    present,
    topLevel: childView === null,
    rootOf,
  })
  const { detail: detailState, ensure, forget: forgetDetail, reset: resetDetail } = reader

  /** 父行被清单换版收走（解除归档 / 删除 / 语料消失）⇒ 孩子视图失去只读根：关掉并丢账本。 */
  useEffect(() => {
    if (childView === null || rows === null) return
    if (rows.some((row) => row.sessionId === childView.parentSessionId)) return
    forgetDetail(childView.child.sessionId)
    resetDetail(childView.child.sessionId)
    setChildView(null)
  }, [rows, childView, forgetDetail, resetDetail])

  const openChild = useCallback(async (sessionId: string): Promise<void> => {
    // 单级：孩子视图里不再开下一层；保持期不接受导航（与回收站同一条）。
    if (selected === null || childView !== null || detailState.kind === 'holding') return
    const kids = detailState.kind === 'ready' ? detailState.detail.subagents : undefined
    const child = kids?.find((candidate) => candidate.sessionId === sessionId)
    if (child === undefined) return
    setChildView({ parentSessionId: selected.sessionId, child })
    await ensure(child.sessionId)
  }, [selected, childView, detailState, ensure])

  const closeChild = useCallback((): void => {
    if (childView !== null) resetDetail(childView.child.sessionId)
    setChildView(null)
  }, [childView, resetDetail])

  const back = useCallback((): void => {
    if (childView !== null) { closeChild(); return }
    drop()
  }, [childView, closeChild, drop])

  const unarchive = useCallback(async (ids: readonly string[]): Promise<void> => {
    clearRowFailures(ids)
    const run = await runWrite({
      deps,
      action: 'unarchive',
      ids,
      presentation: noPresentation('unarchive'),
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
    childView,
    detail: reader.detail,
    loadingOlder: reader.loadingOlder,
    olderFailure: reader.olderFailure,
    actionFailure,
    // 选中/返回/预取/批删没有自己的判据：原样转交选中面、读路与批量确认框那一面，不包一层空壳。
    select: pick,
    back,
    prefetch: reader.prefetch,
    openChild,
    closeChild,
    loadOlder: reader.loadOlder,
    retry: reader.retry,
    unarchive,
    requestDeleteOne,
    requestDeleteMany: requestDeleteBatch,
  }
}
