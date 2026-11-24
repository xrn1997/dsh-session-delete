import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Toast } from '../../src/client/ui/Toast.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('Toast 暂停与恢复', () => {
  // 暂停时 timer 与淡出动画一起冻住；恢复时必须从同一冻结点续，重新计满会让冻住的淡出先走完，
  // 留下一条透明却仍占着 `role=alert` 的横幅。
  it('恢复后只续剩余停留，不重新计满', () => {
    vi.useFakeTimers()
    const onDone = vi.fn()
    const view = render(<Toast text="已删除" holdMs={6000} paused={false} onDone={onDone} />)

    act(() => { vi.advanceTimersByTime(2000) })
    view.rerender(<Toast text="已删除" holdMs={6000} paused onDone={onDone} />)
    act(() => { vi.advanceTimersByTime(5000) })
    expect(onDone).not.toHaveBeenCalled()

    view.rerender(<Toast text="已删除" holdMs={6000} paused={false} onDone={onDone} />)
    // 总共 6000 + 1000，已经走了 2000 ⇒ 恢复后应剩 5000，而不是重新计满 7000。
    act(() => { vi.advanceTimersByTime(4999) })
    expect(onDone).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})

describe('Toast 正文与副行', () => {
  // 副行（`detail`）排在句尾动作按钮之后：块级进度行另起第二行，不能插在按钮前面把「撤销」挤到第三行。
  it('detail 排在动作按钮之后，首行文案与按钮保持在同一顺序段内', () => {
    render(
      <Toast
        text="会话已移入回收站"
        detail={<span role="status">正在恢复 1/1 · 移动中 · 已用 0 秒</span>}
        holdMs={6000}
        paused
        onDone={vi.fn()}
        actions={[{ label: '撤销', onClick: vi.fn() }]}
      />,
    )
    const body = screen.getByRole('alert').querySelector('.sd-toast-text')
    expect(body).toHaveTextContent('会话已移入回收站')
    expect(body).toHaveTextContent('正在恢复 1/1 · 移动中 · 已用 0 秒')
    const button = screen.getByRole('button', { name: '撤销' })
    const status = screen.getByRole('status')
    expect(button.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
