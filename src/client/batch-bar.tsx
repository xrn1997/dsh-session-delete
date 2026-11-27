/**
 * 批量移入回收站的浮条：**多选模式内常驻**（0 条也渲染），汇总「已选 N 条」+「含 K 个子会话」，
 * 「查看已选」展开可滚动的标题清单。K 是勾选防抖 300ms 后的一次批量 count（`/apply` 的 action:count），
 * 带最新票守卫；读数与它对应的名单绑在一起存，对不上就整句不说（不拿旧读数求新名单的和）。
 * 整行点击守卫也挂在这棵常驻宿主上；浮条住 `shell.overlay`。
 */
import { useEffect, useState, type ReactElement } from 'react'
import { fetchCounts } from './batch-select.js'
import { useBusyGate } from './busy-gate.js'
import { zhTranslate, type Translate } from './copy.js'
import { areAllVisibleRowsSelected, selectAllVisible, useSelectionRowClickGuard } from './batch-pick.js'
import { useVisibleSelectableRows } from './host-rows.js'
import type { OneShotDeps } from './remote.js'
import { clearPicks, exitSelection, getPicks, shrinkPicksToFailures, togglePick, useSelection } from './batch-selection-store.js'
import { createLatestWins } from './store.js'
import { Button } from './ui/Button.js'
import { IconCloseOutlineRegular } from './ui/icons.js'
import { deleteSessionsFromBatch } from './write-seats.js'

/** 勾选变化后到发问之间的等待：连勾十条不该发十次 count。 */
const COUNT_DEBOUNCE_MS = 300

/** 一次计数读数与它对应的**那一份名单**：两者必须同进同退，旧读数不许当成新名单的合计。 */
interface CountSnapshot {
  readonly ids: readonly string[]
  readonly counts: ReadonlyMap<string, number>
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const wanted = new Set(left)
  return right.every((id) => wanted.has(id))
}

export function BatchBar({
  deps,
  t = zhTranslate,
}: {
  deps: OneShotDeps
  t?: Translate
}): ReactElement | null {
  const { selecting, picks } = useSelection()
  const gate = useBusyGate()
  useSelectionRowClickGuard()
  // 浮条常驻，但行快照只在多选态订阅：模式外每次行登记都不该把它叫醒（可见行登记住 `host-rows.ts`）。
  const visibleRows = useVisibleSelectableRows(selecting)
  const [snapshot, setSnapshot] = useState<CountSnapshot | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [latest] = useState(createLatestWins)

  useEffect(() => {
    const ids = picks.map((item) => item.sessionId)
    const ticket = latest.issue()
    const timer = setTimeout(() => {
      void fetchCounts(deps, ids).then((result) => {
        if (ticket.current) setSnapshot(result === null ? null : { ids, counts: result })
      })
    }, COUNT_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [deps, latest, picks])

  // 退出模式或名单清空后清单回到收起态；下次进来不沿用上一批的展开记忆。
  useEffect(() => {
    if (!selecting || picks.length === 0) setExpanded(false)
  }, [selecting, picks.length])

  if (!selecting) return null
  const pickedIds = picks.map((item) => item.sessionId)
  const counted = snapshot !== null && sameIds(snapshot.ids, pickedIds) ? snapshot : null
  const kids = counted === null ? null : pickedIds.reduce((sum, id) => sum + (counted.counts.get(id) ?? 0), 0)
  const allPicked = areAllVisibleRowsSelected(visibleRows, picks)
  const moveToTrash = async (): Promise<void> => {
    const submittedIds = getPicks().map((item) => item.sessionId)
    if (submittedIds.length === 0) return
    const run = await deleteSessionsFromBatch(deps, submittedIds, gate)
    if (run.kind === 'blocked') return
    shrinkPicksToFailures([...run.value.keys()], submittedIds)
  }
  return (
    <div className="sd-batch-bar" data-dsh-session-delete="batch-bar">
      {expanded && picks.length > 0 ? (
        <>
          <div className="sd-batch-bar-list-head">
            <span>{t('batch.bar.count', { n: picks.length })}</span>
            {kids !== null && kids > 0 ? <span>{t('batch.bar.kids', { k: kids })}</span> : null}
          </div>
          <ul className="sd-batch-bar-list">
            {picks.map((item) => {
              const title = item.title === '' ? t('common.untitled') : item.title
              const rowKids = counted?.counts.get(item.sessionId) ?? 0
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
                    disabled={gate.busy}
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
        <Button variant="outline" size="sm" disabled={gate.busy} onClick={allPicked ? clearPicks : selectAllVisible}>
          {allPicked ? t('batch.bar.selectNone') : t('batch.bar.selectAll')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={picks.length === 0 || gate.busy}
          onClick={() => { void moveToTrash() }}
        >
          {gate.busy ? (
            <>
              <span className="sd-spinner" aria-hidden="true" />
              {t('progress.action.delete')}
            </>
          ) : (
            t('batch.run', { n: picks.length })
          )}
        </Button>
        <Button variant="ghost" size="sm" onClick={exitSelection}>
          {t('list.select.exit')}
        </Button>
      </div>
    </div>
  )
}
