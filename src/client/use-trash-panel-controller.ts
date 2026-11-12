/**
 * 回收站面板状态机：孩子视图、窄档下钻、失效重读，以及确认后的恢复/批量/清空；选中面
 * （选中行、清单换版清场、宽档自动选中、失败落点）走 `use-panel-selection.ts` 的回收站那一台，
 * 详情读路（账本 / 在飞 / 失败 / 保持 / 分页）整块归 `use-trash-detail-reader.ts`。
 *
 * 关键判据：
 * - 清场与自动选中同帧收口那条规矩住选中面（两档同一份），这里只交本档独有的两样：
 *   `onGone` 里的孩子视图与下钻让位，以及挂载时的快照续位。
 * - 详情主体可以离清单：孩子视图 = 从这条父行点进来的下一代，`selectedId` 仍指着父行
 *   （单级是设计，ADR-0055）。
 * - 失效通告与挂载都只触发 reload()；动作成功必须在同一趟里丢详情账本。
 * - back() 先收孩子视图、再收下钻，不碰焦点；失败原文不翻译。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BusyGate } from './busy-gate.js'
import {
  type SessionDeleteRemote,
  type TrashEntryLike,
} from './remote.js'
import type { TrashEntryWire } from '../shared/wire.js'
import {
  forgetTrashDetail,
  forgetTrashDetails,
  readTrashSnapshot,
  writeTrashSelection,
} from './trash-snapshot.js'
import { useTrashDetailReader } from './use-trash-detail-reader.js'
import { useTrashRevision } from './trash-store.js'
import { useLatest } from './store.js'
import { usePanelSelection } from './use-panel-selection.js'
import type { DetailNav } from './session-detail.js'
import type { TrashDetailState } from './trash-detail.js'
import { listView, type TrashQuery } from './use-trash-query.js'
import type { WriteOutcome } from './write.js'
import { purgeFromPanel, restoreFromPanel } from './write-seats.js'

/** 待确认的动作：一条记录、整个回收站、或多选挑出来的一批（`ids` 已按清单顺序排好）。
 *  类型归状态机，视图只 import 它来渲染。 */
export type PendingAction =
  | { kind: 'entry'; entry: TrashEntryLike }
  | { kind: 'all' }
  | { kind: 'entries'; ids: readonly string[] }
  | { kind: 'restore'; ids: readonly string[] }

/**
 * 控制器要的面。`query` 取四样：清单（选中从它里面找）、`reload`（挂载、显式重试、失效与写后
 * 都是同一条读）、清空（面板的写动作那一半）、`noteAttachmentCleanup`（purge 回执里
 * 附件那半句交给查询侧拼句子上屏）。`ordered` 是键盘/自动选中用的"屏幕上的顺序"（只含展开的组），
 * 由面板算好传进来——布局常量不搬进控制器。输入的引用**不需稳定**：失效 effect 的判据只有
 * `revision`，reload 回调经 `useLatest` 读最新那一份（判据住 `store.ts`）。
 */
export interface TrashPanelControllerInput {
  deps: Pick<SessionDeleteRemote, 'detail' | 'applyOutcomes'>
  gate: BusyGate
  query: Pick<TrashQuery, 'list' | 'reload' | 'emptyTrash' | 'noteAttachmentCleanup'>
  ordered: readonly TrashEntryLike[]
  canAutoSelect: boolean
}

export interface TrashPanelController {
  readonly busy: boolean
  readonly selected: TrashEntryLike | null
  readonly selectedId: string | null
  /** 正在看哪个孩子（离清单的详情导航态；null = 看清单选中那条）。单级是设计（ADR-0055）：
   *  只有一个槽，`openChild` 换槽不叠栈，返回交还清单选中那条。 */
  readonly childView: TrashEntryWire | null
  /** 详情的导航面（开孩子 / 回父）。ADR-0055 单级判据的**唯一实现**：面板只转交它，
   *  不再自己拼 openChild / parentContext 两个派生块（判据有第二个家，视图与测试就得各自复述语义）。 */
  readonly detailNav: DetailNav
  /** 打开一个孩子（父详情子会话段点进来）：按 id 在这条父详情的孩子里找到那一行，读它的详情，
   *  清单选中不动。id 交接是 `DetailNav` 的形状——两档共用一面，视图不必先查出清册行。 */
  openChild(childId: string): Promise<void>
  /** 回到父详情（详情顶部那颗「返回父会话」；窄档 back/Esc 的第一程也走它）。 */
  closeChild(): void
  readonly drilled: boolean
  readonly detail: TrashDetailState
  /** 更早一页正在读（只对当前详情主体有意义：孩子视图开着就是孩子）。 */
  readonly loadingOlder: boolean
  /** 更早一页读失败的原文（只对当前详情主体有意义；正文本身仍是 ready）。 */
  readonly olderFailure: string | null
  /** 待确认的那一批（确认框的开合）；确认落地后由控制器收起。 */
  readonly pending: PendingAction | null
  /** 恢复确认框要摆的这一批（按勾选顺序；清单里已找不到的 id 滤掉）。 */
  readonly pendingEntries: readonly TrashEntryLike[]
  /** 恢复/彻底删除/批量 的失败原文，按条目 id 存：切走再回来还在。 */
  readonly actionFailure: Readonly<Record<string, string>>
  /** 下面是面板会**摘下来转交**的动作（导航的 `select`/`back`、确认框的 `cancelPending`）：
   *  属性声明而不是方法简写，实现体都不读 `this`。方法简写的隐式 `this` 会让 `unbound-method`
   *  把转交报成可疑；改形状是纯类型面，零运行时改动。 */
  select: (entry: TrashEntryLike, options?: { drill?: boolean }) => Promise<void>
  /** 只热身、不改选中：hover / focus 时把详情读进账本与首帧快照。 */
  prefetch: (entry: TrashEntryLike) => void
  /** 按当前详情的 `olderCursor` 读更早一页，拼到现有块前面。 */
  loadOlder: () => Promise<void>
  retry: () => void
  back: () => void
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
  const { deps, gate, query, ordered, canAutoSelect } = input
  const { list, reload, emptyTrash, noteAttachmentCleanup } = query
  const entries = listView(list).rows

  /** 首帧快照只在挂载时读一次：选中从它起步，之后由成功读数写回。 */
  const [initialSnapshot] = useState(readTrashSnapshot)

  /**
   * 选中面（`use-panel-selection.ts` 的回收站那一台）：选中行、清单换版清场、宽档自动选中、
   * 动作失败落点。两档读同一份实现，各持一份状态（ADR-0060 决定第 4 条）。
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
    onPick: (entry) => ensureDetail(entry.id),
    // 那一行被清单收走：丢掉它的详情账本、作废在飞读数，孩子视图与下钻跟着让位
    // （孩子是从这条父行点进来的，父让位了就没有第二道门）。选中 id 由选中面清。
    onGone: (entryId) => {
      forgetTrashDetail(entryId)
      setChildView(null)
      resetReader(entryId)
      setDrilled(false)
    },
  })
  /** 详情主体可以离清单：孩子视图开着时画的是孩子，`selectedId` 仍指着父行。 */
  const [childView, setChildView] = useState<TrashEntryWire | null>(null)
  const [drilled, setDrilled] = useState(false)
  const [pending, setPending] = useState<PendingAction | null>(null)
  /** 失效重读的载体：`reload` 回调经 `useLatest` 读最新那一份（判据住 `store.ts`），
   *  失效 effect 的判据只有 `revision`——挂载首拍与后续通告现在是同一个动作，不再分两支。 */
  const refreshers = useLatest({ reload })

  /** 详情现在画谁：孩子视图开着就是孩子，否则是清单选中那条。孩子不在清单里，
   *  所以它是离清单的导航态——selectedId 不动，清场/自动选中/组动作全部照旧。 */
  const subject: TrashEntryWire | null = childView ?? selected
  /** 「上一条详情还在不在清单里」的判据：保持（holding）只在它仍可见时成立。 */
  const present = useCallback(
    (entryId: string): boolean => (entries ?? []).some((entry) => entry.id === entryId),
    [entries],
  )
  /** 详情读路：账本 / 在飞 / 失败 / 保持 / 分页都住 `use-trash-detail-reader.ts`。 */
  const {
    detail,
    loadingOlder,
    olderFailure,
    ensure: ensureDetail,
    prefetch: prefetchDetail,
    loadOlder: loadOlderDetail,
    retry: retryDetail,
    clearOlderFailure,
    reset: resetReader,
  } = useTrashDetailReader({ deps, subject, topLevel: childView === null, present })

  // 挂载读一次清单；别处动过回收站（侧栏菜单里删了一条、或撤销了另一条）时，这一拍再重读。
  // 无主子会话不再顺带扫：那是设置页维护卡的手动动作（ADR-0021）。
  const revision = useTrashRevision()
  useEffect(() => {
    void refreshers.current.reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `refreshers` 是 `useLatest` 的恒稳 ref（规则看不见自定义 hook）；失效判据只有 `revision`。
  }, [revision])

  // 选中行写进快照：面板卸载再挂载时先画这一行；重读回来若它不在了，清场 effect 再让位。
  // `entries` 一起进依赖：清单从 unknown 恢复时快照刚被重建（`reconcileTrashRows` 拿不到当前选中），
  // 只盯 `selectedId` 会让这一次恢复永远不写回，下一次挂载窄档就丢掉选中。
  useEffect(() => {
    if (selectedId !== null && entries !== null && !entries.some((entry) => entry.id === selectedId)) return
    writeTrashSelection(selectedId)
  }, [selectedId, entries])

  // 清单未知时，确认框不许留着：看不见的行不许继续被确认；写入在飞时不收（那一趟还在跑）。
  // `pending` 也进依赖：打开那一刻清单已经未知时同样要收，不能只靠「进入 unknown」这一次迁移。
  useEffect(() => {
    if (pending !== null && !gate.busy && list.status === 'unknown') setPending(null)
  }, [gate.busy, list.status, pending])

  /**
   * 选一条：命中账本就直接摆（不经过 loading），没命中才去读那条会话自己的日志。
   * `drill` 是窄档的第二步语义（点行 = 选中并下钻；方向键 = 只移动选中）。
   * 选清单行就是回清单：孩子视图跟着收掉（详情主体交还给选中那条）。
   */
  const select = useCallback(
    async (entry: TrashEntryLike, options: { drill?: boolean } = {}): Promise<void> => {
      setChildView(null)
      if (options.drill === true) setDrilled(true)
      await pick(entry)
    },
    [pick],
  )

  /** 意图预取：只热身详情账本，不动选中/下钻，也不碰详情上屏槽——不会把保持中的上一条顶成
   *  骨架。只碰账本与在飞登记：成功不清失败态、失败不记账也不上屏（ADR-0051）；选中它时
   *  `ensureDetail` 才读/重试。 */
  const prefetch = useCallback((entry: TrashEntryLike): void => {
    prefetchDetail(entry.id)
  }, [prefetchDetail])

  const openChild = useCallback(async (childId: string): Promise<void> => {
    // 保持期（ADR-0049）的上屏槽属于上一条：正文是 inert 的，指针点不到；但键盘/合成事件仍可能
    // 到这里。放进来的话，孩子导航面会把 A 的分页读到 B 上，所以这一帧不接受导航。
    if (detail.kind === 'holding') return
    // 孩子的清册行只存在于**父详情**那一份 `subagents` 里（它不在客户端清单上）：id 在这里补回成行，
    // 视图侧的导航面因此不必先查行——两档共用一面的代价就收在这一处。
    const kids = detail.kind === 'ready' ? detail.detail.subagents : undefined
    const child = kids?.find((candidate) => candidate.id === childId)
    if (child === undefined) return
    setChildView(child)
    await ensureDetail(child.id)
  }, [detail, ensureDetail, setChildView])

  const closeChild = useCallback((): void => {
    setChildView(null)
    clearOlderFailure()
  }, [clearOlderFailure, setChildView])

  /**
   * 按当前详情的 `olderCursor` 取更早一页，拼到现有块前面。判据（没有游标 / 在飞去重 /
   * 晚到不落屏 / 失败只坏分页）全在 `use-trash-detail-reader.ts`。
   * 保持期不接受：那一帧画的是上一条的正文，翻页会把它的游标读进新主体（ADR-0049）。
   */
  const loadOlder = useCallback(async (): Promise<void> => {
    if (detail.kind === 'holding') return
    await loadOlderDetail()
  }, [detail.kind, loadOlderDetail])

  // 清单换版清场与宽档自动选中都在 `use-panel-selection.ts`（layout 阶段，ADR-0050）；
  // 这一台通过 `onGone` 把「父行让位 ⇒ 孩子视图跟着收」那条本地规矩接进去。

  // 宽档没有「下钻」这一层：从窄档拖宽后把残留的 `drilled` 收掉，缩回去时不至于直接停在详情页。
  // 它不改选中、不清详情；宽档右栏本来就在读这一条。
  useEffect(() => {
    if (canAutoSelect && drilled) setDrilled(false)
  }, [canAutoSelect, drilled])

  /**
   * 详情的导航面（ADR-0055 单级判据的唯一实现，住控制器）：
   * - 孩子视图没开（主体是清单选中那条）⇒ `onOpenChild` 在场、`parentContext` 缺席。
   *   在孩子视图里再开一层会造出第二套导航路径，还会让那颗返回指着孙辈说话（更深一代走清单可达，
   *   判据住 `src/trash/groups.ts`），所以入口只在这半边交出。
   * - 孩子视图开着 ⇒ `onOpenChild` 缺席、`parentContext` 交回父：title 是**选中行的原文**
   *   （未命名兜底由视图按 t 处理，控制器不碰翻译），onBack 收孩子视图。
   * - `selected` 为 null（清单换版把父行收走的那一帧，清场 effect 随后也把孩子视图收掉）
   *   ⇒ `parentContext` 缺席：返回键不能指着一个不存在的父。
   */
  const detailNav = useMemo<DetailNav>(() => {
    if (childView === null) {
      return {
        onOpenChild: (childId: string): void => { void openChild(childId) },
        // 与入口同进同出：孩子视图里不再多一条读路，返回父之后才重新交出。
        onPrefetchChild: (childId: string): void => { prefetchDetail(childId) },
      }
    }
    if (selected === null) return {}
    return { parentContext: { title: selected.title, onBack: closeChild } }
  }, [childView, selected, openChild, closeChild, prefetchDetail])

  /** 恢复确认框要摆的这一批：按勾选顺序，清单里已经找不到的 id 滤掉
   *  （别的窗口刚动过；重读会把勾选也剔掉）。单条与整站确认框不摆条目，各自念自己的那一句。 */
  const pendingEntries = useMemo(() => {
    if (pending?.kind !== 'restore') return []
    const byId = new Map((entries ?? []).map((entry) => [entry.id, entry]))
    return pending.ids.map((id) => byId.get(id)).filter((entry): entry is TrashEntryLike => entry !== undefined)
  }, [entries, pending])

  /** 「重试」只重读当前这一条，不牵清单。 */
  const retry = useCallback((): void => {
    retryDetail()
  }, [retryDetail])

  /** 窄档返回/Esc 的两程：孩子视图开着先回父详情（仍下钻），再按一次才退出下钻。
   *  选中留着，详情不清；焦点不动（Esc 那条归 `trash-nav.ts`）。 */
  const back = useCallback((): void => {
    if (childView !== null) { closeChild(); return }
    setDrilled(false)
  }, [childView, closeChild])

  const request = useCallback((action: PendingAction): void => {
    setPending(action)
  }, [])
  const cancelPending = useCallback((): void => {
    setPending(null)
  }, [])

  /**
   * 单条恢复：**先清掉这一行的旧失败**（再点一次不该还挂着上一次的原文），再把整趟交给面板恢复座位。
   * 成功要丢详情账本 + 重读清单——账本不失效的话，这条会话再被删回来时会直接摆出上一世的正文。
   * 失败也重读：组回滚可能自己失败（`details.rollbackFailures`），清单不能继续摆旧行。
   * 「重读也在这趟里」由 `runWrite` 的闸保证：旧清单还在屏上时同一个动作不能被再点一次——再点那一次
   * 被同步挡回、整趟不跑（座位交回 blocked），这一行保持原样，等在飞那一趟的结论。
   * 单条恢复走 `single` 读法，`already-gone` 不可能出现，座位里那条查找兜底在此不会命中。
   * 座位的 refresh 仍按 `WriteOutcome` 给（那只信封里没有附件读数要转交）：这里只把它换成"重读"这一个动作，
   * outcome 不再流向 query——孤儿重扫判据已不在面板（ADR-0021）。座位字段仍叫 `refreshAfterWrite`
   * （`write-seats.ts` 的信封接口，写座位自己的名字），与清单重读已合一的旧双名无关。
   */
  const restore = useCallback(async (entry: TrashEntryLike): Promise<void> => {
    clearRowFailures([entry.id])
    const run = await restoreFromPanel({
      deps,
      ids: [entry.id],
      single: true,
      entries,
      gate,
      refreshAfterWrite: () => reload(),
      forgetTrashDetails,
    })
    // 被闸挡回的那一趟什么都没跑：这一行的成败由在飞那一趟说，这里不再补失败原文
    // （进入时清旧失败那一下已在同一动作里发生）。
    if (run.kind === 'blocked') return
    const failure = run.value.failures.get(entry.id)
    if (failure !== undefined) setRowFailures(new Map([[entry.id, failure]]))
  }, [clearRowFailures, deps, entries, gate, reload, setRowFailures])

  /**
   * 批量彻底删除 / 批量恢复**共用这一条**：一次 `apply` 把整批交给 Node 半，逐条成败住在
   * `WriteOutcome` 里 ⇒ 不再"每条一次全量重读"。顶层失败（路由自检 / 通道断）只说明没拿到信封，
   * 不能断言哪几条落地：原文保守地铺到每一个 id（别让清单看起来"删成功了"），清单照样重读。
   */
  const confirmApply = useCallback(async (action: 'purge' | 'restore', ids: readonly string[]): Promise<void> => {
    // 这一趟碰到的行先清掉旧失败：再点一次不该还挂着上一次的原文。
    clearRowFailures(ids)
    // 成败都走同一段收尾（写完框就收、清单就重读）。无主子会话的重扫已不在面板：要不要扫由设置页
    // 维护卡的手动检查决定（ADR-0021），这里只交"重读"本身。
    // 附件读数只住在 purge 的回执里：信封成功就交摘要那半（逐条全失败时摘要也没有读数 ⇒ 旧提示会收掉），
    // 顶层失败没拿到信封、不能断言清过 ⇒ 交 `undefined`。restore 不碰它。
    const settle = (outcome: WriteOutcome<'purge' | 'restore'>): Promise<void> => {
      setPending(null)
      if (action === 'purge') noteAttachmentCleanup(outcome.ok ? outcome.summary.attachmentCleanup : undefined)
      return reload()
    }
    // 面板座位：purge 清成功条目的详情账本并熄灭指向它们的撤销横幅；restore 另忘掉 main-view 的
    // closedByUs（只遗忘、不重开）。两样都由 settlement 按 anySuccess 上闸。
    const seat = { deps, ids, gate, refreshAfterWrite: settle, forgetTrashDetails }
    const run = action === 'purge'
      ? await purgeFromPanel(seat)
      : await restoreFromPanel({ ...seat, entries })
    // 座位被闸挡回（这一趟没跑）：框、清单、逐行原文的后续都由在飞那一趟收尾；这里不再追加后果
    // （进入时清旧失败那一下已在同一动作里发生）。
    if (run.kind === 'blocked') return
    setRowFailures(run.value.failures)
  }, [clearRowFailures, deps, entries, gate, reload, noteAttachmentCleanup, setRowFailures])

  /**
   * 确认框上的「确认」按 `pending` 的形状分派：三条按条目标都委托 `confirmApply`（一段 `/apply`）；
   * 清空是**聚合回执**、形状不同，走 `query.emptyTrash`——`emptyTrash` 自己包闸；这条不是 `/apply`
   * 座位，别在外面再包一层（双套会让外层 busy 提前落下）。
   */
  const confirmPurge = useCallback(async (): Promise<void> => {
    const target = pending
    if (target === null) return
    if (target.kind === 'entry') return confirmApply('purge', [target.entry.id])
    if (target.kind === 'entries') return confirmApply('purge', target.ids)
    if (target.kind === 'restore') return confirmApply('restore', target.ids)
    const run = await emptyTrash()
    // `blocked` 是闸把这一趟挡回来了（连点的第二下）：这一趟没跑 ⇒ 框不收，
    // 界面后果全归在飞那一趟。成功的清单重读、撤销熄灭与详情账本作废都归 `emptyTrash`
    // 那一趟（它才拥有挂载归属）；控制器只负责收框。
    if (run.kind === 'blocked') return
    setPending(null)
  }, [confirmApply, emptyTrash, pending])

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
