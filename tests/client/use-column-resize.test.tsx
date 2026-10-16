// 分栏拖动那个 hook（2026-10-15 追加：清单列可拖宽）。夹住它的是两端各一条**量出来的**下沿：
// 清单那一侧 330（「删除于 … · 大小」不再被省略号截断，见面板常量注），详情那一侧「正文至少 399」。
// 这里钉边界、键盘、aria、"没按着就不跟着鼠标走"，以及把手中途被卸载时那条 window 上的结束兜底；
// Probe 用的是面板当时那份实参。
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useColumnResize } from '../../src/client/use-column-resize.js'
import { firePointer } from './support/pointer.js'

function Probe({ panelWidth, showHandle = true }: { panelWidth: number; showHandle?: boolean }) {
  const resize = useColumnResize({
    panelWidth,
    defaultValue: 420,
    min: 330,
    reserve: 489,
    step: 20,
    label: '调整左右分栏宽度',
  })
  return (
    <div data-resizing={resize.resizing ? '' : undefined}>
      <span data-testid="width">{String(resize.listWidth)}</span>
      <span data-testid="max">{String(resize.max)}</span>
      {showHandle ? <span data-testid="handle" {...resize.handleProps} /> : null}
    </div>
  )
}

const width = () => Number(screen.getByTestId('width').textContent)
const drag = (from: number, dx: number) => {
  const handle = screen.getByTestId('handle')
  firePointer(handle, 'pointerdown', { clientX: from })
  firePointer(handle, 'pointermove', { clientX: from + dx })
  firePointer(handle, 'pointerup', { clientX: from + dx })
}

describe('分栏拖动', () => {
  it('没拖过就是默认 420；上限是「面板宽 − 详情地板与内边距」', () => {
    render(<Probe panelWidth={1200} />)
    expect(width()).toBe(420)
    expect(Number(screen.getByTestId('max').textContent)).toBe(711)
  })

  it('往宽拖按 dx 走，越界夹在上限', () => {
    render(<Probe panelWidth={1200} />)
    drag(500, 120)
    expect(width()).toBe(540)
    drag(500, 4000)
    expect(width()).toBe(711)
  })

  it('往窄拖夹在下限 330（量的是「删除于 … · 大小」那行不再被省略号截断，不是按钮放得下）', () => {
    render(<Probe panelWidth={1200} />)
    drag(500, -300)
    expect(width()).toBe(330)
  })

  it('面板自己变窄时读数重新夹住，不留一根超宽清单', () => {
    const { rerender } = render(<Probe panelWidth={1200} />)
    drag(500, 200)
    expect(width()).toBe(620)
    rerender(<Probe panelWidth={900} />)
    // 900 − 489 = 411：断点下沿那一档清单比默认还窄 9px、也抢不动宽度，两栏都守住各自的读得下限
    // （详情正好 399，2026-10-15 headless Chromium 上量过）
    expect(width()).toBe(411)
    expect(Number(screen.getByTestId('max').textContent)).toBe(411)
  })

  it('键盘：←→ 各 20px、Home 回默认、End 到上限', () => {
    render(<Probe panelWidth={1200} />)
    const handle = screen.getByTestId('handle')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(width()).toBe(440)
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(width()).toBe(400)
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(width()).toBe(420)
    fireEvent.keyDown(handle, { key: 'End' })
    expect(width()).toBe(711)
  })

  it('把手是 separator：带范围读数与方向，且可聚焦', () => {
    render(<Probe panelWidth={1200} />)
    const handle = screen.getByTestId('handle')
    expect(handle.getAttribute('role')).toBe('separator')
    expect(handle.getAttribute('aria-orientation')).toBe('vertical')
    expect(handle.getAttribute('aria-label')).toBe('调整左右分栏宽度')
    expect(handle.getAttribute('tabindex')).toBe('0')
    expect(handle.getAttribute('aria-valuemin')).toBe('330')
    expect(handle.getAttribute('aria-valuemax')).toBe('711')
    expect(handle.getAttribute('aria-valuenow')).toBe('420')
  })

  it('按下才算在拖：期间 resizing 与 data-dragging 在场，抬起就退场', () => {
    render(<Probe panelWidth={1200} />)
    const handle = screen.getByTestId('handle')
    expect(handle.hasAttribute('data-dragging')).toBe(false)
    firePointer(handle, 'pointerdown', { clientX: 500 })
    expect(handle.hasAttribute('data-dragging')).toBe(true)
    expect(document.querySelector('[data-resizing]')).not.toBeNull()
    firePointer(handle, 'pointerup', { clientX: 500 })
    expect(handle.hasAttribute('data-dragging')).toBe(false)
    expect(document.querySelector('[data-resizing]')).toBeNull()
  })

  it('拖动途中把手被卸载（面板窄过断点 ⇒ `split` 翻了）⇒ window 兜住结束，resizing 不挂死', () => {
    const { rerender } = render(<Probe panelWidth={1200} />)
    firePointer(screen.getByTestId('handle'), 'pointerdown', { clientX: 500 })
    expect(document.querySelector('[data-resizing]')).not.toBeNull()
    // 卸载之后的节点收不到任何事件：把手自己那条 pointerup 这一拍不可能再来，只能由 window 兜
    rerender(<Probe panelWidth={1200} showHandle={false} />)
    expect(document.querySelector('[data-resizing]')).not.toBeNull()
    act(() => {
      window.dispatchEvent(new Event('pointerup'))
    })
    expect(document.querySelector('[data-resizing]')).toBeNull()
  })

  it('没按着的时候 pointermove 一动不动（否则鼠标扫过就改布局）', () => {
    render(<Probe panelWidth={1200} />)
    firePointer(screen.getByTestId('handle'), 'pointermove', { clientX: 900 })
    expect(width()).toBe(420)
  })

  it('面板窄到夹不住时（max < min）停在 min，不给出负数宽度', () => {
    render(<Probe panelWidth={600} />)
    // 600 − 489 = 111 比下限还小 ⇒ 上限抬回下限，读数落在 330（这一档本来也不该出现把手）
    expect(Number(screen.getByTestId('max').textContent)).toBe(330)
    expect(width()).toBe(330)
  })
})
