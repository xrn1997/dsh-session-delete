/**
 * 宿主会话行的适配：**可见行由槽位组件登记**；选择动作与模式内整行点击守卫住 `batch-pick.ts`。
 *
 * 选中集（模式 + 名单）只住 `batch-selection-store.ts`；本文件只回答页面上的「当前有哪些可勾选的
 * 会话行」：行槽位开关的挂载登记、渲染快照与按 id 的行查找。「这一行可不可勾」的 live 判据
 * 也只住这里（`pickableRowOf` / `readVisibleSelectableRows`）。DOM 只用于守卫认行，且那处 DOM
 * 读取随守卫住在 `batch-pick.ts`（ADR-0034 记下的受约束偏离）。
 *
 * 为什么不再扫 DOM：宿主的行槽位只在行可见时挂载，行首/行尾两颗开关（`BatchPickCheckbox` /
 * `BatchPickButton`）都会登记 `{title, live}`；挂载/卸载就是「这一行在不在可见集合」的契约，
 * 不需要 MutationObserver。
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { PickItem } from './batch-selection-store.js'
import { createLazyStore } from './store.js'

export interface HostRowInfo {
  /** 槽位宿主投影的标题（`PickLeadingRow` / `PickRow` 从 root hook 读）；守卫只读登记，不读 DOM 文本。 */
  readonly title: string
  /** 在跑的行点整行也不选：与置灰的勾选框同口径（级联遇在跑成员整组拒绝）。 */
  readonly live: boolean
}

/** 一条登记：它是什么 + 此刻有几颗行槽位开关在用它；标题/运行态变化就地更新，不重排。 */
interface HostRowRegistration {
  info: HostRowInfo
  owners: number
}

/**
 * 守卫从 `data-row-key` 反解出 sessionId，但拿不到槽位投影的标题／运行态 ⇒ 行首/行尾开关
 * 在 effect 里把这两件登记进这张表。生命周期跟着**行槽位组件的挂载**走：卸载即注销
 * （{@link unregisterHostRowInfo}），表的大小被"当前渲染的行"钉住，而不是随用过的会话只增不减；
 * 行重挂载时 effect 会重新登记。**这张表就是可见行的事实源**（ADR-0034），不再由 DOM 行列表反查。
 *
 * **按挂载实例计数**：同一个会话在 DOM 里可能有两行（重复行），两行各挂一组开关；
 * 其中一颗卸载时不能把另一颗还在用的登记一起摘掉——那会让这一行从"全选"里消失、标题也变空。
 */
const rowInfo = new Map<string, HostRowRegistration>()

/**
 * 渲染侧快照：`rowInfo` 变了才标脏；订阅脚手架住 `store.ts` 的 `createLazyStore`。
 * `readVisibleSelectableRows` 按登记顺序（宿主渲染顺序）返回，不再观察 DOM。
 */
const EMPTY_ROWS: readonly PickItem[] = []

const visibleRows = createLazyStore<readonly PickItem[]>(EMPTY_ROWS, readVisibleSelectableRows)

const EMPTY_ROW_INFO: HostRowInfo = { title: '', live: false }

/**
 * 行槽位开关登记一行：模式内与模式外都要登记（守卫进模式的那一帧就得有标题）。
 * 每次登记算**多一个挂载实例**；不给 info 时只占位，随后由 {@link updateHostRowInfo} 填值。
 */
export function registerHostRowInfo(sessionId: string, info?: HostRowInfo): void {
  const current = rowInfo.get(sessionId)
  if (current === undefined) {
    rowInfo.set(sessionId, { info: info ?? EMPTY_ROW_INFO, owners: 1 })
    visibleRows.invalidate()
    return
  }
  current.owners += 1
  if (info !== undefined && (current.info.title !== info.title || current.info.live !== info.live)) {
    current.info = info
    visibleRows.invalidate()
  }
}

/**
 * 标题/运行态变了就地更新：**不注销、不重登记**，否则这一行会被挪到登记序末尾（ADR-0034 决定 2）。
 */
export function updateHostRowInfo(sessionId: string, info: HostRowInfo): void {
  const current = rowInfo.get(sessionId)
  if (current === undefined) return
  // 同一行有两颗槽位开关（行首 / 行尾）：空标题可能只是其中一颗还没读到 root hook 的值，
  // 不能让它抹掉另一颗已登记的名字；非空值之间以最后落地的为准。
  const title = info.title === '' ? current.info.title : info.title
  if (current.info.title === title && current.info.live === info.live) return
  current.info = { title, live: info.live }
  visibleRows.invalidate()
}

/**
 * 槽位组件共用的登记生命周期：挂载登记、卸载注销；标题/运行态变化只走更新口。
 * 两次 effect 分工是顺序契约：先占住首次登记序，再填值。
 */
export function useHostRowRegistration(sessionId: string, info: HostRowInfo): void {
  useEffect(() => {
    registerHostRowInfo(sessionId)
    return () => { unregisterHostRowInfo(sessionId) }
  }, [sessionId])
  const { title, live } = info
  useEffect(() => {
    updateHostRowInfo(sessionId, { title, live })
  }, [sessionId, title, live])
}

/** 行槽位开关卸载时调用：那一行已经离开渲染树，登记跟着走。
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

/** `live` 行不可勾：与置灰的勾选框、守卫拦下的整行点击同一条判据。 */
function isPickable(info: HostRowInfo): boolean {
  return !info.live
}

/**
 * 守卫与全选共用的一行读数：这一行此刻可勾选时交回登记（含标题）；未登记或在跑回 `undefined`。
 * 登记表是可见行的事实源，所以"没登记"就是"这一行此刻不在可见集合里"。
 */
export function pickableRowOf(sessionId: string): HostRowInfo | undefined {
  const entry = rowInfo.get(sessionId)
  return entry === undefined || !isPickable(entry.info) ? undefined : entry.info
}

/**
 * 「当前可见」的可选行：**已登记**的会话行（槽位开关还挂在渲染树上）——折叠组、归档过滤外的行
 * 没有挂载，因此没有登记；在跑的行跳过（与置灰勾选框同口径）。标题/运行态来自登记值；
 * 顺序是登记顺序（宿主按列表顺序挂载行）。
 *
 * 这是**当场读**：事件路径（点「全选」那一刻的页面）与测试用它；渲染侧读下面的快照。
 */
export function readVisibleSelectableRows(): PickItem[] {
  const rows: PickItem[] = []
  for (const [sessionId, entry] of rowInfo) {
    if (!isPickable(entry.info)) continue
    rows.push({ sessionId, title: entry.info.title })
  }
  return rows
}

/**
 * 渲染侧的快照：脏了才重读登记；干净时回同一个引用（React 的 `useSyncExternalStore` 契约）。
 * 没变化时连续两次调用必须同引用，否则订阅方会被自己的快照更新推成死循环。
 */
export function getVisibleSelectableRowsSnapshot(): readonly PickItem[] {
  return visibleRows.get()
}

/**
 * `enabled === false` 时的稳定替身：同一个空表、不订阅、不读登记。
 * 浮条是 `shell.overlay` 的常驻槽位，模式外若照常订阅，每次行登记都会白叫醒它重渲染一次。
 */
function getEmptyRowsSnapshot(): readonly PickItem[] {
  return EMPTY_ROWS
}

function noopSubscribe(): () => void {
  return () => {}
}

/**
 * 渲染侧只读快照 + 登记订阅；`enabled === false` 不订阅也不读登记——行列表只随多选态存在，
 * 模式外不必付订阅的成本。
 */
export function useVisibleSelectableRows(enabled: boolean): readonly PickItem[] {
  return useSyncExternalStore(
    enabled ? visibleRows.subscribe : noopSubscribe,
    enabled ? visibleRows.get : getEmptyRowsSnapshot,
    enabled ? visibleRows.get : getEmptyRowsSnapshot,
  )
}

/** 测试专用：登记表清空并标脏（会话 id 不跨用例复用，名字/运行态别串味）。 */
export function resetHostRows(): void {
  rowInfo.clear()
  visibleRows.invalidate()
}
