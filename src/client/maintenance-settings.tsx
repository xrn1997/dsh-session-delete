/**
 * 插件设置页的「维护」卡（ADR-0021）：那张槽位上的两张卡里，本文件只拥有下面这一张。
 *
 * 两段都是**手动**的：检查 → 预览 → 清理，没有挂载即扫、没有定时器。卡片的职责只有呈现：
 * 状态那一行、检查按钮、以及各段自己的横幅 / 失败 / 提示 / 确认框；读数与动作全归
 * `src/client/use-maintenance.ts`。两张卡的先后与 `summary` 守卫在 `src/client/settings-cards.tsx`。
 *
 * 与回收站面板的区别：这里没有面板高度、没有清单与详情两栏、没有全局闸。控件只用
 * `settingsCardShell` / `Button` / `Modal` / `fileSizeText`，所以同一张卡放在插件详情页的任意宽度下都成立。
 *
 * 孤儿会话段直接复用 `OrphanMaintenance`（警告条 / 失败 / 中性提示 / 预览确认的既有呈现）；
 * 孤儿附件段是本文件里的 `AttachmentMaintenance`（横幅 + 失败 + 回执 + 缩略图预览与清理确认）。
 */
import type { ReactElement, ReactNode } from 'react'
import { AttachmentNotice, AttachmentStrip } from './attachment-view.js'
import { useIdleClose } from './confirm-close.js'
import { zhTranslate, type Translate } from './copy.js'
import type { AttachmentOrphanItemWire, AttachmentOrphanReportWire } from '../shared/wire.js'
import { MaintenanceBanner, MaintenanceFailure } from './maintenance-parts.js'
import { OrphanMaintenance } from './orphan-maintenance.js'
import { settingsCardShell } from './settings-view.js'
import { fileSizeText } from './ui/format.js'
import { Button } from './ui/Button.js'
import { Modal } from './ui/Modal.js'
import { BULK_DANGER } from './trash-view.js'
import { useMaintenance, type MaintenanceDeps } from './use-maintenance.js'
import type { MaintenanceSectionView, MaintenancePhase } from './use-maintenance-section.js'

/** 卡片外壳：与「可调项」卡同款，只差本卡的内容节奏。 */
const CARD_SHELL = settingsCardShell(18)

interface MaintenanceSectionProps {
  /** 给测试与界面规格一个稳定的段名；也方便宿主页调试时看出是哪一段。 */
  slot: 'maintenance-orphans' | 'maintenance-attachments'
  title: string
  hint: string
  /** 这一段的计数（从报告里点名：孤儿会话念组数、附件念件数）；报告不在 = null。 */
  count: number | null
  countKey: 'maintenance.orphans.count' | 'maintenance.attachments.count'
  /** 段对象：状态行的在飞档位 / 失败与检查按钮的忙碌都从它取（busy 由段自己给，不再当 prop 传）。 */
  section: Pick<MaintenanceSectionView<unknown>, 'busy' | 'phase' | 'failure'>
  onScan: () => void
  t: Translate
  children: ReactNode
}

/** 一段的标题行：标题 + 说明 + 状态 + 检查按钮。状态按优先级：清理中 / 检查中 / 检查失败 / 尚未检查 / 没有发现 / N。 */
function MaintenanceSection({ slot, title, hint, count, countKey, section, onScan, t, children }: MaintenanceSectionProps): ReactElement {
  const status = statusText({ phase: section.phase, failure: section.failure, count, countKey, t })
  return (
    <section
      data-dsh-session-delete={slot}
      style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 auto', minWidth: 0 }}>
          <div style={{ fontSize: 13.5, lineHeight: '19px', fontWeight: 500 }}>{title}</div>
          <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--sd-label-tertiary)' }}>{hint}</div>
        </div>
        <span
          data-dsh-session-delete="maintenance-status"
          style={{
            flex: 'none',
            paddingTop: 1,
            fontSize: 12,
            lineHeight: '17px',
            color: 'var(--sd-label-tertiary)',
            whiteSpace: 'nowrap',
          }}
        >
          {status}
        </span>
        <Button variant="outline" size="sm" style={{ flex: 'none' }} disabled={section.busy} onClick={onScan}>
          {t('maintenance.scan')}
        </Button>
      </div>
      {children}
    </section>
  )
}

/**
 * 状态那一行只有一个判据，顺序固定：
 * 在飞的动作（清理中 / 检查中）→ 失败（检查失败，不是"尚未检查"）→ 报告在不在、是否为 0（尚未检查 / 没有发现 / N）。
 */
function statusText(input: {
  phase: MaintenancePhase | null
  failure: string | null
  count: number | null
  countKey: 'maintenance.orphans.count' | 'maintenance.attachments.count'
  t: Translate
}): string {
  if (input.phase === 'cleaning') return input.t('maintenance.cleaning')
  if (input.phase === 'scanning') return input.t('maintenance.scanning')
  // 失败时报告会被置回 `null`：那一格若退回「尚未检查」，等于把"没能回答"说成"还没问"。
  if (input.failure !== null) return input.t('maintenance.checkFailed')
  if (input.count === null) return input.t('maintenance.notScanned')
  if (input.count === 0) return input.t('maintenance.none')
  return input.t(input.countKey, { count: input.count })
}

interface AttachmentMaintenanceProps {
  /** 段视图：读数、提示、确认框、忙碌与四个动作都在它上面（与孤儿会话段同一台状态机）。 */
  section: MaintenanceSectionView<AttachmentOrphanReportWire>
  t: Translate
}

/**
 * 孤儿附件段：报告 >0 时出横幅（数量 + 体积 + 查看并清理）；检查/清理失败在原位摆原文 + 重试；
 * 上一趟清理的回执单独一行（已清 / 跳过 / 逐文件失败）。确认框把三条边界说完再动手。
 */
function AttachmentMaintenance({ section, t }: AttachmentMaintenanceProps): ReactElement {
  const { report, failure, notice, confirm, busy } = section
  return (
    <>
      {!busy && report !== null && report.count > 0 ? (
        <MaintenanceBanner
          slot="attachment-banner"
          busy={busy}
          t={t}
          onOpen={() => section.openPreview()}
        >
          <div style={{ fontSize: 13, lineHeight: '19px' }}>
            {t('maintenance.attachments.count', { count: report.count })}
            {' · '}
            {fileSizeText(report.totalBytes)}
          </div>
        </MaintenanceBanner>
      ) : null}

      {failure !== null ? (
        <MaintenanceFailure
          slot="attachment-failure"
          message={failure}
          busy={busy}
          t={t}
          onRetry={() => void section.scan()}
        />
      ) : null}

      {/* 回执不是检查状态：清单/报告重读读不出来，所以它单独一行、只在上一趟真的清过或跳过时出现。 */}
      <AttachmentNotice message={notice} />

      {confirm && report !== null ? (
        <AttachmentConfirm
          count={report.count}
          items={report.items}
          busy={busy}
          t={t}
          onCancel={() => section.cancel()}
          onConfirm={() => void section.clean()}
        />
      ) : null}
    </>
  )
}

/** 预览 + 确认：先摆出这些图片（点开可放大），再决定清不清；只清 `.dsh` 内无引用的图片副本。
 *  `items` 只是预览清单（服务端按配置给条数，默认最多 200 条），`count` 才是这次要清理的总数。 */
function AttachmentConfirm({
  count,
  items,
  busy,
  t,
  onCancel,
  onConfirm,
}: {
  count: number
  items: readonly AttachmentOrphanItemWire[]
  busy: boolean
  t: Translate
  onCancel: () => void
  onConfirm: () => void
}): ReactElement {
  const { close, closeDisabled } = useIdleClose(busy, onCancel)
  const attachments = items.map((item) => ({
    attachmentId: item.attachmentId,
    kind: 'image' as const,
    bytes: item.bytes,
  }))
  return (
    <Modal
      open
      onClose={close}
      title={t('maintenance.attachments.confirm', { count })}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="outline" disabled={closeDisabled} onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" style={BULK_DANGER} disabled={busy} onClick={onConfirm}>
            {t('maintenance.attachments.clean')}
          </Button>
        </>
      }
    >
      <p>{t('maintenance.attachments.body')}</p>
      <div style={{ maxHeight: '55vh', overflow: 'auto', margin: '10px 0', paddingRight: 4 }}>
        <AttachmentStrip attachments={attachments} t={t} align="start" />
      </div>
      {items.length < count ? (
        <p style={{ fontSize: 12, lineHeight: '17px', color: 'var(--sd-label-tertiary)' }}>
          {t('maintenance.attachments.previewTruncated', { shown: items.length, total: count })}
        </p>
      ) : null}
      <p style={{ fontSize: 12, lineHeight: '17px', color: 'var(--sd-label-tertiary)' }}>
        {t('maintenance.attachments.previewHint')}
      </p>
    </Modal>
  )
}

export interface MaintenanceSettingsProps {
  /** 维护四件（读数与动作）；可调项两件由占用者另发给「可调项」卡。 */
  deps: MaintenanceDeps
  /** 文案（缺省 = 内置 zh；宿主 locale 服务缺席时也是它，见 `copy.ts`）。 */
  t?: Translate
}

export function MaintenanceSettings({ deps, t = zhTranslate }: MaintenanceSettingsProps): ReactElement {
  // 两个段各自一台状态机（busy / 报告 / 提示都从段对象取）；这个 hook 不自动扫描。
  const maintenance = useMaintenance({ deps, t })
  return (
    <div data-dsh-session-delete="maintenance-card" style={CARD_SHELL}>
      <div style={{ fontSize: 16, fontWeight: 600, lineHeight: '24px' }}>{t('maintenance.title')}</div>

      <MaintenanceSection
        slot="maintenance-orphans"
        title={t('maintenance.orphans.title')}
        hint={t('maintenance.orphans.hint')}
        count={maintenance.orphans.report?.totalSessions ?? null}
        countKey="maintenance.orphans.count"
        section={maintenance.orphans}
        onScan={() => void maintenance.orphans.scan()}
        t={t}
      >
        <OrphanMaintenance section={maintenance.orphans} t={t} />
        {/* 孤儿会话清理也会顺带清掉会话独占的图片副本：回执那半份读数单独一行，句子与孤儿附件段同一套。 */}
        <AttachmentNotice message={maintenance.orphans.attachmentNotice} />
      </MaintenanceSection>

      <MaintenanceSection
        slot="maintenance-attachments"
        title={t('maintenance.attachments.title')}
        hint={t('maintenance.attachments.hint')}
        count={maintenance.attachments.report?.count ?? null}
        countKey="maintenance.attachments.count"
        section={maintenance.attachments}
        onScan={() => void maintenance.attachments.scan()}
        t={t}
      >
        <AttachmentMaintenance section={maintenance.attachments} t={t} />
      </MaintenanceSection>
    </div>
  )
}
