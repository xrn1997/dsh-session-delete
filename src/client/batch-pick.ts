/**
 * 批量选择的**动作面**：全选、全选判定与模式内整行点击守卫。可见行住 `host-rows.ts`、选中集住
 * `batch-selection-store.ts`，本文件只接起来（依赖单向：`batch-pick` → 两者，`host-rows` 不 import 选择动作）。
 * DOM 只在这里读一次 `data-row-key`（ADR-0034 的受约束偏离）。
 */
import { useEffect } from 'react'
import { addPicks, togglePick, useSelection, type PickItem } from './batch-selection-store.js'
import { pickableRowOf, readVisibleSelectableRows, registeredHostRowOf } from './host-rows.js'

/** 全选：按登记序追加当前可见行；已在名单里的由 `addPicks` 跳过，原有选中保持在前。 */
export function selectAllVisible(): void {
  addPicks(readVisibleSelectableRows())
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

/**
 * 多选态内的整行点击守卫（document 捕获阶段）。行里的按钮 / 链接 / 输入 / 菜单项一律放行；双击的第二下
 * 与 dblclick 不翻转；模式外不挂监听（点行仍是宿主的「打开会话」）。
 * 认行靠 `data-row-key="session:…"`——**本文件唯一一处 DOM 读**（ADR-0034）：宿主改掉它是可接受的降级。
 * **先查登记再吞事件**：没登记的行一个默认行为都不改（吞掉会让它们静默失效）。
 */
export function useSelectionRowClickGuard(): void {
  const selecting = useSelection().selecting
  useEffect(() => {
    if (!selecting) return
    const handle = (event: MouseEvent): void => {
      if (!(event.target instanceof Element)) return
      const row = event.target.closest('[data-row-key^="session:"]')
      if (row === null) return
      const key = row.getAttribute('data-row-key') ?? ''
      if (!key.startsWith('session:')) return
      const sessionId = key.slice('session:'.length)
      if (sessionId === '') return
      // 登记过但**在跑**的行仍要吃掉这一下（不许点整行打开它），只是不勾选。
      if (registeredHostRowOf(sessionId) === undefined) return
      if (event.target.closest(INTERACTIVE_IN_ROW) !== null) return
      // 先吃掉：宿主行的 onClick / 标题的 dblclick 都在后面
      event.preventDefault()
      event.stopPropagation()
      if (event.type === 'dblclick' || (event.type === 'click' && event.detail > 1)) return
      const info = pickableRowOf(sessionId)
      if (info === undefined) return
      togglePick({ sessionId, title: info.title })
    }
    document.addEventListener('click', handle, true)
    document.addEventListener('dblclick', handle, true)
    return () => {
      document.removeEventListener('click', handle, true)
      document.removeEventListener('dblclick', handle, true)
    }
  }, [selecting])
}
