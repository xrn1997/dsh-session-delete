// 面板宽度观测（回收站两栏/下钻那条断点的数据来源，docs/ui-spec.md）
import { act, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { usePanelWidth } from '../../src/client/use-panel-width.js'
import { installWidthObserver, type WidthObserver } from './support/observe-width.js'

function Probe() {
  const ref = useRef<HTMLDivElement | null>(null)
  const width = usePanelWidth(ref)
  return (
    <div ref={ref}>
      <span data-testid="w">{String(width)}</span>
    </div>
  )
}

let observer: WidthObserver | undefined

afterEach(() => {
  observer?.restore()
})

describe('usePanelWidth', () => {
  it('量不到之前是窄档（0），不是先画一个更宽的形态', () => {
    observer = installWidthObserver()
    render(<Probe />)
    expect(screen.getByTestId('w').textContent).toBe('0')
  })

  it('RO 交回多少就是多少，宽度变了跟着变（宿主折叠侧栏那一类）', () => {
    const installed = installWidthObserver()
    observer = installed
    render(<Probe />)
    act(() => { installed.pump(1100) })
    expect(screen.getByTestId('w').textContent).toBe('1100')
    act(() => { installed.pump(400) })
    expect(screen.getByTestId('w').textContent).toBe('400')
  })

  it('卸载即断开：不留一个还在收派发的观测者', () => {
    const installed = installWidthObserver()
    observer = installed
    const view = render(<Probe />)
    act(() => { installed.pump(900) })
    expect(installed.active()).toBe(1)
    view.unmount()
    expect(installed.active()).toBe(0)
    expect(() => { installed.pump(700) }).not.toThrow()
  })
})
