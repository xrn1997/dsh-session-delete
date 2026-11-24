// 进度行（`WriteProgressLine`）：三种认领脸的渲染——own 出「正在{动作} k/N · 步骤 · 已用秒数」、
// queued 只说排队中、null 不渲染（按钮 busyLabel 已兜底）。秒数在组件内每秒刷新，不靠父组件重渲染。
// 动作码在脸里（own 支自带 `action`）——渲染端没有第二个身份入口可传错。
// 刻意**不 mock 文案**：断言写的是用户看得见的原句（zh 真源），文案改了这里就该红。
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WriteProgressAction } from '../../src/shared/wire.js'
import { zhTranslate } from '../../src/client/copy.js'
import type { WriteProgressFace } from '../../src/client/use-write-progress.js'
import { WriteProgressLine } from '../../src/client/write-progress.js'

/** 起始时刻取「当前假时钟 − 若干毫秒」：已用秒数的期望由用例自己算，不读组件内部。 */
function ownFace(
  startedAgoMs: number,
  action: WriteProgressAction = 'delete',
  over: Partial<Extract<WriteProgressFace, { kind: 'own' }>> = {},
  localStartedAgoMs = startedAgoMs,
): WriteProgressFace {
  return { kind: 'own', action, done: 2, total: 5, step: 'moving', startedAt: Date.now() - startedAgoMs, localStartedAt: Date.now() - localStartedAgoMs, ...over }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_700_000_000_000)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('WriteProgressLine · 三种认领脸', () => {
  it('own ⇒ 「正在{动作} {done}/{total} · {步骤} · 已用 {s} 秒」（动作与步骤各按自己的键出词）', () => {
    render(<WriteProgressLine face={ownFace(3500)} t={zhTranslate} />)
    expect(screen.getByRole('status')).toHaveTextContent('正在删除 2/5 · 移动中 · 已用 3 秒')
  })

  it('动作键认 wire 的连字符码：orphan-clean 出「正在清理孤儿会话」，步骤键同屏出词', () => {
    render(
      <WriteProgressLine
        face={ownFace(0, 'orphan-clean', { done: 1, total: 2, step: 'attachments' })}
        t={zhTranslate}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('正在清理孤儿会话 1/2 · 清理附件中 · 已用 0 秒')
  })

  it('秒数组件内每秒自己刷新（不靠父组件重渲染）：已用秒数随假时钟推进', () => {
    const face = ownFace(500, 'purge')
    const view = render(<WriteProgressLine face={face} t={zhTranslate} />)
    expect(screen.getByRole('status')).toHaveTextContent('已用 0 秒')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByRole('status')).toHaveTextContent('已用 1 秒')
    // 父组件不重渲染（同一张脸原样递回来），秒数照走——这行是活的，不是贴上去的字。
    view.rerender(<WriteProgressLine face={face} t={zhTranslate} />)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByRole('status')).toHaveTextContent('已用 2 秒')
  })

  it('服务端时钟落后时已用秒数按本机在飞时长封顶，不显示巨额秒数', () => {
    render(<WriteProgressLine face={ownFace(60_000, 'delete', {}, 0)} t={zhTranslate} />)
    expect(screen.getByRole('status')).toHaveTextContent('已用 0 秒')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByRole('status')).toHaveTextContent('已用 1 秒')
  })

  it('服务端时钟超前时已用秒数仍按本机单调推进，不冻在 0', () => {
    render(<WriteProgressLine face={ownFace(-60_000, 'delete', {}, 0)} t={zhTranslate} />)
    expect(screen.getByRole('status')).toHaveTextContent('已用 0 秒')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByRole('status')).toHaveTextContent('已用 1 秒')
  })

  it('秒数不进无障碍树：每秒重播整行是读屏灾难，只有 k/N 与步骤在 live region 里', () => {
    render(<WriteProgressLine face={ownFace(3500)} t={zhTranslate} />)
    // 视觉上照旧有秒数；无障碍树里它挂在 `aria-hidden` 节点下，live region 的可播报文本不含它。
    const elapsed = screen.getByText('已用 3 秒')
    expect(elapsed.closest('[aria-hidden="true"]')).not.toBeNull()
  })

  it('announce=false：整行只做视觉（撤销横幅外层已是 role=alert，不能再逐 tick 播报）', () => {
    render(<WriteProgressLine face={ownFace(0, 'restore')} t={zhTranslate} announce={false} />)
    expect(screen.queryByRole('status')).toBeNull()
    const line = screen.getByText('已用 0 秒').parentElement
    expect(line).toHaveTextContent('正在恢复 2/5 · 移动中 · 已用 0 秒')
    expect(line).toHaveAttribute('aria-hidden', 'true')
  })

  it('queued ⇒ 只说「排队中：另一写入进行中…」（不冒领别人的 k/N）', () => {
    render(<WriteProgressLine face={{ kind: 'queued' }} t={zhTranslate} />)
    expect(screen.getByRole('status')).toHaveTextContent('排队中：另一写入进行中…')
  })

  it('null ⇒ 什么都不渲染（按钮上的 busyLabel 已兜底）', () => {
    const { container } = render(<WriteProgressLine face={null} t={zhTranslate} />)
    expect(container).toBeEmptyDOMElement()
  })
})
