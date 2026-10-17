/**
 * 会话「⋯」菜单里的「多选」入口（第十三批①改版）。
 *
 * 常驻勾选框被用户打回后，入口改成显式模式：按下这一行才进入多选态（再按一次退出），
 * 模式内才渲染勾选框、才把整行点击变成"勾/取消"（守卫在 `batch-select.tsx`）。
 * 菜单的开关归 owner（与 `delete-menu-item.tsx` 同一条契约）：按下后先切模式、再收菜单。
 *
 * 文案复用回收站工具栏那两句（`trash.toolbar.select` / `selectExit`）——同一个"多选/退出多选"
 * 不造第二个键。
 */
import type { ReactElement } from 'react'
import { enterSelection, exitSelection, useSelecting } from './batch-select.js'
import { zhTranslate, type Translate } from './copy.js'
import { IconCheckOutlineRegular } from './ui/icons.js'
import { MenuItemButton } from './ui/MenuItemButton.js'

export interface BatchSelectMenuItemProps {
  /** 菜单 owner 交下来的「收起菜单」；缺省不动，方便单独测这一行。 */
  dismissMenu?: () => void
  /** 文案（缺省 = 内置 zh，见 `copy.ts`）。 */
  t?: Translate
}

export function BatchSelectMenuItem({
  dismissMenu,
  t = zhTranslate,
}: BatchSelectMenuItemProps): ReactElement {
  const selecting = useSelecting()
  return (
    <MenuItemButton
      separatorBefore
      icon={<IconCheckOutlineRegular size={14} />}
      onSelect={() => {
        if (selecting) exitSelection()
        else enterSelection()
        dismissMenu?.()
      }}
    >
      {selecting ? t('trash.toolbar.selectExit') : t('trash.toolbar.select')}
    </MenuItemButton>
  )
}
