/**
 * 「档」这个 module：面板里**一档**的整条装配线——清单读数 → 分组 → 选择面 → 控制器 → 键盘导航 →
 * 意图预取 → 详情帧。
 *
 * 之前这条线在 `trash-panel.tsx` 里写了两遍（回收站档与归档档各一遍），两档控制器另有 16 个
 * 同名成员各转一遍；同一件事写两遍，一边补了「窄档方向键只移选中」、另一边忘了是不可能的漂移。
 * 收进来之后：**装配只写一份**，两档的差异全部由 {@link PanelTabAdapter} 表达（行身份 / 行读数 /
 * 分组键 / 两个 hook / 导航三格 / 预取参数域 / 详情挂载判据），状态仍各一份
 * （两个 `usePanelTab` 实例互不读写，ADR-0060 决定第 4 条不翻）。
 *
 * 判据归属不变：
 * - 「什么时候重读」仍住 `use-gated-refresh.ts`（回收站由控制器接线、归档由查询接线）；
 * - 选中面/选择面/详情读路/详情帧/键盘契约/预取延时各住原 module，这里只回答「谁接给谁」；
 * - 布局事实（宽窄、分栏）由面板算好交进来：本 hook 只按 `wide` + 行数派生 `split`，不认断点常量。
 */
import { useCallback, useMemo, useRef, type RefObject } from 'react'
import type { BusyGate } from './busy-gate.js'
import type { Translate } from './copy.js'
import type { SessionDeleteRemote } from './remote.js'
import type { DetailNav } from './session-detail.js'
import { useRowFocus, type ListDom } from './session-list.js'
import { useTrashNav, type TrashNav } from './trash-nav.js'
import type { ProjectGroup } from './trash-view.js'
import { useDetailFrame, type DetailFrame } from './use-detail-frame.js'
import type { DetailState } from './use-detail-reader.js'
import type { RailDetailLike } from './use-detail-rail.js'
import { useDelayedPrefetch, type DelayedPrefetch } from './use-prefetch.js'
import { useListSelection, type ListSelection } from './use-list-selection.js'

/**
 * 一档的依赖面：面板的两条读 + 一段 `/apply` + 清空。两档结构相同（各自只取自己用得到的几格），
 * 控制器/查询的输入类型是它的窄切片，宽依赖面在编译期收窄。
 */
export type PanelTabDeps = Pick<
  SessionDeleteRemote,
  'list' | 'detail' | 'applyOutcomes' | 'emptyTrash' | 'archiveList' | 'archiveDetail'
>

/** 清单读数对视图的**共用五格**：两档各把自己的状态机折成它（三态/四态映射住 adapter）。 */
export interface PanelTabListView<R> {
  readonly rows: readonly R[] | null
  readonly refreshing: boolean
  readonly failure: string | null
  readonly loading: boolean
  readonly empty: boolean
}

/**
 * 一档控制器的**共有面**：详情主体（选中/孩子视图/账本/详情帧）+ 写闸 + 行失败落点。
 * 两档控制器的本档差异（待确认动作、解除归档、光标、下钻位）不进这里。
 */
export interface PanelTabController<R, S, D extends RailDetailLike> {
  readonly busy: boolean
  readonly selected: R | null
  readonly detail: DetailState<S, D>
  /** 「保持期拒绝导航/跳转」判据（`use-detail-reader` 的唯一出口）。 */
  readonly canNavigate: boolean
  readonly loadingOlder: boolean
  readonly olderFailure: string | null
  readonly detailNav: DetailNav
  /** 打开父详情里的一个孩子（按 id 交接，两档同一面）；孩子视图的槽位与「单级」判据差异住各自控制器。 */
  readonly openChild: (childId: string) => Promise<void>
  /** 回到父详情（详情顶部那颗「返回父会话」）。 */
  readonly closeChild: () => void
  readonly actionFailure: Readonly<Record<string, string>>
  readonly back: () => void
  readonly loadOlder: () => Promise<void>
  readonly retry: () => void
}

/** 面板交给一档的宿主事实：依赖、闸、文案、布局宽窄、档位门、Esc 作用域根。 */
export interface PanelTabContext {
  readonly deps: PanelTabDeps
  readonly gate: BusyGate
  readonly t: Translate
  /** 面板盒子够宽（两栏候选；真正的 `split` 还要清单里有行）。 */
  readonly wide: boolean
  /** 这一档是否在眼前（档位门）：控制器/查询/键盘/Esc 都按它收口。 */
  readonly active: boolean
  /** 面板根节点：Esc 只归本面板里的清单（`trash-nav.ts` 的作用域判据）。 */
  readonly scope: RefObject<HTMLElement | null>
}

/** 控制器拿到的上下文：宿主事实 + 已经算好的选择面与分栏事实。 */
export interface PanelTabControllerContext<Q, R> extends PanelTabContext {
  readonly query: Q
  /** 屏幕上的可见顺序（只含展开的组）：自动选中第一条走这一份。 */
  readonly ordered: readonly R[]
  readonly canAutoSelect: boolean
  readonly split: boolean
}

/**
 * 一档的 adapter：两档差异的**唯一落点**。每条都只回答本档与另一档不同的那一点，
 * 装配线（`usePanelTab`）本身不认识任何一档的具体形状。
 */
export interface PanelTabAdapter<Q, R, S, D extends RailDetailLike, C extends PanelTabController<R, S, D>> {
  /** 这一档进 DOM 的身份（行身份属性；两档本来就不是同一种 id）。 */
  readonly dom: ListDom
  /** 行身份（回收站 = 条目 id，归档 = 会话 id）：模块级稳定函数。 */
  readonly idOf: (row: R) => string
  /** 本档状态机 → 共用五格视图。 */
  readonly viewOf: (query: Q) => PanelTabListView<R>
  /** 本档的分组键（回收站带「未分组」、归档不带）。 */
  readonly groupsOf: (rows: readonly R[], t: Translate) => readonly ProjectGroup<R>[]
  /** 本档的清单读 hook（回收站 `/list` + 首帧快照；归档 `/archive-list` + 惰性计数）。 */
  readonly useQuery: (ctx: PanelTabContext) => Q
  /** 本档的控制器 hook（回收站带待确认动作与光标下钻；归档带光标与解除归档）。 */
  readonly useController: (ctx: PanelTabControllerContext<Q, R>) => C
  /** 「详情正画着哪一条」的行 id：回收站 = 选中 id；归档 = 选中优先、窄档回退光标。 */
  readonly activeRowId: (controller: C) => string | null
  /** 键盘里的「已下钻」判据：回收站 = drilled 位；归档 = 窄档选中即下钻。 */
  readonly navDrilled: (controller: C, split: boolean) => boolean
  /** 键盘的 select 动作（两档同形，来源不同：回收站的 `select` / 归档的 `selectRow`）。 */
  readonly navSelect: (controller: C) => (row: R, options?: { readonly drill?: boolean }) => Promise<void>
  /** 意图预取：行 → 读路（两档参数域不同：清册行 vs 会话 id）。 */
  readonly prefetchOf: (controller: C) => (row: R) => void
  /** 窄档下详情栏在 DOM 里的条件（回收站要 drilled 过，归档选中即等价于下钻）。 */
  readonly detailMountedNarrow: (controller: C) => boolean
  /** 详情帧的挂载判据（缺省 = `detailMounted`）：归档档还要看档位是否在眼前（不活动不挂轨监听）。 */
  readonly framePaneMounted?: (
    controller: C,
    facts: { readonly split: boolean; readonly detailMounted: boolean; readonly active: boolean },
  ) => boolean
}

/** 一档装配完的整份现场：视图件只读它，不自己接线。 */
export interface PanelTab<Q, R, S, D extends RailDetailLike, C extends PanelTabController<R, S, D>> {
  readonly query: Q
  readonly view: PanelTabListView<R>
  readonly rows: readonly R[] | null
  readonly groups: readonly ProjectGroup<R>[]
  readonly selection: ListSelection<R>
  readonly controller: C
  readonly nav: TrashNav
  readonly prefetch: DelayedPrefetch<R>
  readonly frame: DetailFrame<S, D>
  readonly listRef: RefObject<HTMLDivElement>
  readonly scrollRef: RefObject<HTMLDivElement>
  /** 盒子够宽且清单有行：两栏成立（空态/读失败不分栏）。 */
  readonly split: boolean
  /** 窄档下详情栏该不该在 DOM 里（宽档恒真）。 */
  readonly detailMounted: boolean
  /** 清单的活动行（行底色 / `aria-activedescendant` / 键盘落点读它）。 */
  readonly activeId: string | null
}

export function usePanelTab<Q, R, S, D extends RailDetailLike, C extends PanelTabController<R, S, D>>(
  adapter: PanelTabAdapter<Q, R, S, D, C>,
  ctx: PanelTabContext,
): PanelTab<Q, R, S, D, C> {
  const query = adapter.useQuery(ctx)
  const view = adapter.viewOf(query)
  const rows = view.rows
  const groups = useMemo(() => adapter.groupsOf(rows ?? [], ctx.t), [adapter, rows, ctx.t])

  /** 选择面（多选/折叠/勾选）：两档各一台实例，读同一份实现。 */
  const selection = useListSelection({ rows, groups, idOf: adapter.idOf })

  /** 两栏成立 = 盒子够宽 **且** 清单里有东西可看（空态与读失败时右栏不出现）。 */
  const split = ctx.wide && rows !== null && rows.length > 0

  /** 控制器：本档状态机。布局事实只交「屏幕顺序」与「要不要自动选中 / 选中即读」。 */
  const controller = adapter.useController({
    ...ctx,
    query,
    ordered: selection.ordered,
    canAutoSelect: split,
    split,
  })

  const listRef = useRef<HTMLDivElement>(null)
  /** 详情栏的滚动容器：分页 prepend 后按高度差补偿滚动位置（正文块与提问轨共用）。 */
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 焦点交还只拿这一个动作：行 DOM 查询留在清单那一侧（`session-list.tsx` 的 `useRowFocus`）。 */
  const focusRow = useRowFocus(listRef, adapter.dom.idAttr)

  const activeId = adapter.activeRowId(controller)
  /** 详情栏的 DOM 判据：宽档常驻；窄档由本档的「已下钻」条件给。 */
  const detailMounted = split || adapter.detailMountedNarrow(controller)
  /** 详情帧的挂载判据（ADR-0057 的挂载事实）：缺省与 DOM 判据同一份，归档档另加档位门。 */
  const framePaneMounted = adapter.framePaneMounted?.(controller, {
    split,
    detailMounted,
    active: ctx.active,
  }) ?? detailMounted
  const frame = useDetailFrame(controller, { scrollRef, paneMounted: framePaneMounted })

  /**
   * 键盘导航：屏幕顺序与四个动作从这里进去。`drillEnabled` 只跟**当前档**走——两台导航都听
   * `document` 的 Esc，按档收口，另一档看不见的下钻才不会被收走（ADR-0060 决定第 4 条）。
   */
  const nav = useTrashNav({
    ordered: selection.ordered,
    idOf: adapter.idOf,
    selectedId: activeId,
    selectMode: selection.selectMode,
    drillEnabled: !split && ctx.active,
    drilled: adapter.navDrilled(controller, split),
    select: adapter.navSelect(controller),
    toggleCheck: selection.toggleCheck,
    back: controller.back,
    focusRow,
    scope: ctx.scope,
  })

  /** 清单行的意图预取：hover / focus 150ms 后才读；只热身，不动选中与当前详情（ADR-0051）。 */
  const prefetch = useDelayedPrefetch(adapter.prefetchOf(controller))

  return {
    query,
    view,
    rows,
    groups,
    selection,
    controller,
    nav,
    prefetch,
    frame,
    listRef,
    scrollRef,
    split,
    detailMounted,
    activeId,
  }
}

/**
 * 详情**导航面**（`DetailNav`，ADR-0055 单级判据）的唯一装配：孩子视图开着就只交「返回父」，
 * 关着就只交「开孩子 / 预取孩子」；父行的标题由本档给（回收站读选中行原文，归档读显示名）——
 * 两档原先各写一遍这个三支判断，第二份迟早与第一份走散。
 */
export interface PanelDetailNavInput<R> {
  readonly childViewOpen: boolean
  readonly selected: R | null
  /** 返回键的标题：两档口径不同（原文 / 显示名），判据仍住各自视图词汇。 */
  readonly parentTitle: (row: R) => string
  readonly openChild: (childId: string) => void | Promise<void>
  readonly prefetchChild: (childId: string) => void
  readonly closeChild: () => void
}

export function panelDetailNav<R>(input: PanelDetailNavInput<R>): DetailNav {
  if (!input.childViewOpen) {
    return {
      onOpenChild: (childId: string): void => { void input.openChild(childId) },
      // 与入口同进同出：孩子视图里不再多一条读路，返回父之后才重新交出。
      onPrefetchChild: (childId: string): void => { input.prefetchChild(childId) },
    }
  }
  // `selected` 为 null（清单换版把父行收走的那一帧，清场随后也收孩子视图）⇒ 不交返回键：
  // 不能指着一个不存在的父。
  if (input.selected === null) return {}
  return { parentContext: { title: input.parentTitle(input.selected), onBack: input.closeChild } }
}

/**
 * 「更早一页」的守卫（ADR-0049）：保持期那一帧画的是上一条的正文，翻页会把它的游标读进新主体——
 * 判据只问 `canNavigate`（`use-detail-reader` 的唯一出口）。两档原先各写一遍，收在这里。
 */
export function useGuardedLoadOlder(
  canNavigate: boolean,
  loadOlder: () => Promise<void>,
): () => Promise<void> {
  return useCallback(async (): Promise<void> => {
    if (!canNavigate) return
    await loadOlder()
  }, [canNavigate, loadOlder])
}
