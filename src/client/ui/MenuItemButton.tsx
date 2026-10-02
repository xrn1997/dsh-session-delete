/**
 * `MenuItemButton`（**照抄** `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2` 的同名组件，出处与三条
 * 改写规则见 `ui.css` 头注）：菜单里的一行，宿主菜单容器渲染它、键盘巡游也认它。
 *
 * **形状必须与宿主自己那四行（pin/rename/fork/archive）逐字同构**：`<div class=itemWrap>` 里先是可选
 * 的发丝线（`role="separator"`），再是 `<button type="button" role="menuitem">`，按钮内是
 * 图标位 + 标签位（+ 官方的快捷键位）。少一层、换个标签，这一行就会在键盘顺序、hover 底色或
 * `.itemLabel` 的省略号上跟邻行错开。
 *
 * **置灰用原生 `disabled`**（不是 `aria-disabled`）：宿主菜单行的契约就是原生属性——`MenuItemButton`
 * 只把它落到 `<button>` 上，本仓用例也按 `toBeDisabled()` 判。
 *
 * **砍掉的**：`shortcut`（本插件这一行没有快捷键，故不带 `aria-keyshortcuts`，也不渲染快捷键位）。
 * `danger` / `separatorBefore` / `disabled` / `icon` / `children` / `onSelect` 都在用，保留。
 */
import type { ReactElement, ReactNode } from 'react'
import './styles.js'

export interface MenuItemButtonProps {
  /** 可见的行标签。 */
  children: ReactNode
  /** 前导图标。 */
  icon?: ReactNode
  /** 这一行不能被激活。 */
  disabled?: boolean
  /** 用破坏性的行配色（error 字色 + danger 悬停底）。 */
  danger?: boolean
  /** 这一行另起一组（上方一条发丝线）。 */
  separatorBefore?: boolean
  /** 行被激活。 */
  onSelect: () => void
}

export function MenuItemButton({
  children,
  icon,
  disabled = false,
  danger = false,
  separatorBefore = false,
  onSelect,
}: MenuItemButtonProps): ReactElement {
  return (
    <div className="sd-menu-item-wrap">
      {separatorBefore ? <div className="sd-menu-separator" role="separator" /> : null}
      <button
        type="button"
        role="menuitem"
        className={danger ? 'sd-menu-item sd-menu-item-danger' : 'sd-menu-item'}
        disabled={disabled}
        onClick={onSelect}
      >
        {icon === undefined ? null : <span className="sd-menu-item-icon">{icon}</span>}
        <span className="sd-menu-item-label">{children}</span>
      </button>
    </div>
  )
}
