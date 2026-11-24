/**
 * 无主子会话的**维护块**：警告条、失败块、中性提示与清理确认框（现住插件设置页维护卡，ADR-0021）。
 * 只吃泛型段视图 `MaintenanceSectionView`。三条界面规则：报告非空才出警告条；读不到就说读不到
 * （原位原文 + 重试，不折成空报告）；「已经不在」不是失败（中性提示，下次检查自然消失）。
 */
import type { ReactElement } from 'react'
import type { Translate } from './copy.js'
import type { OrphanReportWire } from '../shared/wire.js'
import type { OneShotDeps } from './remote.js'
import type { MaintenanceSectionView } from './use-maintenance-section.js'
import { MaintenanceBanner, MaintenanceFailure } from './maintenance-parts.js'
import { OrphanConfirm } from './trash-confirm.js'
import { CARD } from './trash-view.js'
import { fileSizeText } from './ui/format.js'
import { IconWarningOutlineRegular } from './ui/icons.js'

export interface OrphanMaintenanceProps {
  /** 段视图：读数、提示、确认框、忙碌与四个动作都在它上面，本块不多要也不少读。 */
  section: MaintenanceSectionView<OrphanReportWire>
  /** 确认框里的进度行要轮询 `/progress`（写身份认领），走同一份取数依赖。 */
  deps: OneShotDeps
  t: Translate
}

export function OrphanMaintenance({ section, deps, t }: OrphanMaintenanceProps): ReactElement | null {
  const { report, failure, notice, confirm, busy } = section
  return (
    <>
      {/* 回收站之外的无主子会话：**只在报告非空时出现**——"检查过了，什么都没有"不是要给用户看的；
          读不到时走下面的失败块（不是这里，更不是"零条"）。层级沿用页面上那一条，实心红只归「清空回收站」。 */}
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

      {/* 检查/清理自己失败："我们没能回答有多少残留"与"没有残留"是两件事 ⇒ 原位上屏 + 重试。 */}
      {failure !== null ? (
        <MaintenanceFailure
          message={failure}
          busy={busy}
          t={t}
          gapBelow
          onRetry={() => void section.scan()}
        />
      ) : null}

      {/* 「已经不在」不是失败：别处清掉或父已回到清册；中性一条，下次扫描/刷新时自然消失。 */}
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
          deps={deps}
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
