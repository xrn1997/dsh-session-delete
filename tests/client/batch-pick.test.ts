// 模式内整行点击守卫（2026-11-25 起带 Shift+点范围勾选）：普通 click 切换单条、
// Shift+click 勾上「锚点→目标」整段、双击的第二下（detail>1）不翻转。
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSelectionRowClickGuard } from '../../src/client/batch-pick.js'
import { enterSelection, getPicks, togglePick } from '../../src/client/batch-selection-store.js'
import { registerHostRowInfo } from '../../src/client/host-rows.js'

const ids = (): string[] => getPicks().map((item) => item.sessionId)

/** 每条会话行一个 `data-row-key="session:…"` 的 div；查不到就地报错（不许静默空跑）。 */
function mountRows(keys: readonly string[]): (key: string) => HTMLElement {
  const rows = new Map<string, HTMLElement>()
  for (const key of keys) {
    const row = document.createElement('div')
    row.setAttribute('data-row-key', `session:${key}`)
    document.body.append(row)
    rows.set(key, row)
  }
  return (key) => {
    const row = rows.get(key)
    if (row === undefined) throw new Error(`没有行 ${key}`)
    return row
  }
}

function clickRow(row: HTMLElement, init: MouseEventInit = {}): void {
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, ...init }))
}

describe('行点击守卫的 Shift+点范围勾选', () => {
  let rowAt: (key: string) => HTMLElement

  beforeEach(() => {
    enterSelection()
    renderHook(() => { useSelectionRowClickGuard() })
    for (const key of ['a', 'b', 'c', 'd']) registerHostRowInfo(key, { title: key.toUpperCase(), live: false })
    rowAt = mountRows(['a', 'b', 'c', 'd'])
  })

  afterEach(() => {
    document.body.replaceChildren()
  })

  it('Shift+click 勾上锚点到目标整段', () => {
    clickRow(rowAt('a'))
    clickRow(rowAt('c'), { shiftKey: true })
    expect(ids()).toEqual(['a', 'b', 'c'])
  })

  it('普通 click 仍是切换单条', () => {
    clickRow(rowAt('a'))
    expect(ids()).toEqual(['a'])
    clickRow(rowAt('a'))
    expect(ids()).toEqual([])
  })

  it('双击的第二下（detail>1）不翻转，Shift 也一样', () => {
    clickRow(rowAt('a'))
    clickRow(rowAt('c'), { shiftKey: true, detail: 2 })
    expect(ids()).toEqual(['a'])
  })

  it('Ctrl+click 等价普通切换单条', () => {
    clickRow(rowAt('a'))
    clickRow(rowAt('c'), { ctrlKey: true })
    expect(ids()).toEqual(['a', 'c'])
    clickRow(rowAt('a'), { ctrlKey: true })
    expect(ids()).toEqual(['c'])
  })

  it('Shift+mousedown 阻止默认选字行为，普通 mousedown 不拦', () => {
    const plainDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    rowAt('a').dispatchEvent(plainDown)
    expect(plainDown.defaultPrevented).toBe(false)

    const shiftDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, shiftKey: true })
    rowAt('a').dispatchEvent(shiftDown)
    expect(shiftDown.defaultPrevented).toBe(true)
  })
})

describe('rangePick 的 DOM 视觉序与锚点', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('按 DOM 视觉序切段而非 host-rows 挂载登记序（新会话插顶/重排后不误选）', () => {
    enterSelection()
    renderHook(() => { useSelectionRowClickGuard() })
    // 登记序是 a, b, c, d，但屏幕上 d 被置顶/新消息上浮排到最前：d, a, b, c
    for (const key of ['a', 'b', 'c', 'd']) registerHostRowInfo(key, { title: key.toUpperCase(), live: false })
    const rowAt = mountRows(['d', 'a', 'b', 'c'])
    clickRow(rowAt('d'))
    clickRow(rowAt('a'), { shiftKey: true })
    expect(ids()).toEqual(['d', 'a'])
  })

  it('togglePick 立锚后，Shift+click 从锚点起算（含中间行）', () => {
    enterSelection()
    renderHook(() => { useSelectionRowClickGuard() })
    for (const key of ['a', 'b', 'c', 'd']) registerHostRowInfo(key, { title: key.toUpperCase(), live: false })
    const rowAt = mountRows(['a', 'b', 'c', 'd'])
    act(() => { togglePick({ sessionId: 'd', title: 'D' }) })
    clickRow(rowAt('b'), { shiftKey: true })
    expect(ids()).toEqual(['d', 'b', 'c'])
  })
})
