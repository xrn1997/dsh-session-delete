/**
 * 浏览器半入口：**一张贡献表 + 一个注册循环**注册全部槽位贡献，注册前先探取数通道。
 * 槽位出处（宿主产物 asar 偏移，换代先复核）：菜单行 `sidebar.workspaces.session.menu.item` @46391872
 * （数据面投影 @46271806；`menuOpenState` hook 工厂 @46195835；官方菜单行 @46392466 起；
 * 0.2.2 起内置动作改住 `ctx.contextMenus`，此槽位只剩 legacy React 扩展位）；
 * 浮层 `shell.overlay` @21206189（槽位说明原文 "a toast stack or a status pill all belong here"）；面板行 `sidebar.panellist` @44796980（`ctx.slots.subscribe` 叫醒 @44795361，
 * 行渲染 @44783481）与 `main` @21185725（同字 key、成对注册，selectPanel 只校验已注册 @21199710）；
 * 设置页 `plugins.bundle.config`（插件详情页的 keyed 子槽位，页面挂载时才声明）。
 * 硬约束：inject 只写宿主必给的 `slots`，可选服务走 `ctx.get`（写错代价是进程死）；探测不过则不注册。
 * 宿主 ctx 用本地窄镜像：只声明用到的成员 + 一次强转，不装宿主类型包、不做 declare module 增强。
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
import { installClientScene, type ClientScene } from './scene.js'
import { withErrorBoundary } from './ui/ErrorBoundary.js'
import { installPointerModality } from './ui/styles.js'
import { UndoToast } from './undo-toast.js'

export const name = '@xrn1997/dsh-session-delete/client'

/** 只列**宿主公开面保证存在**的成员（`slots` 是冻结平台模块表里的静态键）。取数通道、`locale`、
 *  `contextMenus` 都不在这里：它们走 `ctx.get` 可选读，写进 `inject` 等于这一代缺它就不激活
 *  ⇒ 宿主进程死。`contextMenus` 迟到时按 `ctx.inject` scoped 等待切过去，旧宿主没有就留 legacy 槽位。 */
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

/* ── 勾选框座位的适配：槽位投影 → 组件 props ─── */
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

/* ── 槽位贡献表：一行 = 一个注册。菜单两行与两个 icon 有双轨协商，归 `context-menu-actions.tsx`。 ── */

/** 每种注入面允许的组件 Props：组件放错组会在编译期报错；宿主额外派发的字段只窄镜像、不拥有。 */
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
  | ComponentType<ComponentProps<typeof TrashPanelIcon>>

interface SlotContributionBase {
  readonly slot: string
  /** 注册元数据；`inject` 由循环按 payload 现造，表里不写。 */
  readonly spec: Omit<SlotRegistration, 'inject'>
}

/** 这几行只吃这几种注入面；多一种就加一格，不在注册循环里现拼。 */
type SlotContribution =
  | (SlotContributionBase & { readonly payload: 't'; readonly component: TComponent })
  | (SlotContributionBase & { readonly payload: 'deps+t'; readonly component: DepsTComponent })

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
    // 撤销提示的常驻宿主
    { slot: OVERLAY_SLOT, spec: { name: OVERLAY_SLOT, id: `${PLUGIN_ID}.undo-toast` }, payload: 'deps+t', component: UndoToast },
    // 删除确认框必须脱离菜单子树的生命周期（见 delete-confirm.tsx）
    { slot: OVERLAY_SLOT, spec: { name: OVERLAY_SLOT, id: `${PLUGIN_ID}.delete-confirm` }, payload: 'deps+t', component: DeleteConfirmHost },
    // 批量浮条与确认框：浮条跟着勾选重绘，确认框必须脱离行子树的生命周期
    { slot: OVERLAY_SLOT, spec: { name: OVERLAY_SLOT, id: `${PLUGIN_ID}.batch-bar` }, payload: 'deps+t', component: BatchBar },
    { slot: OVERLAY_SLOT, spec: { name: OVERLAY_SLOT, id: `${PLUGIN_ID}.batch-confirm` }, payload: 'deps+t', component: BatchConfirmHost },
    // 面板行：名字给宿主（`.panelTitle` 与折叠 tooltip），我们出 glyph + 拖放投放目标（`trash-entry.tsx`）；
    // 名字走 thunk（宿主每次重读时求值、语言变化时重读）。
    {
      slot: PANEL_SLOT,
      spec: { name: PANEL_SLOT, id: PANEL_ID, order: 900, label: () => t('trash.title') },
      payload: 'deps+t',
      component: TrashPanelIcon,
    },
    // 中央面板：同字 key；清单本体（自带页面骨架与滚动）。
    { slot: MAIN_SLOT, spec: { name: MAIN_SLOT, key: PANEL_ID }, payload: 'deps+t', component: TrashPanel },
    // 插件设置页的两张卡（可调项 + 维护）：宿主按 **bundle 包名**寻址这个 keyed 子槽位。
    { slot: SETTINGS_SLOT, spec: { name: SETTINGS_SLOT, key: PLUGIN_ID }, payload: 'deps+t', component: SettingsCards },
  ]
}

/** 一个循环登记整张表；payload 的两种形状在这里收口，调用点不再各写一段 inject。 */
function registerContributions(
  client: ClientContextLike,
  deps: SessionDeleteRemote,
  t: Translate,
  scene: ClientScene,
): void {
  for (const row of contributions(t)) {
    const inject = row.payload === 'deps+t' ? () => ({ deps, t }) : () => ({ t })
    // 每条贡献各自一颗错误边界：一条渲染崩了只收起它自己那一块（宿主那一格不许被连坐成空白）。
    // Props 形状由宿主按座位派发、彼此不同，边界这一层只关心"包住它"，所以擦成 `never` 面再包；
    // 场景实例随贡献进子树：宿主各槽位是独立 React 树，跨槽位共享靠同一个实例（不是树）。
    const guard = withErrorBoundary(row.component as ComponentType<never>, t('common.renderFailed'), scene)
    client.slots.inject(row.slot, () => client.slots.register(
      { ...row.spec, inject },
      guard,
    ))
  }
}

/**
 * **探测 → 注册**：探测不过（打不通 / 非信封 / 401·403 / 失败信封）⇒ **早返回**，一个槽位贡献都不注册——
 * 半吊子 UI 比没有 UI 更糟（docs/architecture.md §3）。探测过才注册；支持面是 web UI 与桌面端（ADR-0033）。
 * 面板行与 `main` 是**一对座位**、成不了原子事务：漏一半的代价是宿主那句响亮的抛错，不是静默降级。
 */
async function activate(client: ClientContextLike): Promise<void> {
  // 跨槽位现场收在一份场景里：注册面装入进程（已装入则沿用：HMR 不丢现场；未装才现造），再由各贡献的
  // Provider 带给组件（宿主槽位之间没有共同父级，共享靠实例本身）。
  const scene = installClientScene()
  bindMainView(client)
  // 探测是一次往返（有 5s 上限，但这道守卫不拿它当卸载信号）；期间宿主可能已经卸载本条目（HMR / 销毁）。
  // 卸载标记必须抢在探测之前登记，回来先看它——续拍再注册就是把贡献写进一个已销毁的注册表。
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
  // 归档旁路观察：可选服务 `workspaces`（窄镜像、缺席安静降级）——归档档实时反映宿主侧变化，不轮询。
  // `effect` 与 activation 守卫同一判据：老宿主没有这一格时不许把注册后面的一整串打掉。
  if (typeof client.effect === 'function') {
    client.effect(() => installArchiveHostWatch(client), 'session-delete: archive host watch')
  }
  registerContributions(client, deps, t, scene)
}

/** 入口：**同步返回、绝不抛**。注册挂在探测的续拍上：前端启动自检只看 entry 声明的 `inject` 服务齐不齐，
 *  且槽位注册是注册表的一次 mutation、渲染层按微任务批量订阅，晚一拍注册照常上屏。 */
export function apply(ctx: unknown): void {
  const client = ctx as ClientContextLike
  // 指针模态的两个 window 监听器归 effect：条目卸载 / HMR 换代时摘掉；注册失败不改变入口（只是少一层时序优化）。
  if (typeof client.effect === 'function') {
    try {
      client.effect(() => installPointerModality(), 'session-delete: pointer modality')
    } catch {
      // 监听器是优化，不是入口的前置条件。
    }
  }
  void activate(client).catch((error: unknown) => {
    console.warn('[dsh-session-delete] 入口未注册（取数通道不可用）:', error)
  })
}
