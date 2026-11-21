/**
 * 维护卡各段共用的两块皮：警告条外壳与失败块。三段只差正文；清理后的回执行不在本文件，
 * 它同时被回收站面板用到，住中立模块 `notice.tsx`。
 */
import type { ReactElement, ReactNode } from 'react'
import type { Translate } from './copy.js'
import { CARD } from './trash-view.js'
import { Button } from './ui/Button.js'
import { IconWarningOutlineRegular } from './ui/icons.js'

interface MaintenanceChromeProps {
  /** 给测试与界面规格一个稳定的块名；缺省不写 `data-*`。 */
  slot?: string
  busy: boolean
  t: Translate
  /** 旧面板块用过的下边距；设置页段内间距由父级 gap 给，默认不加。 */
  gapBelow?: boolean
}

export function MaintenanceBanner({
  slot,
  busy,
  t,
  gapBelow = false,
  onOpen,
  children,
}: MaintenanceChromeProps & { onOpen: () => void; children: ReactNode }): ReactElement {
  return (
    <div
      data-dsh-session-delete={slot}
      style={{ ...CARD, alignItems: 'flex-start', gap: 12, ...(gapBelow ? { marginBottom: 10 } : {}) }}
    >
      <span
        style={{ display: 'inline-flex', flex: 'none', paddingTop: 2, color: 'var(--dsw-alias-state-warn-primary)' }}
        aria-hidden="true"
      >
        <IconWarningOutlineRegular size={16} />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 auto', minWidth: 0 }}>
        {children}
      </div>
      <Button
        variant="outline"
        size="sm"
        style={{ flex: 'none' }}
        disabled={busy}
        onClick={() => {
          if (busy) return
          onOpen()
        }}
      >
        {t('trash.orphans.open')}
      </Button>
    </div>
  )
}

export function MaintenanceFailure({
  slot,
  message,
  busy,
  t,
  gapBelow = false,
  onRetry,
}: MaintenanceChromeProps & { message: string; onRetry: () => void }): ReactElement {
  return (
    <div
      data-dsh-session-delete={slot}
      role="status"
      style={{ ...CARD, alignItems: 'flex-start', gap: 10, padding: '10px 12px', ...(gapBelow ? { marginBottom: 10 } : {}) }}
    >
      <span
        style={{ display: 'inline-flex', flex: 'none', color: 'var(--dsw-alias-state-error-primary)' }}
        aria-hidden="true"
      >
        <IconWarningOutlineRegular size={15} />
      </span>
      <span
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          wordBreak: 'break-word',
          fontSize: 12,
          lineHeight: '17px',
          color: 'var(--dsw-alias-state-error-primary)',
        }}
      >
        {message}
      </span>
      <Button variant="outline" size="sm" style={{ flex: 'none' }} disabled={busy} onClick={onRetry}>
        {t('common.retry')}
      </Button>
    </div>
  )
}
