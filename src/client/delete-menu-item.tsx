/**
 * 会话条目「…」菜单里的「删除」行（设计稿 §7 状态 ①）。
 *
 * 这一行**只做两件事**：把「要删这个会话」写进 `delete-confirm.tsx` 的模块级现场，然后让菜单
 * owner 把菜单收起来（确认框不许叠在收起的菜单上——设计稿 §7 状态 ② 画的就是菜单已经收起之后
 * 的画面）。**确认框不在这棵子树里**——
 * 原因见 `delete-confirm.tsx` 的头注：宿主的菜单行随菜单一起卸载（真产物 `Menu` 是
 * `open && jsxs(MenuSurface, { … children: [items.map(renderEntry), children] })`，`open === false`
 * 时槽位行根本不渲染），住在行里的确认框会被这次的卸载连坐带走，真机上「移入回收站」永远点不到。
 * 所以"请求"与"确认"分居两处：请求走模块级现场，确认框住在 `shell.overlay` 上。
 *
 * 另外两件事说清：
 *
 * 1. **不自建菜单壳**。菜单行由宿主既有菜单容器渲染，我们只贡献一行 `MenuItemButton`
 *    （官方 `dsh-client-ui-primitives`），由 `index.tsx` 注册进槽位
 *    `sidebar.workspaces.session.menu.item`（该槽位只投影 `sessionId` / `displayTitle` 两个数据
 *    加 `menuOpenState` / `shortcuts` 两个 hook，见 asar @46391872 的槽位声明原文）。
 *    菜单的**开合归 owner**：槽位把 `useMenuOpenState` 交给这一行（`index.tsx` 的 `DeleteRow` 接住后
 *    当 `dismissMenu` 传下来），按下时先发请求、再收菜单——与官方 README 的示例同序
 *    （`onSelect={() => { setMenuOpen(false); … }}`）。
 * 2. **运行中置灰**（设计稿 §7「运行中」）。置灰用**原生 `disabled`**：本平台的菜单行组件
 *    `MenuItemButton` 只把 `disabled` 落在原生按钮属性上（真产物原文 `<button type="button"
 *    role="menuitem" … disabled={disabled}>`），jest-dom 的 `toBeDisabled()` 也只认这个属性；
 *    `aria-disabled` 在这条链上既渲染不出来也不算数。原因文案用官方 `Tooltip` 挂在行上
 *    （anchor 用一层 `<span>`：`MenuItemButton` 是普通函数组件、接不住 `Tooltip` 注入的 ref）。
 */
import { IconTrashOutlineRegular, MenuItemButton, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { requestDelete } from './delete-confirm.js'

/** 运行中那句提示的原文（设计稿 §7「运行中」那条逐字）。 */
export const LIVE_HINT = '会话正在运行，先停止再删除'

export interface DeleteMenuItemProps {
  /** 宿主菜单槽投影的会话 id，原样透给 `sessiondelete/delete`（浏览器半不自己拼 id）。 */
  sessionId: string
  /** 宿主菜单槽投影的 `displayTitle`：只用于确认框与提示文案，不参与任何请求。 */
  title: string
  /** 会话在跑：这一行置灰，并把原因摆在行上。 */
  live?: boolean
  /**
   * 菜单 owner 交下来的「收起菜单」——槽位注入的 `useMenuOpenState`（`index.tsx` 的 `DeleteRow` 接住）。
   * 「关不关菜单是 owner 的决定」是官方对该槽位的契约；按下这一行时**先发请求、再收菜单**。
   * 缺省不动，方便单独测这一行。
   */
  dismissMenu?: () => void
}

export function DeleteMenuItem({ sessionId, title, live = false, dismissMenu }: DeleteMenuItemProps) {
  const select = (): void => {
    // 先把请求写进现场（确认框住在 overlay 上、不随这一行的卸载消失），再让 owner 收菜单——
    // 即使 owner 收菜单的动作把这一行卸了，请求也已经发出去了。
    requestDelete({ sessionId, title })
    dismissMenu?.()
  }

  return (
    <Tooltip label={LIVE_HINT} side="right" portal disabled={!live}>
      <span>
        <MenuItemButton
          separatorBefore
          danger
          disabled={live}
          icon={<IconTrashOutlineRegular size={14} />}
          onSelect={select}
        >
          删除
        </MenuItemButton>
      </span>
    </Tooltip>
  )
}
