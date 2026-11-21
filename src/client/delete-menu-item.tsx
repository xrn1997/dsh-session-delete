/**
 * 会话条目「…」菜单里的「删除」行（`docs/ui-spec.md` §2 ①）。**确认框不在这棵子树里**：宿主菜单行
 * 随菜单关闭而卸载，住在行里的确认框会被连坐带走（真机上「移入回收站」永远点不到）——请求走
 * `delete-confirm.tsx` 的现场，确认框住 `shell.overlay`。菜单的开合归 owner；只贡献一行 `MenuItemButton`。
 * 这一行挂在 legacy 槽位 `sidebar.workspaces.session.menu.item`（出处 asar @46391872，槽位把
 * `menuOpenState` / `shortcuts` 两个 hook 交给行）上；`contextMenus` 在场的宿主改走数据动作。
 * 运行中置灰用**原生 `disabled`**：本平台的菜单行组件 `MenuItemButton` 只把 `disabled` 落在原生按钮属性上
 * （真产物原文 `<button type="button" role="menuitem" … disabled={disabled}>`），`aria-disabled` 在这条链上
 * 既渲染不出来也不算数。
 */
import { requestDelete } from './delete-confirm.js'
import { zhTranslate, type Translate } from './copy.js'
import { IconTrashOutlineRegular } from './ui/icons.js'
import { MenuItemButton } from './ui/MenuItemButton.js'
import { Tooltip } from './ui/Tooltip.js'

export interface DeleteMenuItemProps {
  /** 槽位投影的会话 id，原样透给删除写入（段名与动作住 `shared/wire.ts`）。 */
  sessionId: string
  /** 槽位投影的 `displayTitle`：只用于确认框与提示文案，不参与任何请求。 */
  title: string
  /** 会话在跑：这一行置灰，并把原因摆在行上。 */
  live?: boolean
  /** 上方那条发丝线；缺省 true。多选入口排在删除前面时由它带线。 */
  separatorBefore?: boolean
  /** 菜单 owner 交下来的「收起菜单」（槽位契约：开合归 owner）。按下时**先发请求、再收菜单**；缺省不动。 */
  dismissMenu?: () => void
  /** 文案（缺省 = 内置 zh：不是"忘了传"，而是"这次没有 locale 服务"）。 */
  t?: Translate
}

export function DeleteMenuItem({
  sessionId,
  title,
  live = false,
  separatorBefore = true,
  dismissMenu,
  t = zhTranslate,
}: DeleteMenuItemProps) {
  const select = (): void => {
    // 先把请求写进现场（确认框在 overlay 上、不随这一行卸载），再让 owner 收菜单——即使收菜单把这一行卸了，请求也已发出。
    requestDelete({ sessionId, title })
    dismissMenu?.()
  }

  return (
    <Tooltip label={t('menu.live')} side="right" portal disabled={!live}>
      <span>
        <MenuItemButton
          separatorBefore={separatorBefore}
          danger
          disabled={live}
          icon={<IconTrashOutlineRegular size={14} />}
          onSelect={select}
        >
          {t('menu.delete')}
        </MenuItemButton>
      </span>
    </Tooltip>
  )
}
