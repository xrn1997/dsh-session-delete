// 提问轨的读侧：点一格之后的补页循环、落位与当前那句、收手条件与换主体清场。
// 这里不画组件（轨的静态形态归 `prompt-rail.tsx` 与面板用例），只钉那几笔会出错的账：
// 补几页、什么时候停、落位落到哪、换主体怎么清。
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { JUMP_PAGE_LIMIT, JUMP_SCROLL_MARGIN_PX, usePromptRail } from '../../src/client/use-prompt-rail.js'
import type { TrashDetailBlockWire, TrashDetailPromptWire } from '../../src/shared/wire.js'

const block = (id: string): TrashDetailBlockWire => ({
  kind: 'user', id, time: Number(id), text: `第 ${id} 句`, truncated: false, attachments: [],
})

const PROMPTS: readonly TrashDetailPromptWire[] = [
  { id: '0', at: 1, preview: '第 0 句' },
  { id: '2', at: 2, preview: '第 2 句' },
]

interface Props {
  readonly prompts: readonly TrashDetailPromptWire[]
  readonly blocks: readonly TrashDetailBlockWire[]
  readonly olderCursor: number | null
  readonly loadingOlder: boolean
  readonly olderFailure: string | null
  /** 省略 = 详情栏在 DOM 里（宽档），与真实面板的默认分支一致。 */
  readonly paneMounted?: boolean
  /** 详情保持期：轨跟着上一条的帧顶住，但不再接受跳转。 */
  readonly disabled?: boolean
}

/** 真 DOM 的详情滚动容器：钩子会 `querySelector` 目标那块。 */
function scroller(): HTMLDivElement {
  const element = document.createElement('div')
  element.innerHTML = '<div data-block-id="0"></div><div data-block-id="2"></div>'
  return element
}

const rectOf = (top: number): DOMRect => ({
  top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}),
})

/**
 * 一根**量得出「这一句滚到哪」**的滚动容器：jsdom 的 rect 全是 0，看不见落位。
 * `place` 重建 `data-block-id` 节点，每个节点的 rect 读 `tops` 的当前值——落位后就地改那张表。
 */
function measuredScroller() {
  const tops = new Map<string, number>()
  const element = document.createElement('div')
  element.getBoundingClientRect = () => rectOf(0)
  const place = (ids: readonly string[]): void => {
    element.replaceChildren(...ids.map((id) => {
      const node = document.createElement('div')
      node.dataset['blockId'] = id
      node.getBoundingClientRect = () => rectOf(tops.get(id) ?? 0)
      return node
    }))
  }
  return { element, tops, place }
}

function setup(initial: Props, onLoadOlder = vi.fn()) {
  const scrollRef = { current: scroller() }
  const view = renderHook(
    (props: Props) => usePromptRail({
      ...props,
      paneMounted: props.paneMounted ?? true,
      onLoadOlder,
      scrollRef,
    }),
    { initialProps: initial },
  )
  return { ...view, onLoadOlder, scrollRef }
}

const TAIL: Props = { prompts: PROMPTS, blocks: [block('0')], olderCursor: 2, loadingOlder: false, olderFailure: null }

describe('usePromptRail', () => {
  it('已加载的那句：不发请求，直接滚过去并把当前那句换过去（不画落地框）', () => {
    const { result, onLoadOlder } = setup(TAIL)
    act(() => { result.current.jump('0') })
    expect(onLoadOlder).not.toHaveBeenCalled()
    expect(result.current.activeId).toBe('0')
  })

  it('没加载的那句：先补页，目标进窗后落位，且不再发请求', () => {
    const { result, rerender, onLoadOlder } = setup(TAIL)
    act(() => { result.current.jump('2') })
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
    expect(result.current.busyId).toBe('2')

    rerender({ ...TAIL, blocks: [block('2'), block('0')], olderCursor: null })
    expect(result.current.busyId).toBeNull()
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
    expect(result.current.activeId).toBe('2')
  })

  it('补页有上限：到 JUMP_PAGE_LIMIT 页就收手，留一句人话，之后不再自己发请求', () => {
    const { result, rerender, onLoadOlder } = setup(TAIL)
    act(() => { result.current.jump('2') })
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    // 每一页都只有别的内容（目标始终没进窗）：补到上限那页停。
    let blocks = TAIL.blocks
    for (let page = 0; page <= JUMP_PAGE_LIMIT; page += 1) {
      blocks = [block(`9${page}`), ...blocks]
      rerender({ ...TAIL, blocks })
    }
    expect(result.current.notice).toBe('tooFar')
    expect(result.current.busyId).toBeNull()

    const calls = onLoadOlder.mock.calls.length
    blocks = [block('older'), ...blocks]
    rerender({ ...TAIL, blocks })
    expect(onLoadOlder).toHaveBeenCalledTimes(calls)
  })

  it('保持期禁用：点格不发补页请求；补页途中进入保持期也不续页', () => {
    const off = setup({ ...TAIL, disabled: true })
    act(() => { off.result.current.jump('2') })
    expect(off.onLoadOlder).not.toHaveBeenCalled()
    expect(off.result.current.busyId).toBeNull()

    const on = setup(TAIL)
    act(() => { on.result.current.jump('2') })
    expect(on.onLoadOlder).toHaveBeenCalledTimes(1)
    on.rerender({ ...TAIL, disabled: true })
    expect(on.result.current.busyId).toBeNull()
    on.rerender({ ...TAIL, disabled: true, blocks: [block('9'), ...TAIL.blocks] })
    expect(on.onLoadOlder).toHaveBeenCalledTimes(1)
  })

  it('补页失败：停在那一页，不假装还在补', () => {
    const { result, rerender, onLoadOlder } = setup(TAIL)
    act(() => { result.current.jump('2') })
    rerender({ ...TAIL, olderFailure: '更早的页读不出来' })
    expect(result.current.busyId).toBeNull()
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
  })

  it('换主体：上一趟的补页现场整份作废', () => {
    const { result, rerender } = setup(TAIL)
    act(() => { result.current.jump('2') })
    expect(result.current.busyId).toBe('2')

    rerender({ ...TAIL, prompts: [{ id: '0', at: 9, preview: '另一条的提问' }], olderCursor: null })
    expect(result.current.busyId).toBeNull()
    expect(result.current.notice).toBeNull()
    // 当前句交给新主体的滚动读数（清场是 layout 阶段，新主体的那句在同一拍重算；这里 DOM 里
    // 只有 id 0 属于新 prompts）——不是上一条补页现场留下的 busy/notice。
    expect(result.current.activeId).toBe('0')
  })

  it('跳转途中换主体：不拿旧基线补新主体的帧，也不替它续页', () => {
    const { result, rerender, onLoadOlder } = setup(TAIL)
    act(() => { result.current.jump('2') })
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    // 新主体的块比上一条**多**（清场的 passive effect 跑在 layout 之后，光看「块变少」认不出换主体）。
    const next = { ...TAIL, prompts: [{ id: '7', at: 9, preview: '另一条的提问' }], olderCursor: 2 }
    rerender({ ...next, blocks: [block('9'), block('8'), block('7'), block('0')] })
    expect(result.current.busyId).toBeNull()
    // 旧账里的「还没进窗、再补一页」不许落到新主体头上。
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
    expect(result.current.notice).toBeNull()
  })

  it('落位后「当前这句」就是目标：目标停在落位让位处，不能判给上一句', () => {
    // 用户行行内 `scrollMarginTop: JUMP_SCROLL_MARGIN_PX`：`reveal()` 之后目标正好停在那一档。
    // edge 若小于它，`update()` 会在目标那一行 break ⇒ 读者刚点完就被告诉落在了上一句。
    const { element, tops, place } = measuredScroller()
    tops.set('0', -300)
    tops.set('2', 1200) // 目标还没进窗
    place(['0', '2'])
    const onLoadOlder = vi.fn()
    const scrollRef = { current: element }
    const view = renderHook(
      (props: Props) => usePromptRail({ ...props, paneMounted: true, onLoadOlder, scrollRef }),
      { initialProps: TAIL },
    )

    act(() => { view.result.current.jump('2') })
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    // 一页落地：目标进窗，浏览器把它停在落位让位那一档。
    tops.set('2', JUMP_SCROLL_MARGIN_PX)
    view.rerender({ ...TAIL, blocks: [block('2'), block('0')], olderCursor: null })
    expect(view.result.current.activeId).toBe('2')
  })

  it('还在 edge 之下的那句不算「已经滚过」：给标题排与落位偏移留的余量要够、也不能吞太多', () => {
    const { element, tops, place } = measuredScroller()
    tops.set('0', -20)
    tops.set('2', 60) // 已进窗，但仍在 edge 之下
    place(['0', '2'])
    const scrollRef = { current: element }
    const view = renderHook(
      (props: Props) => usePromptRail({ ...props, paneMounted: true, onLoadOlder: vi.fn(), scrollRef }),
      { initialProps: TAIL },
    )
    view.rerender({ ...TAIL, blocks: [block('2'), block('0')], olderCursor: null })
    expect(view.result.current.activeId).toBe('0')
  })

  it('已滚到底、目标被底边 clamp：当前句取最后一句可见的提问，不许判回上一句', () => {
    // 目标靠近页尾时 `scrollIntoView` 停不到让位线之上；读者点完那一句，轨仍必须认它。
    const { element, tops, place } = measuredScroller()
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      value: 600,
      writable: true,
    })
    tops.set('0', -500)
    tops.set('2', 20)
    tops.set('4', 200) // 已到底，目标只能停在让位线之下、但仍在视口内
    place(['0', '2', '4'])
    const prompts: readonly TrashDetailPromptWire[] = [
      ...PROMPTS,
      { id: '4', at: 3, preview: '第 4 句' },
    ]
    const scrollRef = { current: element }
    const view = renderHook(
      (props: Props) => usePromptRail({ ...props, paneMounted: true, onLoadOlder: vi.fn(), scrollRef }),
      { initialProps: { ...TAIL, prompts, blocks: [block('4'), block('2'), block('0')], olderCursor: null } },
    )
    expect(view.result.current.activeId).toBe('4')
  })

  it('内容不足一屏时没有「已到底」特判：不让最后一句越过让位线成为当前', () => {
    // 容器不溢出时 scrollTop 恒为 0，不算「到底」；仍按让位线取最后一句滚过的提问。
    const { element, tops, place } = measuredScroller()
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 400 })
    tops.set('0', -20)
    tops.set('2', 60)
    tops.set('4', 200)
    place(['0', '2', '4'])
    const prompts: readonly TrashDetailPromptWire[] = [
      ...PROMPTS,
      { id: '4', at: 3, preview: '第 4 句' },
    ]
    const scrollRef = { current: element }
    const view = renderHook(
      (props: Props) => usePromptRail({ ...props, paneMounted: true, onLoadOlder: vi.fn(), scrollRef }),
      { initialProps: { ...TAIL, prompts, blocks: [block('4'), block('2'), block('0')], olderCursor: null } },
    )
    expect(view.result.current.activeId).toBe('0')
  })

  // 补页入口不止一个（工具栏按钮 / 简洁档连翻 / 本轨）：prepend 的滚动补偿只能有一个主人
  // （`use-detail-pager`）。轨这边若也按高度差补一次，同一页会被补两遍，正文多跳一段。
  it('补页落地时不动滚动位置：补偿归详情分页那一侧', () => {
    const element = scroller()
    let scrollTop = 0
    let scrollHeight = 1000
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value },
    })
    Object.defineProperty(element, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })
    const scrollRef = { current: element }
    const view = renderHook(
      (props: Props) => usePromptRail({ ...props, paneMounted: true, onLoadOlder: vi.fn(), scrollRef }),
      { initialProps: TAIL },
    )

    act(() => { view.result.current.jump('2') })
    // 一页落地（目标仍未进窗）：容器高了 620。轨不该按这笔差动 scrollTop。
    scrollHeight = 1620
    view.rerender({ ...TAIL, blocks: [block('9'), block('0')] })
    expect(scrollTop).toBe(0)
  })

  // 窄档没下钻时详情栏不在 DOM 里，`scrollRef.current` 是 null；下钻那一刻栏才挂上，而
  // `prompts` / `blocks` 一个都没变（首帧快照命中账本的路径就是这样）。监听若只按那几个
  // 依赖挂，永远不会补上——轨上的 `aria-current` 从此不跟正文滚动走。
  it('详情栏后挂上（窄档下钻）时补挂滚动监听：ref 不是 state，依赖不变也要重跑', () => {
    const element = scroller()
    const scrollRef: { current: HTMLDivElement | null } = { current: null }
    const view = renderHook(
      (props: { paneMounted: boolean }) => usePromptRail({
        ...TAIL,
        paneMounted: props.paneMounted,
        onLoadOlder: vi.fn(),
        scrollRef,
      }),
      { initialProps: { paneMounted: false } },
    )
    expect(view.result.current.activeId).toBeNull()

    scrollRef.current = element
    view.rerender({ paneMounted: true })
    // 监听挂上时先量一次：两句都在视口顶之上 ⇒ 当前这句是最后一句。
    expect(view.result.current.activeId).toBe('2')
  })
})
