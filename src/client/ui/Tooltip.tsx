/**
 * `Tooltip`（**照抄** `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2` 的 Tooltip，出处与三条改写
 * 规则见 `ui.css` 头注）：把提示挂在锚点元素上，hover / 键盘 focus 才出。
 *
 * **保留下来的行为**：`side` 三个方位的定位（`right` 取锚点右缘再让出 10px，`bottom`/`top` 居中并按
 * `gap` 让位）、视口边界收口（`edgeMargin=12`、`bottom`/`top` 装不下就翻面）、等 `ResizeObserver`
 * 量到气泡尺寸再显示（所以不会先闪一个错位的框）、指针交互之后的 focus 不弹（见 `styles.ts` 的
 * `isPointerModality`）、`portal` 时挂到 `document.body`（宿主菜单有裁剪与层叠上下文，锚点在菜单里
 * 时必须 portal，否则气泡被裁掉）。
 *
 * **砍掉的**：`shortcutKeys`（本插件没有快捷键）、`openOnClick`/`pinned` 与随之而来的
 * `useDismissOnOutsidePointer`、`aria-describedby` 关联（官方只在 pinned 时挂）、
 * `TooltipSuppression`（那是给 HoverCard 预览用的互相压制）、`delayMs`/`focusDelayMs`/`maxWidth`
 * （本插件唯一一处用的是零延迟默认值）。**没有砍掉 `side`/`gap`**：定位数学是三行分支，
 * 留着才与官方同形。
 *
 * **与官方的一处差异**：官方把锚点自己的 `ref` 与它的 `ref` 合并后一起挂；这里要求锚点**不带
 * 自己的 ref**（本插件唯一的调用点是一个裸 `<span>`），所以直接挂。要合并再补。
 */
import {
  Fragment,
  cloneElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react'
import { createPortal } from 'react-dom'
import { isPointerModality } from './styles.js'
import './styles.js'

export type TooltipSide = 'right' | 'bottom' | 'top'

export interface TooltipProps {
  /** 气泡文案；空串不显示文字（官方支持"只显示快捷键"的那种用法，本插件不用）。 */
  label: string
  /** 相对锚点的方位；缺省 `right`。 */
  side?: TooltipSide
  /** `bottom`/`top` 时锚点到气泡的距离（像素，缺省 8）；`right` 不用它。 */
  gap?: number
  /** 为真时不出气泡；锚点渲染完全不变（不会因为切换而重挂，进而打断它自己的 CSS 过渡）。 */
  disabled?: boolean
  /** 把气泡挂到 `document.body` 下（锚点在被裁剪的容器里时必须开）。 */
  portal?: boolean
  /** 单一锚点元素。 */
  children: ReactElement
}

interface AnchorRect {
  x: number
  top: number
  bottom: number
}

export function Tooltip({ label, side = 'right', gap = 8, disabled = false, portal = false, children }: TooltipProps): ReactElement {
  const anchor = useRef<HTMLElement | null>(null)
  const bubble = useRef<HTMLSpanElement | null>(null)
  const [rect, setRect] = useState<AnchorRect | null>(null)
  const visible = rect !== null && !disabled

  useEffect(() => {
    const element = bubble.current
    if (rect === null || !visible || element === null) return
    const EDGE_MARGIN = 12
    let size: { inlineSize: number; blockSize: number } | undefined
    let placement: TooltipSide = side
    const fit = (): void => {
      if (size === undefined) return
      const { inlineSize: width, blockSize: height } = size
      const offset = side === 'right' ? 0 : width / 2
      const left = Math.max(EDGE_MARGIN, Math.min(rect.x - offset, window.innerWidth - EDGE_MARGIN - width))
      const fitsBelow = rect.bottom + gap + height <= window.innerHeight - EDGE_MARGIN
      const fitsAbove = rect.top - gap - height >= EDGE_MARGIN
      if (placement === 'bottom' && !fitsBelow && fitsAbove) placement = 'top'
      else if (placement === 'top' && !fitsAbove && fitsBelow) placement = 'bottom'
      element.style.left = `${left + offset}px`
      element.style.top = `${
        placement === 'right' ? (rect.top + rect.bottom) / 2 : placement === 'top' ? rect.top - gap : rect.bottom + gap
      }px`
      element.dataset.side = placement
      element.style.visibility = 'visible'
    }
    const observer = new ResizeObserver((entries) => {
      size = entries[0]?.borderBoxSize[0]
      fit()
    })
    observer.observe(element, { box: 'border-box' })
    window.addEventListener('resize', fit)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', fit)
    }
  }, [gap, rect, side, visible])

  const show = useCallback((): void => {
    const element = anchor.current
    /* v8 ignore next -- 事件是在克隆出来的锚点上冒泡上来的，触发时 ref 必已挂上 */
    if (element === null) return
    const box = element.getBoundingClientRect()
    setRect({
      x: side === 'right' ? box.right + 10 : box.left + box.width / 2,
      top: box.top,
      bottom: box.bottom,
    })
  }, [side])

  const withdraw = useCallback((): void => {
    setRect(null)
  }, [])

  useEffect(() => {
    if (disabled) setRect(null)
  }, [disabled])

  /** 锚点自己带的处理器要照常跑（我们只加不减）——官方也是先 `children.props.onX?.(e)` 再接管。 */
  const inner = children.props as {
    onMouseEnter?: (event: ReactMouseEvent) => void
    onMouseLeave?: (event: ReactMouseEvent) => void
    onClick?: (event: ReactMouseEvent) => void
    onFocus?: (event: ReactFocusEvent) => void
    onBlur?: (event: ReactFocusEvent) => void
  }

  const anchorElement = cloneElement(children, {
    ref: (element: HTMLElement | null) => {
      anchor.current = element
    },
    onMouseEnter: (event: ReactMouseEvent) => {
      inner.onMouseEnter?.(event)
      if (!disabled) show()
    },
    onMouseLeave: (event: ReactMouseEvent) => {
      inner.onMouseLeave?.(event)
      withdraw()
    },
    onClick: (event: ReactMouseEvent) => {
      inner.onClick?.(event)
      withdraw()
    },
    onFocus: (event: ReactFocusEvent) => {
      inner.onFocus?.(event)
      // 指针交互（点一下菜单行）之后紧接着到来的 focus 不该把提示顶出来。
      if (isPointerModality()) return
      if (!disabled) show()
    },
    onBlur: (event: ReactFocusEvent) => {
      inner.onBlur?.(event)
      withdraw()
    },
  })

  const content =
    visible ? (
      <span
        ref={bubble}
        className="sd-tooltip-bubble"
        data-side={side}
        data-portal={portal ? 'true' : undefined}
        style={{ left: rect.x, top: rect.top, visibility: 'hidden' }}
        role="tooltip"
      >
        {label === '' ? null : <span className="sd-tooltip-label">{label}</span>}
      </span>
    ) : null

  return (
    <Fragment>
      {anchorElement}
      {content === null ? null : portal ? createPortal(content, document.body) : content}
    </Fragment>
  )
}
