/**
 * `Button`（**照抄** `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2` 的 Button，出处与三条改写规则
 * 见 `ui.css` 头注）：`<button type="button">`，`variant` × `size` 两个正交档，可带前导图标。
 *
 * 只收本插件用到的面：`primary` / `ghost` / `outline` 三档与 `md`(36px) / `sm`(28px) 两号；
 * 官方还有 `toolbar` 变体与 `className` 之外的转发面，这里不铺开。
 *
 * **转发 `ref`**：官方把 `ref` 交给原生按钮（"for focus management and overlay anchors"），
 * `Modal` 的初始焦点与外壳的对齐测量都吃这个。React 18 的 `forwardRef` 与官方实现同形。
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react'
import './styles.js'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 视觉族；缺省 `ghost`。 */
  variant?: 'primary' | 'ghost' | 'outline'
  /** `md` = 36px 控件（12px 圆角）／`sm` = 28px 控件（8px 圆角）。 */
  size?: 'md' | 'sm'
  /** 前导 16px 图标节点。 */
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'ghost', size = 'md', icon, className, children, ...rest },
  ref,
): ReactElement {
  const classes = ['sd-button', `sd-button-${variant}`, `sd-button-${size}`, className]
    .filter((name) => name !== undefined && name !== '')
    .join(' ')
  return (
    <button ref={ref} type="button" className={classes} {...rest}>
      {icon === undefined || icon === null ? null : <span className="sd-button-icon">{icon}</span>}
      {children}
    </button>
  )
})
