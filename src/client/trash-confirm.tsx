/**
 * 回收站的**两张确认框**，外加孤儿会话清理框（从 `trash-panel.tsx` 拆出的 seam）。
 * 两张只共页脚壳（`confirm-dialog.tsx`，ADR-0052）：`TrashConfirm` 说"这一批去哪"，`OrphanConfirm`
 * 说的是"没有去处"——盘上目录直接消失。`busy` 期间取消与关闭都拦住：一次批量在飞时关掉框，用户会以为没动。
 */
import type { CSSProperties } from 'react'
import { ConfirmDialog } from './confirm-dialog.js'
import { absoluteText, splitOn, type Translate } from './copy.js'
import type { OrphanReportWire } from '../shared/wire.js'
import type { TrashEntryLike } from './remote.js'
import { fileSizeText } from './ui/format.js'
import { ELLIPSIS } from './ui/recipe.js'
import { CARD, projectLabel } from './trash-view.js'
import type { PendingAction } from './use-trash-panel-controller.js'

/** 弹出的一批卡片（逐条说清这一批有哪些）：长清单在框内滚，标题与动作行留在框里。 */
const CARD_LIST: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  maxHeight: 280,
  overflow: 'auto',
  marginBlockEnd: 10,
}

/** 两种批量动作共用确认框壳：批量恢复把条目列成卡片（去向是每条各自的旧项目目录）；批量彻底删除
 *  只给条数——"不可恢复"那句警告才是要读的。 */
export function TrashConfirm({
  pending,
  restoreEntries,
  busy,
  t,
  onCancel,
  onConfirmPurge,
  onConfirmRestore,
}: {
  pending: PendingAction
  restoreEntries: readonly TrashEntryLike[]
  busy: boolean
  t: Translate
  onCancel: () => void
  onConfirmPurge: () => void
  onConfirmRestore: (ids: readonly string[]) => void
}) {
  if (pending.kind === 'restore') {
    return (
      <ConfirmDialog
        title={t('trash.confirm.restore', { count: pending.ids.length })}
        closeLabel={t('common.close')}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('trash.confirm.restoreNow')}
        busy={busy}
        onCancel={onCancel}
        onConfirm={() => onConfirmRestore(pending.ids)}
      >
        {restoreEntries.length === 0 ? null : (
          <div style={CARD_LIST}>
            {restoreEntries.map((entry) => (
              <div key={entry.id} style={{ ...CARD, flexDirection: 'column', alignItems: 'stretch', gap: 2, padding: '9px 12px' }}>
                <div style={{ ...ELLIPSIS, fontSize: 13.5, lineHeight: '19px' }}>
                  {entry.title === '' ? t('common.untitled') : entry.title}
                </div>
                <div style={{ ...ELLIPSIS, fontSize: 12, lineHeight: '16px', color: 'var(--sd-label-tertiary)' }}>
                  {projectLabel(entry.projectDir, t)}
                </div>
                {/* 逐条说清去向：这一条的原工作区不存在，回去后会在「未分组」。 */}
                {entry.workspaceMissing === true ? (
                  <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--sd-label-tertiary)' }}>
                    {t('trash.row.workspaceGone')}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
        <p>{t('trash.confirm.restore.body')}</p>
      </ConfirmDialog>
    )
  }

  const title =
    pending.kind === 'all' ? t('trash.confirm.all')
    : pending.kind === 'entries' ? t('trash.confirm.bulk', { count: pending.ids.length })
    : t('trash.confirm.one')
  const strong = t('trash.confirm.body.strong')
  const body = splitOn(t('trash.confirm.body', { strong }), strong)
  return (
    <ConfirmDialog
      title={title}
      closeLabel={t('common.close')}
      cancelLabel={t('common.cancel')}
      confirmLabel={t('trash.confirm.purge')}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirmPurge}
      danger
    >
      {pending.kind === 'entry' ? (
        <div
          style={{
            ...CARD,
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: 2,
            padding: '10px 12px',
            marginBlockEnd: 10,
          }}
        >
          <div style={{ ...ELLIPSIS, fontSize: 13.5, lineHeight: '19px' }}>
            {pending.entry.title === '' ? t('common.untitled') : pending.entry.title}
          </div>
          <div
            style={{ ...ELLIPSIS, fontSize: 12, lineHeight: '16px', color: 'var(--sd-label-tertiary)' }}
          >
            {t('trash.confirm.one.meta', {
              project: projectLabel(pending.entry.projectDir, t),
              at: absoluteText(pending.entry.deletedAt),
              // 「我即将失去多少」= 整组，读的是 Node 半算好的 `releaseBytes`（与头部合计同一个数）
              size: fileSizeText(pending.entry.releaseBytes),
            })}
          </div>
        </div>
      ) : null}
      <p>
        {body[0]}
        <b style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{body[1]}</b>
        {body[2]}
      </p>
    </ConfirmDialog>
  )
}

/** 无主子会话的清理确认框。载荷是刚扫出来的那份报告，界面不重算。 */
export function OrphanConfirm({
  report,
  busy,
  t,
  onCancel,
  onConfirm,
}: {
  report: OrphanReportWire
  busy: boolean
  t: Translate
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <ConfirmDialog
      title={t('trash.orphans.confirm', { count: report.totalSessions })}
      closeLabel={t('common.close')}
      cancelLabel={t('common.cancel')}
      confirmLabel={t('trash.orphans.clean')}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
      danger
    >
      {report.groups.length === 0 ? null : (
        <div style={CARD_LIST}>
          {report.groups.map((group) => {
            const text = t('trash.orphans.group', {
              project: projectLabel(group.projectDir, t),
              count: group.sessions,
              size: fileSizeText(group.bytes),
            })
            return (
              <div
                key={group.projectDir}
                title={text}
                style={{ ...CARD, padding: '9px 12px', fontSize: 13, lineHeight: '19px' }}
              >
                <span style={{ ...ELLIPSIS, minWidth: 0, flex: '1 1 auto' }}>{text}</span>
              </div>
            )
          })}
        </div>
      )}
      <p>{t('trash.orphans.body')}</p>
      <p style={{ fontSize: 12, lineHeight: '17px', color: 'var(--sd-label-tertiary)' }}>
        {t('trash.orphans.cacheNote')}
      </p>
    </ConfirmDialog>
  )
}
