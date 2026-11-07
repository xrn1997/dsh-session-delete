/**
 * 详情分页的读侧编排：手动「加载更早」、简洁档自动连翻、prepend 后的滚动锚点。
 * 组件只画；分页的两笔账（连翻预算与滚动位置）都住这里。
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { TrashDetailBlockWire } from '../shared/wire.js'
import { hasDialogue } from './detail-blocks.js'

/**
 * 「加载更早」跟工作步骤档位联动时，一次点击最多自动连翻多少页。
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
  /** 手动「加载更早」与切进简洁档时那一次自动翻页共用的入口：记下这一批的起点与预算，再交给上层取数。 */
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
  /** 更早一页要 prepend 时的块数；换页回来（组件重挂载）这份意图会丢，那是可接受的边界。 */
  const pendingScroll = useRef<{ blocks: number } | null>(null)
  /** 简洁档自动连翻的账：起点块数 + 已经连翻了几页。 */
  const autoOlder = useRef<{ blocks: number; pages: number } | null>(null)
  /** 上一次布局后的滚动高度：合并更早一页时用它算**真正插进来的高度**，不把请求在飞期间的
   *  滚动或折叠变化也算进去。 */
  const lastHeight = useRef<number | null>(null)

  const loadOlder = (): void => {
    const element = scrollRef?.current
    if (element !== null && element !== undefined) {
      pendingScroll.current = { blocks: blocks.length }
    }
    autoOlder.current = { blocks: blocks.length, pages: 0 }
    onLoadOlder()
  }

  // 更早一页 prepend 后补偿滚动位置：读者正看着的那一块不因上方长出新内容而跳走。
  // 加的是**当前** `scrollTop`（请求在飞时读者可能继续滚动），高度差只取这一拍真正插进来的部分。
  useLayoutEffect(() => {
    const element = scrollRef?.current
    const pending = pendingScroll.current
    if (element === null || element === undefined || pending === null) return
    if (blocks.length !== pending.blocks) {
      pendingScroll.current = null
      if (lastHeight.current !== null) {
        element.scrollTop += element.scrollHeight - lastHeight.current
      }
      return
    }
    if (!loadingOlder) pendingScroll.current = null
  }, [blocks.length, loadingOlder, scrollRef])

  // 每次布局后记下高度：它在合并更早一页的那一拍就是「插入前」的高度（滚动不触发渲染，
  // 折叠开合会先渲染、顺带把这笔高度更新掉）。
  useLayoutEffect(() => {
    const element = scrollRef?.current
    if (element !== null && element !== undefined) lastHeight.current = element.scrollHeight
  })

  // 「加载更早」跟档位联动：简洁档下这一页全是过程块（都藏起来了）⇒ 自动再往前翻，
  // 直到出现对话块、翻完、或到连翻上限。标准及以上每页至少有一行可见内容（过程组头），
  // 保持"一次点击一页"。滚动补偿的意图逐页续上，读者不会被连续 prepend 甩走。
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
    const element = scrollRef?.current
    if (element !== null && element !== undefined) {
      pendingScroll.current = { blocks: blocks.length }
    }
    onLoadOlder()
    // 读的是整份 `blocks`，但触发信号只认块数：同长度的新数组不该重跑这一趟。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `blocks` 以长度作信号；`scrollRef` 是 ref 的容器，已按约定列入。
  }, [blocks.length, olderCursor, loadingOlder, olderFailure, compact, onLoadOlder, scrollRef])

  return { loadOlder }
}
