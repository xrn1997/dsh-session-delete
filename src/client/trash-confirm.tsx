/**
 * 回收站的**两张确认框**，外加孤儿会话清理框（都从 `trash-panel.tsx` 搬出来的那一道 seam）。
 *
 * 搬出来的理由不是行数：它们读的是面板的 `pending`（`OrphanConfirm` 读的是维护卡的无主子会话报告）
 * 这两处 state，却与清单的渲染、选取、键盘、拖栏毫无关系——同住一个文件让"改确认框"和"改布局"在
 * 同一次 diff 里互相踩。搬成同级 module 之后，开框的那一面只负责"什么时候开哪一张"（面板开回收站
 * 的两张，插件设置页维护卡开 `OrphanConfirm`），框自己负责"点之前把话说完"。
 *
 * 两张**不共壳**：`TrashConfirm` 的两个形状说的都是"这一批要去哪"（回盘 / 进回收站），而
 * `OrphanConfirm` 的"去哪"是**没有去处**——盘上那些会话目录直接消失，回收站里从来不会有它们那一行。
 * 所以它摆的是**在哪、多大、几条**（按项目目录一组一行），外加两句服务端已经明写的边界：
 * 正在运行的会被拒绝（不是被强删），以及这一趟只清会话目录与会话独占的图片附件副本
 * （共享图片与投影缓存不在这批账里）。
 *
 * 两条贯穿两张框的规矩：
 * - **计数一律照念**：`{count}` 是报告里的 `totalSessions`、`{size}` 是 `totalBytes`，`releaseBytes`
 *   是 Node 半算好的那一格——框里一行都不自己算（自己算就是第二套口径）。
 * - **`busy` 期间取消与关闭都拦住**：一次批量在飞时关掉框，用户会以为"没动"，而它其实正在动。
 */
import type { CSSProperties } from 'react'
import { absoluteText, splitOn, type Translate } from './copy.js'
import type { OrphanReportWire, TrashEntryLike } from './remote.js'
import { Button } from './ui/Button.js'
import { fileSizeText } from './ui/format.js'
import { ELLIPSIS } from './ui/recipe.js'
import { Modal } from './ui/Modal.js'
import { BULK_DANGER, CARD, projectLabel } from './trash-view.js'
import { useIdleClose } from './confirm-close.js'
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

/**
 * 两种批量动作共用这一个确认框壳：`purge`（不可恢复）与 `restore`（加法，但一批条目多、去向是
 * 各自的旧项目目录，点之前也要过一道）。标题、正文、确认键的措辞各处一套；批量恢复把选中条目
 * 列成卡片（标题 + 项目名——恢复的去向是**每条各自的**旧项目目录，逐条列出来是这句话的正文）；
 * 批量彻底删除只给条数——那批的"去哪"没有可说的，而"不可恢复"那句警告才是要读的。
 */
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
  const { close, closeDisabled } = useIdleClose(busy, onCancel)
  if (pending.kind === 'restore') {
    return (
      <Modal
        open
        onClose={close}
        title={t('trash.confirm.restore', { count: pending.ids.length })}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="outline" disabled={closeDisabled} onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => onConfirmRestore(pending.ids)}>
              {t('trash.confirm.restoreNow')}
            </Button>
          </>
        }
      >
        {restoreEntries.length === 0 ? null : (
          <div style={CARD_LIST}>
            {restoreEntries.map((entry) => (
              <div key={entry.id} style={{ ...CARD, flexDirection: 'column', alignItems: 'stretch', gap: 2, padding: '9px 12px' }}>
                <div style={{ ...ELLIPSIS, fontSize: 13.5, lineHeight: '19px' }}>
                  {entry.title === '' ? t('common.untitled') : entry.title}
                </div>
                <div style={{ ...ELLIPSIS, fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>
                  {projectLabel(entry.projectDir, t)}
                </div>
                {/* 逐条说清去向：这一条的原工作区不存在，回去后会在「未分组」（与行上同一句）。 */}
                {entry.workspaceMissing === true ? (
                  <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>
                    {t('trash.row.workspaceGone')}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
        <p>{t('trash.confirm.restore.body')}</p>
      </Modal>
    )
  }

  const title =
    pending.kind === 'all' ? t('trash.confirm.all')
    : pending.kind === 'entries' ? t('trash.confirm.bulk', { count: pending.ids.length })
    : t('trash.confirm.one')
  const strong = t('trash.confirm.body.strong')
  const body = splitOn(t('trash.confirm.body', { strong }), strong)
  return (
    <Modal
      open
      onClose={close}
      title={title}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="outline" disabled={closeDisabled} onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" style={BULK_DANGER} disabled={busy} onClick={onConfirmPurge}>
            {t('trash.confirm.purge')}
          </Button>
        </>
      }
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
            style={{ ...ELLIPSIS, fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}
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
    </Modal>
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
  const { close, closeDisabled } = useIdleClose(busy, onCancel)
  return (
    <Modal
      open
      onClose={close}
      title={t('trash.orphans.confirm', { count: report.totalSessions })}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="outline" disabled={closeDisabled} onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" style={BULK_DANGER} disabled={busy} onClick={onConfirm}>
            {t('trash.orphans.clean')}
          </Button>
        </>
      }
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
      <p style={{ fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)' }}>
        {t('trash.orphans.cacheNote')}
      </p>
    </Modal>
  )
}
