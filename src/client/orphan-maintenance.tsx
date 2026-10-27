/**
 * 无主子会话的**维护块**——警告条、失败块、中性提示与清理确认框。
 *
 * 它先是回收站面板上的一块，2026-10-27 起搬进插件设置页的「维护」卡（面板不再自动扫孤儿，ADR-0021）。
 * 之所以仍收成一个 module：这三段与任何一面的清单渲染、选择、键盘、拖栏都毫无关系；改维护块的文案或
 * 确认框时，diff 不该与布局改动互相踩。它只吃一个窄接口 `OrphanMaintenanceQuery`——报告、三条提示与
 * 四个动作，实现方是设置页的 `use-maintenance.ts`。
 *
 * 三条界面规则（现状住 `docs/ui-spec.md`）：
 * - **报告非空才出警告条**：空报告与 `null` 都不出现——"检查过了，什么都没有"不是要给用户看的东西，
 *   而"还没扫到"更不是"零条"。
 * - **读不到就说读不到**：检查/清理失败在原位摆原文 + 重试，绝不静默折成一条都不出现
 *   （"没能回答有多少残留"与"没有残留"是两件事，不许折成空报告）。
 * - **「已经不在」不是失败**：别处清掉或父已回到清册时单独一条中性提示，不计入失败，下次检查时自然消失。
 *
 * 四个动作都由实现方给：警告条开预览（`openOrphanPreview`）、失败块重试（`scanOrphans`）、
 * 确认框清理（`cleanOrphans`）、取消（`setOrphanConfirm`）。`busy` 不归本 module 管——它是实现方
 * 那一段自己的忙碌读数，通过 props 传进来。
 */
import type { ReactElement } from 'react'
import type { Translate } from './copy.js'
import type { OrphanReportWire } from './remote.js'
import { MaintenanceBanner, MaintenanceFailure } from './maintenance-parts.js'
import { OrphanConfirm } from './trash-confirm.js'
import { CARD } from './trash-view.js'
import { fileSizeText } from './ui/format.js'
import { IconWarningOutlineRegular } from './ui/icons.js'

/**
 * 本块消费的那一面：一份报告、三条提示、四个动作。窄到只列它真读的成员——实现方多给（阶段、忙碌、
 * 附件回执…）都与本块无关，也不许本块去读。设置页的 `Maintenance` 结构上满足它。
 */
export interface OrphanMaintenanceQuery {
  /** `null` = 还没检查/读不到；本块只认"非空报告"那一档。 */
  readonly orphanReport: OrphanReportWire | null
  readonly orphanFailure: string | null
  readonly orphanNotice: string | null
  readonly orphanConfirm: boolean
  setOrphanConfirm(open: boolean): void
  openOrphanPreview(): void
  cleanOrphans(): Promise<void>
  /** 检查（也是失败块那颗「重试」）：维护面上没有第二份扫描入口。 */
  scanOrphans(): Promise<void>
}

export interface OrphanMaintenanceProps {
  query: OrphanMaintenanceQuery
  /** 这一段自己的忙碌读数：在飞时按住本块里的每一颗按钮。 */
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
        <MaintenanceBanner
          slot="orphan-banner"
          busy={busy}
          t={t}
          gapBelow
          onOpen={() => query.openOrphanPreview()}
        >
          <div style={{ fontSize: 13, lineHeight: '19px' }}>
            {t('trash.orphans.banner', { count: orphanReport.totalSessions })}
          </div>
          <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>
            {t('trash.orphans.meta', {
              size: fileSizeText(orphanReport.totalBytes),
              parents: orphanReport.missingParents,
            })}
          </div>
        </MaintenanceBanner>
      ) : null}

      {/* 检查/清理自己失败：这是"我们没能回答有多少残留"，与"没有残留"是两件事 ⇒ 原位上屏 + 重试，
          绝不静默折成一条都不出现。 */}
      {orphanFailure !== null ? (
        <MaintenanceFailure
          message={orphanFailure}
          busy={busy}
          t={t}
          gapBelow
          onRetry={() => void query.scanOrphans()}
        />
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
