/**
 * 清单列与详情列之间那根可拖的宽度把手。
 * ① 宽度夹在 [min, panelWidth − reserve]，reserve 的算式住调用方；② 夹在读的时候也做一次（窗口变窄
 * 不触发写入）；③ 按下才算在拖：指针捕获挂把手，window 上另兜 pointerup/pointercancel——拖动途中把手
 * 可能卸载，它自己的 pointerup 永远不来。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

export interface ColumnResizeArgs {
  /** 面板自己那一块的 border-box 宽（来自 `usePanelWidth`，不是 `window.innerWidth`）。 */
  panelWidth: number
  /** 没拖过之后的默认宽度（也是 Home 的落点）。 */
  defaultValue: number
  /** 清单列下限（读得开的下沿，来历见调用方那条注释）。 */
  min: number
  /** 详情那一侧要留下的地板：正文最小可读宽 + 间隙与分隔 + 页内边距。 */
  reserve: number
  /** 键盘一格的像素数。 */
  step: number
  /** 读屏名字（走 `copy.ts`，这里不写字面量）。 */
  label: string
}

export interface ColumnResizeHandleProps {
  role: 'separator'
  'aria-orientation': 'vertical'
  'aria-label': string
  'aria-valuenow': number
  'aria-valuemin': number
  'aria-valuemax': number
  tabIndex: number
  'data-dragging'?: ''
  onPointerDown: (event: PointerEvent<HTMLElement>) => void
  onPointerMove: (event: PointerEvent<HTMLElement>) => void
  onPointerUp: (event: PointerEvent<HTMLElement>) => void
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

export interface ColumnResize {
  listWidth: number
  max: number
  /** 拖动中：面板根挂 `.sd-resizing`（关掉文字选中），把手挂 `data-dragging`。 */
  resizing: boolean
  handleProps: ColumnResizeHandleProps
}

export function useColumnResize({
  panelWidth,
  defaultValue,
  min,
  reserve,
  step,
  label,
}: ColumnResizeArgs): ColumnResize {
  const [dragged, setDragged] = useState<number | null>(null)
  const [resizing, setResizing] = useState(false)
  const origin = useRef<{ x: number; width: number } | null>(null)

  const max = Math.max(min, panelWidth - reserve)
  const clamp = (value: number): number => Math.min(max, Math.max(min, value))
  const listWidth = clamp(dragged ?? defaultValue)

  const onPointerDown = (event: PointerEvent<HTMLElement>): void => {
    origin.current = { x: event.clientX, width: listWidth }
    setResizing(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
    const from = origin.current
    if (from === null) return
    setDragged(clamp(from.width + (event.clientX - from.x)))
  }

  const stop = (): void => {
    if (origin.current === null) return
    origin.current = null
    setResizing(false)
  }

  // 拖住期间另在 window 上兜结束：把手若在拖动途中被卸载（`split` 翻了），它的 pointerup 永远不来。
  useEffect(() => {
    if (!resizing) return
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [resizing])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const next =
      event.key === 'ArrowLeft' ? listWidth - step
      : event.key === 'ArrowRight' ? listWidth + step
      : event.key === 'Home' ? defaultValue
      : event.key === 'End' ? max
      : null
    if (next === null) return
    event.preventDefault()
    setDragged(clamp(next))
  }

  return {
    listWidth,
    max,
    resizing,
    handleProps: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': label,
      'aria-valuenow': listWidth,
      'aria-valuemin': min,
      'aria-valuemax': max,
      tabIndex: 0,
      ...(resizing ? { 'data-dragging': '' as const } : {}),
      onPointerDown,
      onPointerMove,
      onPointerUp: stop,
      onPointerCancel: stop,
      onKeyDown,
    },
  }
}
