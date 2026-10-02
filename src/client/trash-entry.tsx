/**
 * 侧栏面板列表里的「回收站」行图标（`sidebar.panellist` 的占用者；设计稿 §7 状态 ④ 的入口那一行）。
 *
 * **只出 glyph**——行本体由宿主 `PanelRow` 画：`<button class=panelRow aria-current
 * onClick=selectPanel(id)>` 里一个 `.panelGlyph`（`renderSlot("sidebar.panellist", { size: wide ? 16 : 18,
 * active }, { only: id })`）加一个 `.panelTitle`（**名字从注册元数据来**：宿主 `syncPanels` 逐字
 * `label: resolveSlotLabel(options.label) ?? id`，asar @44795361），外加折叠时的 `Tooltip`、
 * hover 与选中底色（asar @44783481 逐字）。所以这里**不能**有按钮、文字或角标：多画一样，
 * 这一行就与「插件 / 任务 / 小说」三行错位。
 *
 * `active`（本行是否被中央列选中）由 owner 一并给出，**刻意不用**：选中呈现已经是宿主行自己的事
 * （`aria-current` + `.panelActive`），我们再加一层就会出现两种选中态。
 *
 * 计数角标**不做**（2026-09-30 裁决）：这个座位只给一个 16/18px 的 glyph 盒（`.panelGlyph{flex:none}`），
 * 角标只能溢出到行外（本仓量过：15px 的角标右缘超出 glyph 7px、顶缘高出行顶 5px，宽态就压到上一行；
 * rail 态那行是 36px 圆、`padding:0`，更糟）。`label` 虽支持 thunk，但宿主只在**槽位条目变化或
 * 语言变化**时重读（同上 @44795361），拿它当活计数必然 stale。条数与合计占用改在面板头部给
 * （见 `trash-panel.tsx`）。
 */
import { IconTrashOutlineRegular } from './ui/icons.js'

/** 宿主 `SidebarPanelIconOwnerProps`：请求的方形边长；`active` 收了但不用（见头注）。 */
export interface TrashPanelIconProps {
  size?: number
  active?: boolean
}

export function TrashPanelIcon({ size = 16 }: TrashPanelIconProps) {
  return <IconTrashOutlineRegular size={size} />
}
