/**
 * 回收站面板状态机：选中、孩子视图、详情缓存、窄档下钻、清单换版清场、宽档自动选中、
 * 失效重读，以及确认后的恢复/批量/清空与失败落点。
 *
 * 关键判据：
 * - 选中从全量条目里找，不从键盘序列 ordered 找；折叠组只影响清单列。
 * - 详情成功读数按条目 id 缓存；失败不缓存，重试会重新读。
 * - 选中 id 不在新清单里 ⇒ 丢缓存、清选中、退出下钻；清单读不到（null）不算“没了”。
 * - 自动选中只在 selectedId 为 null 时接管。
 * - 失效通告与挂载都只触发 reload()；动作成功必须在同一趟里丢详情缓存。
 * - back() 先收孩子视图、再收下钻，不碰焦点；失败原文不翻译。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BusyGate } from './busy-gate.js'
import {
  callRemote,
  type SessionDeleteRemote,
  type TrashDetailLike,
  type TrashEntryLike,
} from './remote.js'
import type { TrashEntryWire } from '../shared/wire.js'
import { useTrashRevision } from './trash-store.js'
import { useLatest } from './store.js'
import type { DetailNav, TrashDetailState } from './trash-detail.js'
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
  /** 正在看哪个孩子（离清单的详情导航态；null = 看清单选中那条）。单级是设计（ADR-0029）：
   *  只有一个槽，`openChild` 换槽不叠栈，返回交还清单选中那条。 */
  readonly childView: TrashEntryWire | null
  /** 详情的导航面（开孩子 / 回父）。ADR-0029 单级判据的**唯一实现**：面板只转交它，
   *  不再自己拼 openChild / parentContext 两个派生块（判据有第二个家，视图与测试就得各自复述语义）。 */
  readonly detailNav: DetailNav
  /** 打开一个孩子（父详情子会话段点进来）：读它的详情，但清单选中不动。 */
  openChild(child: TrashEntryWire): Promise<void>
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
  /** 按当前详情的 `olderCursor` 读更早一页，拼到现有块前面。 */
  loadOlder: () => Promise<void>
  retry: () => void
  back: () => void
  /** 构造待确认动作（唯一入口：新增一种确认只改 `PendingAction` 与确认框，不再加一串转调）。 */
  request: (action: PendingAction) => void
  cancelPending: () => void
  /** 单条恢复（`/apply` 的 N=1）：成功后丢缓存，写完无论成败都重读清单，失败原文落回这一行。 */
  restore: (entry: TrashEntryLike) => Promise<void>
  /** 确认框上的「确认」：按 `pending.kind` 分派到空清或 `confirmApply`。 */
  confirmPurge: () => Promise<void>
  /** 一组 id 上的同一个动作：逐条成败落成行上原文/缓存失效，整批只重读一次清单。 */
  confirmApply: (action: 'purge' | 'restore', ids: readonly string[]) => Promise<void>
}

/** 失败按**哪一条**记：只有失败那条与当前选中行同 id 时才会进详情块，别的条目失败不会串台。 */
interface DetailFailure {
  entryId: string
  message: string
}

/**
 * 「渲染态 + 同步镜像」成对出现时的唯一写口：setter 同步更新 ref。`setState` 要等下一拍，
 * 而落地判「用户还在不在这一条」（`loadOlder` 的晚到结果）是同一 tick 里的事。写只走 setter——
 * 再手写一处 `ref.current = x` 就是第二份同步，两处迟早漂移。
 */
function useSyncedRef<T>(initial: T): [T, (value: T) => void, { readonly current: T }] {
  const ref = useRef(initial)
  const [value, setValue] = useState(initial)
  const set = useCallback((next: T): void => {
    ref.current = next
    setValue(next)
  }, [])
  return [value, set, ref]
}

/** 在飞句柄的动作面：四个方法都是稳定引用，可以放心进 callback / effect 的依赖。 */
interface InFlight {
  /** 渲染位摆到这一条（`null` 收掉）：在飞早退前也要摆——loading 得跟着选中走。 */
  show(id: string | null): void
  /** 登记一条在飞；这一条已经在飞就回 false（调用方早退，不发第二条）。 */
  begin(id: string): boolean
  /** 落地收尾：摘登记；渲染位还指着自己才收（晚到的别按掉新的一拍）。 */
  end(id: string): void
  /** 全收：清单换版把选中那条收走时，这一趟的分页账也跟着清。 */
  clear(): void
}

/**
 * 在飞句柄：`/detail` 与「更早一页」各持一份。两条时间线各有自己的载体，别混——判重在
 * **同步**这一侧（`begin`：同一 tick 连点不发第二条；登记按条目，A 在飞不挡 B，也绝不放
 * 同一条进两条），上屏在 **state** 那一侧（渲染位单槽要等下一拍，只回答「当前这条转不转圈」）。
 * 置位/清位只走这四个方法，不再一对 state+ref 镜像各写一份同步。
 */
function useInFlight(): readonly [string | null, InFlight] {
  const flying = useRef(new Set<string>())
  const [shownId, setShownId] = useState<string | null>(null)
  const show = useCallback((id: string | null): void => setShownId(id), [])
  const begin = useCallback((id: string): boolean => {
    if (flying.current.has(id)) return false
    flying.current.add(id)
    return true
  }, [])
  const end = useCallback((id: string): void => {
    flying.current.delete(id)
    setShownId((current) => (current === id ? null : current))
  }, [])
  const clear = useCallback((): void => {
    flying.current.clear()
    setShownId(null)
  }, [])
  const flight = useMemo<InFlight>(() => ({ show, begin, end, clear }), [show, begin, end, clear])
  return [shownId, flight] as const
}

export function useTrashPanelController(input: TrashPanelControllerInput): TrashPanelController {
  const { deps, gate, query, ordered, canAutoSelect } = input
  const { list, reload, emptyTrash, noteAttachmentCleanup } = query
  const entries = listView(list).rows

  const [selectedId, setSelectedId, selectedIdRef] = useSyncedRef<string | null>(null)
  /** 详情主体可以离清单：孩子视图开着时画的是孩子，`selectedId` 仍指着父行。 */
  const [childView, setChildView, childViewRef] = useSyncedRef<TrashEntryWire | null>(null)
  const [drilled, setDrilled] = useState(false)
  const [detailShown, detailFlight] = useInFlight()
  const [detailFailure, setDetailFailure] = useState<DetailFailure | null>(null)
  const [olderShown, olderFlight] = useInFlight()
  const [olderFailureState, setOlderFailure] = useState<DetailFailure | null>(null)
  /** 缓存是 ref：合并更早一页后要有一个**必然变化**的 state 把新对象推上屏（极快的响应会把
   *  分页渲染位的置位/清位合批成净零变化，React 会直接 bail out）。 */
  const [detailVersion, setDetailVersion] = useState(0)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [actionFailure, setActionFailure] = useState<Readonly<Record<string, string>>>({})
  /** 面板存活期内每条只读一次（本机量级不值得预读，也不值得重复读）。 */
  const detailCache = useRef(new Map<string, TrashDetailLike>())
  /** 失效重读的载体：`reload` 回调经 `useLatest` 读最新那一份（判据住 `store.ts`），
   *  失效 effect 的判据只有 `revision`——挂载首拍与后续通告现在是同一个动作，不再分两支。 */
  const refreshers = useLatest({ reload })

  // 挂载读一次清单；别处动过回收站（侧栏菜单里删了一条、或撤销了另一条）时，这一拍再重读。
  // 无主子会话不再顺带扫：那是设置页维护卡的手动动作（ADR-0021）。
  const revision = useTrashRevision()
  useEffect(() => {
    void refreshers.current.reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `refreshers` 是 `useLatest` 的恒稳 ref（规则看不见自定义 hook）；失效判据只有 `revision`。
  }, [revision])

  // 清单未知时，确认框不许留着：看不见的行不许继续被确认；写入在飞时不收（那一趟还在跑）。
  // `pending` 也进依赖：打开那一刻清单已经未知时同样要收，不能只靠「进入 unknown」这一次迁移。
  useEffect(() => {
    if (pending !== null && !gate.busy && list.status === 'unknown') setPending(null)
  }, [gate.busy, list.status, pending])

  /** 按 entryId 确保详情在缓存里：命中直接摆，没命中读一次（在飞闸挡重复）。
   *  选中（select）与孩子视图（openChild）共用这一条读路——缓存/在飞/失败都按 entryId 键控，
   *  谁在屏幕上是 subject 的事，不是读路的事。 */
  const ensureDetail = useCallback(async (entryId: string): Promise<void> => {
    if (detailCache.current.has(entryId)) {
      detailFlight.show(null)
      setDetailFailure(null)
      return
    }
    // loading 先摆到这一条上，**再**判在飞：在飞时早退也得让 loading 跟着选中走。
    // 反过来写（先判在飞、后摆 loading）会留下一条卡死的路：A 在飞 → 选 B → 再选 A，
    // A 的回执落地时 loading 还指着 B，没有任何 state 变化，详情块永远停在 loading。
    detailFlight.show(entryId)
    setDetailFailure(null)
    // 同一条在飞时不重复发 `/detail`（宽档双击同一行会打两条）。
    if (!detailFlight.begin(entryId)) return
    const outcome = await callRemote(() => deps.detail(entryId))
    // 只收自己那一拍的 loading：期间已经切到别的条目时，别把新的那一拍按掉。
    detailFlight.end(entryId)
    if (outcome.ok) detailCache.current.set(entryId, outcome.value)
    else setDetailFailure({ entryId, message: outcome.failure.message })
  }, [deps, detailFlight])

  /**
   * 选一条：命中缓存就直接摆（不经过 loading），没命中才去读那条会话自己的日志。
   * `drill` 是窄档的第二步语义（点行 = 选中并下钻；方向键 = 只移动选中）。
   * 选清单行就是回清单：孩子视图跟着收掉（详情主体交还给选中那条）。
   */
  const select = useCallback(
    async (entry: TrashEntryLike, options: { drill?: boolean } = {}): Promise<void> => {
      setChildView(null)
      setSelectedId(entry.id)
      setOlderFailure(null)
      if (options.drill === true) setDrilled(true)
      await ensureDetail(entry.id)
    },
    // 三个 setter（`setChildView` / `setSelectedId` / `setOlderFailure`）都是恒稳引用，不进依赖，
    // 与 `openChild`、`closeChild` 同一条写法。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setChildView / setSelectedId 是 React 的恒稳 setter（规则看不见 setState 的恒等性）。
    [ensureDetail],
  )

  const openChild = useCallback(async (child: TrashEntryWire): Promise<void> => {
    setChildView(child)
    setOlderFailure(null)
    await ensureDetail(child.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setChildView / setOlderFailure 是恒稳 setter，不进依赖是本文件既有写法。
  }, [ensureDetail])

  const closeChild = useCallback((): void => {
    setChildView(null)
    setOlderFailure(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只调恒稳 setter，无外部读数可依赖。
  }, [])

  /**
   * 按当前详情的 `olderCursor` 取更早一页，拼到现有块前面。
   *
   * 三条判据：没有游标 / 这一条已有更早页在飞 ⇒ 不发请求（同一 tick 连点、或切走再切回都撞
   * 在飞登记——晚到的第二条注定落不了屏，白打一次往返）；用户已经切走或缓存已被换掉 ⇒ 晚到的
   * 页**不落屏**（A 的更早页不许盖掉 B）；失败只走 `olderFailure`，已读到的正文照旧是 ready。
   */
  const loadOlder = useCallback(async (): Promise<void> => {
    const entryId = childView?.id ?? selectedId
    if (entryId === null) return
    const cached = detailCache.current.get(entryId)
    if (cached === undefined || cached.olderCursor === null) return
    // 渲染位先摆到这一条，**再**判在飞（与 `ensureDetail` 同一条顺序）：另一条占过这个槽之后切回来点，
    // 这一条其实已经在读——不先摆，按钮看着可点却静默无动作。摆了也只是按一次 loading，
    // `begin` 回 false 就不发第二条。
    olderFlight.show(entryId)
    setOlderFailure(null)
    if (!olderFlight.begin(entryId)) return

    const cursor = cached.olderCursor
    const outcome = await callRemote(() => deps.detail(entryId, cursor))
    olderFlight.end(entryId)
    // 晚到结果只在「用户还在这一条」时落屏：状态闭包读到的是发请求那一刻的主体，判最新值走镜像。
    // 孩子那一面也要比：孩子的 id 从来不等于清单选中，只比选中会把孩子的每一页都丢掉。
    if ((childViewRef.current?.id ?? selectedIdRef.current) !== entryId) return
    const current = detailCache.current.get(entryId)
    if (current !== cached) return
    if (outcome.ok) {
      detailCache.current.set(entryId, {
        ...current,
        blocks: [...outcome.value.blocks, ...current.blocks],
        olderCursor: outcome.value.olderCursor,
      })
      setDetailVersion((version) => version + 1)
      return
    }
    setOlderFailure({ entryId, message: outcome.failure.message })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `childViewRef` / `selectedIdRef` 是 ref（恒稳），读的是 `.current`；规则把 ref 也当读数。
  }, [deps, childView, selectedId, olderFlight])

  // 清单换了（别处删了一条、恢复成功、彻底删除成功）：选中那条已经不在了就让位，并把它的缓存丢掉。
  // 下面那条自动选中以「尚未选中」为门，所以这一拍（选中还在）它不抢；清场落地后的下一拍才接住。
  useEffect(() => {
    if (entries === null || selectedId === null) return
    if (entries.some((entry) => entry.id === selectedId)) return
    detailCache.current.delete(selectedId)
    setSelectedId(null)
    // 孩子是从这条父行点进来的：父让位了，孩子视图跟着清场（它自己不在清单里，没有第二道门）。
    setChildView(null)
    olderFlight.clear()
    setDrilled(false)
    setOlderFailure(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `setChildView` 是 React 的恒稳 setter（规则看不见恒等性）；其余读数都已在数组里。
  }, [entries, selectedId, setSelectedId, olderFlight])

  // 宽档没有「下钻」这一层：从窄档拖宽后把残留的 `drilled` 收掉，缩回去时不至于直接停在详情页。
  // 它不改选中、不清详情；宽档右栏本来就在读这一条。
  useEffect(() => {
    if (canAutoSelect && drilled) setDrilled(false)
  }, [canAutoSelect, drilled])

  // 宽档首读完成后自动选中第一条：右栏空着比多一次点击更怪（窄档不自动下钻）。
  // `canAutoSelect` 由面板算（盒子够宽且清单里有东西），控制器不认布局常量。
  useEffect(() => {
    const first = ordered[0]
    if (canAutoSelect && selectedId === null && first !== undefined) void select(first)
  }, [canAutoSelect, selectedId, ordered, select])

  /**
   * 选中那条从**全量条目**里找，不从 `ordered`（只含展开的组）里找：折叠组只是把那一列收掉，
   * 右栏那条不该跟着消失——详情读的是这条会话，跟清单怎么分段无关。
   */
  const selected = useMemo(
    () => (entries ?? []).find((entry) => entry.id === selectedId) ?? null,
    [entries, selectedId],
  )

  /** 详情现在画谁：孩子视图开着就是孩子，否则是清单选中那条。孩子不在清单里，
   *  所以它是离清单的导航态——selectedId 不动，清场/自动选中/组动作全部照旧。 */
  const subject: TrashEntryWire | null = childView ?? selected

  /**
   * 详情的导航面（ADR-0029 单级判据的唯一实现，住控制器）：
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
      return { onOpenChild: (child: TrashEntryWire): void => { void openChild(child) } }
    }
    if (selected === null) return {}
    return { parentContext: { title: selected.title, onBack: closeChild } }
  }, [childView, selected, openChild, closeChild])

  /** 恢复确认框要摆的这一批：按勾选顺序，清单里已经找不到的 id 滤掉
   *  （别的窗口刚动过；重读会把勾选也剔掉）。单条与整站确认框不摆条目，各自念自己的那一句。 */
  const pendingEntries = useMemo(() => {
    if (pending?.kind !== 'restore') return []
    const byId = new Map((entries ?? []).map((entry) => [entry.id, entry]))
    return pending.ids.map((id) => byId.get(id)).filter((entry): entry is TrashEntryLike => entry !== undefined)
  }, [entries, pending])

  const detail = useMemo<TrashDetailState>(() => {
    if (subject === null) return { kind: 'idle' }
    if (detailShown === subject.id) return { kind: 'loading', entry: subject }
    const cached = detailCache.current.get(subject.id)
    if (cached !== undefined) return { kind: 'ready', entry: subject, detail: cached }
    if (detailFailure?.entryId === subject.id) {
      return { kind: 'failed', entry: subject, message: detailFailure.message }
    }
    // 兜底：选中了、这一拍没有在飞的读、缓存刚被某个动作清掉（恢复 / 整批 / 清空）——先按
    // 「读着」摆着，下一次 `select` / `openChild` / `retry` 或清单换版会把状态推到 ready / failed / idle，
    // 不会永久停在这里。
    return { kind: 'loading', entry: subject }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `detailVersion` 不能删：详情缓存是 `useRef(new Map())`，只有这个必然变化的信号能让 memo 知道缓存被 prepend 过。删了 = 「加载更早」读回来了但不落屏。
  }, [subject, detailShown, detailFailure, detailVersion])

  /** 分页/失败都只对当前详情主体上屏（孩子视图开着就是孩子）；切到别的条目时它们是别人家的旧账。 */
  const subjectId = subject?.id ?? null
  const loadingOlder = subjectId !== null && olderShown === subjectId
  const olderFailure = olderFailureState !== null && olderFailureState.entryId === subjectId
    ? olderFailureState.message
    : null

  /** 「重试」只重读当前这一条，不牵清单。 */
  const retry = useCallback((): void => {
    if (childView !== null) { void ensureDetail(childView.id); return }
    if (selected !== null) void select(selected)
  }, [childView, ensureDetail, selected, select])

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

  /** 一次动作的失败原文落回它自己那一行（按条目 id 存，别条目的成败不会串台）。 */
  const failRow = useCallback((entryId: string, message: string): void => {
    setActionFailure((current) => ({ ...current, [entryId]: message }))
  }, [])

  /** 成功支（含 already-gone）的条目丢详情缓存。 */
  const clearDetailCache = useCallback((successIds: readonly string[]): void => {
    for (const id of successIds) detailCache.current.delete(id)
  }, [])

  /** 清掉这些行的旧失败；没有任何一行挂着失败时原样返回，不触发多余的一拍。 */
  const clearRowFailures = useCallback((ids: readonly string[]): void => {
    setActionFailure((current) => {
      let changed = false
      const next = { ...current }
      for (const id of ids) {
        if (Object.hasOwn(next, id)) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- `next` 是本函数刚浅拷出来的本地副本，删的是自己的键；不存在共享对象/原型链问题。
          delete next[id]
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [])

  /**
   * 单条恢复：**先清掉这一行的旧失败**（再点一次不该还挂着上一次的原文），再把整趟交给面板恢复座位。
   * 成功要丢详情缓存 + 重读清单——缓存不失效的话，这条会话再被删回来时会直接摆出上一世的正文。
   * 失败也重读：组回滚可能自己失败（`details.rollbackFailures`），清单不能继续摆旧行。
   * 「重读也在这趟里」由 `runWrite` 的闸保证：旧清单还在屏上时同一个动作不能被再点一次——再点那一次
   * 被同步挡回、整趟不跑（座位交回 `undefined`），这一行保持原样，等在飞那一趟的结论。
   * 单条恢复走 `single` 读法，`already-gone` 不可能出现，座位里那条查找兜底在此不会命中。
   * 座位的 refresh 仍按 `WriteOutcome` 给（那只信封里没有附件读数要转交）：这里只把它换成"重读"这一个动作，
   * outcome 不再流向 query——孤儿重扫判据已不在面板（ADR-0021）。座位字段仍叫 `refreshAfterWrite`
   * （`write-seats.ts` 的信封接口，写座位自己的名字），与清单重读已合一的旧双名无关。
   */
  const restore = useCallback(async (entry: TrashEntryLike): Promise<void> => {
    clearRowFailures([entry.id])
    const outcome = await restoreFromPanel({
      deps,
      ids: [entry.id],
      single: true,
      entries,
      gate,
      refreshAfterWrite: () => reload(),
      clearDetailCache,
    })
    // 被闸挡回的那一趟什么都没跑：这一行的成败由在飞那一趟说，这里不再补失败原文
    // （进入时清旧失败那一下已在同一动作里发生）。
    if (outcome === undefined) return
    const failure = outcome.failures.get(entry.id)
    if (failure !== undefined) failRow(entry.id, failure)
  }, [clearDetailCache, clearRowFailures, deps, entries, failRow, gate, reload])

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
    // 面板座位：purge 清成功条目的详情缓存并熄灭指向它们的撤销横幅；restore 另忘掉 main-view 的
    // closedByUs（只遗忘、不重开）。两样都由 settlement 按 anySuccess 上闸。
    const seat = { deps, ids, gate, refreshAfterWrite: settle, clearDetailCache }
    const outcome = action === 'purge'
      ? await purgeFromPanel(seat)
      : await restoreFromPanel({ ...seat, entries })
    // 座位被闸挡回（这一趟没跑）：框、清单、逐行原文的后续都由在飞那一趟收尾；这里不再追加后果
    // （进入时清旧失败那一下已在同一动作里发生）。
    if (outcome === undefined) return
    if (outcome.failures.size === 0) return
    setActionFailure((current) => {
      const next = { ...current }
      for (const [id, message] of outcome.failures) next[id] = message
      return next
    })
  }, [clearDetailCache, clearRowFailures, deps, entries, gate, reload, noteAttachmentCleanup])

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
    const emptied = await emptyTrash()
    // `undefined` 是闸把这一趟挡回来了（连点的第二下）：这一趟没跑 ⇒ 框不收、详情缓存不丢，
    // 界面后果全归在飞那一趟。
    if (emptied === undefined) return
    setPending(null)
    if (emptied) detailCache.current.clear()
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
