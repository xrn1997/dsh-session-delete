/**
 * 宿主会话行的**DOM 适配**（2026-10-20）：可见行解析、全选判定、模式内的整行点击守卫。
 *
 * 从 `batch-select.tsx` 拆出来的理由：选中集本身（模式 + 名单）只住 `batch-selection-store.ts`；
 * 本文件只回答**页面上**的两件事——"现在 DOM 里有哪些可选的会话行"与"在这个行上点一下算不算选中"。
 * 两边的唯一交界是 `data-row-key`（宿主会话行的稳定标记）和行尾兜底登记的那张 `rowInfo` 表。
 *
 * **为什么整行点击要抢在 document 捕获阶段**：宿主的会话行自己带 `onClick = open(sessionId)`，
 * 第三方没有官方的"别切会话"开关；模式内点行要变成"勾/取消"，只能抢在 React 根监听之前把事件吃掉。
 */
import { useEffect } from 'react'
import {
  addPicks,
  getSelection,
  togglePick,
  useSelection,
  type PickItem,
} from './batch-selection-store.js'

export interface HostRowInfo {
  /** 槽位投影的 `displayTitle`（行首槽只投 id，所以守卫靠行尾那颗常驻登记）。 */
  readonly title: string
  /** 在跑的行点整行也不选：与置灰的勾选框同口径（级联遇在跑成员整组拒绝）。 */
  readonly live: boolean
}

/**
 * 守卫从 `data-row-key` 反解出 sessionId，但拿不到槽位投影的标题／运行态 ⇒ 行尾兜底那颗
 * （它对每个非空行都渲染，哪怕 CSS 把整排藏起来）在 effect 里把这两件登记进这张表。
 * 只增不删：会话 id 不复用，行被过滤掉也不会拿旧标题冒充新行。
 */
const rowInfo = new Map<string, HostRowInfo>()

/** 行尾兜底勾选开关登记一行：模式内与模式外都要登记（守卫进模式的那一帧就得有标题）。 */
export function registerHostRowInfo(sessionId: string, info: HostRowInfo): void {
  rowInfo.set(sessionId, info)
}

/**
 * 「当前可见」的可选行：侧栏里**已渲染**的会话行（`data-row-key="session:…"`）——折叠组、
 * 归档过滤外的行不在 DOM 里，宿主隐藏的 subagent 也不在；在跑的行跳过（与置灰勾选框同口径）。
 * 标题/运行态来自行尾兜底登记的 `rowInfo`（模式内它对每个非空行都渲染）；DOM 序就是侧栏顺序。
 */
export function readVisibleSelectableRows(): PickItem[] {
  const rows: PickItem[] = []
  const seen = new Set<string>()
  for (const row of document.querySelectorAll('[data-row-key^="session:"]')) {
    const key = row.getAttribute('data-row-key') ?? ''
    if (!key.startsWith('session:')) continue
    const sessionId = key.slice('session:'.length)
    if (sessionId === '' || seen.has(sessionId)) continue
    const info = rowInfo.get(sessionId)
    if (info === undefined || info.live) continue
    seen.add(sessionId)
    rows.push({ sessionId, title: info.title })
  }
  return rows
}

/** 全选：把当前可见可选行按 DOM 序追加；已在名单里的由 `addPicks` 自己跳过，原有选中保持在前。 */
export function selectAllVisible(): void {
  addPicks(readVisibleSelectableRows())
}

/**
 * 同一个切换口该显示「全选」还是「取消全选」：
 * - 有选中、且当前可见可选行全都选中 ⇒ 取消全选；
 * - 有选中、但当前没有可见可选行（全折叠/过滤掉）⇒ 只能清空，也显示取消全选；
 * - 其余（含 0 条）⇒ 全选。
 */
export function allVisibleSelected(): boolean {
  const picks = getSelection().picks
  if (picks.length === 0) return false
  const rows = readVisibleSelectableRows()
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
 * 认行靠 `data-row-key="session:…"`——宿主将来改掉这个属性，最差是模式内点行不生效，
 * 勾选框本身仍在。模式外不挂监听：这时点行必须还是宿主的"打开会话"。
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
      const info = rowInfo.get(sessionId)
      if (info?.live === true) return
      togglePick({ sessionId, title: info?.title ?? '' })
    }
    document.addEventListener('click', handle, true)
    document.addEventListener('dblclick', handle, true)
    return () => {
      document.removeEventListener('click', handle, true)
      document.removeEventListener('dblclick', handle, true)
    }
  }, [selecting])
}

/** 测试专用：登记表清空（会话 id 不跨用例复用，名字/运行态别串味）。 */
export function resetHostRows(): void {
  rowInfo.clear()
}
