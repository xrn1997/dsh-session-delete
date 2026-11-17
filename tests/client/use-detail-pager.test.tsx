/**
 * 详情分页器（`use-detail-pager.ts`）的**接口级用例**：在 hook 的接口上直接测分页的两笔账
 * （连翻预算与滚动锚点），不再借两档详情包装或面板去间接观察。
 *
 * 这里钉的都是 ADR-0057 的语义：取数只由显式动作发起（不挂 scroll 监听）、prepend 后按真正
 * 插进来的高度补偿滚动位置、简洁档才自动连翻（上限 `AUTO_OLDER_PAGE_LIMIT`）、在飞不重复发、
 * 失败只收这一笔的预算（下一次显式动作照常）。
 */
import { act, renderHook } from '@testing-library/react'
import type { RefObject } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AUTO_OLDER_PAGE_LIMIT, useDetailPager } from '../../src/client/use-detail-pager.js'
import type { TrashDetailBlockWire } from '../../src/shared/wire.js'

const userBlock = (id: string, text: string): TrashDetailBlockWire => ({
  kind: 'user', id, time: 1, text, truncated: false, attachments: [],
})

const toolBlock = (id: string): TrashDetailBlockWire => ({
  kind: 'tool', id, time: 1, callId: `call-${id}`, name: 'read', status: 'ok',
  args: '{}', argsTruncated: false, result: 'ok', resultTruncated: false, attachments: [],
})

/** 详情分页的滚动容器假件：分页只用 `scrollTop` / `scrollHeight` 做 prepend 后的位置补偿。
 *  `listenerCount` 钉「取数不挂在滚动事件上」——滚到顶不自动补页（ADR-0057）。 */
function fakeScroller() {
  const scroll = {
    scrollHeight: 1000,
    scrollTop: 0,
    listenerCount: 0,
    addEventListener: (_type: string, _listener: () => void): void => { scroll.listenerCount += 1 },
    removeEventListener: (_type: string, _listener: () => void): void => {},
  }
  return scroll
}

interface PagerProps {
  blocks: readonly TrashDetailBlockWire[]
  olderCursor: number | null
  loadingOlder: boolean
  olderFailure: string | null
  compact: boolean
  onLoadOlder: () => void
  scrollRef?: RefObject<HTMLDivElement | null>
}

/** 与壳同一套接法：`useDetailPager` 的输入逐格从 props 来，用例控制每一拍。 */
function mount(over: Partial<PagerProps> = {}) {
  const initial: PagerProps = {
    blocks: [toolBlock('100')],
    olderCursor: 99,
    loadingOlder: false,
    olderFailure: null,
    compact: true,
    onLoadOlder: vi.fn(),
    ...over,
  }
  return renderHook((props: PagerProps) => useDetailPager(props), { initialProps: initial })
}

describe('useDetailPager · 取数只由显式动作发起（ADR-0057）', () => {
  it('不挂滚动监听：滚到顶不会替人多发一次请求', () => {
    const scroll = fakeScroller()
    const scrollRef = { current: scroll as unknown as HTMLDivElement }
    const { result } = mount({ scrollRef })
    scroll.scrollTop = 0
    expect(scroll.listenerCount).toBe(0)
    expect(result.current.loadOlder).toBeTypeOf('function')
  })

  it('`loadOlder` 只把意图交给上层，不自己取数、也不重复发同一拍', () => {
    const onLoadOlder = vi.fn()
    const { result } = mount({ onLoadOlder })
    act(() => { result.current.loadOlder() })
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
  })
})

describe('useDetailPager · prepend 后的滚动锚点', () => {
  it('按真正插进来的高度差补偿：读者正看着的那块不因上方长出新内容而跳走', () => {
    const scroll = fakeScroller()
    scroll.scrollTop = 480
    const scrollRef = { current: scroll as unknown as HTMLDivElement }
    const onLoadOlder = vi.fn()
    const tail = [userBlock('10', '尾页')]
    const { result, rerender } = mount({ blocks: tail, olderCursor: 10, onLoadOlder, scrollRef })

    act(() => { result.current.loadOlder() })
    rerender({ blocks: tail, olderCursor: 10, loadingOlder: true, olderFailure: null, compact: true, onLoadOlder, scrollRef })

    // 更早三块落到屏上、容器高了 620 ⇒ 视口跟着下移同样的量。
    scroll.scrollHeight = 1620
    rerender({
      blocks: [userBlock('7', '更早一'), userBlock('8', '更早二'), userBlock('9', '更早三'), ...tail],
      olderCursor: 7,
      loadingOlder: false,
      olderFailure: null,
      compact: true,
      onLoadOlder,
      scrollRef,
    })
    expect(scroll.scrollTop).toBe(1100)
  })

  it('请求在飞时读者继续滚动：补偿加在**当前**视口上，不把人拽回点击位置', () => {
    const scroll = fakeScroller()
    scroll.scrollTop = 480
    const scrollRef = { current: scroll as unknown as HTMLDivElement }
    const onLoadOlder = vi.fn()
    const tail = [userBlock('10', '尾页')]
    const { result, rerender } = mount({ blocks: tail, olderCursor: 10, onLoadOlder, scrollRef })

    act(() => { result.current.loadOlder() })
    rerender({ blocks: tail, olderCursor: 10, loadingOlder: true, olderFailure: null, compact: true, onLoadOlder, scrollRef })

    scroll.scrollTop = 880
    scroll.scrollHeight = 1620
    rerender({
      blocks: [userBlock('7', '更早一'), userBlock('8', '更早二'), userBlock('9', '更早三'), ...tail],
      olderCursor: 7,
      loadingOlder: false,
      olderFailure: null,
      compact: true,
      onLoadOlder,
      scrollRef,
    })
    expect(scroll.scrollTop).toBe(1500)
  })

  it('这一页读失败：块数没变 ⇒ 位置不动；下一次显式补页照常重新记账', () => {
    const scroll = fakeScroller()
    scroll.scrollTop = 480
    const scrollRef = { current: scroll as unknown as HTMLDivElement }
    const onLoadOlder = vi.fn()
    const tail = [userBlock('10', '尾页')]
    const { result, rerender } = mount({ blocks: tail, olderCursor: 10, onLoadOlder, scrollRef })

    act(() => { result.current.loadOlder() })
    rerender({ blocks: tail, olderCursor: 10, loadingOlder: true, olderFailure: null, compact: true, onLoadOlder, scrollRef })
    rerender({ blocks: tail, olderCursor: 10, loadingOlder: false, olderFailure: '更早的页读不出来', compact: true, onLoadOlder, scrollRef })
    expect(scroll.scrollTop).toBe(480)
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    // 失败只收这一笔的预算（不再自动续页），不废掉分页入口：读者再点一次照样取。
    act(() => { result.current.loadOlder() })
    expect(onLoadOlder).toHaveBeenCalledTimes(2)
  })
})

describe('useDetailPager · 简洁档自动连翻的预算', () => {
  it('补回的一页全是过程块就继续往前，直到出现对话内容', () => {
    const onLoadOlder = vi.fn()
    const tail = [userBlock('10', '尾页正文')]
    const { result, rerender } = mount({
      blocks: tail, olderCursor: 10, onLoadOlder,
    })
    act(() => { result.current.loadOlder() })
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    // 第一页全是过程块：简洁档下不可见 ⇒ 自动再翻一页。
    rerender({ blocks: [toolBlock('9'), ...tail], olderCursor: 9, loadingOlder: false, olderFailure: null, compact: true, onLoadOlder })
    expect(onLoadOlder).toHaveBeenCalledTimes(2)

    // 第二页带回用户提问 ⇒ 停在这一页，不再自动翻。
    rerender({ blocks: [userBlock('8', '更早的提问'), toolBlock('9'), ...tail], olderCursor: 8, loadingOlder: false, olderFailure: null, compact: true, onLoadOlder })
    expect(onLoadOlder).toHaveBeenCalledTimes(2)
  })

  it(`到 AUTO_OLDER_PAGE_LIMIT（${AUTO_OLDER_PAGE_LIMIT}）页就停，之后的新页不再请求`, () => {
    const onLoadOlder = vi.fn()
    let blocks: TrashDetailBlockWire[] = [toolBlock('100')]
    let cursor: number | null = 99
    const { result, rerender } = mount({ blocks, olderCursor: 100, onLoadOlder })

    act(() => { result.current.loadOlder() })
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    // 连续 11 页都只有过程块：前 10 页自动请求，第 11 页落地时预算已尽。
    for (let page = 0; page < 11; page += 1) {
      blocks = [toolBlock(String(90 - page)), ...blocks]
      rerender({ blocks, olderCursor: cursor, loadingOlder: false, olderFailure: null, compact: true, onLoadOlder })
      cursor = cursor === null ? null : cursor - 1
    }
    expect(onLoadOlder).toHaveBeenCalledTimes(AUTO_OLDER_PAGE_LIMIT + 1)
  })

  it('游标耗尽就停：翻到顶也不改说「这段会话只有过程内容」——那句归壳', () => {
    const onLoadOlder = vi.fn()
    const { result, rerender } = mount({ blocks: [toolBlock('10')], olderCursor: 10, onLoadOlder })
    act(() => { result.current.loadOlder() })
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    rerender({ blocks: [toolBlock('9'), toolBlock('10')], olderCursor: null, loadingOlder: false, olderFailure: null, compact: true, onLoadOlder })
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
  })

  it('在飞时不再发第二趟：同一页没落地之前预算原地等（换回调引用也一样）', () => {
    const onLoadOlder = vi.fn()
    const { result, rerender } = mount({ onLoadOlder })
    act(() => { result.current.loadOlder() })
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    // 请求在飞：块数没长、loadingOlder 为真；上层每渲染换一次回调引用也不该再发。
    const next = vi.fn()
    rerender({ blocks: [toolBlock('100')], olderCursor: 99, loadingOlder: true, olderFailure: null, compact: true, onLoadOlder: next })
    rerender({ blocks: [toolBlock('100')], olderCursor: 99, loadingOlder: true, olderFailure: null, compact: true, onLoadOlder: next })
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
    expect(next).not.toHaveBeenCalled()

    // 这一页落地（全是过程块）⇒ 预算接着走，只续一趟。
    rerender({ blocks: [toolBlock('99'), toolBlock('100')], olderCursor: 98, loadingOlder: false, olderFailure: null, compact: true, onLoadOlder: next })
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('标准及以上一页一停：补回的页即使全是过程块也不再自动翻', () => {
    const onLoadOlder = vi.fn()
    const tail = [userBlock('10', '尾页正文')]
    const { result, rerender } = mount({ blocks: tail, olderCursor: 10, compact: false, onLoadOlder })
    act(() => { result.current.loadOlder() })
    rerender({ blocks: [toolBlock('9'), ...tail], olderCursor: 9, loadingOlder: false, olderFailure: null, compact: false, onLoadOlder })
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
  })
})
