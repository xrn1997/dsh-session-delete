/**
 * 详情分页的读侧编排：手动补页、简洁档自动连翻、prepend 后的滚动锚点。
 * 取数只由**显式动作**发起（工具栏按钮、切进简洁档、提问轨点格）；滚动只管阅读，不挂 scroll 监听——
 * 「滚到顶就补一页」会让新页一页页顶在读者头上（ADR-0057）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { TrashDetailBlockWire } from '../shared/wire.js'
import { hasDialogue } from './detail-blocks.js'

/** 简洁档一次补页最多自动连翻多少页：服务端按块翻页，一页可能全是藏起来的过程块 ⇒ 点一下什么都不
 *  出现。自动往前翻直到出现对话块、翻完或到上限——上限防"几乎全是工具调用的巨型会话"把一次点击
 *  变成几十个串行请求。 */
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
  /** 上一次布局后的滚动高度：算真正插进来的高度，不把在飞期间的滚动或折叠变化算进去。 */
  const lastHeight = useRef<number | null>(null)
  /** 上一拍的块数：只有块数**变多**才是 prepend 落地（首挂与换主体由 `key` 重挂，ref 是新的）。 */
  const lastBlocks = useRef(blocks.length)

  const loadOlder = useCallback((): void => {
    autoOlder.current = { blocks: blocks.length, pages: 0 }
    onLoadOlder()
  }, [blocks.length, onLoadOlder])

  /**
   * 更早一页 prepend 后补偿滚动位置：读者正看着的那一块不因上方长出新内容而跳走。补偿只有这一个主人：
   * 翻页入口不止一个，判据只看「块数变多」，不看「这一趟是谁要的」——按发起方各补一次会让同一页补两遍。
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

  // 每次布局后记下高度：它在合并更早一页的那拍就是「插入前」的高度。
  useLayoutEffect(() => {
    const element = scrollRef?.current
    if (element !== null && element !== undefined) lastHeight.current = element.scrollHeight
  })

  // 精简档下这一页全是过程块（都藏起来了）⇒ 自动再往前翻，直到出现对话块、翻完或到连翻上限。
  // 触发源只有读者点「加载更早」（或切进简洁档）：滚动本身不发请求（ADR-0057）。
  useEffect(() => {
    const pending = autoOlder.current
    if (pending === null) return
    if (blocks.length === pending.blocks) {
      // 块数没长：请求还没落地或这一页为空；只有失败原文到了才收账。
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
    // 触发信号只认块数：同长度的新数组不该重跑这一趟。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `blocks` 以长度作信号；`scrollRef` 是 ref 的容器，已按约定列入。
  }, [blocks.length, olderCursor, loadingOlder, olderFailure, compact, onLoadOlder, scrollRef])

  return { loadOlder }
}
