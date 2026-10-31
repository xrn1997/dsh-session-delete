// 控件面：行首常驻勾选 + 行尾兜底（2026-10-17；2026-10-20 选中集与模式语义拆去
// `batch-selection-store.test.ts`，这里只钉"控件渲染与翻转"这一半）。
// 两个现场都是模块级（跨用例存活）：每个用例前清一次。
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchPickButton, BatchPickCheckbox, fetchCounts } from '../../src/client/batch-select.js'
import { readVisibleSelectableRows, resetHostRows } from '../../src/client/host-rows.js'
import { enterSelection, getPicks, resetSelection, togglePick } from '../../src/client/batch-selection-store.js'

beforeEach(() => {
  resetSelection()
  resetHostRows()
})

afterEach(() => {
  resetSelection()
  resetHostRows()
})

describe('多选态的渲染门', () => {
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

describe('行信息登记（守卫读的那张表）', () => {
  it('模式外也登记：进入模式的那一帧守卫就有标题，不必等这一行重挂载', () => {
    const row = document.createElement('div')
    row.setAttribute('data-row-key', 'session:s1')
    document.body.appendChild(row)
    try {
      render(<BatchPickButton sessionId="s1" title="行尾登记的名字" />)
      expect(readVisibleSelectableRows()).toEqual([{ sessionId: 's1', title: '行尾登记的名字' }])
    } finally {
      row.remove()
    }
  })

  // 登记表跟着开关的挂载走：行被宿主卸掉后不能再拿旧标题冒充「当前可见」。
  it('开关卸载即注销：DOM 行还在也不再被全选收进去', () => {
    const row = document.createElement('div')
    row.setAttribute('data-row-key', 'session:s1')
    document.body.appendChild(row)
    try {
      const { unmount } = render(<BatchPickButton sessionId="s1" title="行尾登记的名字" />)
      expect(readVisibleSelectableRows()).toEqual([{ sessionId: 's1', title: '行尾登记的名字' }])
      unmount()
      expect(readVisibleSelectableRows()).toEqual([])
    } finally {
      row.remove()
    }
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

describe('子会话计数', () => {
  it('fetchCounts：缺一条回执 ⇒ null（不拿假数）', async () => {
    const deps = { applyOutcomes: vi.fn(async () => []) }
    await expect(fetchCounts(deps, ['a'])).resolves.toBeNull()
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
