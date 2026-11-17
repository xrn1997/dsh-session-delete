/**
 * 详情这一帧的**接线 module**：把「一台详情读路 + 分页读面 + 提问轨」收成一个对象。
 *
 * 之前这条接线碎在三处：面板为两档各拼一遍 `useDetailRail` 的七个参数（`trash-panel.tsx`
 * 里两次），两档投影各自在 props 上转交一份手拼的 `pager`，壳里再拼一遍 `useDetailPager` 的
 * 七个参数。三处拼的是同一件事——「这一帧的读路」。收进来之后：
 * - 面板：`useDetailFrame(controller, { scrollRef, paneMounted })` 一档一次，交出的帧给栏外壳
 *   （`rail`）、两档投影（`state`）与壳（`state` / `pager`）；
 * - 两档投影：只做行投影（`head` / `infoRows` / `subagents`），帧原样转交；
 * - 壳：拿帧里那两格画状态与正文，翻页入口经 `useDetailFramePager` 接上（档位是壳自己的状态）。
 *
 * 判据一条都没搬：`useDetailRail` 的三条（没有正文没有轨 / 保持期顶住 / 挂载判据显式给）仍在
 * `use-detail-rail.ts`；分页的两笔账（连翻预算与滚动锚点）仍在 `use-detail-pager.ts`。这里只
 * 拥有「谁接给谁」：两档读路来源只是**结构相同**（同一个 module 接两台实例），不是同一个状态机，
 * 两档的显示模型也照旧各是各的（`TrashEntryWire` vs `ArchiveSubagentWire`）。
 */
import { useMemo, type RefObject } from 'react'
import type { DetailBody, DetailState } from './use-detail-reader.js'
import { useDetailPager, type DetailPagerHandle } from './use-detail-pager.js'
import { useDetailRail, type DetailRail, type RailDetailLike } from './use-detail-rail.js'

/** 分页这一块（在飞/失败 + 滚动容器）整体过手：两档详情投影各自转交，谁画正文谁拆开用。
 *  四样东西是一个概念（分页读面）的四个格子，打包走一个名字，不再逐样穿透组件边界。 */
export interface DetailPager {
  /** 更早一页正在读。 */
  loadingOlder: boolean
  /** 更早一页读失败的原文；正文本身仍是 ready。 */
  olderFailure: string | null
  onLoadOlder: () => void
  /** 详情栏的滚动容器；prepend 更早一页后按高度差补偿滚动位置。 */
  scrollRef?: RefObject<HTMLDivElement | null>
}

/** 帧的读路来源：两档面板控制器各交一台实例的同名五格（结构上就是控制器，不必整台传进来）。
 *  这几格与 `use-detail-reader.ts` 的 `DetailReader` 同名同义——帧不重新定义它们，只负责把它们
 *  和轨、分页读面接在一起。 */
export interface DetailFrameSource<S, D extends RailDetailLike> {
  /** 这一档的详情读路状态（控制器对外的 `detail`）。 */
  readonly detail: DetailState<S, D>
  /** 「保持期拒绝导航/跳转」判据（`use-detail-reader` 的唯一出口）：原样交给轨与投影。 */
  readonly canNavigate: boolean
  readonly loadingOlder: boolean
  readonly olderFailure: string | null
  readonly loadOlder: () => Promise<void>
}

/** 帧的宿主事实：详情栏这一刻在不在 DOM 里、滚动容器是谁——只有面板知道（ADR-0057 的挂载判据）。 */
export interface DetailFrameHost {
  /** 详情栏的滚动容器：分页补偿与提问轨落位共用这一个 ref。 */
  readonly scrollRef: RefObject<HTMLDivElement | null>
  readonly paneMounted: boolean
}

/** 详情这一帧：壳的两格（`state` / `pager`）与栏外壳的搭档（`rail`）。
 *  reader 的 `loadingOlder` / `olderFailure` 折在 `pager` 那一格里——同一件事只有一份名字。 */
export interface DetailFrame<S, D extends RailDetailLike> {
  readonly state: DetailState<S, D>
  readonly pager: DetailPager
  readonly rail: DetailRail
}

export function useDetailFrame<S, D extends RailDetailLike>(
  source: DetailFrameSource<S, D>,
  host: DetailFrameHost,
): DetailFrame<S, D> {
  const { detail: state, canNavigate, loadingOlder, olderFailure, loadOlder } = source
  const { scrollRef, paneMounted } = host
  const rail = useDetailRail({
    state,
    canNavigate,
    loadingOlder,
    olderFailure,
    loadOlder,
    scrollRef,
    paneMounted,
  })
  /** 分页读面只在这里拼一次：`onLoadOlder` 的引用稳下来，壳里的分页 effect 才不会每渲染重跑一趟。 */
  const pager = useMemo<DetailPager>(() => ({
    loadingOlder,
    olderFailure,
    onLoadOlder: () => { void loadOlder() },
    scrollRef,
  }), [loadingOlder, olderFailure, loadOlder, scrollRef])
  return useMemo(() => ({ state, pager, rail }), [state, pager, rail])
}

/** 壳要的那两格（`rail` 归栏外壳；`canNavigate` 归控制器与轨，不进帧）。投影口只读 `state`。 */
export type DetailFrameView<S, D extends RailDetailLike> = Pick<DetailFrame<S, D>, 'state' | 'pager'>

/**
 * 正文块的**翻页入口**：`useDetailPager` 的接线只住这里——帧给分页读面，壳只交正文与档位。
 * 预算与滚动锚点的判据仍在 `use-detail-pager.ts`；这里只把帧里的四个格子接上去（行为零变化）。
 */
export function useDetailFramePager(
  frame: { readonly pager: DetailPager },
  detail: DetailBody,
  compact: boolean,
): DetailPagerHandle {
  const { pager } = frame
  return useDetailPager({
    blocks: detail.blocks,
    olderCursor: detail.olderCursor,
    loadingOlder: pager.loadingOlder,
    olderFailure: pager.olderFailure,
    compact,
    onLoadOlder: pager.onLoadOlder,
    scrollRef: pager.scrollRef,
  })
}
