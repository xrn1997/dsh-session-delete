/**
 * 提问轨的读侧编排：当前那句（跟着正文滚动走）、点一条之后的补页循环，以及落位那一下的滚动。
 *
 * 组件只画；DOM 度量、滚动与「还要补几页」的账都住这里（与 `use-detail-pager` 同一条分工）。
 * 四条判据值得先知道：
 * - **跳转不是一次请求**：正文按块分页（一页 30 块），目标那句可能在很浅的页里。所以跳转 =
 *   从尾往前逐页补，直到它进窗；补完再一次性滚过去。**补页期间的滚动补偿不在这里**——它只有
 *   `use-detail-pager` 一个主人（谁发起的翻页都走同一条 prepend）。上限 `JUMP_PAGE_LIMIT`
 *   防一次点击变成几十个串行请求。
 * - **落位不画高亮框**：宿主 `scrollToTurn` 也只把目标行对齐到离顶一档；读者靠滚动位置与轨上
 *   那格的 `aria-current` 认落点。整行套一圈环在正文里是一个大白框，评审已否（ADR-0057）。
 * - **当前那句只在已加载的块里找**：整条会话的索引里有更早的提问，但它们没有 DOM，谈不上「滚到它」；
 *   轨上那几格就只亮「已加载且已滚过顶」的那一句。
 * - **换主体就收手**：跳转账里的块数基线属于起跳那条主体，`prompts` 身份一变整趟作废
 *   （layout 阶段先看到它——清场的 passive effect 跑在 layout 之后，靠它来不及）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { TrashDetailBlockWire, TrashDetailPromptWire } from '../shared/wire.js'

/** 一次跳转最多连续补多少页（每页 30 块）：防「点最老那句」把一次点击变成几十个串行请求。 */
export const JUMP_PAGE_LIMIT = 20

/** 跳转落位时目标行离视口顶的距离（px）：给 sticky 标题排让位。详情用户行以行内
 *  `scrollMarginTop` 消费它（`session-detail.tsx` 的 `USER_ROW`），落位几何只有这一个来源。 */
export const JUMP_SCROLL_MARGIN_PX = 44

/** 视口顶往下这么多像素内算「这一句已经在顶上」。
 *
 *  **必须大于跳转的落位偏移**：`reveal()` 之后目标行正好停在 `JUMP_SCROLL_MARGIN_PX`。
 *  edge 若小于它，`update()` 会在目标那一行 `break`，把「当前这句」判给上一句——读者刚点完
 *  就被告知落在了别处（ADR-0057：当前那句靠轨上那格认）。这里多留 4px 吸收亚像素。 */
export const ACTIVE_EDGE_PX = JUMP_SCROLL_MARGIN_PX + 4

/** 跳转收手的原因：只有「太远」需要跟用户说话（失败原文另有出口，走详情自己的分页失败面）。 */
export type PromptRailNotice = 'tooFar'

export interface PromptRailHandle {
  /** 正文滚到的那一句（只在已加载的块里选）；没有可算的就 `null`。 */
  readonly activeId: string | null
  /** 正在补页的那句；轨上那格呼吸。 */
  readonly busyId: string | null
  readonly notice: PromptRailNotice | null
  /** 点一格：已加载直接滚过去，没加载就补页到它进窗。 */
  readonly jump: (id: string) => void
}

interface PromptRailInput {
  /** 整条会话的提问索引；`null` = 这一拍没有主体（读数中 / 失败 / 保持期）。 */
  readonly prompts: readonly TrashDetailPromptWire[] | null
  /** 当前已加载的块：只用来判「这句在不在窗口里」。 */
  readonly blocks: readonly TrashDetailBlockWire[]
  readonly olderCursor: number | null
  readonly loadingOlder: boolean
  /** 更早一页读失败的原文：补页循环据此收账，不然会一直等一个不会来的下一页。 */
  readonly olderFailure: string | null
  readonly onLoadOlder: () => void
  readonly scrollRef: RefObject<HTMLDivElement | null>
  /** 详情栏这一刻在不在 DOM 里：宽档常驻；窄档只有下钻之后才画。ref 不是 state——面板从窄档切到
   *  下钻时 `scrollRef.current` 才补上，而 `prompts` / `blocks` 一个都没变，下面的滚动监听
   *  就漏挂了（当前那句从此不跟滚动走）。所以「挂没挂上」必须是一条显式输入。 */
  readonly paneMounted: boolean
  /** 详情保持期：轨跟着上一条的帧顶住，但不再接受跳转（也不续页）。 */
  readonly disabled?: boolean
}

/** 当前这一趟跳转的账：目标、起跳时的块数、已经补了几页、起跳时的主体。 */
interface JumpState {
  id: string
  blocks: number
  pages: number
  /** 起跳那一刻的 `prompts` 身份：换主体（孩子视图 / 换选中 / 保持期）时它先于本 effect 变掉——
   *  清场的 effect 是 passive，跑在 layout 之后，光靠它这一趟已经先拿旧基线补过一帧了。 */
  prompts: readonly TrashDetailPromptWire[] | null
}

export function usePromptRail({
  prompts,
  blocks,
  olderCursor,
  loadingOlder,
  olderFailure,
  onLoadOlder,
  scrollRef,
  paneMounted,
  disabled = false,
}: PromptRailInput): PromptRailHandle {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<PromptRailNotice | null>(null)
  const jumpState = useRef<JumpState | null>(null)

  /** 滚到那句：只对齐，不画落地框（与宿主同一条，判据住文件头注）。块由详情按 `data-block-id` 标出。 */
  const reveal = useCallback((id: string): void => {
    const node = scrollRef.current?.querySelector<HTMLElement>(`[data-block-id="${id}"]`)
    if (node === null || node === undefined) return
    // jsdom 没有 scrollIntoView；浏览器里 `scroll-margin-top` 让 sticky 标题排不让位。
    if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'start' })
    setActiveId(id)
  }, [scrollRef])

  const jump = useCallback((id: string): void => {
    if (disabled) return
    setNotice(null)
    if (blocks.some((block) => block.id === id)) {
      jumpState.current = null
      setBusyId(null)
      reveal(id)
      return
    }
    // 游标已经到顶还不在这段窗口里：索引与账本对不上（只可能在外部把日志换掉时发生），收手不报错。
    if (olderCursor === null) return
    jumpState.current = { id, blocks: blocks.length, pages: 0, prompts }
    setBusyId(id)
    onLoadOlder()
  }, [blocks, disabled, olderCursor, onLoadOlder, prompts, reveal])

  // 补页循环：每落一页看目标进窗没有；没进窗就续一页，直到进窗 / 游标耗尽 / 到上限 / 读失败。
  // **这里不补滚动位置**：prepend 的补偿只有一个主人（`use-detail-pager` 按高度差补）。
  // 翻页入口不止一个（按钮 / 简洁档连翻 / 本轨），按发起方各补一次会让同一页补两遍。
  useLayoutEffect(() => {
    const pending = jumpState.current
    if (pending === null) return
    // 换主体了：这一趟的块数基线属于上一条，拿去补新主体的帧只会把画面推飞；
    // 补页请求也不该替新主体发。直接收手（真 prepend 只会让块变多，不会换身份）。
    if (pending.prompts !== prompts) {
      jumpState.current = null
      setBusyId(null)
      return
    }
    if (blocks.some((block) => block.id === pending.id)) {
      jumpState.current = null
      setBusyId(null)
      reveal(pending.id)
      return
    }
    if (blocks.length === pending.blocks) {
      // 块数没长：这一页还在飞，或落地但没带来新块。只有失败原文到了才收账。
      if (!loadingOlder && olderFailure !== null) {
        jumpState.current = null
        setBusyId(null)
      }
      return
    }
    pending.blocks = blocks.length
    if (olderCursor === null) {
      jumpState.current = null
      setBusyId(null)
      return
    }
    if (pending.pages >= JUMP_PAGE_LIMIT) {
      jumpState.current = null
      setBusyId(null)
      setNotice('tooFar')
      return
    }
    pending.pages += 1
    onLoadOlder()
  }, [blocks, olderCursor, loadingOlder, olderFailure, onLoadOlder, prompts, reveal])

  // 当前那句：正文滚到哪儿，就选最后一句已经滚过视口顶的提问；已滚到底时目标可能被 clamp 在
  // 让位线之下，那一拍取最后一句仍可见的提问（见 `update` 里的 `atBottom`）。
  useEffect(() => {
    const element = scrollRef.current
    if (!paneMounted || element === null || prompts === null || prompts.length === 0) {
      setActiveId(null)
      return
    }
    const ids = new Set(prompts.map((prompt) => prompt.id))
    let frame = 0
    const update = (): void => {
      frame = 0
      const box = element.getBoundingClientRect()
      const edge = box.top + ACTIVE_EDGE_PX
      /** 已滚到底且内容真的溢出。目标句靠近页尾时 `scrollIntoView` 会被底边 clamp、停不到
       *  让位线之上；那一拍仍应把它认成当前句（ADR-0057：点完就被告知落在别处比不亮更糟）。 */
      const atBottom = element.scrollHeight > element.clientHeight + 1
        && element.scrollTop + element.clientHeight >= element.scrollHeight - 1
      const viewportBottom = box.top + element.clientHeight
      let current: string | null = null
      for (const node of element.querySelectorAll<HTMLElement>('[data-block-id]')) {
        const id = node.dataset['blockId']
        if (id === undefined || !ids.has(id)) continue
        const top = node.getBoundingClientRect().top
        if (top <= edge) {
          current = id
          continue
        }
        // 只在「已到底」时接受让位线之下的刻度：取最后一个仍可见的提问（读者读到的是它）。
        // 否则仍按让位线截断——列表中段的目标不能因为后面还有可见刻度而被提前选中。
        if (!atBottom || top >= viewportBottom) break
        current = id
      }
      setActiveId(current)
    }
    const onScroll = (): void => {
      if (frame !== 0) return
      if (typeof requestAnimationFrame !== 'function') { update(); return }
      frame = requestAnimationFrame(update)
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    update()
    return () => {
      element.removeEventListener('scroll', onScroll)
      if (frame !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    }
  }, [scrollRef, prompts, blocks, paneMounted])

  // 换主体（孩子视图 / 换选中）：这一条的分页现场整份作废。**layout 阶段**清：下一条命中账本时
  // 轨不卸载，passive 再清会让新主体首帧带上一条的当前句 / 补页刻度 / 「太远」提示（ADR-0050）。
  useLayoutEffect(() => {
    jumpState.current = null
    setBusyId(null)
    setNotice(null)
    setActiveId(null)
  }, [prompts])

  // 详情保持期整条轨禁用：在飞的补页不再续页（请求本身撤不回，但不继续多补）。
  useLayoutEffect(() => {
    if (!disabled) return
    jumpState.current = null
    setBusyId(null)
    setNotice(null)
  }, [disabled])

  return useMemo<PromptRailHandle>(
    () => ({ activeId, busyId, notice, jump }),
    [activeId, busyId, notice, jump],
  )
}
