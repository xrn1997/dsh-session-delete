/**
 * 详情栏的提问轨接线（两档共用）：从一台详情读路算出轨要画的三份读数加上 `usePromptRail` 那一面。
 * 三条判据：**没有正文就没有轨**（读数中/失败那一帧不画指向不存在正文的刻度）；**保持期顶住**
 * （跳转会把别人的游标补进这一页，禁用判据问 `canNavigate`，ADR-0049）；**挂载判据要显式传**
 * （窄档下钻后 ref 才补上，只靠 ref 会漏挂滚动监听，ADR-0057）。
 */
import { useMemo, type RefObject } from 'react'
import type { TrashDetailBlockWire, TrashDetailPromptWire } from '../shared/wire.js'
import type { DetailState } from './use-detail-reader.js'
import { usePromptRail, type PromptRailHandle } from './use-prompt-rail.js'

const NO_PROMPTS: readonly TrashDetailPromptWire[] = []
const NO_BLOCKS: readonly TrashDetailBlockWire[] = []

/** 轨要的三格：`SessionDetailWire` 与它的两档投影都够（两半的详情线上都带这三样）。 */
export interface RailDetailLike {
  readonly prompts?: readonly TrashDetailPromptWire[]
  readonly blocks?: readonly TrashDetailBlockWire[]
  readonly olderCursor?: number | null
}

export interface DetailRailInput<S, D extends RailDetailLike> {
  /** 这一档的详情读路状态（回收站档与归档档各一台实例）。 */
  readonly state: DetailState<S, D>
  /** 「保持期拒绝导航/跳转」判据（`use-detail-reader` 的唯一出口）：`disabled` 直接取反，不在这里重推保持。 */
  readonly canNavigate: boolean
  readonly loadingOlder: boolean
  readonly olderFailure: string | null
  loadOlder: () => Promise<void>
  readonly scrollRef: RefObject<HTMLDivElement | null>
  /** 详情栏这一刻在不在 DOM 里。 */
  readonly paneMounted: boolean
}

export interface DetailRail {
  /** 整条会话的提问索引；没有正文时是空表 ⇒ `hasRail` false。 */
  readonly prompts: readonly TrashDetailPromptWire[]
  /** 已加载块的 id：轨上未加载的刻度更短更淡，预览卡里也明说「会先补页」。 */
  readonly loadedIds: ReadonlySet<string>
  readonly hasRail: boolean
  /** 保持期：轨仍画上一条的刻度，但整条顶住——跳转会把别人的游标补进这一页（ADR-0049）。 */
  readonly disabled: boolean
  readonly handle: PromptRailHandle
}

export function useDetailRail<S, D extends RailDetailLike>({
  state, canNavigate, loadingOlder, olderFailure, loadOlder, scrollRef, paneMounted,
}: DetailRailInput<S, D>): DetailRail {
  // 读数中/失败那一帧没有正文 ⇒ 那一拍没有轨；正文按「有没有 body」认（保持判据归 `canNavigate`）。
  const detail = 'detail' in state ? state.detail : null
  const prompts = detail?.prompts ?? NO_PROMPTS
  const blocks = detail?.blocks ?? NO_BLOCKS
  const disabled = !canNavigate
  const handle = usePromptRail({
    prompts: prompts.length > 0 ? prompts : null,
    blocks,
    olderCursor: detail?.olderCursor ?? null,
    loadingOlder,
    olderFailure,
    onLoadOlder: () => { void loadOlder() },
    scrollRef,
    paneMounted,
    disabled,
  })
  const loadedIds = useMemo(() => new Set(blocks.map((block) => block.id)), [blocks])
  return { prompts, loadedIds, hasRail: prompts.length > 0, disabled, handle }
}
