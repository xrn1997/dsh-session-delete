/**
 * 清单列与详情列之间那根**可拖的宽度把手**（2026-10-15 加，设计稿 §7 状态④）。
 *
 * 三件事住在这里，因为它们互相咬合、分开测各自都不成立：
 * ① **宽度夹在两个界之间**。下限由调用方给（回收站那条的来历写在 `trash-panel.tsx`：真 Chromium
 *    上扫出来的，约束不是"两颗按钮放得下"——它们 `flex:none`，再窄也是文字列缩；而是「删除于 … ·
 *    大小」那一行不再被省略号截断），上限 = 面板宽 − `reserve`。**`reserve` 的数值与来历都住在调用方**
 *    （`DETAIL_RESERVE`，那三件东西怎么加出来的见设计稿 2026-10-15 §7.1 与现状稿 §8 的几何读数）：
 *    这一层不复制那份算式——上一版在这里钉过一个"480 ⇒ 900 那档正好回 420"，调用方改到 489 之后
 *    它就成了假数，而 900 那档的真实读数是**清单被夹到 411**（比默认窄 9px，还能往里拖）。
 * ② **夹在"读"的时候也做一次**。窗口变窄不触发任何写入，若只在写入时夹，之前拖出来的超宽
 *    清单会一直留到下次交互 ⇒ `listWidth` 每次渲染都按当前 `panelWidth` 重算。
 * ③ **按下才算在拖**。指针捕获挂在把手元素上（`setPointerCapture`），move 只可能来自这一根把手；
 *    `origin === null` 时 move 直接返回——鼠标扫过不该改布局。抬起不用显式 release：规范里
 *    pointerup/pointercancel 会隐式释放捕获，多写那一行只会引入"指针已不活跃"的抛错面。
 *    **但"结束"不能只挂在把手上**：拖动途中把手会被卸载（面板窄过断点、或清单被读空 ⇒ `split`
 *    翻了），而卸载后的节点收不到任何事件 ⇒ `resizing` 永远挂着：面板根留着 `.sd-resizing`
 *    （关文字选中），下次变宽时把手还带着 `data-dragging` 长回来。所以拖住期间另在 window 上兜
 *    一层 `pointerup`/`pointercancel`（复用同一个 `stop`）。move 仍然只认把手，捕获那套一点没动。
 *
 * 键盘那条不是装饰：`role="separator"` 可聚焦、←→ 各一格、Home 回默认、End 到上限。
 * 这一代的 `--dsw-focus-ring-color` 是 transparent（宿主自己那份焦点环靠别的属性撑），
 * 所以焦点态的可见性由 `ui.css` 里 `.sd-width-handle:focus-visible::after` 那一条负责。
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

  // 拖住期间另在 window 上兜结束那一路：把手若在拖动途中被卸载（`split` 翻了），它自己的
  // pointerup 永远不来，`resizing` 就挂在 true 上（见文件头③）。
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
