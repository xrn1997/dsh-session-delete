/**
 * 批量删除的浮条（2026-10-17 `6f24fd4`）：**多选模式内常驻**（0 条也渲染，既显示模式又给退出入口），
 * 汇总「已选 N 条」+（读得到时）「含 K 个子会话」；「查看已选」展开限高可滚动的标题清单
 * （逐条可移除），回答"到底选了哪些"——清单默认收起，不把底部输入区盖住。
 * 模式内的整行点击守卫也挂在这棵常驻宿主上（见 `host-rows.ts` 的 `useSelectionRowClickGuard`）。
 *
 * 为什么单独一个文件而不是并进 `batch-select.tsx`：那份是"行开关控件"，而浮条要点开确认框
 * （要 import 它的现场）——两个方向合到一个文件上就是一圈。浮条住在
 * `shell.overlay` 上，与单删的撤销提示/确认框同类（槽位原文："a toast stack or a status pill
 * all belong here"）。
 *
 * 那个 K 是**勾选变化后防抖 300ms 的一次批量 count**（`/apply` 的 `action:'count'`，一组 id 一次），
 * 并且带**最新票守卫**：在飞的旧响应不许盖掉新名单的读数（compare-and-set 住 `createLatestWins`，
 * 防抖本身仍在下面这个 effect 里）。
 * 读不到就整句不说——K 是合计，缺一条就是假数（「不许拿 0 冒充没有」）。
 */
import { useEffect, useState, type ReactElement } from 'react'
import { fetchCounts } from './batch-select.js'
import { requestDeleteBatch } from './batch-confirm.js'
import { zhTranslate, type Translate } from './copy.js'
import {
  areAllVisibleRowsSelected,
  selectAllVisible,
  useSelectionRowClickGuard,
  useVisibleSelectableRows,
} from './host-rows.js'
import type { SessionDeleteRemote } from './remote.js'
import { clearPicks, exitSelection, getPicks, togglePick, useSelection } from './batch-selection-store.js'
import { createLatestWins } from './store.js'
import { Button } from './ui/Button.js'
import { IconCloseOutlineRegular } from './ui/icons.js'

/** 浮条只需要那一个批量口（计数）；执行归确认框。 */
export type BatchBarDeps = Pick<SessionDeleteRemote, 'applyOutcomes'>

/** 勾选变化后到发问之间的等待：连勾十条不该发十次 count。 */
const COUNT_DEBOUNCE_MS = 300

export function BatchBar({
  deps,
  t = zhTranslate,
}: {
  deps: BatchBarDeps
  t?: Translate
}): ReactElement | null {
  const { selecting, picks } = useSelection()
  // 模式内的整行点击（勾/取消、拦会话切换）挂在浮条这棵常驻宿主上：浮条是模式的可见形态。
  useSelectionRowClickGuard()
  // 渲染期只读快照：DOM 观察与行登记留在适配器（host-rows.ts），这里不查 DOM。
  // 浮条常驻，但行快照只在多选态订阅：模式外 body 的每次变更都不该把它叫醒。
  const visibleRows = useVisibleSelectableRows(selecting)
  const [counts, setCounts] = useState<Map<string, number> | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [latest] = useState(createLatestWins)

  useEffect(() => {
    const ids = picks.map((item) => item.sessionId)
    const ticket = latest.issue()
    const timer = setTimeout(() => {
      void fetchCounts(deps, ids).then((result) => {
        if (ticket.current) setCounts(result)
      })
    }, COUNT_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [deps, latest, picks])

  // 退出模式或名单清空后清单回到收起态；下次进来不沿用上一批的展开记忆。
  useEffect(() => {
    if (!selecting || picks.length === 0) setExpanded(false)
  }, [selecting, picks.length])

  if (!selecting) return null
  // 只合计**当前名单**：退模式/清空后 counts 里可能还留着上一批的读数，不能拿它冒充这一批。
  const kids = counts === null ? 0 : picks.reduce((sum, item) => sum + (counts.get(item.sessionId) ?? 0), 0)
  const allPicked = areAllVisibleRowsSelected(visibleRows, picks)
  return (
    <div className="sd-batch-bar" data-dsh-session-delete="batch-bar">
      {expanded && picks.length > 0 ? (
        <>
          <div className="sd-batch-bar-list-head">
            <span>{t('batch.bar.count', { n: picks.length })}</span>
            {kids > 0 ? <span>{t('batch.bar.kids', { k: kids })}</span> : null}
          </div>
          <ul className="sd-batch-bar-list">
            {picks.map((item) => {
              const title = item.title === '' ? t('common.untitled') : item.title
              const rowKids = counts?.get(item.sessionId) ?? 0
              return (
                <li className="sd-batch-bar-item" key={item.sessionId}>
                  <span className="sd-batch-bar-title" title={item.title === '' ? undefined : item.title}>
                    {title}
                  </span>
                  {rowKids > 0 ? (
                    <span className="sd-batch-bar-meta">{t('trash.row.subagents', { n: rowKids })}</span>
                  ) : null}
                  <button
                    type="button"
                    className="sd-batch-bar-remove"
                    aria-label={t('batch.bar.remove', { title })}
                    onClick={() => togglePick(item)}
                  >
                    <IconCloseOutlineRegular size={12} />
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      ) : null}
      <div className="sd-batch-bar-main">
        {picks.length === 0 ? (
          <span className="sd-batch-bar-hint">{t('batch.bar.pickHint')}</span>
        ) : null}
        {picks.length > 0 ? (
          <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
            {expanded ? t('batch.bar.reviewClose') : t('batch.bar.review')}
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onClick={allPicked ? clearPicks : selectAllVisible}>
          {allPicked ? t('batch.bar.selectNone') : t('batch.bar.selectAll')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={picks.length === 0}
          onClick={() => requestDeleteBatch(getPicks())}
        >
          {t('batch.run', { n: picks.length })}
        </Button>
        <Button variant="ghost" size="sm" onClick={exitSelection}>
          {t('trash.toolbar.selectExit')}
        </Button>
      </div>
    </div>
  )
}
