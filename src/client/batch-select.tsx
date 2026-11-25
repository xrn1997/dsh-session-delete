/**
 * 宿主列表批量删除的**控件面**：行首勾选框、行尾兜底开关，以及计数问句 `fetchCounts`。
 * 入口在「⋯」菜单：按下才进入多选模式，模式内才渲染勾选框并把整行点击变成勾/取消；退出模式清空名单。
 * 选中集只住 `batch-selection-store.ts`；可见行住 `host-rows.ts`；点行算不算选中住 `batch-pick.ts`。
 * **主勾选在行首**：宿主对行尾 `.rowActions` 是 `display:none`，只有行尾悬停/菜单打开才出现（app.asar 0.2.0-rc.2 的 `Rows` 渲染）；
 * 有状态点与归档行不渲染行首格，走行尾兜底（两条不会同时出现，靠 `ui.css` 的 `:has` 隐藏规则）。
 */
import { useRef, type ReactElement } from 'react'
import { zhTranslate, type Translate } from './copy.js'
import { useHostRowRegistration } from './host-rows.js'
import { type SessionDeleteRemote } from './remote.js'
import { readReceipt } from './receipt.js'
import { togglePick, useSelection } from './batch-selection-store.js'
import { rangePick } from './batch-pick.js'
import { Checkbox } from './ui/Checkbox.js'
import { IconCheckOutlineRegular } from './ui/icons.js'
import { Tooltip } from './ui/Tooltip.js'

/**
 * 一组会话的子会话计数（`/apply` 的 `action:'count'`，纯读、不进串行链）。
 * **一条读不到就整份返回 null**：界面上的合计缺一条就是假数（不许拿 0 冒充没有）。
 */
export async function fetchCounts(
  deps: Pick<SessionDeleteRemote, 'applyOutcomes'>,
  ids: readonly string[],
): Promise<Map<string, number> | null> {
  if (ids.length === 0) return new Map()
  const outcome = await deps.applyOutcomes('count', ids)
  if (!outcome.ok) return null
  const receipt = readReceipt('count', ids, outcome.value)
  if (receipt.verdicts.some((verdict) => verdict.kind !== 'ok')) return null
  // `readReceipt` 已去重且为每个请求 id 填了一条 verdict ⇒ `counts` 的键集就是请求集，不用再比一次。
  return new Map(receipt.verdicts.map((verdict): [string, number] =>
    [verdict.id, verdict.kind === 'ok' ? verdict.value : 0]))
}

export interface BatchPickCheckboxProps {
  sessionId: string
  /** 槽位只投 `sessionId`；标题由宿主侧的 root hook 读出来再传进来（见 `index.tsx` 的 `PickLeadingRow`）。 */
  title: string
  /** 运行态同样由 root hook 读：登记表里的 `live` 与行尾兜底保持同一口径。 */
  live?: boolean
  t?: Translate
}

/**
 * 行首 16px 格里的主勾选框：**只在多选模式内渲染**。原生 `Checkbox` 自己会 `stopPropagation`，
 * 所以点框不会顺带打开会话；宿主对「有状态点」与归档行不渲染这一格，走 `BatchPickButton` 兜底。
 */
export function BatchPickCheckbox({
  sessionId,
  title,
  live = false,
  t = zhTranslate,
}: BatchPickCheckboxProps): ReactElement | null {
  const { selecting, picks } = useSelection()
  // 行首槽也登记：只有行首槽渲染的宿主代次也不必单独兜底（ADR-0034 决定 1）。
  useHostRowRegistration(sessionId, { title, live })
  // Shift 只在 click 上有、onChange 带不出来 ⇒ click 记一笔、change 分派（键盘点空格也走 click）。
  // 必须在早退之前：hook 顺序不许随渲染分支变。
  const shiftRef = useRef(false)
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
        onClick={(event) => { shiftRef.current = event.shiftKey }}
        onChange={() => {
          const item = { sessionId, title }
          if (shiftRef.current) {
            shiftRef.current = false
            rangePick(item)
            return
          }
          togglePick(item)
        }}
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
 * 多选态里行尾悬停排的**兜底**勾选开关：只在宿主不渲染行首格的行上露头。
 * 座位原文保证「排内点击不误开会话」（`rowActions` 那层自己挡住冒泡），所以这里不需要 `stopPropagation`。
 */
export function BatchPickButton({
  sessionId,
  title,
  live = false,
  t = zhTranslate,
}: BatchPickButtonProps): ReactElement | null {
  const { selecting, picks } = useSelection()
  const on = picks.some((candidate) => candidate.sessionId === sessionId)
  // 模式内与模式外都登记：守卫进入模式那一帧就要有标题；卸载即注销，标题/运行态变化走更新口。
  useHostRowRegistration(sessionId, { title, live })
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
          onClick={(event) => {
            const item = { sessionId, title }
            if (event.shiftKey) {
              rangePick(item)
              return
            }
            togglePick(item)
          }}
        >
          <IconCheckOutlineRegular size={14} />
        </button>
      </span>
    </Tooltip>
  )
}
