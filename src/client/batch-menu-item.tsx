/**
 * 会话「⋯」菜单里的「多选」入口：按下才进入多选态（再按一次退出），菜单的开关归 owner——按下后先切模式、再收菜单。
 * 文案复用清单那两句，不造第二个键。
 */
import type { ReactElement } from 'react'
import { zhTranslate, type Translate } from './copy.js'
import { enterSelection, exitSelection, useSelection } from './batch-selection-store.js'
import { IconCheckOutlineRegular } from './ui/icons.js'
import { MenuItemButton } from './ui/MenuItemButton.js'

export interface BatchSelectMenuItemProps {
  dismissMenu?: () => void
  t?: Translate
}

export function BatchSelectMenuItem({
  dismissMenu,
  t = zhTranslate,
}: BatchSelectMenuItemProps): ReactElement {
  const selecting = useSelection().selecting
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
      {selecting ? t('list.select.exit') : t('list.select.enter')}
    </MenuItemButton>
  )
}
