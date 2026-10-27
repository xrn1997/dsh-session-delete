/**
 * 插件设置页的「维护」卡（`plugins.bundle.config` 的占用者）。
 *
 * 两张段都是**手动**的：检查 → 预览 → 清理，没有挂载即扫、没有定时器。卡片的职责只有呈现：
 * 状态那一行、检查按钮、以及各段自己的横幅 / 失败 / 提示 / 确认框；读数与动作全归
 * `src/client/use-maintenance.ts`。
 *
 * 与回收站面板的区别：这里没有面板高度、没有清单与详情两栏、没有全局闸。控件只用
 * `CARD` / `Button` / `Modal` / `fileSizeText`，所以同一张卡放在插件详情页的任意宽度下都成立。
 *
 * 孤儿会话段直接复用 `OrphanMaintenance`（警告条 / 失败 / 中性提示 / 预览确认的既有呈现）；
 * 孤儿附件段是本文件里的 `AttachmentMaintenance`（横幅 + 失败 + 回执 + 缩略图预览与清理确认）。
 */
import type { ReactElement, ReactNode } from 'react'
import { AttachmentNotice, AttachmentStrip } from './attachment-view.js'
import { useIdleClose } from './confirm-close.js'
import { zhTranslate, type Translate } from './copy.js'
import type { AttachmentOrphanItemWire } from '../shared/wire.js'
import { MaintenanceBanner, MaintenanceFailure } from './maintenance-parts.js'
import { OrphanMaintenance } from './orphan-maintenance.js'
import { fileSizeText } from './ui/format.js'
import { Button } from './ui/Button.js'
import { Modal } from './ui/Modal.js'
import { BULK_DANGER, CARD } from './trash-view.js'
import { useMaintenance, type Maintenance, type MaintenanceDeps, type MaintenancePhase } from './use-maintenance.js'

/** 卡片外壳：按内容高、铺满宿主给的宽度；不假设自己住在中央面板里（没有 `height:100%`）。 */
const CARD_SHELL = {
  ...CARD,
  flexDirection: 'column' as const,
  alignItems: 'stretch' as const,
  gap: 18,
  width: '100%',
  boxSizing: 'border-box' as const,
  padding: '14px 16px',
}

interface MaintenanceSectionProps {
  /** 给测试与界面规格一个稳定的段名；也方便宿主页调试时看出是哪一段。 */
  slot: 'maintenance-orphans' | 'maintenance-attachments'
  title: string
  hint: string
  status: string
  /** 这一段自己的写动作在飞：检查按钮与段内动作一起按住。 */
  busy: boolean
  onScan: () => void
  t: Translate
  children: ReactNode
}

/** 一段的标题行：标题 + 说明 + 状态 + 检查按钮。状态按优先级：清理中 / 检查中 / 检查失败 / 尚未检查 / 没有发现 / N。 */
function MaintenanceSection({ slot, title, hint, status, busy, onScan, t, children }: MaintenanceSectionProps): ReactElement {
  return (
    <section
      data-dsh-session-delete={slot}
      style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 auto', minWidth: 0 }}>
          <div style={{ fontSize: 13.5, lineHeight: '19px', fontWeight: 500 }}>{title}</div>
          <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)' }}>{hint}</div>
        </div>
        <span
          data-dsh-session-delete="maintenance-status"
          style={{
            flex: 'none',
            paddingTop: 1,
            fontSize: 12,
            lineHeight: '17px',
            color: 'var(--dsw-alias-label-tertiary)',
            whiteSpace: 'nowrap',
          }}
        >
          {status}
        </span>
        <Button variant="outline" size="sm" style={{ flex: 'none' }} disabled={busy} onClick={onScan}>
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
  query: Pick<
    Maintenance,
    | 'attachmentReport' | 'attachmentFailure' | 'attachmentNotice' | 'attachmentConfirm'
    | 'setAttachmentConfirm' | 'openAttachmentPreview' | 'cleanAttachmentOrphans' | 'scanAttachmentOrphans'
  >
  busy: boolean
  t: Translate
}

/**
 * 孤儿附件段：报告 >0 时出横幅（数量 + 体积 + 查看并清理）；检查/清理失败在原位摆原文 + 重试；
 * 上一趟清理的回执单独一行（已清 / 跳过 / 逐文件失败）。确认框把三条边界说完再动手。
 */
function AttachmentMaintenance({ query, busy, t }: AttachmentMaintenanceProps): ReactElement {
  const { attachmentReport, attachmentFailure, attachmentNotice, attachmentConfirm } = query
  return (
    <>
      {!busy && attachmentReport !== null && attachmentReport.count > 0 ? (
        <MaintenanceBanner
          slot="attachment-banner"
          busy={busy}
          t={t}
          onOpen={() => query.openAttachmentPreview()}
        >
          <div style={{ fontSize: 13, lineHeight: '19px' }}>
            {t('maintenance.attachments.count', { count: attachmentReport.count })}
            {' · '}
            {fileSizeText(attachmentReport.totalBytes)}
          </div>
        </MaintenanceBanner>
      ) : null}

      {attachmentFailure !== null ? (
        <MaintenanceFailure
          slot="attachment-failure"
          message={attachmentFailure}
          busy={busy}
          t={t}
          onRetry={() => void query.scanAttachmentOrphans()}
        />
      ) : null}

      {/* 回执不是检查状态：清单/报告重读读不出来，所以它单独一行、只在上一趟真的清过或跳过时出现。 */}
      <AttachmentNotice message={attachmentNotice} />

      {attachmentConfirm && attachmentReport !== null ? (
        <AttachmentConfirm
          count={attachmentReport.count}
          items={attachmentReport.items}
          busy={busy}
          t={t}
          onCancel={() => query.setAttachmentConfirm(false)}
          onConfirm={() => void query.cleanAttachmentOrphans()}
        />
      ) : null}
    </>
  )
}

/** 预览 + 确认：先摆出这些图片（点开可放大），再决定清不清；只清 `.dsh` 内无引用的图片副本。
 *  `items` 只是预览清单（服务端最多给 200 条），`count` 才是这次要清理的总数。 */
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
        <p style={{ fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)' }}>
          {t('maintenance.attachments.previewTruncated', { shown: items.length, total: count })}
        </p>
      ) : null}
      <p style={{ fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)' }}>
        {t('maintenance.attachments.previewHint')}
      </p>
    </Modal>
  )
}

export interface MaintenanceSettingsProps {
  deps: MaintenanceDeps
  /** 文案（缺省 = 内置 zh；宿主 locale 服务缺席时也是它，见 `copy.ts`）。 */
  t?: Translate
}

export function MaintenanceSettings({ deps, t = zhTranslate }: MaintenanceSettingsProps): ReactElement {
  // 两个 section 各自一份忙碌与报告；这个 hook 不自动扫描。
  const maintenance = useMaintenance({ deps, t })
  return (
    <div data-dsh-session-delete="maintenance-card" style={CARD_SHELL}>
      <div style={{ fontSize: 16, fontWeight: 600, lineHeight: '24px' }}>{t('maintenance.title')}</div>

      <MaintenanceSection
        slot="maintenance-orphans"
        title={t('maintenance.orphans.title')}
        hint={t('maintenance.orphans.hint')}
        status={statusText({
          phase: maintenance.orphanPhase,
          failure: maintenance.orphanFailure,
          count: maintenance.orphanReport?.totalSessions ?? null,
          countKey: 'maintenance.orphans.count',
          t,
        })}
        busy={maintenance.orphanBusy}
        onScan={() => void maintenance.scanOrphans()}
        t={t}
      >
        <OrphanMaintenance query={maintenance} busy={maintenance.orphanBusy} t={t} />
        {/* 孤儿会话清理也会顺带清掉会话独占的图片副本：回执那半份读数单独一行，句子与孤儿附件段同一套。 */}
        <AttachmentNotice message={maintenance.orphanAttachmentNotice} />
      </MaintenanceSection>

      <MaintenanceSection
        slot="maintenance-attachments"
        title={t('maintenance.attachments.title')}
        hint={t('maintenance.attachments.hint')}
        status={statusText({
          phase: maintenance.attachmentPhase,
          failure: maintenance.attachmentFailure,
          count: maintenance.attachmentReport?.count ?? null,
          countKey: 'maintenance.attachments.count',
          t,
        })}
        busy={maintenance.attachmentBusy}
        onScan={() => void maintenance.scanAttachmentOrphans()}
        t={t}
      >
        <AttachmentMaintenance query={maintenance} busy={maintenance.attachmentBusy} t={t} />
      </MaintenanceSection>
    </div>
  )
}
