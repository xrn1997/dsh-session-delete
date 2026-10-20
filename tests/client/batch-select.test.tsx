// 选中集 store + 行首常驻勾选 + 行尾兜底（2026-10-17）
// store 是模块级现场（跨用例存活）：每个用例前清一次。
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  BatchPickButton,
  BatchPickCheckbox,
  clearPicks,
  enterSelection,
  exitSelection,
  getPicks,
  isSelecting,
  shrinkPicksToFailures,
  togglePick,
} from '../../src/client/batch-select.js'

beforeEach(() => {
  exitSelection()
  clearPicks()
})

describe('选中集', () => {
  it('按勾选顺序记；对已勾的再勾一次是取消，不出现重复', () => {
    togglePick({ sessionId: 'a', title: 'A' })
    togglePick({ sessionId: 'b', title: 'B' })
    expect(getPicks().map((p) => p.sessionId)).toEqual(['a', 'b'])
    togglePick({ sessionId: 'a', title: 'A' })
    expect(getPicks().map((p) => p.sessionId)).toEqual(['b'])
    togglePick({ sessionId: 'a', title: 'A' })
    expect(getPicks().map((p) => p.sessionId)).toEqual(['b', 'a'])
  })

  it('shrinkPicksToFailures 只留失败名单；空名单 = 全清', () => {
    togglePick({ sessionId: 'a', title: 'A' })
    togglePick({ sessionId: 'b', title: 'B' })
    togglePick({ sessionId: 'c', title: 'C' })
    shrinkPicksToFailures(['c'])
    expect(getPicks().map((p) => p.sessionId)).toEqual(['c'])
    shrinkPicksToFailures([])
    expect(getPicks()).toEqual([])
  })
})

describe('多选模式', () => {
  it('进入/退出；退出把选中集一起清掉', () => {
    expect(isSelecting()).toBe(false)
    enterSelection()
    expect(isSelecting()).toBe(true)
    togglePick({ sessionId: 'a', title: 'A' })
    exitSelection()
    expect(isSelecting()).toBe(false)
    expect(getPicks()).toEqual([])
  })

  it('不在模式内时两颗勾选开关都不渲染（入口只在「⋯ → 多选」）', () => {
    const { container } = render(
      <>
        <BatchPickCheckbox sessionId="s1" title="A" />
        <BatchPickButton sessionId="s1" title="A" />
      </>,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('多选态行首勾选框', () => {
  it('勾上/取消都进出选中集，并带 CSS 认的座位标记', () => {
    enterSelection()
    const { container } = render(<BatchPickCheckbox sessionId="s1" title="重构日志读取代次" />)
    const box = screen.getByRole('checkbox', { name: '勾选「重构日志读取代次」以批量删除' })
    expect(box).not.toBeChecked()
    const seat = container.querySelector('[data-dsh-session-delete="batch-pick"]')
    expect(seat).toHaveAttribute('data-seat', 'leading')
    expect(seat).toHaveAttribute('data-checked', 'false')

    fireEvent.click(box)
    expect(box).toBeChecked()
    expect(seat).toHaveAttribute('data-checked', 'true')
    expect(getPicks().map((p) => p.sessionId)).toEqual(['s1'])

    fireEvent.click(box)
    expect(box).not.toBeChecked()
    expect(getPicks()).toEqual([])
  })

  it('选中集被别处改动时跟着翻转（浮条里逐条移除走同一条路）', () => {
    enterSelection()
    render(<BatchPickCheckbox sessionId="s1" title="A" />)
    const box = screen.getByRole('checkbox', { name: '勾选「A」以批量删除' })
    act(() => { togglePick({ sessionId: 's1', title: 'A' }) })
    expect(box).toBeChecked()
    act(() => { togglePick({ sessionId: 's1', title: 'A' }) })
    expect(box).not.toBeChecked()
  })
})

describe('多选态行尾兜底勾选开关', () => {
  it('点一下 aria-pressed 翻转，并进/出选中集；座位标记是 action', () => {
    enterSelection()
    render(<BatchPickButton sessionId="s1" title="重构日志读取代次" />)
    const button = screen.getByRole('button', { name: '勾选「重构日志读取代次」以批量删除' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(button).toHaveAttribute('data-dsh-session-delete', 'batch-pick')
    expect(button).toHaveAttribute('data-seat', 'action')
    expect(button).toHaveAttribute('data-checked', 'false')
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(button).toHaveAttribute('data-checked', 'true')
    expect(getPicks().map((p) => p.sessionId)).toEqual(['s1'])
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(getPicks()).toEqual([])
  })

  it('会话在跑时置灰点不动，悬停把原因摆出来', async () => {
    enterSelection()
    render(<BatchPickButton sessionId="s" title="t" live />)
    expect(screen.getByRole('button', { name: '勾选「t」以批量删除' })).toBeDisabled()
    fireEvent.focus(screen.getByRole('button', { name: '勾选「t」以批量删除' }))
    // Tooltip 走 portal 异步渲染 ⇒ findByText（预裁记档）
    expect(await screen.findByText('会话正在运行，先停止再删除')).toBeInTheDocument()
  })
})
