/**
 * 浏览器半入口：注册全部槽位贡献，并在注册前探测取数通道。
 *
 * 槽位贡献的注册面见 docs/architecture.md §3，语义归属见 §4 的主人清单；
 * 本文件做注册与槽位接线：**一张贡献表 + 一个注册循环**（槽位 / 注册元数据 / 注入面 / 组件各一格），
 * 不再逐条手写 `slots.inject`。菜单两行有双轨协商（0.2.2+ 的 `ctx.contextMenus` 数据动作 /
 * 旧宿主的 legacy 槽位行 + 迟到切换），整段归 `context-menu-actions.tsx` 的 `installSessionMenus`。
 *
 * 槽位出处（宿主产物，不是猜的；换代先复核）：
 * - sidebar.workspaces.session.menu.item：声明 asar @46391872；数据面投影 @46271806；
 *   menuOpenState hook 工厂 @46195835；宿主官方菜单行 @46392466 起（pin/rename/fork/archive/session-id）。
 *   0.2.2 起内置动作改住 ctx.contextMenus，此槽位只剩 legacy React 扩展位；本插件把多选/删除
 *   迁到数据动作，见 `context-menu-actions.tsx`。
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
import type { ComponentProps, ComponentType } from 'react'
import { BatchBar } from './batch-bar.js'
import { BatchConfirmHost } from './batch-confirm.js'
import { BatchPickButton, BatchPickCheckbox } from './batch-select.js'
import { installSessionMenus } from './context-menu-actions.js'
import { NEVER_SESSIONS, useSessionLive, type UseSessions } from './session-live.js'
import { type ClientContextLike, type SlotRegistration } from './context.js'
import { createTranslate, type Translate } from './copy.js'
import { DeleteConfirmHost } from './delete-confirm.js'
import { installArchiveHostWatch } from './host-archive-watch.js'
import { bindMainView } from './main-view.js'
import { PLUGIN_ID } from './plugin.js'
import { createHttpRemote, probeChannel, type SessionDeleteRemote } from './remote.js'
import { SettingsCards } from './settings-cards.js'
import { TrashPanelIcon } from './trash-entry.js'
import { TrashPanel } from './trash-panel.js'
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

/** 会话行首 16px 格（无状态点时归第三方装饰）；批量删除的主勾选框落这里，多选模式内可见。 */
const LEADING_SLOT = 'sidebar.session.row.leading'
/** 会话行尾的悬停按钮排（宿主自己的归档(100)/置顶(200) 也在这排）；状态点/归档行的兜底勾选落这里。 */
const ROW_ACTION_SLOT = 'sidebar.workspaces.session.row.action'
const OVERLAY_SLOT = 'shell.overlay'
const PANEL_SLOT = 'sidebar.panellist'
const MAIN_SLOT = 'main'
/** 插件详情页的子槽位：宿主页面挂载时才声明，未声明前 `inject` 等待（更早的宿主没有这张卡）。 */
const SETTINGS_SLOT = 'plugins.bundle.config'

/** 面板 id 与 `main` 的 key 同字：官方按 list id 去 `main` 里寻址同 id 的占用者。 */
const PANEL_ID = `${PLUGIN_ID}.trash`

/* ── 勾选框座位的适配：槽位投影 → 组件 props（live 读法归 session-live，菜单两行归 context-menu-actions） ─── */
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
  const live = useSessionLive(useSessions, sessionId)
  return <BatchPickCheckbox sessionId={sessionId} title={title} live={live} t={t} />
}

/** 行尾兜底勾选开关的宿主：投影与菜单行同款（`sessionId` / `displayTitle`），`live` 自己从 root hook 读。 */
function PickRow({
  sessionId,
  displayTitle,
  useSessions,
  t,
}: {
  sessionId: string
  displayTitle: string
  useSessions?: UseSessions
  t: Translate
}) {
  const live = useSessionLive(useSessions, sessionId)
  return <BatchPickButton sessionId={sessionId} title={displayTitle} live={live} t={t} />
}

/* ── 槽位贡献表：一行 = 一个注册（槽位 / 注册元数据 / 注入面 / 组件） ─────────────
 * 十一次 `slots.inject` 曾经是十一段手写代码；现在这张表就是装配面，注册循环只写一遍。
 * 菜单两行与两个 icon 不在这里：它们有双轨协商，归 `context-menu-actions.tsx` 的
 * `installSessionMenus`。 */

/** 每种注入面允许的组件 Props：组件放错组会在编译期报错。
 *  宿主还会额外派发 `view` / `sessionId` 这类我们只窄镜像、不拥有的字段；这里只钉组件自己的
 *  Props，不把宿主槽位契约抄成本地第二份。 */
type TComponent =
  | ComponentType<ComponentProps<typeof PickLeadingRow>>
  | ComponentType<ComponentProps<typeof PickRow>>
type DepsTComponent =
  | ComponentType<ComponentProps<typeof UndoToast>>
  | ComponentType<ComponentProps<typeof DeleteConfirmHost>>
  | ComponentType<ComponentProps<typeof BatchBar>>
  | ComponentType<ComponentProps<typeof BatchConfirmHost>>
  | ComponentType<ComponentProps<typeof TrashPanel>>
  | ComponentType<ComponentProps<typeof SettingsCards>>
type NoneComponent = ComponentType<ComponentProps<typeof TrashPanelIcon>>

interface SlotContributionBase {
  readonly slot: string
  /** 注册元数据；`inject` 由循环按 payload 现造，表里不写。 */
  readonly spec: Omit<SlotRegistration, 'inject'>
}

/** 这几行只吃这几种注入面；多一种就加一格，不在注册循环里现拼。 */
type SlotContribution =
  | (SlotContributionBase & { readonly payload: 't'; readonly component: TComponent })
  | (SlotContributionBase & { readonly payload: 'deps+t'; readonly component: DepsTComponent })
  | (SlotContributionBase & { readonly payload: 'none'; readonly component: NoneComponent })

/** 表本身就是注册顺序（测试里的 `injected` 数组也按它）。 */
function contributions(t: Translate): readonly SlotContribution[] {
  return [
    {
      slot: LEADING_SLOT,
      spec: { name: LEADING_SLOT, id: `${PLUGIN_ID}.batch-pick-leading`, order: 300 },
      payload: 't',
      component: PickLeadingRow,
    },
    {
      slot: ROW_ACTION_SLOT,
      spec: { name: ROW_ACTION_SLOT, id: `${PLUGIN_ID}.batch-pick`, order: 300 },
      payload: 't',
      component: PickRow,
    },
    // ② 撤销提示的常驻宿主（不在菜单里，理由见 §头注）
    { slot: OVERLAY_SLOT, spec: { name: OVERLAY_SLOT, id: `${PLUGIN_ID}.undo-toast` }, payload: 'deps+t', component: UndoToast },
    // ②' 确认框的常驻宿主（必须脱离菜单子树的生命周期，见 delete-confirm.tsx）
    { slot: OVERLAY_SLOT, spec: { name: OVERLAY_SLOT, id: `${PLUGIN_ID}.delete-confirm` }, payload: 'deps+t', component: DeleteConfirmHost },
    // ②'' 批量删除的两件浮层：浮条跟着勾选重绘，确认框必须脱离行子树的生命周期
    { slot: OVERLAY_SLOT, spec: { name: OVERLAY_SLOT, id: `${PLUGIN_ID}.batch-bar` }, payload: 'deps+t', component: BatchBar },
    { slot: OVERLAY_SLOT, spec: { name: OVERLAY_SLOT, id: `${PLUGIN_ID}.batch-confirm` }, payload: 'deps+t', component: BatchConfirmHost },
    // ③ 面板行：名字给宿主（`.panelTitle` 与折叠 tooltip），我们只出一个 glyph。
    // 名字走 thunk：宿主 `resolveSlotLabel` 在每次重读时求值并在语言变化时重读。
    {
      slot: PANEL_SLOT,
      spec: { name: PANEL_SLOT, id: PANEL_ID, order: 900, label: () => t('trash.title') },
      payload: 'none',
      component: TrashPanelIcon,
    },
    // ③' 中央面板：同字 key；清单本体（自带页面骨架与滚动）。
    { slot: MAIN_SLOT, spec: { name: MAIN_SLOT, key: PANEL_ID }, payload: 'deps+t', component: TrashPanel },
    // ④ 插件设置页的两张卡（可调项 + 维护）：宿主按 **bundle 包名**寻址这个 keyed 子槽位。
    { slot: SETTINGS_SLOT, spec: { name: SETTINGS_SLOT, key: PLUGIN_ID }, payload: 'deps+t', component: SettingsCards },
  ]
}

/** 一个循环登记整张表；payload 的三种形状在这里收口，调用点不再各写一段 inject。 */
function registerContributions(
  client: ClientContextLike,
  deps: SessionDeleteRemote,
  t: Translate,
): void {
  for (const row of contributions(t)) {
    const inject = row.payload === 'none'
      ? undefined
      : row.payload === 'deps+t' ? () => ({ deps, t }) : () => ({ t })
    client.slots.inject(row.slot, () => client.slots.register(
      inject === undefined ? row.spec : { ...row.spec, inject },
      row.component,
    ))
  }
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
  const deps = createHttpRemote()
  if (!(await probeChannel(deps))) return
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `disposed` 由卸载闭包写成 true，TS 看不见闭包写入；删了会让探测回来的续拍注册进已销毁的注册表。
  if (disposed) return
  // 文案：宿主 locale 服务在就注册字典并绑命名空间，不在就降级到内置 zh（见 `copy.ts` 头注）。
  const t = createTranslate(client)

  // 菜单两行有双轨协商（数据动作 / legacy + 迟到切换），归 context-menu-actions。
  installSessionMenus(client, t)
  // A1：宿主归档集的旁路观察（可选服务 `workspaces`，窄镜像、缺席安静降级）——
  // 归档档实时反映宿主侧归档/解除归档（不轮询；失效只戳 archive-store，重读归查询）。
  // `effect` 与 activation 守卫同一判据：老宿主没有这一格时不许把注册后面的一整串打掉。
  if (typeof client.effect === 'function') {
    client.effect(() => installArchiveHostWatch(client), 'session-delete: archive host watch')
  }
  // 其余贡献是一张表、一个注册循环（槽位 / id / order / 注入面 / 组件各一格）。
  registerContributions(client, deps, t)
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
