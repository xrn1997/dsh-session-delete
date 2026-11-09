/**
 * 详情分页的读侧编排：手动补页、简洁档自动连翻、prepend 后的滚动锚点。
 * 组件只画；分页的两笔账（连翻预算与滚动位置）都住这里。
 *
 * 取数只由**显式动作**发起：工具栏那颗「加载更早」、切进简洁档时的联动、提问轨上点某一格。
 * 滚动只管阅读，不挂 scroll 监听——「滚到顶就补一页」会让新页一页页顶在读者头上，顶端持续
 * 后退，想往回拖滚动条找位置反而越拉越远（ADR-0057）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { TrashDetailBlockWire } from '../shared/wire.js'
import { hasDialogue } from './detail-blocks.js'

/**
 * 简洁档里一次补页最多自动连翻多少页（补回来的一整页可能全是被藏起来的过程块）。
 *
 * 服务端按**块**翻页；简洁档把过程块整段藏起来，一页可能全是过程块 ⇒ 点一下什么都不出现，
 * 看着像没反应。所以简洁档下自动继续往前翻，直到这一批里出现对话块、翻完、或到上限。
 * 切进简洁档时当前页若全是过程块，也按同一份预算自动连翻——否则用户看到的仍是一页空白。
 * 上限防的是"一条几乎全是工具调用的巨型会话"把一次点击变成几十个串行请求。
 */
export const AUTO_OLDER_PAGE_LIMIT = 10

interface DetailPagerOptions {
  blocks: readonly TrashDetailBlockWire[]
  olderCursor: number | null
  loadingOlder: boolean
  /** 更早一页读失败的原文；正文本身仍是 ready。 */
  olderFailure: string | null
  /** 简洁档才自动连翻；标准及以上每页至少有一行可见内容（过程组头）。 */
  compact: boolean
  onLoadOlder: () => void
  /** 详情栏的滚动容器；prepend 更早一页后按高度差补偿滚动位置。 */
  scrollRef?: RefObject<HTMLDivElement | null> | undefined
}

export interface DetailPagerHandle {
  /** 读者点「加载更早」，或切进简洁档时那一次联动共用的入口：记下这一批的起点与预算，再交给上层取数。 */
  loadOlder: () => void
}

export function useDetailPager({
  blocks,
  olderCursor,
  loadingOlder,
  olderFailure,
  compact,
  onLoadOlder,
  scrollRef,
}: DetailPagerOptions): DetailPagerHandle {
  /** 简洁档自动连翻的账：起点块数 + 已经连翻了几页。 */
  const autoOlder = useRef<{ blocks: number; pages: number } | null>(null)
  /** 上一次布局后的滚动高度：合并更早一页时用它算**真正插进来的高度**，不把请求在飞期间的
   *  滚动或折叠变化也算进去。 */
  const lastHeight = useRef<number | null>(null)
  /** 上一拍的块数：只有块数**变多**才是 prepend 落地（首挂与换主体由 `key` 重挂，ref 是新的）。 */
  const lastBlocks = useRef(blocks.length)

  const loadOlder = useCallback((): void => {
    autoOlder.current = { blocks: blocks.length, pages: 0 }
    onLoadOlder()
  }, [blocks.length, onLoadOlder])

  /**
   * 更早一页 prepend 后补偿滚动位置：读者正看着的那一块不因上方长出新内容而跳走。
   * 加的是**当前** `scrollTop`（请求在飞时读者可能继续滚动），高度差只取这一拍真正插进来的部分。
   *
   * **补偿只有这一个主人**：翻页入口不止一个（工具栏按钮、简洁档连翻、提问轨跳转），谁发起的
   *  都走同一条 prepend；按发起方各补一次会让同一页补两遍（正文多跳一段）。所以判据只看
   *  「块数变多」，不看「这一趟是谁要的」——提问轨那边因此一行补偿都不写。
   */
  useLayoutEffect(() => {
    const grew = blocks.length > lastBlocks.current
    lastBlocks.current = blocks.length
    if (!grew) return
    const element = scrollRef?.current
    if (element === null || element === undefined) return
    if (lastHeight.current !== null) {
      element.scrollTop += element.scrollHeight - lastHeight.current
    }
  }, [blocks.length, scrollRef])

  // 每次布局后记下高度：它在合并更早一页的那一拍就是「插入前」的高度（滚动不触发渲染，
  // 折叠开合会先渲染、顺带把这笔高度更新掉）。
  useLayoutEffect(() => {
    const element = scrollRef?.current
    if (element !== null && element !== undefined) lastHeight.current = element.scrollHeight
  })

  // 档位联动：简洁档下这一页全是过程块（都藏起来了）⇒ 自动再往前翻，
  // 直到出现对话块、翻完、或到连翻上限。标准及以上每页至少有一行可见内容（过程组头），
  // 保持"一次点击一页"。prepend 的补偿逐页自动发生（上面那一支是唯一主人），读者不会被
  // 连续 prepend 甩走。触发源只有读者点「加载更早」（或切进简洁档）：滚动本身不发请求（ADR-0057）。
  useEffect(() => {
    const pending = autoOlder.current
    if (pending === null) return
    if (blocks.length === pending.blocks) {
      // 块数没长：请求还没落地，或落地但这一页为空。只有失败原文到了才收账——
      // 切档那一拍 `loadingOlder` 可能还没翻真，不能把它当失败把预算丢掉。
      if (!loadingOlder && olderFailure !== null) autoOlder.current = null
      return
    }
    const added = blocks.slice(0, blocks.length - pending.blocks)
    const done = !compact
      || hasDialogue(added)
      || olderCursor === null
      || pending.pages >= AUTO_OLDER_PAGE_LIMIT
    if (done) {
      autoOlder.current = null
      return
    }
    autoOlder.current = { blocks: blocks.length, pages: pending.pages + 1 }
    onLoadOlder()
    // 读的是整份 `blocks`，但触发信号只认块数：同长度的新数组不该重跑这一趟。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `blocks` 以长度作信号；`scrollRef` 是 ref 的容器，已按约定列入。
  }, [blocks.length, olderCursor, loadingOlder, olderFailure, compact, onLoadOlder, scrollRef])

  return { loadOlder }
}
