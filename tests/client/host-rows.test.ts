// 宿主会话行适配（2026-10-20）：可见行解析、全选判定、模式内整行点击守卫。
//
// 从 `batch-bar.test.tsx` 迁来的守卫/全选用例住这里，改用 `host-rows` 的公开面直接驱动；
// 浮条那边只留一条集成，证明守卫确实挂在常驻宿主上（见 batch-bar.test.tsx）。
//
// 文件是 `.ts`（不是 `.tsx`）：守卫的 React 行替身用 `createElement` 造，省得为一个测试文件
// 多开一种扩展名——扩展名跟着任务单的指名走。
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement, Fragment, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  areAllVisibleRowsSelected,
  getVisibleSelectableRowsSnapshot,
  readVisibleSelectableRows,
  registerHostRowInfo,
  resetHostRows,
  selectAllVisible,
  unregisterHostRowInfo,
  useSelectionRowClickGuard,
  useVisibleSelectableRows,
} from '../../src/client/host-rows.js'
import {
  enterSelection,
  exitSelection,
  getPicks,
  getSelection,
  isSelecting,
  resetSelection,
  togglePick,
} from '../../src/client/batch-selection-store.js'

beforeEach(() => {
  resetSelection()
  resetHostRows()
})

afterEach(() => {
  resetSelection()
  resetHostRows()
  document.body.replaceChildren()
})

/** 只有守卫 hook、没有宿主行：行由用例自己往 document 里造（与真宿主同一条认行凭据）。 */
function GuardHarness(): null {
  useSelectionRowClickGuard()
  return null
}

/** 真宿主的 React 行替身：`onClick` 模拟"切会话"（真宿主用的就是合成事件）。 */
function ReactRow({ sessionId, onOpen }: { sessionId: string; onOpen: () => void }): ReactElement {
  const dataRowKey = { 'data-row-key': `session:${sessionId}` }
  return createElement('div', { ...dataRowKey, onClick: onOpen }, createElement('span', null, 'A'))
}

/** 守卫 + 一行（或任意子树）装进同一棵树；回容器供用例自己取元素。 */
function renderGuardWith(child?: ReactElement): HTMLElement {
  return render(createElement(Fragment, null, createElement(GuardHarness), child ?? null)).container
}

/** 行内标题节点：`data-row-key` 是宿主行的认行凭据，点它 = 点行。 */
function titleOf(container: HTMLElement, sessionId: string): Element {
  const node = container.querySelector(`[data-row-key="session:${sessionId}"] span`)
  if (node === null) throw new Error(`行 ${sessionId} 没有标题`)
  return node
}

/** 真宿主会话行替身：行自己的 onClick 模拟"切会话"（document 行，不走 React）。 */
function fakeRow(sessionId: string, titleText = 'A'): {
  row: HTMLDivElement
  title: HTMLSpanElement
  opened: () => number
} {
  const row = document.createElement('div')
  row.setAttribute('data-row-key', `session:${sessionId}`)
  const title = document.createElement('span')
  title.textContent = titleText
  row.appendChild(title)
  document.body.appendChild(row)
  let count = 0
  row.addEventListener('click', () => { count += 1 })
  return { row, title, opened: () => count }
}

const ids = (): string[] => getPicks().map((item) => item.sessionId)

/** 渲染侧只读快照：行列表由订阅驱动重渲染，DOM 观察留在适配器里。 */
function RowsHarness({ enabled = true }: { enabled?: boolean }): ReactElement {
  const rows = useVisibleSelectableRows(enabled)
  return createElement('div', { 'data-testid': 'rows' }, rows.map((item) => item.sessionId).join(','))
}

describe('useVisibleSelectableRows', () => {
  it('DOM 里长出一行后重渲染；没有变化时快照引用稳定', async () => {
    registerHostRowInfo('a', { title: 'A', live: false })
    const { getByTestId } = render(createElement(RowsHarness))
    await waitFor(() => expect(getByTestId('rows').textContent).toBe(''))

    fakeRow('a')
    await waitFor(() => expect(getByTestId('rows').textContent).toBe('a'))

    const first = getVisibleSelectableRowsSnapshot()
    expect(getVisibleSelectableRowsSnapshot()).toBe(first)
  })

  it('未启用时不订阅也不读 DOM；启用后立刻补上当前快照', async () => {
    registerHostRowInfo('a', { title: 'A', live: false })
    const { getByTestId, rerender } = render(createElement(RowsHarness, { enabled: false }))
    expect(getByTestId('rows').textContent).toBe('')

    fakeRow('a')
    // MutationObserver 的回调是微任务：等过一轮宏任务，证明没有订阅把浮条叫醒
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(getByTestId('rows').textContent).toBe('')

    rerender(createElement(RowsHarness, { enabled: true }))
    await waitFor(() => expect(getByTestId('rows').textContent).toBe('a'))
  })
})

describe('readVisibleSelectableRows', () => {
  it('按 DOM 序返回已登记、非在跑的行；空 id / 重复 / 未登记 / 在跑都跳过；标题取登记值', () => {
    registerHostRowInfo('b', { title: 'B', live: false })
    registerHostRowInfo('a', { title: 'A', live: false })
    registerHostRowInfo('run', { title: 'Running', live: true })
    // 侧栏可见顺序 b → a → run；未登记行与重复行也在 DOM 里
    fakeRow('b', 'DOM 文本不算标题')
    fakeRow('a', 'A')
    fakeRow('run', 'Running')
    fakeRow('ghost', 'Ghost')
    fakeRow('b', 'B 的重复行')
    fakeRow('', '空 id')

    expect(readVisibleSelectableRows()).toEqual([
      { sessionId: 'b', title: 'B' },
      { sessionId: 'a', title: 'A' },
    ])
  })

  it('重复行：一颗行尾开关卸载，另一颗还在用的登记要留着', () => {
    registerHostRowInfo('a', { title: 'A', live: false })
    registerHostRowInfo('a', { title: 'A', live: false })
    fakeRow('a')
    fakeRow('a')
    expect(readVisibleSelectableRows()).toEqual([{ sessionId: 'a', title: 'A' }])

    // 其中一行离开渲染树：另一行还挂着，登记不能被一起摘掉。
    unregisterHostRowInfo('a')
    expect(readVisibleSelectableRows()).toEqual([{ sessionId: 'a', title: 'A' }])

    unregisterHostRowInfo('a')
    expect(readVisibleSelectableRows()).toEqual([])
  })

  it('没有被渲染出来的行（折叠/过滤）不出现；DOM 里没有行时回空表', () => {
    registerHostRowInfo('hidden', { title: 'Hidden', live: false })
    expect(readVisibleSelectableRows()).toEqual([])
  })

  it('注销登记后不再用旧标题选中这一行（行尾开关卸载 = 这一行离开渲染树）', () => {
    registerHostRowInfo('a', { title: 'A', live: false })
    fakeRow('a')
    expect(readVisibleSelectableRows()).toEqual([{ sessionId: 'a', title: 'A' }])

    unregisterHostRowInfo('a')
    expect(readVisibleSelectableRows()).toEqual([])
    // 行重新挂载时行尾开关会重新登记。
    registerHostRowInfo('a', { title: 'A', live: false })
    expect(readVisibleSelectableRows()).toEqual([{ sessionId: 'a', title: 'A' }])
  })
})

describe('selectAllVisible', () => {
  it('把可见行按 DOM 序追加到原有选中之后；再全选一次没有新条目（同一份快照 = 不发通告）', () => {
    registerHostRowInfo('b', { title: 'B', live: false })
    registerHostRowInfo('a', { title: 'A', live: false })
    fakeRow('b', 'B')
    fakeRow('a', 'A')

    togglePick({ sessionId: 'c', title: 'C' })
    selectAllVisible()
    expect(ids()).toEqual(['c', 'b', 'a'])
    expect(getPicks().map((item) => item.title)).toEqual(['C', 'B', 'A'])

    const snapshot = getPicks()
    selectAllVisible()
    expect(getPicks()).toBe(snapshot)
  })

  it('已在名单里的可见行不重复追加；名单已经覆盖全部可见行时不动', () => {
    registerHostRowInfo('a', { title: 'A', live: false })
    fakeRow('a', 'A')
    togglePick({ sessionId: 'a', title: 'A' })
    const snapshot = getPicks()
    selectAllVisible()
    expect(getPicks()).toBe(snapshot)
  })

  it('没有可见可选行时什么都不追加（全折叠/过滤掉）', () => {
    selectAllVisible()
    expect(getPicks()).toEqual([])
  })
})

describe('areAllVisibleRowsSelected', () => {
  // 渲染侧配快照；这里用 fresh 读把四态语义测穿。
  const allVisibleSelected = (): boolean =>
    areAllVisibleRowsSelected(readVisibleSelectableRows(), getSelection().picks)

  it('四态：0 条 → false；可见行全选 → true；漏一条 → false；没有可见行且名单非空 → true', () => {
    registerHostRowInfo('a', { title: 'A', live: false })
    fakeRow('a', 'A')
    expect(allVisibleSelected()).toBe(false)

    togglePick({ sessionId: 'a', title: 'A' })
    expect(allVisibleSelected()).toBe(true)

    registerHostRowInfo('b', { title: 'B', live: false })
    fakeRow('b', 'A')
    expect(allVisibleSelected()).toBe(false)

    togglePick({ sessionId: 'b', title: 'B' })
    expect(allVisibleSelected()).toBe(true)

    // 全折叠/过滤掉：只剩名单（同一个切换口显示「取消全选」，点它只能清空）
    document.body.replaceChildren()
    expect(allVisibleSelected()).toBe(true)
  })
})

describe('useSelectionRowClickGuard', () => {
  it('模式外放行：宿主的行 onClick 照常、选中集不动', () => {
    const onOpen = vi.fn()
    const container = renderGuardWith(createElement(ReactRow, { sessionId: 's1', onOpen }))
    fireEvent.click(titleOf(container, 's1'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(getPicks()).toEqual([])
  })

  it('模式内挡住宿主的行 onClick，并把整行点击变成勾/取消', () => {
    enterSelection()
    registerHostRowInfo('s1', { title: 'A', live: false })
    const onOpen = vi.fn()
    const container = renderGuardWith(createElement(ReactRow, { sessionId: 's1', onOpen }))

    fireEvent.click(titleOf(container, 's1'))
    expect(ids()).toEqual(['s1'])
    expect(onOpen).not.toHaveBeenCalled()

    fireEvent.click(titleOf(container, 's1'))
    expect(getPicks()).toEqual([])
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('模式在挂载之后才打开：监听从那一刻起生效（守卫订的是同一份快照）', () => {
    render(createElement(GuardHarness))
    const { title } = fakeRow('s1')
    fireEvent.click(title)
    expect(getPicks()).toEqual([])

    act(() => {
      enterSelection()
    })
    fireEvent.click(title)
    expect(ids()).toEqual(['s1'])
  })

  it('退出多选后守卫卸掉：点行交还宿主的 onClick，也不再往选中集里塞', () => {
    const onOpen = vi.fn()
    const container = renderGuardWith(createElement(ReactRow, { sessionId: 's1', onOpen }))
    act(() => {
      enterSelection()
    })
    fireEvent.click(titleOf(container, 's1'))
    expect(ids()).toEqual(['s1'])
    expect(onOpen).not.toHaveBeenCalled()

    act(() => {
      exitSelection()
    })
    expect(isSelecting()).toBe(false)
    fireEvent.click(titleOf(container, 's1'))
    // 清理没跑的话这里会反过来：行被吃掉、's1' 又被勾上（浮条已不渲染 ⇒ 看不见的选中）
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(ids()).toEqual([])
  })

  it('行里的按钮/输入放行：按钮自己收到点击，不被当成勾选', () => {
    enterSelection()
    render(createElement(GuardHarness))
    const { row } = fakeRow('s1')
    const action = document.createElement('button')
    row.appendChild(action)
    let actionClicks = 0
    action.addEventListener('click', () => { actionClicks += 1 })
    fireEvent.click(action)
    expect(actionClicks).toBe(1)
    expect(getPicks()).toEqual([])
  })

  it('双击不翻转：第二下与 dblclick 都吃掉但不改选中集，也不打开宿主的重命名', () => {
    enterSelection()
    registerHostRowInfo('s1', { title: 'A', live: false })
    render(createElement(GuardHarness))
    const { title, opened } = fakeRow('s1')

    fireEvent.click(title, { detail: 1 })
    expect(ids()).toEqual(['s1'])
    fireEvent.click(title, { detail: 2 })
    fireEvent.dblClick(title)
    expect(ids()).toEqual(['s1'])
    expect(opened()).toBe(0)
  })

  it('在跑的行点整行不选中（与置灰的勾选框同口径），事件照样被吃掉', () => {
    enterSelection()
    registerHostRowInfo('s1', { title: 'A', live: true })
    render(createElement(GuardHarness))
    const { title, opened } = fakeRow('s1')
    fireEvent.click(title)
    expect(getPicks()).toEqual([])
    expect(opened()).toBe(0)
  })

  it('未登记的行也能选：标题按空串（守卫不拿 DOM 文本冒充标题）', () => {
    enterSelection()
    render(createElement(GuardHarness))
    const { title } = fakeRow('s1', 'DOM 里的标题')
    fireEvent.click(title)
    expect(getPicks()).toEqual([{ sessionId: 's1', title: '' }])
  })

  it('点行内没有 data-row-key 的区域不动选中集', () => {
    enterSelection()
    const container = renderGuardWith(createElement('span', { id: 'outside' }, '行外'))
    const outside = container.querySelector('#outside')
    if (outside === null) throw new Error('缺行外节点')
    fireEvent.click(outside)
    expect(getPicks()).toEqual([])
  })
})
