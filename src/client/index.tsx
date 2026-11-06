/**
 * 浏览器半入口：注册全部槽位贡献，并在注册前探测取数通道。
 *
 * 槽位贡献的注册面见 docs/architecture.md §3，语义归属见 §4 的主人清单；
 * 本文件只做注册与槽位接线。
 * 菜单两行有两条路径：0.2.2+ 走 `ctx.contextMenus` 数据动作（`context-menu-actions.ts`，
 * afterContent、排在 Archive 之后）；旧宿主没有这个服务，才注册 legacy 槽位行。
 *
 * 槽位出处（宿主产物，不是猜的；换代先复核）：
 * - sidebar.workspaces.session.menu.item：声明 asar @46391872；数据面投影 @46271806；
 *   menuOpenState hook 工厂 @46195835；宿主官方菜单行 @46392466 起（pin/rename/fork/archive/session-id）。
 *   0.2.2 起内置动作改住 ctx.contextMenus，此槽位只剩 legacy React 扩展位；本插件把多选/删除
 *   迁到数据动作，见 `context-menu-actions.ts`。
 * - shell.overlay：声明 asar @21206189。
 * - sidebar.panellist：声明 @44796980；行渲染 @44783481；label 解析 @44795361（thunk 随 locale）。
 * - main：渲染 @21185725；id 与 panellist 同字，selectPanel 只校验已注册 @21199710。
 * - plugins.bundle.config：插件详情页的 keyed 子槽位，宿主页面挂载时才声明（ADR-0021）。
 *
 * 硬约束：
 * - inject 只写宿主必给的 slots；可选服务走 ctx.get。理由与代价见 docs/architecture.md §3。
 * - apply 同步返回、绝不抛；先探 GET /ping，探测不过则不注册任何贡献（用入口不出现表达不可用）。
 *
 * 宿主 ctx 用本地窄镜像（AGENTS.md：只声明用到的成员 + 一次强转；不装宿主类型包、
 * 不做 declare module 增强）。
 */
import { BatchBar } from './batch-bar.js'
import { BatchConfirmHost } from './batch-confirm.js'
import { BatchSelectMenuItem } from './batch-menu-item.js'
import { BatchPickButton, BatchPickCheckbox } from './batch-select.js'
import {
  createSessionMenuContribution,
  ICON_BATCH,
  ICON_DELETE,
  type ContextMenusLike,
  type SessionsServiceLike,
} from './context-menu-actions.js'
import { type ClientContextLike } from './context.js'
import { createTranslate, type Translate } from './copy.js'
import { DeleteConfirmHost } from './delete-confirm.js'
import { DeleteMenuItem } from './delete-menu-item.js'
import { bindMainView } from './main-view.js'
import {
  buildDeps,
  createHttpRemote,
  probeChannel,
  type SessionDeleteRemote,
} from './remote.js'
import { SettingsCards } from './settings-cards.js'
import { TrashPanelIcon } from './trash-entry.js'
import { TrashPanel } from './trash-panel.js'
import { IconCheckOutlineRegular, IconTrashOutlineRegular } from './ui/icons.js'
import { installPointerModality } from './ui/styles.js'
import { UndoToast } from './undo-toast.js'

export const name = '@xrn1997/dsh-session-delete/client'

/**
 * 只列**宿主公开面保证存在**的成员：`slots` 是浏览器侧槽位注册表
 * （宿主外壳的冻结平台模块表里的静态键 `@deepseek-ai/dsh-client-ui-slots`），一定在。
 * 取数通道不在这里——理由见文件头注（它不是 inject 能表达的事，写错了代价是进程死）。
 * **`locale` 也不在这里**：宿主自己的 `ui-sidebar` 是硬注入它的，但那是"宿主知道自己那一代"的前提；
 * 本插件要跨代活着 ⇒ 走 `ctx.get('locale')` 可选读，缺席时降级到内置 zh 文案（见 `copy.ts` 头注）。
 * 写进 inject 就等于"这一代没有 locale 就不让整个客户端条目激活"，而那等于宿主进程死。
 * **`contextMenus` 同理**：0.2.2+ 用 `ctx.get('contextMenus')` 探测，服务比本条目晚到时按
 * `ctx.inject(['contextMenus'])` 的 scoped 等待切过去；旧宿主没有这个服务时回调不来，legacy 槽位留着。
 * 条目自己的 `inject` 仍然只有 `slots`——把可能迟到的服务写进去等于让整个客户端条目 pending。
 */
export const inject = ['slots']

/** legacy 菜单槽：只在 contextMenus 不可用时注册（0.2.2+ 的内置动作已迁到数据动作）。 */
const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
/** 会话行首 16px 格（无状态点时归第三方装饰）；批量删除的主勾选框落这里，多选模式内可见。 */
const LEADING_SLOT = 'sidebar.session.row.leading'
/** 会话行尾的悬停按钮排（宿主自己的归档(100)/置顶(200) 也在这排）；状态点/归档行的兜底勾选落这里。 */
const ROW_ACTION_SLOT = 'sidebar.workspaces.session.row.action'
const OVERLAY_SLOT = 'shell.overlay'
const PANEL_SLOT = 'sidebar.panellist'
const MAIN_SLOT = 'main'
/** 插件详情页的子槽位：宿主页面挂载时才声明，未声明前 `inject` 等待（更早的宿主没有这张卡）。 */
const SETTINGS_SLOT = 'plugins.bundle.config'

/** 本插件在槽位里的稳定 id 前缀（宿主对重名直接抛错、对重 id 静默替换，必须带插件专属前缀）。 */
const PLUGIN_ID = '@xrn1997/dsh-session-delete'

/** 面板 id 与 `main` 的 key 同字：官方按 list id 去 `main` 里寻址同 id 的占用者。 */
const PANEL_ID = `${PLUGIN_ID}.trash`

/* ── 菜单行的适配：槽位投影 → 组件 props ─────────────────── */
/** `ui-session` 通过 `ctx.slots.provideRoot({ hooks: { sessions: ctx.sessions.list } })` 提供的根
 *  hook（asar @22967283 原文）——宿主自己的框架组件就是这样消费它的
 *  （`useSessions((state) => … state.byId[sessionId] …)`，asar @21178811）。 */
type SessionRowState = { byId?: Record<string, { running?: boolean; title?: string } | undefined> }
/** 窄镜像把宿主 hook 的入参写成可能缺席：`state?.byId?.[id]` 这种判法是本仓「缺席不等于没有」
 *  的既有写法，规则若把 `state` 钉成必有，会把防御读报成多余。 */
type UseSessions = <T>(select: (state: SessionRowState | undefined) => T) => T

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

/** 根 hook 缺失时的兜底：对空 state 求值（`running` 判 false、`title` 取空串）。恒等身份，不会让 hook 顺序在两次渲染之间变化。 */
const NEVER_SESSIONS: UseSessions = (select) => select({})

/** 槽位 hook 缺失时的兜底：什么都不关（同样恒等身份，hook 顺序不随渲染变）。 */
const NEVER_MENU_OPEN_STATE: UseMenuOpenState = () => [false, () => undefined]

/** 菜单行的宿主：文案与远程面都从槽位载荷来（`live` 由这一行自己从 root hook 读）。 */
function DeleteRow({ sessionId, displayTitle, useSessions, useMenuOpenState, t }: MenuRowProps & { t: Translate }) {
  const select = typeof useSessions === 'function' ? useSessions : NEVER_SESSIONS
  const live = select((state) => state?.byId?.[sessionId]?.running === true)
  // 菜单收不收是 owner（本槽位的宿主菜单）的决定，我们只消费它给的这对状态：按下这一行时先发请求、
  // 再让 owner 收菜单——确认框不叠在菜单上（docs/ui-spec.md 状态 ②；官方 README 的示例同序）。
  const useMenuState = typeof useMenuOpenState === 'function' ? useMenuOpenState : NEVER_MENU_OPEN_STATE
  const [, setMenuOpen] = useMenuState()
  return (
    <DeleteMenuItem
      sessionId={sessionId}
      title={displayTitle}
      live={live}
      // 多选入口排在这一行前面并带发丝线；删除行不再重复画一条。
      separatorBefore={false}
      t={t}
      dismissMenu={() => setMenuOpen(false)}
    />
  )
}

/** 「多选」入口的宿主：只吃菜单开合与文案；模式状态由 `BatchSelectMenuItem` 自己订阅。 */
function SelectRow({ useMenuOpenState, t }: { useMenuOpenState?: UseMenuOpenState; t: Translate }) {
  const useMenuState = typeof useMenuOpenState === 'function' ? useMenuOpenState : NEVER_MENU_OPEN_STATE
  const [, setMenuOpen] = useMenuState()
  return <BatchSelectMenuItem dismissMenu={() => setMenuOpen(false)} t={t} />
}

/** 多选模式行首勾选框的宿主：槽位只投 `sessionId`，标题从 root hook 的 `byId[id].title` 读。 */
function PickLeadingRow({
  sessionId,
  useSessions,
  t,
}: {
  sessionId: string
  useSessions?: UseSessions
  t: Translate
}) {
  const select = typeof useSessions === 'function' ? useSessions : NEVER_SESSIONS
  // 与宿主 `sessionTitle()` 同一口径（trim 后空串兜底），免得两颗入口给确认框的标题不一样。
  const title = select((state) => state?.byId?.[sessionId]?.title?.trim() ?? '')
  const live = select((state) => state?.byId?.[sessionId]?.running === true)
  return <BatchPickCheckbox sessionId={sessionId} title={title} live={live} t={t} />
}

/** 行尾兜底勾选开关的宿主：投影与菜单行同款（`sessionId` / `displayTitle`），`live` 自己从 root hook 读。 */
function PickRow({
  sessionId,
  displayTitle,
  useSessions,
  t,
}: Omit<MenuRowProps, 'useMenuOpenState'> & { t: Translate }) {
  const select = typeof useSessions === 'function' ? useSessions : NEVER_SESSIONS
  const live = select((state) => state?.byId?.[sessionId]?.running === true)
  return <BatchPickButton sessionId={sessionId} title={displayTitle} live={live} t={t} />
}

/** 撤销提示的宿主：组件本身只吃 `restore` 与文案。 */
function UndoToastSlot({ deps, t }: { deps: SessionDeleteRemote; t: Translate }) {
  return <UndoToast deps={deps} t={t} />
}

/** 确认框的宿主：组件只吃 `delete`（会话 id 来自模块级现场，不从这里走）。 */
function DeleteConfirmSlot({ deps, t }: { deps: SessionDeleteRemote; t: Translate }) {
  return <DeleteConfirmHost deps={deps} t={t} />
}

/** 浮条的宿主：选中非空才渲染（组件自己收空态）。 */
function BatchBarSlot({ deps, t }: { deps: SessionDeleteRemote; t: Translate }) {
  return <BatchBar deps={deps} t={t} />
}

/** 批量确认框的宿主：与单删那张同理，必须脱离行开关那棵子树的生命周期。 */
function BatchConfirmSlot({ deps, t }: { deps: SessionDeleteRemote; t: Translate }) {
  return <BatchConfirmHost deps={deps} t={t} />
}

/** 面板行的占用者：宿主给 `SidebarPanelIconOwnerProps { size, active }`，我们只回一个 glyph。 */
function TrashPanelIconSlot({ size }: { size?: number }) {
  return <TrashPanelIcon size={size} />
}

/**
 * **探测 → 注册**：取数通道在不在，只有真发一次请求才知道。
 *
 * - 探测不过（打不通 / 回的不是信封 / 401·403 表示没有宿主身份 / 失败信封）⇒ **早返回**：
 *   一个槽位贡献都不注册。页面上的表现是"本插件不存在"，而不是点下去必然失败的入口——半吊子 UI
 *   比没有 UI 更糟（docs/architecture.md §3「通道探测决定入口出现与否」）。
 * - 探测过（`ping` 回成功信封的 `pong`）⇒ 注册：那次往返证明路由在、依赖接上了、鉴权也过了。
 *
 * 支持面是 web UI 与桌面端，二者都从宿主 `/api` 取数（ADR-0033）；没有旧前缀可退回。
 *
 * 面板那两条是**一对座位**：行的 `selectPanel(id)` 要求 `main` 里有同字 key，缺了面板那一头，
 * 用户点一下就是宿主自己的 `layout.selectPanel: main panel "…" is not registered`。
 * 两条分属 `sidebar.panellist` / `main` 两个槽位，只能各注册一次、**成不了原子事务**：
 * 谁先谁后都一样（两个 `inject` 的回调各跑各的）。所以这里不假装能防住半个座位——
 * 漏一半的代价是**宿主那句响亮的抛错**，不是静默降级。
 */
async function activate(client: ClientContextLike): Promise<void> {
  bindMainView(client)
  // 探测是一次往返（有 5s 上限，但这道守卫不拿它当卸载信号）；期间宿主可能已经卸载本条目
  // （HMR / 条目销毁）。卸载标记必须抢在探测之前登记，回来先看它——续拍再注册就是把贡献
  // 写进一个已销毁的注册表。
  let disposed = false
  if (typeof client.effect === 'function') {
    client.effect(() => () => {
      disposed = true
    }, 'session-delete: activation')
  }
  const raw = createHttpRemote()
  if (!(await probeChannel(raw))) return
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `disposed` 由卸载闭包写成 true，TS 看不见闭包写入；删了会让探测回来的续拍注册进已销毁的注册表。
  if (disposed) return
  const deps = buildDeps(raw)
  // 文案：宿主 locale 服务在就注册字典并绑命名空间，不在就降级到内置 zh（见 `copy.ts` 头注）。
  const t = createTranslate(client)

  // 0.2.2+：两行菜单改住 ctx.contextMenus，才能排在 Archive(600) 之后；旧宿主没有这个服务，
  // 继续走 legacy 槽位（两套注册互斥）。贡献对象住 context-menu-actions.ts，注册仍只在本文件。
  //
  // **一次性 `ctx.get` 不够**：`dsh.client.inject` 只排模块到达（build 侧的 `arriveGraphRow`），
  // 不保证服务已 provide。若本条目先激活、`ui-context-menu` 后提供 `contextMenus`，只探一次就会
  // 永久停在 legacy。所以先按现状注册，再用 `ctx.inject(['contextMenus'])` 等服务迟到：旧宿主
  // 没有这个服务时它永远不回调，legacy 留着。

  /** 数据动作路径：注册 contextMenus 贡献 + 两个 icon key。返回是否成功接管。 */
  const registerDataMenus = (target: ClientContextLike): boolean => {
    const menus = target.get?.('contextMenus') as ContextMenusLike | null | undefined
    if (menus === null || menus === undefined || typeof menus.register !== 'function') return false
    const sessions = target.get?.('sessions') as SessionsServiceLike | null | undefined
    try {
      target.effect(
        () => menus.register(createSessionMenuContribution(t, sessions?.list)),
        'session-delete: context menu actions',
      )
    } catch (error) {
      console.warn('[dsh-session-delete] context menu 注册失败，回退 legacy 菜单行：', error)
      return false
    }
    try {
      target.slots.inject('contextMenu.icon', () =>
        target.slots.register({ name: 'contextMenu.icon', key: ICON_BATCH }, IconCheckOutlineRegular),
      )
      target.slots.inject('contextMenu.icon', () =>
        target.slots.register({ name: 'contextMenu.icon', key: ICON_DELETE }, IconTrashOutlineRegular),
      )
    } catch (error) {
      console.warn('[dsh-session-delete] context menu 图标注册失败：', error)
    }
    return true
  }

  /** legacy 菜单行：返回两个注册的摘除函数（宿主对 `slots.inject` 的返回值就是 disposer）。 */
  const registerLegacyMenus = (): Array<() => void> => {
    const disposers: Array<() => void> = []
    const keep = (dispose: unknown): void => {
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    }
    // ① 菜单行：只发请求，注入面一件都不需要（会话 id / 名字由槽位投影给）。
    keep(client.slots.inject(MENU_SLOT, () =>
      client.slots.register(
        { name: MENU_SLOT, id: `${PLUGIN_ID}.delete`, order: 900, inject: () => ({ t }) },
        DeleteRow,
      ),
    ))
    // ①' 多选入口：官方菜单行之后、删除之前（order 850，带发丝线）；按下进入/退出多选模式并收菜单。
    keep(client.slots.inject(MENU_SLOT, () =>
      client.slots.register(
        { name: MENU_SLOT, id: `${PLUGIN_ID}.batch-select`, order: 850, inject: () => ({ t }) },
        SelectRow,
      ),
    ))
    return disposers
  }

  if (!registerDataMenus(client)) {
    const legacy = registerLegacyMenus()
    let legacyDisposed = false
    try {
      // 先问 `in`：读成员本身也可能抛——动态包沙箱的 ctx 是只放行白名单动词的 Proxy，未放行的
      // 成员在 get 时就拒绝（`has` 则老实回 false，不会顺手报一次失败）。直接调用保持方法调用的
      // `this`，也只 get 一次。
      if ('inject' in client) {
        client.inject(['contextMenus'], (child) => {
          if (!registerDataMenus(child)) return
          if (legacyDisposed) return
          legacyDisposed = true
          for (const dispose of legacy) {
            try {
              dispose()
            } catch (error) {
              console.warn('[dsh-session-delete] legacy 菜单行摘除失败：', error)
            }
          }
        })
      }
    } catch (error) {
      console.warn('[dsh-session-delete] 等待 contextMenus 就绪失败，legacy 菜单行保留：', error)
    }
  }

  // ①' 行首勾选框：多选模式内的主勾选。宿主只在没有状态点、非归档的行渲染这一格；
  // 槽位只投 sessionId，标题由 root hook 补。勾选是原生 Checkbox，自己挡住冒泡（不误开会话）。
  client.slots.inject(LEADING_SLOT, () =>
    client.slots.register(
      { name: LEADING_SLOT, id: `${PLUGIN_ID}.batch-pick-leading`, order: 300, inject: () => ({ t }) },
      PickLeadingRow,
    ),
  )

  // ①'' 行尾兜底勾选开关：状态点行 / 归档行的入口（行首格不渲染）。座位原文"一行一颗图标按钮、
  // 动作归自己"，且**排内点击不误开会话**（`rowActions` 那层自己挡冒泡）⇒ 不需要我们处理传播。
  // order 300 落在宿主 archive(100) / pin(200) 之后；行首格在场时由 `ui.css` 隐藏这一颗。
  client.slots.inject(ROW_ACTION_SLOT, () =>
    client.slots.register(
      { name: ROW_ACTION_SLOT, id: `${PLUGIN_ID}.batch-pick`, order: 300, inject: () => ({ t }) },
      PickRow,
    ),
  )

  // ② 撤销提示的常驻宿主（不在菜单里，理由见 §头注）
  client.slots.inject(OVERLAY_SLOT, () =>
    client.slots.register(
      { name: OVERLAY_SLOT, id: `${PLUGIN_ID}.undo-toast`, inject: () => ({ deps, t }) },
      UndoToastSlot,
    ),
  )

  // ②' 确认框的常驻宿主（确认框必须脱离菜单子树的生命周期，见 delete-confirm.tsx）
  client.slots.inject(OVERLAY_SLOT, () =>
    client.slots.register(
      { name: OVERLAY_SLOT, id: `${PLUGIN_ID}.delete-confirm`, inject: () => ({ deps, t }) },
      DeleteConfirmSlot,
    ),
  )

  // ②'' 批量删除的两件浮层：浮条与批量确认框。与单删那两件同理，各一次 `inject`、
  // 都住在 overlay 上——浮条要跟着每行的勾选开关重绘，确认框必须脱离行子树的生命周期。
  client.slots.inject(OVERLAY_SLOT, () =>
    client.slots.register(
      { name: OVERLAY_SLOT, id: `${PLUGIN_ID}.batch-bar`, inject: () => ({ deps, t }) },
      BatchBarSlot,
    ),
  )

  client.slots.inject(OVERLAY_SLOT, () =>
    client.slots.register(
      { name: OVERLAY_SLOT, id: `${PLUGIN_ID}.batch-confirm`, inject: () => ({ deps, t }) },
      BatchConfirmSlot,
    ),
  )

  // ③ 面板行：名字给宿主（它画 `.panelTitle` 与折叠 tooltip），我们只出一个 glyph。
  // order 落在官方两个面板行（plugins 0 / schedules）与第三方「小说」（20）之后。
  // **名字走 thunk**：宿主 `resolveSlotLabel` 在每次重读时才求值，并在语言变化时重读
  // （`ctx.locale.subscribe(syncPanels)`）⇒ 切换语言这一行跟着走。**别改成活计数**：它只在
  // 条目变化或语言变化时重读，拿它当计数必然 stale（docs/ui-spec.md）。
  client.slots.inject(PANEL_SLOT, () =>
    client.slots.register(
      { name: PANEL_SLOT, id: PANEL_ID, order: 900, label: () => t('trash.title') },
      TrashPanelIconSlot,
    ),
  )

  // ③' 中央面板：同字 key；清单本体（自带页面骨架与滚动，中央列那个盒子两样都不给）。
  client.slots.inject(MAIN_SLOT, () =>
    client.slots.register({ name: MAIN_SLOT, key: PANEL_ID, inject: () => ({ deps, t }) }, TrashPanel),
  )

  // ④ 插件设置页的两张卡（可调项 + 维护）：宿主按 **bundle 包名**寻址这个 keyed 子槽位。
  // 页面没挂载时宿主不会声明它，`inject` 就等着——不在更早的宿主上硬注册（那会响亮失败）。
  // 「可调项」挂载读一次 `/config`；「维护」两段是手动触发。这里只给读数面与文案，不在这里发扫描。
  client.slots.inject(SETTINGS_SLOT, () =>
    client.slots.register(
      { name: SETTINGS_SLOT, key: PLUGIN_ID, inject: () => ({ deps, t }) },
      SettingsCards,
    ),
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
  const client = ctx as ClientContextLike
  // 指针模态的两个 window 监听器归 effect：条目卸载 / HMR 换代时摘掉，不留无人认领的闭包。
  // 注册失败不改变入口；Tooltip 的模态判断退化为「非指针」，只是少一层时序优化。
  if (typeof client.effect === 'function') {
    try {
      client.effect(() => installPointerModality(), 'session-delete: pointer modality')
    } catch {
      // 见上：监听器是优化，不是入口的前置条件。
    }
  }
  void activate(client).catch((error: unknown) => {
    console.warn('[dsh-session-delete] 入口未注册（取数通道不可用）:', error)
  })
}
