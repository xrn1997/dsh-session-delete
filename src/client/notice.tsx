/**
 * 一段**状态回执行**：清理后的中性 / 成功 / 警告摘要。不是失败块，也不冒充检查状态；
 * 没有话说时整块不画。`tone` 只决定图标与颜色，句子由调用方按自己的判据拼好。
 *
 * 它住在中立模块而不是维护卡里：回收站面板的附件清理提示与设置页维护卡的三段都用它，
 * 面板不该为了一个回执行去 import 设置卡模块。
 */
import type { ReactElement } from 'react'
import { CARD } from './trash-view.js'
import { IconCheckCircleOutlineRegular, IconWarningOutlineRegular } from './ui/icons.js'

export interface NoticeProps {
  readonly message: string | null
  /** 旧面板块用过的下边距；设置页段内间距由父级 gap 给，默认不加。 */
  readonly gapBelow?: boolean
  /** 默认 warning（附件失败 / 跳过、孤儿清理回执）；纯成功回执用 success。 */
  readonly tone?: 'warning' | 'success'
}

export function Notice({ message, gapBelow = false, tone = 'warning' }: NoticeProps): ReactElement | null {
  if (message === null) return null
  const Icon = tone === 'success' ? IconCheckCircleOutlineRegular : IconWarningOutlineRegular
  const color = tone === 'success'
    ? 'var(--dsw-alias-state-success-primary)'
    : 'var(--dsw-alias-state-warn-primary)'
  return (
    <div
      role="status"
      style={{ ...CARD, alignItems: 'flex-start', gap: 10, padding: '10px 12px', ...(gapBelow ? { marginBottom: 10 } : {}) }}
    >
      <span style={{ display: 'inline-flex', flex: 'none', color }} aria-hidden="true">
        <Icon size={15} />
      </span>
      <span style={{ flex: '1 1 auto', minWidth: 0, wordBreak: 'break-word', fontSize: 12, lineHeight: '17px' }}>
        {message}
      </span>
    </div>
  )
}
