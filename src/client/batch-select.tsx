/**
 * 宿主列表批量删除的选择面（2026-10-17）：多选模式 + 选中集 + 行首勾选 + 行尾兜底 + 整行点击守卫。
 *
 * 入口在每行的「⋯」菜单里（`batch-menu-item.tsx`）：**按下才进入多选模式**，模式内才渲染勾选框、
 * 才把整行点击变成"勾/取消"；退出模式清空名单。选中集是**模块级现场**（本仓既有的客户端模式，见
 * `delete-confirm.tsx` / `undo-toast.tsx`）：主勾选框住在每行的 `sidebar.session.row.leading` 槽位里，
 * 行尾兜底住在 `sidebar.workspaces.session.row.action`，浮条与批量确认框住在 `shell.overlay` 上——
 * 四处隔着槽位边界，只有模块级 store 能让他们看见同一份名单。状态源用 React 自带的
 * `useSyncExternalStore`，不为此引新的状态库。
 *
 * **为什么主勾选在行首**：宿主对行尾 `.rowActions` 是 `display:none`，只有 `row:hover` / 菜单打开
 * 才出现（app.asar 0.2.0-rc.2 的 Rows 渲染）；行首 16px 格在无状态点时是空的，模式内可见。
 * 宿主在「有状态点（运行中/待确认/未读完成）」与归档行不渲染行首格 ⇒ 这些行走行尾悬停兜底，
 * 但模式内**点整行**也能选（`useSelectionRowClickGuard`），所以不依赖那颗小框。
 * 两条勾选不会同时出现（`ui.css` 的 `:has` 兜底隐藏规则，靠宿主行的 `data-row-key`）。
 *
 * 名单只收槽位投影原样给的 `sessionId` / `displayTitle`（浏览器半不自己拼 id），**顺序 = 勾选顺序**：
 * 宿主列表的 DOM 序不归我们读，`/apply` 那条「保持输入顺序」吃到的因此就是勾选序。
 */
import { useEffect, useSyncExternalStore, type ReactElement } from 'react'
import { zhTranslate, type Translate } from './copy.js'
import { callRemote, type SessionDeleteRemote } from './remote.js'
import { Checkbox } from './ui/Checkbox.js'
import { IconCheckOutlineRegular } from './ui/icons.js'
import { Tooltip } from './ui/Tooltip.js'

export interface PickItem {
  /** 宿主槽位投影的会话 id，原样透给 `applyOutcomes('delete', …)`。 */
  sessionId: string
  /** 删除那一刻的会话名（投影的 `displayTitle`）：只用于文案与确认框，不参与请求。 */
  title: string
}

let picks: readonly PickItem[] = []
/** 多选模式：入口在每一行的「⋯」菜单里；只有模式内才渲染勾选框、才吃整行点击。 */
let selecting = false
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const listener of listeners) listener()
}

export function getPicks(): readonly PickItem[] {
  return picks
}

export function isSelecting(): boolean {
  return selecting
}

/** 「⋯ → 多选」按下时进入；重复进入是幂等的。 */
export function enterSelection(): void {
  if (selecting) return
  selecting = true
  emit()
}

/** 退出模式并清空名单：多选态和选中集是同一次交互的两半，退出后不该留下看不见的名单。 */
export function exitSelection(): void {
  if (!selecting && picks.length === 0) return
  selecting = false
  picks = []
  emit()
}

export function useSelecting(): boolean {
  return useSyncExternalStore(subscribe, isSelecting, isSelecting)
}

/** 翻转一条：没选过就排队尾，选过就摘掉（列表里永远不会有重复 id）。 */
export function togglePick(item: PickItem): void {
  const at = picks.findIndex((candidate) => candidate.sessionId === item.sessionId)
  picks =
    at === -1
      ? [...picks, item]
      : picks.filter((candidate) => candidate.sessionId !== item.sessionId)
  emit()
}

export function clearPicks(): void {
  if (picks.length === 0) return
  picks = []
  emit()
}

/**
 * 「当前可见」的可选行：侧栏里**已渲染**的会话行（`data-row-key="session:…"`）——折叠组、
 * 归档过滤外的行不在 DOM 里，宿主隐藏的 subagent 也不在；在跑的行跳过（与置灰勾选框同口径）。
 * 标题/运行态来自行尾兜底登记的 `rowInfo`（模式内它对每个非空行都渲染）；DOM 序就是侧栏顺序。
 */
function visibleSelectableRows(): PickItem[] {
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

/** 全选：把当前可见可选行里还没选的按 DOM 序追加；原有选中保持在前。 */
export function selectAllVisible(): void {
  const chosen = new Set(picks.map((item) => item.sessionId))
  const additions = visibleSelectableRows().filter((row) => !chosen.has(row.sessionId))
  if (additions.length === 0) return
  picks = [...picks, ...additions]
  emit()
}

/**
 * 同一个切换口该显示「全选」还是「取消全选」：
 * - 有选中、且当前可见可选行全都选中 ⇒ 取消全选；
 * - 有选中、但当前没有可见可选行（全折叠/过滤掉）⇒ 只能清空，也显示取消全选；
 * - 其余（含 0 条）⇒ 全选。
 */
export function allVisibleSelected(): boolean {
  if (picks.length === 0) return false
  const rows = visibleSelectableRows()
  if (rows.length === 0) return true
  const chosen = new Set(picks.map((item) => item.sessionId))
  return rows.every((row) => chosen.has(row.sessionId))
}

/** 执行后收缩：只留失败名单（空数组 = 全清）。成功的随通告从侧栏消失，不该留在名单里。 */
export function shrinkPicksToFailures(failedSessionIds: readonly string[]): void {
  const keep = new Set(failedSessionIds)
  picks = picks.filter((candidate) => keep.has(candidate.sessionId))
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function usePicks(): readonly PickItem[] {
  return useSyncExternalStore(subscribe, getPicks, getPicks)
}

interface RowInfo {
  /** 槽位投影的 `displayTitle`（行首槽只投 id，所以守卫靠行尾那颗常驻登记）。 */
  title: string
  /** 在跑的行点整行也不选：与置灰的勾选框同口径（级联遇在跑成员整组拒绝）。 */
  live: boolean
}

/**
 * 守卫从 `data-row-key` 反解出 sessionId，但拿不到槽位投影的标题／运行态 ⇒ 行尾兜底那颗
 * （它对每个非空行都渲染，哪怕 CSS 把整排藏起来）在 effect 里把这两件登记进这张表。
 * 只增不删：会话 id 不复用，行被过滤掉也不会拿旧标题冒充新行。
 */
const rowInfo = new Map<string, RowInfo>()

/** 行内这些元素有自己的动作：模式内也不许被"点行=勾选"吃掉。 */
const INTERACTIVE_IN_ROW =
  'button, a, input, select, textarea, [role="menuitem"], [role="menu"], [data-dsh-session-delete="batch-pick"]'

/**
 * 多选态内的整行点击守卫（document 捕获阶段）。
 *
 * 为什么必须在这里拦：宿主的会话行自己带 `onClick = open(sessionId)`，第三方没有官方的
 * "别切会话"开关；模式内点行要变成"勾/取消"，只能抢在 React 根监听之前把事件吃掉。
 * 边界：行里的按钮 / 链接 / 输入 / 菜单项一律放行（否则 ⋯ 菜单、归档、置顶、单删都点不动）；
 * 双击的第二下与 dblclick 不翻转（第一下已经选中，第二下不能又反掉，也不能打开宿主的重命名）。
 * 认行靠 `data-row-key="session:…"`——宿主将来改掉这个属性，最差是模式内点行不生效，
 * 勾选框本身仍在。
 */
export function useSelectionRowClickGuard(): void {
  const selectingNow = useSelecting()
  useEffect(() => {
    if (!selectingNow) return
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
  }, [selectingNow])
}

/**
 * 一组会话的子会话计数（`/apply` 的 `action:'count'`，纯读、不进串行链）。
 *
 * **一条读不到就整份返回 null** ——界面上那两个数（浮条的 K、确认框的 K 与逐条 M）都是合计，
 * 缺一条就是假数；「不许拿 0 冒充没有」。
 */
export async function fetchCounts(
  deps: Pick<SessionDeleteRemote, 'applyOutcomes'>,
  ids: readonly string[],
): Promise<Map<string, number> | null> {
  if (ids.length === 0) return new Map()
  const outcome = await callRemote(() => deps.applyOutcomes('count', ids))
  if (!outcome.ok) return null
  const counts = new Map<string, number>()
  for (const item of outcome.value) {
    if (item.action !== 'count' || !item.ok) return null
    counts.set(item.id, item.value)
  }
  return counts.size === ids.length ? counts : null
}

export interface BatchPickCheckboxProps {
  sessionId: string
  /** 槽位只投 `sessionId`；标题由宿主侧的 root hook 读出来再传进来（见 `index.tsx` 的 `PickLeadingRow`）。 */
  title: string
  /** 文案（缺省 = 内置 zh，见 `copy.ts`）。 */
  t?: Translate
}

/**
 * 行首 16px 格里的主勾选框：**只在多选模式内渲染**（模式入口在「⋯ → 多选」，不常驻）。
 *
 * 用的是回收站多选同款原生 `Checkbox`：它自己会 `stopPropagation`，所以点框不会顺带打开会话
 * （行首格在宿主行那条 `onClick` 里面）。宿主对「有状态点」和归档行不渲染这一格，
 * 那些行走 `BatchPickButton` 兜底；两条不会同时出现（见 `ui.css` 的兜底隐藏规则）。
 */
export function BatchPickCheckbox({
  sessionId,
  title,
  t = zhTranslate,
}: BatchPickCheckboxProps): ReactElement | null {
  const selectingNow = useSelecting()
  const selected = usePicks()
  const on = selected.some((candidate) => candidate.sessionId === sessionId)
  if (!selectingNow) return null
  const name = title === '' ? t('common.untitled') : title
  return (
    <span
      className="sd-batch-pick-leading"
      data-dsh-session-delete="batch-pick"
      data-seat="leading"
      data-checked={on ? 'true' : 'false'}
    >
      <Checkbox
        checked={on}
        label={t('batch.row.pick', { title: name })}
        onChange={() => { togglePick({ sessionId, title }) }}
      />
    </span>
  )
}

export interface BatchPickButtonProps {
  sessionId: string
  title: string
  /** 会话在跑：置灰 + 悬停原因（与单删菜单行同款——级联遇在跑成员整组拒绝，先说清再让人点不动）。 */
  live?: boolean
  /** 文案（缺省 = 内置 zh，见 `copy.ts`：这不是"忘了传"，而是"这次没有 locale 服务"）。 */
  t?: Translate
}

/**
 * 多选态里行尾悬停排的**兜底**勾选开关：只在宿主不渲染行首格的行上露头（状态点行 / 归档行）。
 * 座位原文保证「排内点击不误开会话」（`rowActions` 那层自己挡住冒泡），所以这颗按钮不需要
 * 自己 `stopPropagation`。行首那颗与这颗共用同一份选中集和同一句 aria 名字；模式内点整行也能选。
 */
export function BatchPickButton({
  sessionId,
  title,
  live = false,
  t = zhTranslate,
}: BatchPickButtonProps): ReactElement | null {
  const selectingNow = useSelecting()
  const selected = usePicks()
  const on = selected.some((candidate) => candidate.sessionId === sessionId)
  // 模式内与模式外都登记：守卫在进入模式的那一帧就要有标题，不能等这一行重挂载。
  useEffect(() => {
    rowInfo.set(sessionId, { title, live })
  }, [sessionId, title, live])
  if (!selectingNow) return null
  const name = title === '' ? t('common.untitled') : title
  // Tooltip 注入 ref，普通函数组件接不住 ⇒ 套一层 span（`delete-menu-item.tsx` 同款）。
  return (
    <Tooltip label={t('menu.live')} side="right" portal disabled={!live}>
      <span className="sd-batch-pick-action">
        <button
          type="button"
          className="sd-rowaction-button"
          data-dsh-session-delete="batch-pick"
          data-seat="action"
          data-checked={on ? 'true' : 'false'}
          aria-pressed={on}
          aria-label={t('batch.row.pick', { title: name })}
          disabled={live}
          onClick={() => togglePick({ sessionId, title })}
        >
          <IconCheckOutlineRegular size={14} />
        </button>
      </span>
    </Tooltip>
  )
}
