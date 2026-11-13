/**
 * 无主子会话的**维护块**——警告条、失败块、中性提示与清理确认框。
 *
 * 它先是回收站面板上的一块，2026-10-27 起搬进插件设置页的「维护」卡（面板不再自动扫孤儿，ADR-0021）。
 * 之所以仍收成一个 module：这三段与任何一面的清单渲染、选择、键盘、拖栏都毫无关系；改维护块的文案或
 * 确认框时，diff 不该与布局改动互相踩。它只吃泛型段 module 的一张视图 `MaintenanceSectionView`——
 * 报告、三条提示、确认框与四个动作；实现方是 `use-maintenance-section.ts` 的状态机
 * （设置页的 `use-maintenance.ts` 为孤儿会话段实例化它）。
 *
 * 三条界面规则（现状住 `docs/ui-spec.md`）：
 * - **报告非空才出警告条**：空报告与 `null` 都不出现——"检查过了，什么都没有"不是要给用户看的东西，
 *   而"还没扫到"更不是"零条"。
 * - **读不到就说读不到**：检查/清理失败在原位摆原文 + 重试，绝不静默折成一条都不出现
 *   （"没能回答有多少残留"与"没有残留"是两件事，不许折成空报告）。
 * - **「已经不在」不是失败**：别处清掉或父已回到清册时单独一条中性提示，不计入失败，下次检查时自然消失。
 *
 * 四个动作都从段上取：警告条开预览（`openPreview`，唯一开门、先清旧提示）、失败块重试（`scan`）、
 * 确认框清理（`clean`）、取消（`cancel`，只收框）。`busy` 也不再是 prop——段自己给（在飞即忙），
 * 本块只读它按住按钮。
 */
import type { ReactElement } from 'react'
import type { Translate } from './copy.js'
import type { OrphanReportWire } from '../shared/wire.js'
import type { MaintenanceSectionView } from './use-maintenance-section.js'
import { MaintenanceBanner, MaintenanceFailure } from './maintenance-parts.js'
import { OrphanConfirm } from './trash-confirm.js'
import { CARD } from './trash-view.js'
import { fileSizeText } from './ui/format.js'
import { IconWarningOutlineRegular } from './ui/icons.js'

export interface OrphanMaintenanceProps {
  /** 段视图：读数、提示、确认框、忙碌与四个动作都在它上面，本块不多要也不少读。 */
  section: MaintenanceSectionView<OrphanReportWire>
  t: Translate
}

export function OrphanMaintenance({ section, t }: OrphanMaintenanceProps): ReactElement | null {
  const { report, failure, notice, confirm, busy } = section
  return (
    <>
      {/* 回收站之外的无主子会话。**只在报告非空时出现**——"检查过了，什么都没有"不是
          要给用户看的东西，而那份报告读不到时走下面那块失败（不是这里，更不是"零条"）。
          层级沿用页面上那一条：警告色的图标 + 一句话 + 一颗描边动作，实心红仍然只归「清空回收站…」
          （确认框里那块是它的后续，与彻底删除同一个规矩）。 */}
      {report !== null && report.totalSessions > 0 ? (
        <MaintenanceBanner
          slot="orphan-banner"
          busy={busy}
          t={t}
          gapBelow
          onOpen={() => section.openPreview()}
        >
          <div style={{ fontSize: 13, lineHeight: '19px' }}>
            {t('trash.orphans.banner', { count: report.totalSessions })}
          </div>
          <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--sd-label-tertiary)' }}>
            {t('trash.orphans.meta', {
              size: fileSizeText(report.totalBytes),
              parents: report.missingParents,
            })}
          </div>
        </MaintenanceBanner>
      ) : null}

      {/* 检查/清理自己失败：这是"我们没能回答有多少残留"，与"没有残留"是两件事 ⇒ 原位上屏 + 重试，
          绝不静默折成一条都不出现。 */}
      {failure !== null ? (
        <MaintenanceFailure
          message={failure}
          busy={busy}
          t={t}
          gapBelow
          onRetry={() => void section.scan()}
        />
      ) : null}

      {/* 「已经不在」不是失败：别处清掉或父已回到清册。中性一条，下次扫描/刷新时自然消失。 */}
      {notice !== null ? (
        <div
          data-dsh-session-delete="orphan-notice"
          role="status"
          style={{ ...CARD, alignItems: 'flex-start', gap: 10, marginBottom: 10, padding: '10px 12px' }}
        >
          <span style={{ display: 'inline-flex', flex: 'none', paddingTop: 2, color: 'var(--sd-label-tertiary)' }} aria-hidden="true">
            <IconWarningOutlineRegular size={15} />
          </span>
          <span style={{ flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word', fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-label-secondary)' }}>
            {notice}
          </span>
        </div>
      ) : null}

      {confirm && report !== null ? (
        <OrphanConfirm
          report={report}
          busy={busy}
          t={t}
          onCancel={() => section.cancel()}
          onConfirm={() => void section.clean()}
        />
      ) : null}
    </>
  )
}
