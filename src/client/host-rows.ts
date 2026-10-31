/**
 * 宿主会话行的 DOM 适配：可见行解析、全选判定、模式内整行点击守卫。
 *
 * 选中集（模式 + 名单）只住 batch-selection-store.ts；本文件只回答页面上的两件事：
 * 当前 DOM 里有哪些可选行，以及在某一行上点击是否算选中。交界是 data-row-key 与行尾登记的
 * rowInfo。渲染走 useSyncExternalStore 快照（ADR-0015）；事件路径（全选）走当场读。
 * 模式内整行点击在 document 捕获阶段拦截，避免触发宿主的会话切换。
 */
import { useEffect, useSyncExternalStore } from 'react'
import {
  addPicks,
  togglePick,
  useSelection,
  type PickItem,
} from './batch-selection-store.js'
import { createLazyStore } from './store.js'

export interface HostRowInfo {
  /** 槽位投影的 `displayTitle`（行首槽只投 id，所以守卫靠行尾那颗常驻登记）。 */
  readonly title: string
  /** 在跑的行点整行也不选：与置灰的勾选框同口径（级联遇在跑成员整组拒绝）。 */
  readonly live: boolean
}

/** 一条登记：它是什么 + 此刻有几颗行尾开关在用它。 */
interface HostRowRegistration {
  readonly info: HostRowInfo
  owners: number
}

/**
 * 守卫从 `data-row-key` 反解出 sessionId，但拿不到槽位投影的标题／运行态 ⇒ 行尾兜底那颗
 * （它对每个非空行都渲染，哪怕 CSS 把整排藏起来）在 effect 里把这两件登记进这张表。
 * 生命周期跟着**行尾开关的挂载**走：卸载即注销（{@link unregisterHostRowInfo}），
 * 表的大小被"当前渲染的行"钉住，而不是随用过的会话只增不减；行重挂载时 effect 会重新登记。
 *
 * **按挂载实例计数**：同一个会话在 DOM 里可能有两行（重复行），两行各挂一颗行尾开关；
 * 其中一颗卸载时不能把另一颗还在用的登记一起摘掉——那会让这一行从"全选"里消失、标题也变空。
 */
const rowInfo = new Map<string, HostRowRegistration>()

/**
 * 渲染侧快照 + DOM 观察：订阅脚手架住 `store.ts` 的 `createLazyStore`；这里只提供读法与
 * 观察者生命周期。宿主行的去留只体现在 `data-row-key` 节点上（增删、属性落定），文本变化
 * 不算（标题只认 `rowInfo` 的登记值）。首个订阅者起开始观察，最后一个走了断开。
 */
const EMPTY_ROWS: readonly PickItem[] = []
let observer: MutationObserver | undefined

function startObserving(): void {
  if (observer !== undefined || typeof MutationObserver === 'undefined') return
  observer = new MutationObserver(() => visibleRows.invalidate())
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-row-key'],
  })
}

function stopObserving(): void {
  observer?.disconnect()
  observer = undefined
}

const visibleRows = createLazyStore<readonly PickItem[]>(EMPTY_ROWS, readVisibleSelectableRows, {
  onFirstSubscribe: startObserving,
  onLastUnsubscribe: stopObserving,
})

/**
 * 行尾兜底勾选开关登记一行：模式内与模式外都要登记（守卫进模式的那一帧就得有标题）。
 * 每次登记算**多一个挂载实例**；只有标题／运行态**真的变了**才标脏：重渲染时的同值登记
 * 不该把快照翻新一遍。
 */
export function registerHostRowInfo(sessionId: string, info: HostRowInfo): void {
  const current = rowInfo.get(sessionId)
  const owners = (current?.owners ?? 0) + 1
  const changed = current === undefined
    || current.info.title !== info.title
    || current.info.live !== info.live
  rowInfo.set(sessionId, { info, owners })
  if (changed) visibleRows.invalidate()
}

/** 行尾开关卸载时调用：那一行已经离开渲染树，登记跟着走。
 *  还有别的挂载实例在用同一行（重复行）就只减计数，不摘登记。 */
export function unregisterHostRowInfo(sessionId: string): void {
  const current = rowInfo.get(sessionId)
  if (current === undefined) return
  if (current.owners > 1) {
    current.owners -= 1
    return
  }
  rowInfo.delete(sessionId)
  visibleRows.invalidate()
}

/**
 * 「当前可见」的可选行：侧栏里**已渲染**的会话行（`data-row-key="session:…"`）——折叠组、
 * 归档过滤外的行不在 DOM 里，宿主隐藏的 subagent 也不在；在跑的行跳过（与置灰勾选框同口径）。
 * 标题/运行态来自行尾兜底登记的 `rowInfo`（模式内它对每个非空行都渲染）；DOM 序就是侧栏顺序。
 *
 * 这是**当场读**：事件路径（点「全选」那一刻的页面）与测试用它；渲染侧读下面的快照。
 */
export function readVisibleSelectableRows(): PickItem[] {
  const rows: PickItem[] = []
  const seen = new Set<string>()
  for (const row of document.querySelectorAll('[data-row-key^="session:"]')) {
    const key = row.getAttribute('data-row-key') ?? ''
    if (!key.startsWith('session:')) continue
    const sessionId = key.slice('session:'.length)
    if (sessionId === '' || seen.has(sessionId)) continue
    const entry = rowInfo.get(sessionId)
    if (entry === undefined || entry.info.live) continue
    seen.add(sessionId)
    rows.push({ sessionId, title: entry.info.title })
  }
  return rows
}

/**
 * 渲染侧的快照：脏了才查 DOM；干净时回同一个引用（React 的 `useSyncExternalStore` 契约）。
 * 没变化时连续两次调用必须同引用，否则订阅方会被自己的快照更新推成死循环。
 */
export function getVisibleSelectableRowsSnapshot(): readonly PickItem[] {
  return visibleRows.get()
}

/**
 * `enabled === false` 时的稳定替身：同一个空表、不订阅、不读 DOM。
 * 浮条是 `shell.overlay` 的常驻槽位，模式外若照常订阅，body 上每次变更（以及每次行登记）
 * 都会白叫醒它重渲染一次。
 */
function getEmptyRowsSnapshot(): readonly PickItem[] {
  return EMPTY_ROWS
}

function noopSubscribe(): () => void {
  return () => {}
}

/**
 * 渲染侧只读快照 + DOM 观察订阅；首个订阅者起开始观察，最后一个走了断开。
 * `enabled === false` 不订阅也不读 DOM——行列表只随多选态存在，模式外不必付观察的成本。
 */
export function useVisibleSelectableRows(enabled: boolean): readonly PickItem[] {
  return useSyncExternalStore(
    enabled ? visibleRows.subscribe : noopSubscribe,
    enabled ? visibleRows.get : getEmptyRowsSnapshot,
    enabled ? visibleRows.get : getEmptyRowsSnapshot,
  )
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
      const entry = rowInfo.get(sessionId)
      if (entry?.info.live === true) return
      togglePick({ sessionId, title: entry?.info.title ?? '' })
    }
    document.addEventListener('click', handle, true)
    document.addEventListener('dblclick', handle, true)
    return () => {
      document.removeEventListener('click', handle, true)
      document.removeEventListener('dblclick', handle, true)
    }
  }, [selecting])
}

/** 测试专用：登记表清空并标脏（会话 id 不跨用例复用，名字/运行态别串味）；观察者归订阅者管。 */
export function resetHostRows(): void {
  rowInfo.clear()
  visibleRows.invalidate()
}
