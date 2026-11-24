/**
 * 回收站面板状态机：孩子视图、窄档下钻、失效重读，以及确认后的恢复/批量/清空；选中面走
 * `use-panel-selection.ts`，详情读路归 `use-trash-detail-reader.ts`。
 * 关键判据：失效通告与挂载都只触发 reload()（节奏归 `use-gated-refresh.ts`）；动作成功必须在同一趟里
 * 丢详情账本；back() 先收孩子视图、再收下钻，不碰焦点；失败原文不翻译。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BusyGate } from './busy-gate.js'
import {
  type SessionDeleteRemote,
  type TrashDetailLike,
  type TrashEntryLike,
} from './remote.js'
import type { TrashEntryWire } from '../shared/wire.js'
import {
  rowGone,
  writeSucceeded,
  readTrashSnapshot,
  noteSelection,
} from './trash-snapshot.js'
import { useTrashDetailReader } from './use-trash-detail-reader.js'
import { useTrashRevision } from './trash-store.js'
import { useGatedRefresh } from './use-gated-refresh.js'
import { useLatest } from './store.js'
import { usePanelSelection } from './use-panel-selection.js'
import { useGuardedLoadOlder, type PanelTabController } from './use-panel-tab.js'
import { usePanelChildView } from './use-panel-child-view.js'
import { rowsOf, type TrashQuery } from './use-trash-query.js'
import { purgeFromPanel, restoreFromPanel, type WriteOutcome } from './write-seats.js'

/** 待确认的动作：一条、整个回收站、或多选一批（`ids` 已按清单顺序排好）；类型归状态机。 */
export type PendingAction =
  | { kind: 'entry'; entry: TrashEntryLike }
  | { kind: 'all'; ids: readonly string[] }
  | { kind: 'entries'; ids: readonly string[] }
  | { kind: 'restore'; ids: readonly string[] }

/**
 * 控制器要的面：`query` 取清单、`reload`、清空与附件读数上屏；`ordered` 是屏幕上的顺序。
 * 输入的引用**不需稳定**：reload 回调经 `useLatest` 读最新那一份（判据住 `store.ts`）。
 */
export interface TrashPanelControllerInput {
  /** `progress` 不在这里读：slice 按「自己读或向下转发的」收——座位吃 `OneShotDeps`（含认领轮询那一格）。 */
  deps: Pick<SessionDeleteRemote, 'detail' | 'applyOutcomes' | 'progress'>
  gate: BusyGate
  query: Pick<TrashQuery, 'list' | 'reload' | 'emptyTrash' | 'noteAttachmentCleanup'>
  ordered: readonly TrashEntryLike[]
  canAutoSelect: boolean
  /** 宽档（左右两栏）为真：**没有 drill 的选中**也读详情；窄档给 false——方向键只移选中，详情栏并不在眼前。
   *  它只管选中这一条路：焦点停留 ≥150ms 的意图预取（ADR-0051）仍会热身读一次。 */
  readOnPick?: boolean
  /** 回收站档是否在眼前：不活动只记失效（修订号），不读清单。 */
  active: boolean
}

export interface TrashPanelController
  extends PanelTabController<TrashEntryLike, TrashEntryWire, TrashDetailLike> {
  readonly selectedId: string | null
  /** 正在看哪个孩子（离清单的详情导航态；null = 看清单选中那条）；单级是设计（ADR-0055）。 */
  readonly childView: TrashEntryWire | null
  readonly drilled: boolean
  readonly pending: PendingAction | null
  /** 恢复确认框要摆的这一批（按勾选顺序；清单里已找不到的 id 滤掉）。 */
  readonly pendingEntries: readonly TrashEntryLike[]
  /** 下面是面板会**摘下来转交**的动作：属性声明而不是方法简写，实现体都不读 `this`——隐式 `this` 会让
   *  `unbound-method` 把转交报成可疑。 */
  select: (entry: TrashEntryLike, options?: { drill?: boolean }) => Promise<void>
  /** 只热身、不改选中：hover / focus 时把详情读进账本与首帧快照。 */
  prefetch: (entry: TrashEntryLike) => void
  /** 构造待确认动作（唯一入口：新增一种确认只改 `PendingAction` 与确认框，不再加一串转调）。 */
  request: (action: PendingAction) => void
  cancelPending: () => void
  /** 单条恢复（`/apply` 的 N=1）：成功后丢账本，写完无论成败都重读清单，失败原文落回这一行。 */
  restore: (entry: TrashEntryLike) => Promise<void>
  /** 确认框上的「确认」：按 `pending.kind` 分派到空清或 `confirmApply`。 */
  confirmPurge: () => Promise<void>
  /** 一组 id 上的同一个动作：逐条成败落成行上原文/账本失效，整批只重读一次清单。 */
  confirmApply: (action: 'purge' | 'restore', ids: readonly string[]) => Promise<void>
}

export function useTrashPanelController(input: TrashPanelControllerInput): TrashPanelController {
  const { deps, gate, query, ordered, canAutoSelect, active } = input
  const readOnPick = input.readOnPick ?? true
  const { list, reload, emptyTrash, noteAttachmentCleanup } = query
  const entries = rowsOf(list)

  /** 首帧快照只在挂载时读一次：选中从它起步，之后由成功读数写回。 */
  const [initialSnapshot] = useState(readTrashSnapshot)

  /**
   * 选中面（`use-panel-selection.ts` 的回收站那一台）：选中行、清单换版清场、宽档自动选中、失败落点。
   */
  const {
    selectedId, selected, actionFailure, pick, clearRowFailures, setRowFailures,
  } = usePanelSelection<TrashEntryLike>({
    rows: entries,
    idOf: (entry) => entry.id,
    ordered,
    canAutoSelect,
    // 挂载时只读一次首帧快照：选中行与详情一起续上，回来第一帧就是上次的样子。
    initialId: initialSnapshot?.selectedId ?? null,
    // 只移选中（窄档方向键）时 `read:false`：不读详情，详情栏本来也不在眼前。
    onPick: (entry, pickOptions) => {
      if (pickOptions.read) void ensureDetail(entry.id)
    },
    // 那一行被清单收走：丢掉详情账本、作废在飞读数，孩子视图与下钻跟着让位（父让位就没有第二道门）。
    onGone: (entryId) => {
      rowGone(entryId)
      setChildView(null)
      resetReader(entryId)
      setDrilled(false)
    },
  })
  /** 详情主体可以离清单：孩子视图开着时画的是孩子，`selectedId` 仍指着父行。 */
  const [childView, setChildView] = useState<TrashEntryWire | null>(null)
  const [drilled, setDrilled] = useState(false)
  const [pending, setPending] = useState<PendingAction | null>(null)
  /** 失效重读的载体：`reload` 经 `useLatest` 读最新那一份（判据住 `store.ts`），失效 effect 只认 `revision`。 */
  const refreshers = useLatest({ reload })

  /** 详情现在画谁：孩子视图开着就是孩子，否则是清单选中那条（孩子不在清单里，selectedId 不动）。 */
  const subject: TrashEntryWire | null = childView ?? selected
  /** 「上一条详情还在不在清单里」的判据：保持（holding）只在它仍可见时成立。 */
  const present = useCallback(
    (entryId: string): boolean => (entries ?? []).some((entry) => entry.id === entryId),
    [entries],
  )
  /** 详情读路：账本 / 在飞 / 失败 / 保持 / 分页都住 `use-trash-detail-reader.ts`。 */
  const {
    detail,
    canNavigate,
    loadingOlder,
    olderFailure,
    ensure: ensureDetail,
    prefetch: prefetchDetail,
    loadOlder: loadOlderDetail,
    retry: retryDetail,
    clearOlderFailure,
    reset: resetReader,
  } = useTrashDetailReader({
    deps,
    subject,
    topLevel: childView === null,
    present,
    // 窄档只移选中时不自动补读；下钻 / 点行 / 重试仍显式读（焦点预取照样热身，ADR-0051）。
    autoRead: readOnPick || drilled,
  })

  // 挂载读一次清单；别处动过回收站时，这一拍再重读。档位不活动只记修订、切回来补一趟。
  // 无主子会话是设置页维护卡的手动动作（ADR-0021），不在这里顺带扫。
  const revision = useTrashRevision()
  useGatedRefresh({
    active,
    revisions: [revision],
    refresh: () => refreshers.current.reload(),
    policy: { initialDirty: true },
  })

  // 选中行写进快照：面板卸载再挂载时先画这一行。`entries` 一起进依赖：清单从 unknown 恢复时快照刚
  // 被重建，只盯 `selectedId` 会让这一次恢复永远不写回。
  useEffect(() => {
    if (selectedId !== null && entries !== null && !entries.some((entry) => entry.id === selectedId)) return
    noteSelection(selectedId)
  }, [selectedId, entries])

  // 清单未知时确认框不许留着：看不见的行不许继续被确认；写入在飞时不收。`pending` 也进依赖：
  // 打开那一刻清单已未知时同样要收。
  useEffect(() => {
    if (pending !== null && !gate.busy && list.status === 'unknown') setPending(null)
  }, [gate.busy, list.status, pending])

  /**
   * 选一条：窄档点行 = 选中并下钻；方向键 = 只移选中；宽档右栏常驻，选中即读。选清单行就是回清单。
   */
  const select = useCallback(
    async (entry: TrashEntryLike, options: { drill?: boolean } = {}): Promise<void> => {
      setChildView(null)
      if (options.drill === true) setDrilled(true)
      await pick(entry, { read: options.drill === true || readOnPick })
    },
    [pick, readOnPick],
  )

  /** 意图预取：只碰账本与在飞登记——不动选中/下钻、不碰详情上屏槽（ADR-0051）；成功不清失败态、
   *  失败不记账也不上屏。 */
  const prefetch = useCallback((entry: TrashEntryLike): void => {
    prefetchDetail(entry.id)
  }, [prefetchDetail])

  const openChild = useCallback(async (childId: string): Promise<void> => {
    // 保持期（ADR-0049）的上屏槽属于上一条：键盘/合成事件仍可能到这里，放进来的话孩子导航面会把
    // A 的分页读到 B 上，所以这一帧不接受导航（判据问 `canNavigate`）。
    if (!canNavigate) return
    // 孩子的清册行只存在于父详情那一份 `subagents` 里：id 在这里补回成行，视图侧不必先查行。
    const kids = detail.kind === 'ready' ? detail.detail.subagents : undefined
    const child = kids?.find((candidate) => candidate.id === childId)
    if (child === undefined) return
    setChildView(child)
    await ensureDetail(child.id)
  }, [canNavigate, detail, ensureDetail, setChildView])

  /**
   * 按 `olderCursor` 取更早一页；分页机制住 `use-trash-detail-reader.ts`，守卫与另一档共用
   * `useGuardedLoadOlder`（ADR-0049）。
   */
  const loadOlder = useGuardedLoadOlder(canNavigate, loadOlderDetail)

  // 清单换版清场与宽档自动选中住 `use-panel-selection.ts`（layout 阶段，ADR-0050）；本地只接 `onGone`。

  // 宽档没有下钻：拖宽后收掉残留的 `drilled`，缩回去时不至于停在详情页；不改选中、不清详情。
  useEffect(() => {
    if (canAutoSelect && drilled) setDrilled(false)
  }, [canAutoSelect, drilled])

  /**
   * 孩子视图的收口：状态仍在本控制器（ADR-0060 第 4 条），收尾顺序、返回两程与导航面共用
   * `use-panel-child-view.ts`。
   */
  const parentTitle = useCallback((row: TrashEntryLike): string => row.title, [])
  const { closeChild, back, detailNav } = usePanelChildView<TrashEntryWire, TrashEntryLike>({
    childView,
    setChildView,
    selected,
    parentTitle,
    openChild,
    prefetchChild: prefetchDetail,
    onClose: () => { clearOlderFailure() },
    backWithoutChild: () => { setDrilled(false) },
  })

  /** 恢复确认框要摆的这一批：按勾选顺序，清单里已找不到的 id 滤掉；单条与整站确认框不摆条目。 */
  const pendingEntries = useMemo(() => {
    if (pending?.kind !== 'restore') return []
    const byId = new Map((entries ?? []).map((entry) => [entry.id, entry]))
    return pending.ids.map((id) => byId.get(id)).filter((entry): entry is TrashEntryLike => entry !== undefined)
  }, [entries, pending])

  /** 「重试」只重读当前这一条，不牵清单。 */
  const retry = useCallback((): void => {
    retryDetail()
  }, [retryDetail])

  const request = useCallback((action: PendingAction): void => {
    setPending(action)
  }, [])
  const cancelPending = useCallback((): void => {
    setPending(null)
  }, [])

  /**
   * 单条恢复：整趟交给面板恢复座位，**这一行的失败落点也一并交进去**；被挡回时同样已清。成功要丢详情
   * 账本 + 重读清单（账本不失效会摆出上一世的正文），失败也重读（组回滚可能自己失败）。
   */
  const restore = useCallback(async (entry: TrashEntryLike): Promise<void> => {
    const run = await restoreFromPanel({
      deps,
      ids: [entry.id],
      single: true,
      entries,
      gate,
      refreshAfterWrite: () => reload(),
      writeSucceeded,
      // 行失败落点：清旧原文 / 铺这一趟的失败都归座位；这里只保留「被挡回那一趟不动界面」这一支。
      failureSink: { clear: clearRowFailures, set: setRowFailures },
    })
    // 被闸挡回的那一趟什么都没跑：这一行的成败由在飞那一趟说（旧原文已清）。
    if (run.kind === 'blocked') return
  }, [clearRowFailures, deps, entries, gate, reload, setRowFailures])

  /**
   * 批量彻底删除 / 批量恢复共用这一条：一次 `apply` 把整批交给 Node 半，逐条成败住在 `WriteOutcome` 里。
   * 顶层失败只说明没拿到信封，原文保守地铺到每个 id，清单照样重读。
   */
  const confirmApply = useCallback(async (action: 'purge' | 'restore', ids: readonly string[]): Promise<void> => {
    // 成败都走同一段收尾（收框 + 重读）。附件读数只住在 purge 的回执里：信封失败交 undefined（不能断言清过）。
    const settle = (outcome: WriteOutcome<'purge' | 'restore'>): Promise<void> => {
      setPending(null)
      if (action === 'purge') noteAttachmentCleanup(outcome.ok ? outcome.summary.attachmentCleanup : undefined)
      return reload()
    }
    // 面板座位：purge 清成功条目的账本并熄灭撤销横幅，restore 另忘掉 main-view 的 closedByUs（只遗忘、
    // 不重开）；逐条失败落点同座位一起交，两种收尾都由 settlement 按 anySuccess 上闸。
    const seat = {
      deps, ids, gate, refreshAfterWrite: settle, writeSucceeded,
      failureSink: { clear: clearRowFailures, set: setRowFailures },
    }
    const run = action === 'purge'
      ? await purgeFromPanel(seat)
      : await restoreFromPanel({ ...seat, entries })
    // 被闸挡回（这一趟没跑）：框、清单、逐行原文的后续都由在飞那一趟收尾（旧原文已清过）。
    if (run.kind === 'blocked') return
  }, [clearRowFailures, deps, entries, gate, reload, noteAttachmentCleanup, setRowFailures])

  /**
   * 「确认」按 `pending` 形状分派：三条按条目都委托 `confirmApply`；清空是聚合回执，走
   * `query.emptyTrash`（自己包闸），别在外面再包一层——双套会让外层 busy 提前落。
   */
  const confirmPurge = useCallback(async (): Promise<void> => {
    const target = pending
    if (target === null) return
    if (target.kind === 'entry') return confirmApply('purge', [target.entry.id])
    if (target.kind === 'entries') return confirmApply('purge', target.ids)
    if (target.kind === 'restore') return confirmApply('restore', target.ids)
    // 开框后清单可能已换版：发起清空这一拍重新冻结当前行身份，别拿开框时的旧名单认领服务端进度。
    setPending({ kind: 'all', ids: (entries ?? []).map((entry) => entry.id) })
    const run = await emptyTrash()
    // blocked = 闸挡回（连点第二下）：框不收，界面后果全归在飞那一趟；控制器只负责收框。
    if (run.kind === 'blocked') return
    setPending(null)
  }, [confirmApply, emptyTrash, entries, pending])

  return {
    busy: gate.busy,
    selected,
    selectedId,
    childView,
    detailNav,
    openChild,
    closeChild,
    drilled,
    detail,
    canNavigate,
    loadingOlder,
    olderFailure,
    pending,
    pendingEntries,
    actionFailure,
    select,
    prefetch,
    loadOlder,
    retry,
    back,
    request,
    cancelPending,
    restore,
    confirmPurge,
    confirmApply,
  }
}
