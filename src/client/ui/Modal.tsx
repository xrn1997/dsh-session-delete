/**
 * `Modal`（**照抄** `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2` 的 Modal 与 useModalLayer，
 * 出处与三条改写规则见 `ui.css` 头注）：整视口蒙层 + 居中卡片，portal 到 `document.body`。
 *
 * **保留下来的行为**（官方"用户真的依赖"的那几条，`references/practices.md` 点名了 Modal 的焦点与
 * Escape）：`role="dialog"` + `aria-modal` + `aria-label`（标题即是可及名）、蒙层点击关闭、
 * Escape 关闭、Tab 在框内循环、打开时把焦点送进框（首个 `[data-modal-autofocus]`，没有就首个可聚焦
 * 元素，再没有就框本体）、关闭后把焦点还给打开它的那个元素、自动焦点不留焦点环
 * （`data-dsh-automatic-focus`，宿主主题读它来抑制 outline——键盘导航或 blur 即恢复）。
 *
 * **砍掉的**（本插件用不到，砍掉是为了不摊开官方整个 Modal API）：
 * - `description` / `headless` / `className` / `contentClassName` / `onKeyDownCapture` /
 *   `backdropBlur` / `shortcutModal`：本插件两个确认框都是"标题 + 正文 + 两个按钮"的同一形状。
 * - **官方的多层栈**（`layers` WeakMap + `closeTopModal` / `isBehindModal`）：那是给"对话框里还能再开
 *   对话框、且宿主菜单也在抢 Escape"的场景准备的。本插件同一时刻只会有一个确认框，所以这里只保留它
 *   的**判据本身**——Escape 只在"自己就是文档里最后一个 `[role="dialog"][aria-modal="true"]`
 *   或 `[role="menu"]`"时生效（`isTopLayer`）。这一条不能省：菜单/对话框先后打开时，
 *   "谁在最上面谁收 Escape"是用户能看见的规矩。
 * - **输入法合成守卫**（`observeComposition`）：本插件的对话框里没有文本输入框，不可能处在合成态。
 */
import { useLayoutEffect, useRef, type ReactElement, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { IconCloseOutlineRegular } from './icons.js'
import './styles.js'

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'

/** 文档序里排在前面的层决定谁拿快捷键：对话框与菜单同一张名单（官方 `modalSelector` 逐字）。 */
const TOP_LAYER = '[role="dialog"][aria-modal="true"], [role="menu"]'

/** 这些键一旦按下就不再是"自动焦点"，焦点环恢复正常。 */
const NAVIGATION_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

/** 自己是不是文档里最上面的那一层。 */
function isTopLayer(element: HTMLElement): boolean {
  const layers = element.ownerDocument.querySelectorAll(TOP_LAYER)
  return layers.length > 0 && layers[layers.length - 1] === element
}

/** 自动聚焦不留环：宿主主题按 `data-dsh-automatic-focus` 抑制 outline，键盘导航或失焦即摘掉。 */
function focusWithoutRing(element: HTMLElement): void {
  const release = (): void => {
    element.removeAttribute('data-dsh-automatic-focus')
    element.removeEventListener('blur', release)
    element.removeEventListener('keydown', navigate, true)
  }
  const navigate = (event: KeyboardEvent): void => {
    if (!event.isComposing && !event.ctrlKey && !event.altKey && !event.metaKey && NAVIGATION_KEYS.has(event.key)) {
      release()
    }
  }
  element.setAttribute('data-dsh-automatic-focus', '')
  element.addEventListener('blur', release)
  element.addEventListener('keydown', navigate, true)
  element.focus()
  if (!element.matches(':focus')) release()
}

/** Escape（最上层才生效）与 Tab 环绕；关闭时把焦点还给打开它的元素。 */
function useModalLayer(dialog: RefObject<HTMLDivElement>, open: boolean, onClose: () => void): void {
  const close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => {
    const element = dialog.current
    if (!open || element === null) return
    const doc = element.ownerDocument
    const previous = doc.activeElement
    const initial = element.querySelector<HTMLElement>('[data-modal-autofocus]') ??
      element.querySelector<HTMLElement>(FOCUSABLE) ??
      element
    if (!element.contains(doc.activeElement)) focusWithoutRing(initial)
    const keydown = (event: KeyboardEvent): void => {
      if (
        !isTopLayer(element) ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey
      ) {
        return
      }
      if (event.key === 'Escape' && !event.shiftKey) {
        event.preventDefault()
        if (!event.repeat) close.current()
        return
      }
      if (event.key !== 'Tab') return
      // 框内的菜单自己收 Tab（它是更上层的浮层）。
      if (doc.activeElement?.closest('[role="menu"]') != null) return
      const items = [...element.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (item) => item.closest('[inert], [hidden]') === null,
      )
      const first = items[0] ?? element
      const last = items[items.length - 1] ?? element
      const atEdge = event.shiftKey ? doc.activeElement === first : doc.activeElement === last
      if (doc.activeElement === element || !element.contains(doc.activeElement) || atEdge) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    doc.addEventListener('keydown', keydown)
    return () => {
      doc.removeEventListener('keydown', keydown)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [dialog, open])
}

export interface ModalProps {
  open: boolean
  /** 应用侧关闭（蒙层点击、Escape、关闭钮都走它）。 */
  onClose: () => void
  /** 标题：同时也是对话框的可及名。 */
  title: string
  /** 关闭钮的可及名（本地化文案，由调用面给）。 */
  closeLabel: string
  /** 动作行（取消／确认）。 */
  footer?: ReactNode
  children?: ReactNode
}

export function Modal({ open, onClose, title, closeLabel, footer, children }: ModalProps): ReactElement | null {
  const dialog = useRef<HTMLDivElement>(null)
  useModalLayer(dialog, open, onClose)
  if (!open) return null
  return createPortal(
    <div className="sd-modal-root" role="presentation">
      <div className="sd-modal-mask" aria-hidden="true" onClick={onClose} />
      <div
        ref={dialog}
        tabIndex={-1}
        className="sd-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="sd-modal-content">
          <div className="sd-modal-header">
            <h2 className="sd-modal-title">{title}</h2>
            <button type="button" className="sd-modal-close" aria-label={closeLabel} onClick={onClose}>
              <IconCloseOutlineRegular size={14} />
            </button>
          </div>
          {children === undefined ? null : <div className="sd-modal-body">{children}</div>}
        </div>
        {footer === undefined ? null : <div className="sd-modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
