import type { CSSProperties } from 'react'

/**
 * 安静的红：**只给字色、不给底**。宿主控件的 `.sd-button-ghost:hover` / `:active` 是普通类，
 * 而作者态的内联 `background` 永远赢过类规则 ⇒ 铺了底的红按钮在点错之前不给任何视觉回应。
 * 整页唯一那块实心红另有写法（`variant="primary"` + 就地覆盖 primary 那对 token），不在这里。
 */
export const QUIET_DANGER = { color: 'var(--dsw-alias-state-error-primary)' } as const

/** 单行截断。宽档那一列与可拖的分栏天然会挤文字，逐处手写这三行就会各写各的。 */
export const ELLIPSIS: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
