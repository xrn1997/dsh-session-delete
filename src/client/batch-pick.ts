/**
 * 批量选择的**动作面**：全选、全选判定与模式内整行点击守卫。可见行住 `host-rows.ts`、选中集住
 * `batch-selection-store.ts`，本文件只接起来（依赖单向：`batch-pick` → 两者，`host-rows` 不 import 选择动作）。
 * DOM 的 `data-row-key` 读取都收在本文件（ADR-0034 / ADR-0071 的受约束偏离）：守卫按指针映射一条，
 * `rangePick` 按屏幕视觉序切段。
 */
import { useEffect } from 'react'
import { addPicks, togglePick, toggleRangePick, useSelection, type PickItem } from './batch-selection-store.js'
import { pickableRowOf, readVisibleSelectableRows, registeredHostRowOf } from './host-rows.js'

/** 全选：按登记序追加当前可见行；已在名单里的由 `addPicks` 跳过，原有选中保持在前。 */
export function selectAllVisible(): void {
  addPicks(readVisibleSelectableRows())
}

/** 按屏幕 DOM 视觉顺序收集当前可见的可选行；DOM 无会话节点（孤立控件单测）时回退登记序。 */
function readVisualSelectableRows(): PickItem[] {
  const nodes = document.querySelectorAll('[data-row-key^="session:"]')
  if (nodes.length === 0) return readVisibleSelectableRows()
  const seen = new Set<string>()
  const rows: PickItem[] = []
  for (const node of nodes) {
    const key = node.getAttribute('data-row-key') ?? ''
    const sessionId = key.slice('session:'.length)
    if (sessionId === '' || seen.has(sessionId)) continue
    seen.add(sessionId)
    const info = pickableRowOf(sessionId)
    if (info === undefined) continue
    rows.push({ sessionId, title: info.title })
  }
  return rows
}

/** Shift+点的范围勾选：以最近一次翻转的那条为锚，按屏幕可见行序勾上整段（锚点语义住选中集现场）。 */
export function rangePick(item: PickItem): void {
  toggleRangePick(item, readVisualSelectableRows())
}

/** 切换口显示「全选」还是「取消全选」：有选中而没有可见行时也算「取消全选」（此时点它只能清空）。 */
export function areAllVisibleRowsSelected(
  rows: readonly PickItem[],
  picks: readonly PickItem[],
): boolean {
  if (picks.length === 0) return false
  if (rows.length === 0) return true
  const chosen = new Set(picks.map((item) => item.sessionId))
  return rows.every((row) => chosen.has(row.sessionId))
}

/** 行内这些元素有自己的动作：模式内也不许被"点行=勾选"吃掉。 */
const INTERACTIVE_IN_ROW =
  'button, a, input, select, textarea, [role="menuitem"], [role="menu"], [data-dsh-session-delete="batch-pick"]'

function registeredRowTarget(event: MouseEvent): string | null {
  if (!(event.target instanceof Element)) return null
  const row = event.target.closest('[data-row-key^="session:"]')
  if (row === null) return null
  const key = row.getAttribute('data-row-key') ?? ''
  if (!key.startsWith('session:')) return null
  const sessionId = key.slice('session:'.length)
  if (sessionId === '') return null
  // 登记过但**在跑**的行仍要吃掉这一下（不许点整行打开它），只是不勾选。
  if (registeredHostRowOf(sessionId) === undefined) return null
  if (event.target.closest(INTERACTIVE_IN_ROW) !== null) return null
  return sessionId
}

/**
 * 多选态内的整行点击守卫（document 捕获阶段）。行里的按钮 / 链接 / 输入 / 菜单项一律放行；双击的第二下
 * 与 dblclick 不翻转；模式外不挂监听（点行仍是宿主的「打开会话」）。
 * 认行靠 `data-row-key="session:…"`（ADR-0034 的受约束偏离）：宿主改掉它是可接受的降级。
 * **先查登记再吞事件**：没登记的行一个默认行为都不改（吞掉会让它们静默失效）。
 */
export function useSelectionRowClickGuard(): void {
  const selecting = useSelection().selecting
  useEffect(() => {
    if (!selecting) return
    const handleMouseDown = (event: MouseEvent): void => {
      if (!event.shiftKey) return
      if (registeredRowTarget(event) === null) return
      // 浏览器原生 Shift+点跨行选字发生在 mousedown；模式内拦住以免行身文字被拖蓝。
      event.preventDefault()
    }
    const handle = (event: MouseEvent): void => {
      const sessionId = registeredRowTarget(event)
      if (sessionId === null) return
      // 先吃掉：宿主行的 onClick / 标题的 dblclick 都在后面
      event.preventDefault()
      event.stopPropagation()
      if (event.type === 'dblclick' || (event.type === 'click' && event.detail > 1)) return
      const info = pickableRowOf(sessionId)
      if (info === undefined) return
      const item = { sessionId, title: info.title }
      // Shift+click = 范围勾选（锚点→本行整段）；其余修饰键与裸 click 同路 = 切换单条。
      if (event.shiftKey) {
        rangePick(item)
        return
      }
      togglePick(item)
    }
    document.addEventListener('mousedown', handleMouseDown, true)
    document.addEventListener('click', handle, true)
    document.addEventListener('dblclick', handle, true)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown, true)
      document.removeEventListener('click', handle, true)
      document.removeEventListener('dblclick', handle, true)
    }
  }, [selecting])
}
