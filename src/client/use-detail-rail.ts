/**
 * 详情栏的**提问轨接线**（两档共用）：从一台详情读路的状态算出轨要画的三份读数
 * （整条索引、已加载的块 id、有没有轨）加上 `usePromptRail` 的那一面（当前句 / 在补的那句 / 跳转）。
 *
 * 三条判据（两档共用一份，差别只许在主体与挂载判据上）：
 * - **没有正文就没有轨**：读数中 / 失败那一帧没有 `detail`，那一拍轨不画（画了就是一个指向
 *   不存在正文的刻度）。
 * - **保持期顶住**：那一帧画的是上一条的正文，轨跟着上一条给刻度但整条禁用——跳转会把别人的
 *   游标补进这一页（ADR-0049）。禁用判据**问 `canNavigate`**（保持判据的唯一出口，住
 *   `use-detail-reader`），这里不再自己重推 holding。
 * - **挂载判据要显式传**：窄档下钻之后详情栏才进 DOM，`scrollRef.current` 是那时才补上的，
 *   而 `prompts` / `blocks` 一个都没变；只靠 ref 会把滚动监听漏挂，当前那句从此不跟滚动走
 *   （ADR-0057）。
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
  /** 「保持期拒绝导航/跳转」判据（`use-detail-reader` 的唯一出口）：`disabled` 直接取它的反，
   *  不在这里重推保持。 */
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
  // 只有带正文的状态才画轨刻度（读数中 / 失败那一帧没有正文 ⇒ 那一拍没有轨）。正文的取用
  // 按「有没有 body」认，不再点名状态判别式（保持判据归 `canNavigate`）。
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
