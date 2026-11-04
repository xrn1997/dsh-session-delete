/**
 * 批量选择的**动作面**：全选、全选判定与模式内整行点击守卫。
 *
 * 可见行的事实源仍住 `host-rows.ts`（槽位登记 + 快照）；选中集住 `batch-selection-store.ts`。
 * 本文件只把两者接起来，于是依赖方向单向：`batch-pick` → `host-rows` / `batch-selection-store`；
 * 浮条与行开关 → `batch-pick` / `host-rows`。`host-rows` 不再 import 任何选择动作。
 *
 * DOM 只在这里读一次 `data-row-key`（ADR-0034 记下的受约束偏离）：守卫把指针下的行映射成
 * sessionId，再查登记；它不枚举行，也不维护行列表。
 */
import { useEffect } from 'react'
import { addPicks, togglePick, useSelection, type PickItem } from './batch-selection-store.js'
import { pickableRowOf, readVisibleSelectableRows } from './host-rows.js'

/** 全选：把当前可见可选行按登记序追加；已在名单里的由 `addPicks` 自己跳过，原有选中保持在前。 */
export function selectAllVisible(): void {
  addPicks(readVisibleSelectableRows())
}

/**
 * 同一个切换口该显示「全选」还是「取消全选」：
 * - 有选中、且当前可见可选行全都选中 ⇒ 取消全选；
 * - 有选中、但当前没有可见可选行（全折叠/过滤掉）⇒ 只能清空，也显示取消全选；
 * - 其余（含 0 条）⇒ 全选。
 */
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
 * 多选态内的整行点击守卫（document 捕获阶段）。
 *
 * 边界：行里的按钮 / 链接 / 输入 / 菜单项一律放行（否则 ⋯ 菜单、归档、置顶、单删都点不动）；
 * 双击的第二下与 dblclick 不翻转（第一下已经选中，第二下不能又反掉，也不能打开宿主的重命名）。
 * 认行靠 `data-row-key="session:…"`——**这是本文件唯一一处 DOM 读**（ADR-0034）：宿主将来改掉这个
 * 属性，最差是模式内点行不生效，勾选框本身仍在。模式外不挂监听：这时点行必须还是宿主的"打开会话"。
 */
export function useSelectionRowClickGuard(): void {
  const selecting = useSelection().selecting
  useEffect(() => {
    if (!selecting) return
    const handle = (event: MouseEvent): void => {
      if (!(event.target instanceof Element)) return
      const row = event.target.closest('[data-row-key^="session:"]')
      if (row === null) return
      if (event.target.closest(INTERACTIVE_IN_ROW) !== null) return
      // 先吃掉：宿主行的 onClick / 标题的 dblclick 都在后面
      event.preventDefault()
      event.stopPropagation()
      if (event.type === 'dblclick' || (event.type === 'click' && event.detail > 1)) return
      const key = row.getAttribute('data-row-key') ?? ''
      if (!key.startsWith('session:')) return
      const sessionId = key.slice('session:'.length)
      if (sessionId === '') return
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
