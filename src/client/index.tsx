/**
 * 浏览器半入口（CJS 单文件闭包工厂的 `factory` 体，构建契约见 tsdown.config.ts）。
 *
 * 共交付五个槽位贡献（合起来是四个用户可见入口），分三类：
 *
 * - `sidebar.workspaces.session.menu.item` —— 「删除」菜单行（`DeleteMenuItem`）。这一行**只发请求**
 *   （把 `{sessionId, title}` 写进 `delete-confirm.tsx` 的模块级现场）。
 * - `shell.overlay` —— 菜单之外的**两个**常驻宿主（各一次 `slots.inject`，与宿主自己对
 *   `conversation.chat.node` 连写十几次 `inject` 的写法同形）：
 *   ① 撤销提示 `UndoToast`；② 删除确认框 `DeleteConfirmHost`。**它们不是额外入口**：两样东西都必须
 *   活在菜单之外（真产物 `Menu` 是 `open && jsxs(MenuSurface, { … children: [items.map(renderEntry),
 *   children] })`，`open === false` 时槽位行根本不渲染、行随菜单一起卸载，见 delete-confirm.tsx 的头注）。
 * - **回收站入口 = 一对座位**（同一次探测之后、同一个同步块里注册）：
 *   ① `sidebar.panellist` —— 全局面板列表里的一行（占用者 `TrashPanelIcon`，只出 glyph）；
 *   ② `main` —— 同字 key 的中央面板（占用者 `TrashPanel`，清单本体）。
 *   **两条必须同批**：`ctx.layout.selectPanel(panelId)` 逐字 `if (panelId !== null &&
 *   !this.hasMainPanel(panelId)) throw new Error(...)`（asar @21199710）——只有行、没有面板时，
 *   用户点一下就是运行期抛错；反过来先有面板也没有入口。
 *
 * **为什么不是底栏（2026-09-30 实测裁决，设计稿 §10）**：`sidebar.footer.action` 的**惯用形**是
 * 「42px 整行 + 图标 + 文字 + 右对齐 12px 计数」——官方 `client-ui-cordis` 的占用者 CSS 是
 * `.layer{flex:none;width:100%;height:42px}`，而座位容器只有 `.footerActions{display:flex}`
 * （无 gap、无 wrap）⇒ 我们交的 `Button ghost/sm` 小药丸贴底栏，与下方 42px 的「设置」行不同形。
 * **判据随宿主组成走，不是常量**：2026-09-30 隔离活宿主实测里 `ui-cordis` 虽在组成树里，它的
 * 客户端半并没有挂上那条占用者（槽位渲染为空、零子节点）——所以"被第二个租户整条挤出去"只在
 * 占用者真挂上时才发生；不变的是我们**不是这条座位的惯用形**。
 *
 * 槽位名与注册形状是从宿主产物里**读出来**的，不是猜的：
 * - 菜单槽声明：asar @46391872 `ctx.slots.declare({ name: "sidebar.workspaces", children: {
 *   "sidebar.workspaces.session.menu.item": { kind: "list", scope: "root", inject: { hooks: {
 *   menuOpenState: menuOpenStateFactory, shortcuts: ctx.shortcuts.catalog } } } …`；
 *   数据面投影 @46271806 `renderSlot("sidebar.workspaces.session.menu.item", { sessionId: node.id,
 *   displayTitle: row.title }, { hookContext: menuOpenState })`——`menuOpenStateFactory = (_standard,
 *   state) => () => state`（@46195835），所以这一行拿到的 prop 是 hook `useMenuOpenState`；
 *   宿主自己的四行注册 @46392466 起（pin 100 / rename 200 / fork 300 / archive 400）——本插件取
 *   **order 900**，落在官方动作之后，并用 `separatorBefore` 与它们隔一条分隔线。
 * - 浮层槽声明：asar @21206189 `"shell.overlay": { kind: "list", scope: "root" }`。
 * - 面板行槽：座位目录原文「Global panel icons. Each list id addresses the matching main panel;
 *   the sidebar owns the button and resolves its label from list metadata」；声明在 `ui-sidebar`
 *   的 `sidebar` 注册项 children 里（asar @44796980 区）`"sidebar.panellist": { kind: "list",
 *   scope: "root" }`；行本体渲染 @44783481 `PanelRow` → `<Tooltip disabled={wide}>` 包一个
 *   `<button class=panelRow aria-current={active ? "page" : undefined} onClick={selectPanel(id)}>`，
 *   内含 `.panelGlyph`（`renderSlot("sidebar.panellist", { size: wide ? 16 : 18, active }, { only: id })`）
 *   与 `.panelTitle`（`wide` 时才有）。**名字取自注册元数据**：`syncPanels` 逐字
 *   `label: resolveSlotLabel(options.label) ?? id`（@44795361）——所以本插件把 `label` 写进注册项。
 * - 中央面板槽：座位目录 `main`（`kind: "keyed"`, `scope: "root"`，"Central panel selected by
 *   sidebar entry id"，保留键 `conversation`，`replaceRisk: shadows-shipped-ui`）；宿主渲染
 *   @21185725 `renderSlot("main", {}, { entryKey: usePanelInfo((info) => info.activePanelId) ??
 *   "conversation" })`。**id 不得撞车**：座位目录原文「reusing a shipped id puts you in THAT cell
 *   and replaces it」——静默替换比抛错更难发现，所以两个 id 都带插件专属前缀。
 * - **面板 id 与 main 的 key 是同一个字**（官方：list id 寻址同 id 的中央面板）。`selectPanel`
 *   只校验 main 里有没有注册、不校验 id 形状（@21199710），点号斜杠都不是问题。
 *
 * 宿主 ctx 用**本地窄镜像**（AGENTS.md：只声明用到的成员 + 一次强转；不装宿主类型包、
 * 不做 `declare module` 增强）。
 *
 * **`inject` 只声明一定存在的东西**：全仓只有 `slots` 一项——它是浏览器侧槽位注册表、
 * 宿主必给。**取数通道不进 `inject`**：通道是"同源 fetch 我们自己的前缀路由"（见 `remote.ts` 头注），
 * 它是不是在**只有探测才知道**（`await probeChannel(...)`），
 * 声明它既表达不了这件事，写错的代价又极高——前端启动自检对「有客户端模块但没激活成功」走的是
 * 致命路径（`Error: web boot: 1 entry did not activate` ⇒ 桌面壳 `reportFatal("web-boot")`
 * 杀掉整个进程）。
 * 所以：**`apply` 同步返回、绝不抛**，注册挂在探测的续拍上；探测不过就一个贡献都不注册。
 */
import { DeleteConfirmHost } from './delete-confirm.js'
import { DeleteMenuItem } from './delete-menu-item.js'
import {
  buildDeps,
  createHttpRemote,
  probeChannel,
  type SessionDeleteRemote,
} from './remote.js'
import { TrashPanelIcon } from './trash-entry.js'
import { TrashPanel } from './trash-panel.js'
import { UndoToast } from './undo-toast.js'

export const name = '@xrn1997/dsh-session-delete/client'

/**
 * 只列**宿主公开面保证存在**的成员：`slots` 是浏览器侧槽位注册表
 * （宿主外壳的冻结平台模块表里的静态键 `@deepseek-ai/dsh-client-ui-slots`），一定在。
 * 取数通道不在这里——理由见文件头注（它不是 inject 能表达的事，写错了代价是进程死）。
 */
export const inject = ['slots']

const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
const OVERLAY_SLOT = 'shell.overlay'
const PANEL_SLOT = 'sidebar.panellist'
const MAIN_SLOT = 'main'

/** 本插件在槽位里的稳定 id 前缀（宿主对重名直接抛错、对重 id 静默替换，必须带插件专属前缀）。 */
const PLUGIN_ID = '@xrn1997/dsh-session-delete'

/** 面板 id 与 `main` 的 key 同字：官方按 list id 去 `main` 里寻址同 id 的占用者。 */
const PANEL_ID = `${PLUGIN_ID}.trash`

/* ── 宿主 ctx 的窄镜像 ───────────────────────────────────── */
interface SlotRegistration {
  name: string
  /** list 座位的占用者 id。 */
  id?: string
  /** keyed 座位（`main`）的键；与 `id` 二者按座位取一。 */
  key?: string
  order?: number
  /** 宿主的行名字（`resolveSlotLabel(options.label)`；`sidebar.panellist` 用它画 `.panelTitle`）。 */
  label?: string
  inject?: () => unknown
}

interface SlotsLike {
  inject(key: string, contribute: () => unknown): unknown
  register(options: SlotRegistration, component: unknown): unknown
}

interface ClientContextLike {
  slots: SlotsLike
}

/* ── 菜单行的适配：槽位投影 → 组件 props ─────────────────── */
/** `ui-session` 通过 `ctx.slots.provideRoot({ hooks: { sessions: ctx.sessions.list } })` 提供的根
 *  hook（asar @22967283 原文）——宿主自己的框架组件就是这样消费它的
 *  （`useSessions((state) => … state.byId[sessionId] …)`，asar @21178811）。 */
type UseSessions = (
  select: (state: { byId?: Record<string, { running?: boolean } | undefined> }) => boolean,
) => boolean

/** 菜单槽注入的 `useMenuOpenState`：官方 `menuOpenStateFactory` 交回的是一对开合状态
 *  （asar @46195835 `const menuOpenStateFactory = (_standard, state) => () => state`），
 *  官方 README 的第三方行示例逐字 `const [, setMenuOpen] = useMenuOpenState()`。 */
type UseMenuOpenState = () => readonly [boolean, (open: boolean) => void]

interface MenuRowProps {
  sessionId: string
  displayTitle: string
  useSessions?: UseSessions
  useMenuOpenState?: UseMenuOpenState
}

/** 根 hook 缺失时的兜底：永不判 live。恒等身份，不会让 hook 顺序在两次渲染之间变化。 */
const NEVER_LIVE: UseSessions = () => false

/** 槽位 hook 缺失时的兜底：什么都不关（同样恒等身份，hook 顺序不随渲染变）。 */
const NEVER_MENU_OPEN_STATE: UseMenuOpenState = () => [false, () => undefined]

/** 槽位投影 → `DeleteMenuItem` 的 props。`live` 取自会话运行态（root hook）。
 *  这一行不接注入面：它只把请求写进 `delete-confirm.tsx` 的模块级现场（确认框住在 overlay 上）。 */
function DeleteRow({ sessionId, displayTitle, useSessions, useMenuOpenState }: MenuRowProps) {
  const select = typeof useSessions === 'function' ? useSessions : NEVER_LIVE
  const live = select((state) => state?.byId?.[sessionId]?.running === true)
  // 菜单收不收是 owner（本槽位的宿主菜单）的决定，我们只消费它给的这对状态：按下这一行时先发请求、
  // 再让 owner 收菜单——确认框不叠在菜单上（设计稿 §7 状态 ②；官方 README 的示例同序）。
  const useMenuState = typeof useMenuOpenState === 'function' ? useMenuOpenState : NEVER_MENU_OPEN_STATE
  const [, setMenuOpen] = useMenuState()
  return (
    <DeleteMenuItem
      sessionId={sessionId}
      title={displayTitle}
      live={live}
      dismissMenu={() => setMenuOpen(false)}
    />
  )
}

/** 撤销提示的宿主：组件本身只吃 `restore`。 */
function UndoToastSlot({ deps }: { deps: SessionDeleteRemote }) {
  return <UndoToast deps={deps} />
}

/** 确认框的宿主：组件只吃 `delete`（会话 id 来自模块级现场，不从这里走）。 */
function DeleteConfirmSlot({ deps }: { deps: SessionDeleteRemote }) {
  return <DeleteConfirmHost deps={deps} />
}

/** 面板行的占用者：宿主给 `SidebarPanelIconOwnerProps { size, active }`，我们只回一个 glyph。 */
function TrashPanelIconSlot({ size }: { size?: number }) {
  return <TrashPanelIcon size={size} />
}

/**
 * **探测 → 注册**：取数通道在不在，只有真发一次请求才知道。
 *
 * - 探测不过（打不通 / 回的不是信封）⇒ **早返回**：一个槽位贡献都不注册。页面上的表现是"本插件
 *   不存在"，而不是点下去必然失败的入口——半吊子 UI 比没有 UI 更糟（设计稿 §7「未接通态」）。
 * - 探测过（哪怕 `list` 回的是 `{ok:false,error}`）⇒ 注册：那次往返证明路由在、依赖接上了、
 *   错误映射也生效了，失败该做的是把原文交给用户看。
 *
 * 面板那两条是**一对座位**：行的 `selectPanel(id)` 要求 `main` 里有同字 key，缺了面板那一头，
 * 用户点一下就是宿主自己的 `layout.selectPanel: main panel "…" is not registered`。
 * 两条分属 `sidebar.panellist` / `main` 两个槽位，只能各注册一次、**成不了原子事务**：
 * 谁先谁后都一样（两个 `inject` 的回调各跑各的）。所以这里不假装能防住半个座位——
 * 漏一半的代价是**宿主那句响亮的抛错**，不是静默降级。
 */
async function activate(client: ClientContextLike): Promise<void> {
  const raw = createHttpRemote()
  if (!(await probeChannel(raw))) return
  const deps = buildDeps(raw)

  // ① 菜单行：只发请求，注入面一件都不需要（会话 id / 名字由槽位投影给）。
  client.slots.inject(MENU_SLOT, () =>
    client.slots.register({ name: MENU_SLOT, id: `${PLUGIN_ID}.delete`, order: 900 }, DeleteRow),
  )

  // ② 撤销提示的常驻宿主（不在菜单里，理由见 §头注）
  client.slots.inject(OVERLAY_SLOT, () =>
    client.slots.register(
      { name: OVERLAY_SLOT, id: `${PLUGIN_ID}.undo-toast`, inject: () => ({ deps }) },
      UndoToastSlot,
    ),
  )

  // ②' 确认框的常驻宿主（确认框必须脱离菜单子树的生命周期，见 delete-confirm.tsx）
  client.slots.inject(OVERLAY_SLOT, () =>
    client.slots.register(
      { name: OVERLAY_SLOT, id: `${PLUGIN_ID}.delete-confirm`, inject: () => ({ deps }) },
      DeleteConfirmSlot,
    ),
  )

  // ③ 面板行：名字给宿主（它画 `.panelTitle` 与折叠 tooltip），我们只出一个 glyph。
  // order 落在官方两个面板行（plugins 0 / schedules）与第三方「小说」（20）之后。
  client.slots.inject(PANEL_SLOT, () =>
    client.slots.register(
      { name: PANEL_SLOT, id: PANEL_ID, order: 900, label: '回收站' },
      TrashPanelIconSlot,
    ),
  )

  // ③' 中央面板：同字 key；清单本体（自带页面骨架与滚动，中央列那个盒子两样都不给）。
  client.slots.inject(MAIN_SLOT, () =>
    client.slots.register({ name: MAIN_SLOT, key: PANEL_ID, inject: () => ({ deps }) }, TrashPanel),
  )
}

/**
 * 入口：**同步返回、绝不抛**（见文件头注）。
 *
 * 注册挂在探测的续拍上，两条理由：① 前端启动自检只看 entry 声明的 `inject` 服务齐不齐（`slots`
 * 一定在），不看它注册了几行；② 槽位注册是注册表的一次 mutation，渲染层按微任务批量订阅
 * （`SlotCore` 的变更传播契约），晚一拍注册照常上屏——宿主侧栏对 `sidebar.panellist` 正是
 * `ctx.slots.subscribe("sidebar.panellist", syncPanels)`（asar @44795361）。
 */
export function apply(ctx: unknown): void {
  void activate(ctx as ClientContextLike).catch((error: unknown) => {
    console.warn('[dsh-session-delete] 入口未注册（取数通道不可用）:', error)
  })
}
