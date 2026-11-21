/**
 * 侧栏面板列表里的「回收站」行图标（`sidebar.panellist` 的占用者）。**只出 glyph**——行本体由宿主
 * `PanelRow` 画（行渲染 asar @44783481 逐字，名字来自注册元数据：宿主 `syncPanels` 的
 * `label: resolveSlotLabel(options.label) ?? id`，asar @44795361）：这里不能有按钮、文字或角标，
 * 多画一样这一行就与其它三行错位。
 * `active` 收了但刻意不用：选中呈现已是宿主行自己的事；计数角标不做——glyph 盒放不下，`label` 也只在
 * 槽位条目或语言变化时重读，当活计数必然 stale。条数改在面板头部给（见 `trash-panel.tsx`）。
 */
import { IconTrashOutlineRegular } from './ui/icons.js'

/** 宿主 `SidebarPanelIconOwnerProps`：请求的方形边长。 */
export interface TrashPanelIconProps {
  // 槽位宿主显式传 undefined（`{ size }: { size?: number }` 直转）：props 面可选即含 undefined。
  size?: number | undefined
  active?: boolean
}

export function TrashPanelIcon({ size = 16 }: TrashPanelIconProps) {
  return <IconTrashOutlineRegular size={size} />
}
