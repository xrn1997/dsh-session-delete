/**
 * 宿主列表批量删除的**控件面**（2026-10-17，2026-10-20 拆出状态与行适配）：行首勾选框、行尾兜底开关，
 * 以及确认框/浮条读的那一份计数问句。
 *
 * 入口在每行的「⋯」菜单里（`batch-menu-item.tsx`）：**按下才进入多选模式**，模式内才渲染勾选框、
 * 才把整行点击变成"勾/取消"；退出模式清空名单。选中集只住 `batch-selection-store.ts`（模式 + 名单一份
 * 合并快照）；"哪些行现在可见、点行算不算选中"只住 `host-rows.ts`。四处隔着槽位边界，只有模块级
 * store 能让他们看见同一份名单；本文件不再持有任何现场。
 *
 * **为什么主勾选在行首**：宿主对行尾 `.rowActions` 是 `display:none`，只有 `row:hover` / 菜单打开
 * 才出现（app.asar 0.2.0-rc.2 的 Rows 渲染）；行首 16px 格在无状态点时是空的，模式内可见。
 * 宿主在「有状态点（运行中/待确认/未读完成）」与归档行不渲染行首格 ⇒ 这些行走行尾悬停兜底，
 * 但模式内**点整行**也能选（`host-rows.ts` 的 `useSelectionRowClickGuard`），所以不依赖那颗小框。
 * 两条勾选不会同时出现（`ui.css` 的 `:has` 兜底隐藏规则，靠宿主行的 `data-row-key`）。
 */
import { useEffect, type ReactElement } from 'react'
import { zhTranslate, type Translate } from './copy.js'
import { registerHostRowInfo } from './host-rows.js'
import { callRemote, type SessionDeleteRemote } from './remote.js'
import { togglePick, useSelection } from './batch-selection-store.js'
import { Checkbox } from './ui/Checkbox.js'
import { IconCheckOutlineRegular } from './ui/icons.js'
import { Tooltip } from './ui/Tooltip.js'

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
  const { selecting, picks } = useSelection()
  const on = picks.some((candidate) => candidate.sessionId === sessionId)
  if (!selecting) return null
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
  const { selecting, picks } = useSelection()
  const on = picks.some((candidate) => candidate.sessionId === sessionId)
  // 模式内与模式外都登记：守卫在进入模式的那一帧就要有标题，不能等这一行重挂载。
  useEffect(() => {
    registerHostRowInfo(sessionId, { title, live })
  }, [sessionId, title, live])
  if (!selecting) return null
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
