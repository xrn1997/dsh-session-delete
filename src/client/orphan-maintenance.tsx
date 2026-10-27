/**
 * 无主子会话的**维护块**——警告条、失败块、中性提示与清理确认框，回收站面板上唯一的维护块 seam。
 *
 * 为什么收回一个 module：这三段与面板的清单渲染、选择、键盘、拖栏毫无关系，却同住回收站最大的那个文件；
 * 改维护块的文案或确认框时，diff 会与布局改动互相踩。搬出来之后面板只留一个插入点
 * （`<OrphanMaintenance />`，在 header 之后、toolbar 之前），本 module 的 interface 就是那四个读数与四个动作。
 *
 * 搬字时一处未改的三条界面规则（现状住 `docs/ui-spec.md`）：
 * - **报告非空才出警告条**：空报告与 `null` 都不出现——"检查过了，什么都没有"不是要给用户看的东西，
 *   而"还没扫到"更不是"零条"。
 * - **读不到就说读不到**：检查/清理失败在原位摆原文 + 重试，绝不静默折成一条都不出现
 *   （"没能回答有多少残留"与"没有残留"是两件事，不许折成空报告）。
 * - **「已经不在」不是失败**：别处清掉或父已回到清册时单独一条中性提示，不计入失败，下次扫描/刷新时自然消失。
 *
 * 写动作仍走 `use-trash-query.ts` 那一条：警告条开预览（`openOrphanPreview`）、失败块重试（`refreshAll`）、
 * 确认框清理（`cleanOrphans`）。`busy` 不归本 module 管——它是面板那枚全局闸的读数，通过 props 传进来。
 */
import type { ReactElement } from 'react'
import type { Translate } from './copy.js'
import { OrphanConfirm } from './trash-confirm.js'
import { CARD } from './trash-view.js'
import { Button } from './ui/Button.js'
import { fileSizeText } from './ui/format.js'
import { IconWarningOutlineRegular } from './ui/icons.js'
import type { TrashQuery } from './use-trash-query.js'

export interface OrphanMaintenanceProps {
  query: Pick<TrashQuery,
    | 'orphanReport' | 'orphanFailure' | 'orphanNotice' | 'orphanConfirm'
    | 'setOrphanConfirm' | 'openOrphanPreview' | 'cleanOrphans' | 'refreshAll'>
  /** 面板那枚全局闸的读数：写动作在飞时按住本块里的每一颗按钮。 */
  busy: boolean
  t: Translate
}

export function OrphanMaintenance({ query, busy, t }: OrphanMaintenanceProps): ReactElement | null {
  const { orphanReport, orphanFailure, orphanNotice, orphanConfirm } = query
  return (
    <>
      {/* 回收站之外的无主子会话。**只在报告非空时出现**——"检查过了，什么都没有"不是
          要给用户看的东西，而那份报告读不到时走下面那块失败（不是这里，更不是"零条"）。
          层级沿用页面上那一条：警告色的图标 + 一句话 + 一颗描边动作，实心红仍然只归「清空回收站…」
          （确认框里那块是它的后续，与彻底删除同一个规矩）。 */}
      {orphanReport !== null && orphanReport.totalSessions > 0 ? (
        <div
          data-dsh-session-delete="orphan-banner"
          style={{ ...CARD, alignItems: 'flex-start', gap: 12, marginBottom: 10 }}
        >
          <span style={{ display: 'inline-flex', flex: 'none', paddingTop: 2, color: 'var(--dsw-alias-state-warn-primary)' }} aria-hidden="true">
            <IconWarningOutlineRegular size={16} />
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 auto', minWidth: 0 }}>
            <div style={{ fontSize: 13, lineHeight: '19px' }}>
              {t('trash.orphans.banner', { count: orphanReport.totalSessions })}
            </div>
            <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>
              {t('trash.orphans.meta', {
                size: fileSizeText(orphanReport.totalBytes),
                parents: orphanReport.missingParents,
              })}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            style={{ flex: 'none' }}
            disabled={busy}
            onClick={() => {
              if (busy) return
              query.openOrphanPreview()
            }}
          >
            {t('trash.orphans.open')}
          </Button>
        </div>
      ) : null}

      {/* 检查/清理自己失败：这是"我们没能回答有多少残留"，与"没有残留"是两件事 ⇒ 原位上屏 + 重试，
          绝不静默折成一条都不出现。 */}
      {orphanFailure !== null ? (
        <div role="status" style={{ ...CARD, alignItems: 'flex-start', gap: 10, marginBottom: 10, padding: '10px 12px' }}>
          <span style={{ display: 'inline-flex', flex: 'none', color: 'var(--dsw-alias-state-error-primary)' }} aria-hidden="true">
            <IconWarningOutlineRegular size={15} />
          </span>
          <span style={{ flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word', fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-state-error-primary)' }}>
            {orphanFailure}
          </span>
          <Button variant="outline" size="sm" style={{ flex: 'none' }} disabled={busy} onClick={() => void query.refreshAll()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : null}

      {/* 「已经不在」不是失败：别处清掉或父已回到清册。中性一条，下次扫描/刷新时自然消失。 */}
      {orphanNotice !== null ? (
        <div
          data-dsh-session-delete="orphan-notice"
          role="status"
          style={{ ...CARD, alignItems: 'flex-start', gap: 10, marginBottom: 10, padding: '10px 12px' }}
        >
          <span style={{ display: 'inline-flex', flex: 'none', paddingTop: 2, color: 'var(--dsw-alias-label-tertiary)' }} aria-hidden="true">
            <IconWarningOutlineRegular size={15} />
          </span>
          <span style={{ flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word', fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-label-secondary)' }}>
            {orphanNotice}
          </span>
        </div>
      ) : null}

      {orphanConfirm && orphanReport !== null ? (
        <OrphanConfirm
          report={orphanReport}
          busy={busy}
          t={t}
          onCancel={() => query.setOrphanConfirm(false)}
          onConfirm={() => void query.cleanOrphans()}
        />
      ) : null}
    </>
  )
}
