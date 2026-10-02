/**
 * `Tag`（**照抄** `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2` 的 Tag，出处与三条改写规则见
 * `ui.css` 头注）：只读的状态胶囊。
 *
 * 官方那套有八个 tone（outline/solid/neutral/quiet/success/info/warning/danger），本插件只用
 * **danger 一档**（确认框里的失败原文）⇒ 这里只有这一个 tone，`tone` 收成单值联合而不是"先铺开、
 * 以后可能用得上"。要加第二档时，把对应那条 CSS 与这个联合一起加。
 */
import type { ReactElement, ReactNode } from 'react'
import './styles.js'

export interface TagProps {
  /** 唯一的色板：破坏性/失败面（error 色的 10% 透明底 + error 字）。 */
  tone: 'danger'
  children: ReactNode
}

const TONE_CLASS = { danger: 'sd-tag-danger' } as const

export function Tag({ tone, children }: TagProps): ReactElement {
  return <span className={`sd-tag ${TONE_CLASS[tone]}`}>{children}</span>
}
