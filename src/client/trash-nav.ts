/**
 * 清单的键盘导航面：方向键走环、Enter/Space 的双重语义、roving tabindex 的落点，以及窄档下钻里按 Esc
 * 回退（两程：先回父详情、再退出下钻并把焦点交还那一行）。只读事件的 target 判断这一下该不该归清单：
 * 按 key 判——方向键只在可编辑控件里让路，Enter / Space 只在按钮 / 链接 / 输入 / 菜单项上归控件。
 */
import { useCallback, useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import { hasTopLayer } from './ui/top-layer.js'

/**
 * 导航要的面。`ordered` 是屏幕上的顺序（只含展开的组）；`drillEnabled` 是这一档支不支持整行下钻。
 * 四个动作都由调用方注入：`select`（带 `drill` 才下钻）、`back`（两程回退）、`focusRow`。
 */
export interface TrashNavInput<R> {
  ordered: readonly R[]
  /** 行身份（回收站 = 条目 id，归档 = 会话 id）：调用方给模块级稳定函数，别逐渲染换引用。 */
  idOf: (row: R) => string
  selectedId: string | null
  selectMode: boolean
  drillEnabled: boolean
  drilled: boolean
  /** 四个动作都是**属性声明**：被摘下来交接，实现体不读 `this`；方法简写会被 `unbound-method` 报成可疑。 */
  select: (row: R, options?: { drill?: boolean }) => Promise<void>
  toggleCheck: (rowId: string) => void
  back: () => void
  focusRow: (rowId: string) => void
  /** Esc 的作用域（面板根节点）：**焦点在面板外**的 Esc 不归清单；根还没挂上时无从判断，不处理。 */
  scope: RefObject<HTMLElement | null>
}

export interface TrashNav {
  /** `aria-activedescendant` 的那条 id：选中行不在 DOM 里时是 `null`。 */
  readonly activeDescendantId: string | null
  /** 清单里唯一拿着 `tabIndex=0` 的那一行；清单空时是 `null`。 */
  readonly tabStopId: string | null
  /** 直接挂到清单容器的 `onKeyDown`：属性声明（见上）让「摘下来挂事件」不被误报。 */
  onListKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
}

/**
 * 键盘归属按**键**判：方向键是光标（可编辑控件里归它自己，行内按钮 / 勾选框仍归清单）；
 * Enter / Space 是激活键（按钮 / 链接 / 输入 / 菜单项归控件）。
 */
// 注意：逗号**之前**全体是一个 `input` 复合选择器（多条 `:not(...)` 必须连续拼在 `input` 后面）；
// 逗号之后才是并列的 textarea / select / contenteditable。重排或插行会让选择器静默变形。
const EDITABLE_SELECTOR =
  'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"])'
  + ':not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]), '
  + 'textarea, select, [contenteditable]:not([contenteditable="false"])'

const ACTIVATABLE_SELECTOR = [
  'button, a, input, select, textarea',
  '[role="menuitem"], [role="menu"], [role="button"], [role="link"]',
  '[role="checkbox"], [role="menuitemcheckbox"], [role="menuitemradio"]',
  '[role="option"], [role="switch"], [role="tab"]',
].join(', ')

/** `target` 是否落在某个选择器命中的元素里（含自身）。 */
function within(target: HTMLElement, selector: string): boolean {
  return typeof target.closest === 'function' && target.closest(selector) !== null
}

/** 事件是不是清单自己的：`activation=true` 问 Enter/Space，否则问方向键；测试里的窄事件没有 `target`，
 *  按清单自己的处理。 */
function isListOwnedEvent(event: ReactKeyboardEvent<HTMLElement>, activation: boolean): boolean {
  const target = event.target as HTMLElement | null | undefined
  if (target == null || target === event.currentTarget) return true
  return !within(target, activation ? ACTIVATABLE_SELECTOR : EDITABLE_SELECTOR)
}

/** 这条 Esc 该不该归清单。焦点在页面空地或 `document` 上没有"面板外"的证据，按清单处理；其余按作用域根判。 */
function shouldHandleEsc(event: KeyboardEvent, scope: RefObject<HTMLElement | null>): boolean {
  const target = event.target
  if (!(target instanceof Node)) return true
  if (target === document || target === document.body || target === document.documentElement) return true
  const root = scope.current
  return root !== null && root.contains(target)
}

export function useTrashNav<R>(input: TrashNavInput<R>): TrashNav {
  const { ordered, idOf, selectedId, selectMode, drillEnabled, drilled, select, toggleCheck, back, focusRow } = input
  /** Esc 退出下钻后要交还焦点的那一行；等 `drilled` 落地、清单回到 DOM 之后再用一次。 */
  const refocusRow = useRef<string | null>(null)

  /** 折叠起来的组只是收掉那一列，选中的 id 还留着——所以这条可见性得逐条对账，不能只看非空。 */
  const activeDescendantId = ordered.some((row) => idOf(row) === selectedId) ? selectedId : null
  const first = ordered[0]
  const tabStopId = activeDescendantId ?? (first === undefined ? null : idOf(first))

  const onListKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>): void => {
    if (ordered.length === 0) return
    const index = ordered.findIndex((row) => idOf(row) === selectedId)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // 方向键在可编辑控件里归它自己（光标移动）；行内按钮 / 勾选框上仍归清单。
      if (!isListOwnedEvent(event, false)) return
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = index < 0 ? (step > 0 ? 0 : ordered.length - 1) : (index + step + ordered.length) % ordered.length
      const target = ordered[next]
      // 显式收窄而不是非空断言：前置条件被改坏时只是不动作，不会把 undefined 当条目交出去。
      if (target === undefined) return
      void select(target)
      focusRow(idOf(target))
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      // Enter / Space 是激活键：按钮 / 链接 / 输入 / 菜单项的那一下归它们自己。
      if (!isListOwnedEvent(event, true)) return
      // 选中行被折叠时 `index` 是 -1；拿 tab 落点的那一条就是焦点所在，Enter / Space 该落在它上面。
      const target = ordered[index >= 0 ? index : 0]
      if (target === undefined) return
      event.preventDefault()
      // 多选态下 Enter/Space 说的是"勾上/取消这一条"，光标仍由 ↑↓ 移动（grid 的常规分工）。
      if (selectMode) {
        toggleCheck(idOf(target))
        return
      }
      if (drillEnabled) void select(target, { drill: true })
      else void select(target)
    }
  }, [drillEnabled, focusRow, idOf, ordered, select, selectMode, selectedId, toggleCheck])

  // 监听挂 `document`：窄档下钻时清单不在 DOM 里，挂容器上的 Esc 收不到。宽档残留 `drilled` 也不归清单；
  // 最上层 dialog / menu 自己收 Esc；焦点在面板外的让路（见 `TrashNavInput.scope`）。
  const scope = input.scope
  useEffect(() => {
    if (!drilled || !drillEnabled) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (!shouldHandleEsc(event, scope)) return
      if (hasTopLayer(document)) return
      refocusRow.current = selectedId
      back()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [drillEnabled, drilled, scope, back, selectedId])

  // 只在下钻**刚刚退出**、且手里真的有 id 时交还一次焦点；交完就清账，后续重渲染不会重复抢焦点。
  useEffect(() => {
    if (drilled || refocusRow.current === null) return
    focusRow(refocusRow.current)
    refocusRow.current = null
  }, [drilled, focusRow])

  return { activeDescendantId, tabStopId, onListKeyDown }
}
