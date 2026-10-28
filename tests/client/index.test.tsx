// 浏览器半入口（`apply` 的装配面）——**之前零覆盖的那一块**
//
// 这一层用**假的 `ctx`**（只给槽位注册表）与**假的 `fetch`**（我们自己的前缀路由）跑真的 `apply`，
// 再把注册表里的贡献按**真宿主的形状**装起来（`Scene`：菜单槽的行渲染在一个假 `Menu` 里，
// overlay 槽的贡献全挂上）。钉住四件事：
// 1. **取数通道的探测是注册的前提**：探测通过才十一次 `slots.inject`（槽位名、插件专属 id、order、
//    以及 `main` 的 key 与 `sidebar.panellist` 的 id 同字）；探测不过 ⇒ 零注册、零抛错、`apply` 正常返回；
// 2. **deps 装配**：HTTP 回的是我们的信封（`{ ok: true, value }` / `{ ok: false, error }`，与官方
//    unary 面同形），失败支必须在注入面被展开成 throw——《remote.test.ts》钉形状，这里钉**端到端的
//    可见后果**（原文上屏 / 面板不 TypeError）；
// 3. **两个座位的形状**：回收站入口占的全局面板是一对座位——`sidebar.panellist` 出一个只吃
//    `{ size, active }` 的 glyph（行本体归宿主：按钮、名字、选中态、折叠 tooltip 都不归我们），
//    `main` 的同字 key 出面板本体。两条**必须同一拍注册**：官方 `ctx.layout.selectPanel` 逐字
//    `if (panelId !== null && !this.hasMainPanel(panelId)) throw new Error(...)`，只有行没有面板时
//    点一下就是运行期抛错；
// 4. **菜单收起的门**：`open === false` ⇒ 槽位行子树不渲染（真产物 `Menu` 逐字如此）。确认框必须脱离
//    这棵子树，否则按下「删除」的那一帧它就被连坐卸载——真机上「移入回收站」永远点不到。
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { type ComponentType, type ReactElement, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetBatchConfirm } from '../../src/client/batch-confirm.js'
import { resetDeleteRequest } from '../../src/client/delete-confirm.js'
import { resetHostRows } from '../../src/client/host-rows.js'
import { apply, inject } from '../../src/client/index.js'
import { resetMainView } from '../../src/client/main-view.js'
import type { ApplyAction, ApplyOutcome, RawSessionDeleteRemote, TrashDetailLike, TrashEntryLike } from '../../src/client/remote.js'
import { enterSelection, resetSelection } from '../../src/client/batch-selection-store.js'
import { resetUndoNotice } from '../../src/client/undo-notices.js'
import { ROUTES, SESSION_DELETE_API_PREFIX } from '../../src/shared/wire.js'

// 撤销提示与删除请求都是模块级现场（跨用例存活）：每个用例前复位，用例之间互不串味。
beforeEach(() => {
  resetUndoNotice()
  resetDeleteRequest()
  // 批量删除的两份模块级现场同样跨用例存活（多选模式 + 选中集、行信息登记）
  resetSelection()
  resetHostRows()
  resetBatchConfirm()
  resetMainView()
})

afterEach(() => {
  resetUndoNotice()
  resetDeleteRequest()
  resetSelection()
  resetHostRows()
  resetBatchConfirm()
  resetMainView()
})

const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
/** 会话行首 16px 格（状态点缺席时归第三方装饰）；批量删除的主勾选框住这里。 */
const LEADING_SLOT = 'sidebar.session.row.leading'
/** 会话行尾悬停排的座位（状态点/归档行的兜底勾选开关住这里，宿主自己的归档/置顶也在这里）。 */
const ROW_ACTION_SLOT = 'sidebar.workspaces.session.row.action'
const OVERLAY_SLOT = 'shell.overlay'
const PANEL_SLOT = 'sidebar.panellist'
const MAIN_SLOT = 'main'
/** 插件设置页的子槽位：宿主声明它之后才挂载；卡片的 key 用 bundle 包名。 */
const SETTINGS_SLOT = 'plugins.bundle.config'
/** 面板 id 与 `main` 的 key 是**同一个字**（官方：list id 寻址同 id 的中央面板）。 */
const PANEL_ID = '@xrn1997/dsh-session-delete.trash'

type SlotComponent = (props: Record<string, unknown>) => ReactElement
type Props = Record<string, unknown>
type RowState = { byId?: Record<string, { running?: boolean; title?: string } | undefined> }
type Select = (state: RowState) => boolean
type FakeUseSessions = (select: Select) => boolean

interface Registration {
  name: string
  /** list 座位的占用者 id；`main`（keyed）用它自己的 `key`，两者同字。 */
  id?: string
  key?: string
  order?: number
  label?: string | (() => string)
  inject?: () => Props
  component: ComponentType<Record<string, unknown>>
}

const ROW: TrashEntryLike = {
  id: 'a',
  sessionId: 'session-a',
  projectDir: '--p--',
  workspaceId: 'ws',
  wasArchived: false,
  deletedAt: 1,
  title: '/code-review',
  sizeBytes: 224 * 1024,
  releaseBytes: 224 * 1024,
}

const DETAIL: TrashDetailLike = {
  entryId: 'a',
  cwd: 'C:/develop/p',
  createdAt: 1,
  lastActivity: 2,
  logTitle: '/code-review',
  models: ['m-1'],
  turnCount: 1,
  userMessageCount: 1,
  assistantMessageCount: 1,
  toolCallCount: 3,
  injectedCount: 7,
  messages: [
    { role: 'user', time: 1, text: '先看改动', truncated: false, attachments: [] },
    { role: 'assistant', time: 2, text: '改动分四层', truncated: false, attachments: [] },
  ],
  omittedByPayloadCap: 0,
}

/** 一次 `apply` 的逐条成功结果（判别联合要的是**字面量**动作，所以按动作分支造，不靠展开）。 */
function okOutcomes(action: ApplyAction, ids: readonly string[]): ApplyOutcome[] {
  return ids.map((id) => {
    if (action === 'count') return { id, action, ok: true as const, value: 0 }
    if (action === 'purge') return { id, action, ok: true as const, value: { removed: 1, freedBytes: 224 * 1024 } }
    if (action === 'orphan-clean') return { id, action, ok: true as const, value: { removed: 1, freedBytes: 224 * 1024 } }
    return { id, action, ok: true as const, value: ROW }
  })
}

/** 一个**与实现同形**的 `RawSessionDeleteRemote`：八个 JSON 段各回一个信封（写动词全走 `apply`；附件字节段是二进制，不经这层）。 */
function rawRemote(overrides: Partial<RawSessionDeleteRemote> = {}): RawSessionDeleteRemote {
  return {
    list: async () => ({ ok: true, value: [ROW] }),
    ping: async () => ({ ok: true, value: 'pong' }),
    orphans: async () => ({
      ok: true,
      value: { roots: [], totalSessions: 0, totalBytes: 0, missingParents: 0, groups: [] },
    }),
    detail: async () => ({ ok: true, value: DETAIL }),
    apply: async (action, ids) => ({ ok: true, value: okOutcomes(action, ids) }),
    empty: async () => ({ ok: true, value: { removed: 1, freedBytes: 224 * 1024 } }),
    attachmentOrphans: async () => ({ ok: true, value: { count: 0, totalBytes: 0, items: [] } }),
    attachmentClean: async () => ({ ok: true, value: { removed: 0, freedBytes: 0, failed: 0 } }),
    ...overrides,
  }
}

/**
 * 取数通道的三种状态。
 * - `up`：八个 JSON 段按井号回信封（**探测过**；附件字节段不经这层）；
 * - `throwing`：`fetch` 直接 reject（路由不在、宿主没起来）——探测不过；
 * - `not-json`：回的是 SPA 的 index.html（前缀路由没注册时落到兜底处理器）——探测也不过。
 */
type Channel = 'up' | 'throwing' | 'not-json'

interface FetchCall { path: string; method: string; body: unknown }

/** 假 `fetch`：只认我们自己的前缀路由，把 HTTP 一层折成"方法 + 段名 + body"。 */
function installFetch(raw: RawSessionDeleteRemote, channel: Channel = 'up'): { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const handler: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
    [SESSION_DELETE_API_PREFIX + ROUTES.list]: async () => raw.list(),
    // 探测走这一问（不再每次页面加载都跑一遍全表对账）
    [SESSION_DELETE_API_PREFIX + ROUTES.ping]: async () => raw.ping(),
    // 两条纯读要有座位：面板挂载读详情、确认框打开那一刻问一次计数
    [SESSION_DELETE_API_PREFIX + ROUTES.detail]: async (body) => raw.detail(body['entryId'] as string),
    // 写动词一段收口：`/apply` 按 body 里的动作与 ids 分派（与 Node 半那张路由表同形）
    [SESSION_DELETE_API_PREFIX + ROUTES.apply]: async (body) =>
      raw.apply(body['action'] as never, body['ids'] as string[]),
    [SESSION_DELETE_API_PREFIX + ROUTES.empty]: async () => raw.empty(),
    // 残留条那一份纯读报告（清理不在这里，仍是 `/apply` 的第五个动作）
    [SESSION_DELETE_API_PREFIX + ROUTES.orphans]: async () => raw.orphans(),
    // 维护卡的孤儿附件：报告纯读、清理聚合写
    [SESSION_DELETE_API_PREFIX + ROUTES.attachmentOrphans]: async () => raw.attachmentOrphans(),
    [SESSION_DELETE_API_PREFIX + ROUTES.attachmentClean]: async () => raw.attachmentClean(),
  }
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const path = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>)
    calls.push({ path, method, body })
    if (channel === 'throwing') throw new TypeError('Failed to fetch')
    if (channel === 'not-json') {
      return { status: 200, ok: true, json: async () => { throw new SyntaxError('Unexpected token <') } }
    }
    const run = handler[path]
    if (run === undefined) throw new Error(`假 fetch 不认这条路径：${path}`)
    const envelope = await run(body)
    return { status: 200, ok: true, json: async () => envelope }
  }) as never
  return { calls }
}

/** 等探测那一拍落地（`apply` 是同步返回的，注册在 fetch 的续拍上）。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 跑一次真的 `apply`（假 ctx 只有**槽位注册表**一个成员——`slots` 是唯一写进 `inject` 的服务），
 * 把 inject / register 记下来。
 */
async function bootstrap(
  raw: RawSessionDeleteRemote = rawRemote(),
  channel: Channel = 'up',
  uiWorkspace?: unknown,
) {
  const fetchCalls = installFetch(raw, channel).calls
  const injected: string[] = []
  const registered: Registration[] = []
  const ctx = {
    slots: {
      inject(key: string, contribute: () => unknown): unknown {
        injected.push(key)
        return contribute()
      },
      register(options: Omit<Registration, 'component'>, component: unknown): unknown {
        registered.push({ ...options, component: component as Registration['component'] })
        return component
      },
    },
    ...(uiWorkspace === undefined ? {} : {
      get: (name: string) => (name === 'uiWorkspace' ? uiWorkspace : undefined),
    }),
  }
  apply(ctx as never)
  await settle()
  const slot = (name: string): Registration => {
    const found = registered.find((row) => row.name === name)
    if (found === undefined) throw new Error(`槽位 ${name} 没有注册`)
    return found
  }
  return {
    injected,
    registered,
    fetchCalls,
    /** 取某个槽位贡献的组件与它的注入面 props。 */
    seat(name: string): { Component: SlotComponent; props: Props } {
      const found = slot(name)
      return {
        Component: found.component as unknown as SlotComponent,
        props: found.inject?.() ?? {},
      }
    },
  }
}

/**
 * 把 `apply` 注册出来的贡献按**真宿主的形状**装起来：
 *
 * - 菜单槽的行渲染在一个假 `Menu` 里，**忠实复刻真产物的那条门**：真 `Menu` 的渲染是
 *   `const list = open && jsxs(MenuSurface, { … children: [items.map(renderEntry), children] })`
 *   （asar @22074291 逐字），`open === false` 时槽位行（`children`）**根本不渲染**——行连同它的
 *   子树一起卸载。**替身原来缺的正是这条落差**（假 hook 只把 `open=false` 记进局部变量，行还在），
 *   所以「先关菜单、再开确认框」在旧实现上看起来通过、真机上永远点不到「移入回收站」。
 * - overlay 槽的**全部**贡献都挂上（宿主就是这样渲染 `shell.overlay` 的）。
 */
function Scene({
  registered,
  rowProps = {},
  onMenuClose,
}: {
  registered: Registration[]
  rowProps?: Props
  onMenuClose?: (open: boolean) => void
}) {
  const [open, setOpen] = useState(true)
  // 真宿主的菜单槽是 list：官方四行 + 我们的两行**全部**渲染（不是只渲染第一条），并且按 order 排。
  const menus = registered
    .filter((row) => row.name === MENU_SLOT)
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
  const overlays = registered.filter((row) => row.name === OVERLAY_SLOT)
  const useMenuOpenState = (): readonly [boolean, (next: boolean) => void] =>
    [
      open,
      (next: boolean) => {
        onMenuClose?.(next)
        setOpen(next)
      },
    ] as const
  // 行首 16px 格：真宿主只投 `sessionId`，标题由 root hook 读（这里给同形的假 hook）
  const leading = registered.find((row) => row.name === LEADING_SLOT)
  const PickLeading = leading?.component as SlotComponent | undefined
  const useSessionsForRow = (select: (state: RowState) => unknown): unknown =>
    select({ byId: { 'session-a': { running: false, title: '/code-review' } } })
  // 行尾悬停排：真宿主把它渲染在会话行末尾（`rowActions` 那层自己挡住点击冒泡）
  const pick = registered.find((row) => row.name === ROW_ACTION_SLOT)
  const PickRow = pick?.component as SlotComponent | undefined
  return (
    <>
      <div data-slot="fake-row" data-row-key="session:session-a">
        <div data-slot="fake-row-leading">
          {PickLeading !== undefined ? (
            <PickLeading
              {...(leading?.inject?.() ?? {})}
              sessionId="session-a"
              useSessions={useSessionsForRow}
              {...rowProps}
            />
          ) : null}
        </div>
        <div data-slot="fake-row-strip">
          {PickRow !== undefined ? (
            <PickRow
              {...(pick?.inject?.() ?? {})}
              sessionId="session-a"
              displayTitle="/code-review"
              {...rowProps}
            />
          ) : null}
        </div>
      </div>
      <div data-slot="fake-menu">
        {open
          ? menus.map((entry) => {
            const MenuRow = entry.component as SlotComponent
            return (
              <MenuRow
                key={entry.id}
                {...(entry.inject?.() ?? {})}
                sessionId="session-a"
                displayTitle="/code-review"
                useMenuOpenState={useMenuOpenState}
                {...rowProps}
              />
            )
          })
          : null}
      </div>
      {overlays.map((entry) => {
        const Overlay = entry.component as SlotComponent
        return <Overlay key={entry.id} {...(entry.inject?.() ?? {})} />
      })}
    </>
  )
}

describe('apply 的装配面', () => {
  it('取数通道可用时：菜单槽两行、行首格与行尾排各一次、overlay 槽四次（提示 + 单删框 + 浮条 + 批量框）、面板行与中央面板各一次、设置页一次；面板 id 与 main 的 key 同字', async () => {
    const { injected, registered } = await bootstrap()
    // 同一个槽位 key 多次 `slots.inject` 是官方写法本身（宿主对 `conversation.chat.node`
    // 就连写十几次 inject，每次一个贡献），overlay 上的四样东西各是各的贡献。
    expect(injected).toEqual([
      MENU_SLOT,
      MENU_SLOT,
      LEADING_SLOT,
      ROW_ACTION_SLOT,
      OVERLAY_SLOT,
      OVERLAY_SLOT,
      OVERLAY_SLOT,
      OVERLAY_SLOT,
      PANEL_SLOT,
      MAIN_SLOT,
      SETTINGS_SLOT,
    ])
    expect(registered.map((row) => row.id)).toEqual([
      '@xrn1997/dsh-session-delete.delete',
      '@xrn1997/dsh-session-delete.batch-select',
      '@xrn1997/dsh-session-delete.batch-pick-leading',
      '@xrn1997/dsh-session-delete.batch-pick',
      '@xrn1997/dsh-session-delete.undo-toast',
      '@xrn1997/dsh-session-delete.delete-confirm',
      '@xrn1997/dsh-session-delete.batch-bar',
      '@xrn1997/dsh-session-delete.batch-confirm',
      PANEL_ID,
      undefined,
      undefined,
    ])
    // 一对座位：`sidebar.panellist` 的 id 与 `main` 的 key 必须同字（官方 selectPanel 按 id
    // 去 main 里找占用者，找不着就抛）。
    const panelRow = registered.find((row) => row.id === PANEL_ID)
    const panelMain = registered.find((row) => row.id === undefined && row.key === PANEL_ID)
    expect(panelMain?.key).toBe(PANEL_ID)
    // 行的名字由**注册元数据**给（宿主 `resolveSlotLabel(options.label)` 解析后画在行上），
    // 不是我们组件里写的字——所以这条必须钉在注册项上。**给的是 thunk**：官方
    // `resolveSlotLabel` 逐字按「函数就调用、否则取原值」收口，其 JSDoc 即
    // "thunks follow the active locale"，而宿主又挂了 `ctx.locale.subscribe(syncPanels)`
    // ⇒ 切语言时这一行跟着走（`copy.ts` 头注）。
    const label = panelRow?.label
    expect(typeof label).toBe('function')
    expect(typeof label === 'function' ? label() : label).toBe('回收站')
    // 菜单行落在官方四行（pin 100 / rename 200 / fork 300 / archive 400）之后：多选 850 在删除 900
    // 之前；行首那一格由状态点优先占用（无状态点才轮到我们），行尾那颗落在宿主自己的
    // archive(100) / pin(200) 之后；面板行落在官方两个面板行（plugins 0 / schedules）与第三方
    // 「小说」（20）之后。
    expect(registered[0]?.order).toBe(900)
    expect(registered[1]?.order).toBe(850)
    expect(registered[2]?.order).toBe(300)
    expect(registered[3]?.order).toBe(300)
    expect(panelRow?.order).toBe(900)
    // 设置页卡片按 **bundle 包名** 寻址（keyed 座位），不是 `id`；宿主的插件详情页声明该子槽位后才会挂载。
    const settingsRow = registered.find((row) => row.name === SETTINGS_SLOT)
    expect(settingsRow?.key).toBe('@xrn1997/dsh-session-delete')
    expect(settingsRow?.id).toBeUndefined()
  })

  it('探测走 GET /ping（不碰清单）；每个动作各发一次 POST /apply（计数排在删除之前）', async () => {
    const apply = vi.fn(async (action: ApplyAction, ids: readonly string[]) => ({ ok: true as const, value: okOutcomes(action, ids) }))
    const { registered, fetchCalls } = await bootstrap(rawRemote({ apply }))
    // 探测那一次：最便宜的在/不在
    expect(fetchCalls[0]).toEqual({ path: `${SESSION_DELETE_API_PREFIX}${ROUTES.ping}`, method: 'GET', body: {} })

    render(<Scene registered={registered} />)
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }))
    await waitFor(() => expect(apply).toHaveBeenCalledWith('delete', ['session-a']))
    fireEvent.click(await screen.findByRole('button', { name: '撤销' }))
    await waitFor(() => expect(apply).toHaveBeenCalledWith('restore', ['a']))

    const posted = fetchCalls.filter((c) => c.method === 'POST')
    // 一段管所有动作：三次请求都打同一条路径，**动作住在 body 里**；
    // 计数排在删除**之前**：那半句「含 N 个子会话」要在点下去之前就摆出来（那一刻这条会话还不在回收站里）
    expect(posted).toEqual([
      { path: `${SESSION_DELETE_API_PREFIX}${ROUTES.apply}`, method: 'POST', body: { action: 'count', ids: ['session-a'] } },
      { path: `${SESSION_DELETE_API_PREFIX}${ROUTES.apply}`, method: 'POST', body: { action: 'delete', ids: ['session-a'] } },
      { path: `${SESSION_DELETE_API_PREFIX}${ROUTES.apply}`, method: 'POST', body: { action: 'restore', ids: ['a'] } },
    ])
  })

  // 真机（2026-10-21）：宿主客户端的常驻 Session 把 `removed` 粘住，`api-session/added` 不清它
  // ⇒ 恢复后输入框仍是「会话不可用」。删除当前主视图时关掉它（宿主归档也是这么做的），
  // 撤销恢复成功后等摘要落地再把会话重开（新实例 removed=false）。
  it('删除当前主视图 → 关掉它；撤销恢复 → 重开它', async () => {
    let selected: { sessionId?: string } = { sessionId: 'session-a' }
    const clearMain = vi.fn(() => { selected = {} })
    const openSession = vi.fn()
    const uiWorkspace = {
      selection: { getSnapshot: () => selected },
      sessions: { list: { getSnapshot: () => ({ byId: { 'session-a': {} } }) } },
      clearMain,
      openSession,
    }
    const apply = vi.fn(async (action: ApplyAction, ids: readonly string[]) => ({ ok: true as const, value: okOutcomes(action, ids) }))
    const { registered } = await bootstrap(rawRemote({ apply }), 'up', uiWorkspace)
    render(<Scene registered={registered} />)

    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }))
    await waitFor(() => expect(clearMain).toHaveBeenCalledTimes(1))

    fireEvent.click(await screen.findByRole('button', { name: '撤销' }))
    await waitFor(() => expect(openSession).toHaveBeenCalledWith('session-a'))
  })

  // 批量删除走的是另一条成功路径（`batch-confirm.tsx` 自己发撤销提示）——同一条主视图收尾也要接上。
  it('批量删除当前主视图 → 关掉它；批量撤销恢复 → 重开它', async () => {
    let selected: { sessionId?: string } = { sessionId: 'session-a' }
    const clearMain = vi.fn(() => { selected = {} })
    const openSession = vi.fn()
    const uiWorkspace = {
      selection: { getSnapshot: () => selected },
      sessions: { list: { getSnapshot: () => ({ byId: { 'session-a': {} } }) } },
      clearMain,
      openSession,
    }
    const apply = vi.fn(async (action: ApplyAction, ids: readonly string[]) => ({ ok: true as const, value: okOutcomes(action, ids) }))
    const { registered } = await bootstrap(rawRemote({ apply }), 'up', uiWorkspace)
    render(<Scene registered={registered} />)

    fireEvent.click(screen.getByRole('menuitem', { name: '多选' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '勾选「/code-review」以批量删除' }))
    fireEvent.click(await screen.findByRole('button', { name: '移入回收站 1 条' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '移入回收站 1 条' }))
    await waitFor(() => expect(clearMain).toHaveBeenCalledTimes(1))

    fireEvent.click(await screen.findByRole('button', { name: '撤销' }))
    await waitFor(() => expect(openSession).toHaveBeenCalledWith('session-a'))
  })

  // 2026-10-17：宿主列表批量删除的端到端形状。「⋯ → 多选」进入模式 → 行首勾选 → 浮条 → 批量确认框
  // 都是注册出来的真组件。
  it('⋯ 多选 → 行首勾选 → 浮条 → 批量确认 → 一次 delete → 批量撤销横幅 → 撤销发一次批量 restore', async () => {
    const apply = vi.fn(async (action: ApplyAction, ids: readonly string[]) => ({ ok: true as const, value: okOutcomes(action, ids) }))
    const { registered, fetchCalls } = await bootstrap(rawRemote({ apply }))
    render(<Scene registered={registered} />)
    fireEvent.click(screen.getByRole('menuitem', { name: '多选' }))
    expect(screen.getByText('点击会话行选择')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: '勾选「/code-review」以批量删除' }))
    // 浮条那颗（此刻对话框还没开，全页只此一颗）
    fireEvent.click(await screen.findByRole('button', { name: '移入回收站 1 条' }))
    // 确认框里那颗（与浮条同句同键 ⇒ 只能在 role="dialog" 里找）
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '移入回收站 1 条' }))
    await waitFor(() => expect(apply).toHaveBeenCalledWith('delete', ['session-a']))
    expect(screen.getByText('1 条会话已移入回收站')).toBeInTheDocument()
    const posted = fetchCalls
      .filter((c) => c.method === 'POST')
      .map((c) => (c.body as { action: string }).action)
    // 序只钉"含 count 且发过 delete"：浮条的防抖 count 与开框的 count 谁先落地不定（预裁记档）
    expect(posted).toContain('count')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(apply).toHaveBeenLastCalledWith('restore', ['a']))
  })

  // 真机反馈：删完在侧栏菜单里，中央的回收站面板**不切走再回来就不更新**（面板是挂载时取一次数）。
  // 这条端到端钉住"删除成功后清单立刻把它读出来"——两侧都是真的：真 apply 注册出来的组件 +
  // 真的模块级现场与失效通告台。
  it('删除成功后回收站面板立刻刷新出那一条（不用切走再回来）', async () => {
    let rows: TrashEntryLike[] = []
    const list = vi.fn(async () => ({ ok: true, value: rows }) as const)
    const { registered } = await bootstrap(
      rawRemote({
        list,
        apply: async (action) => { if (action === 'delete') rows = [ROW]; return { ok: true as const, value: okOutcomes('delete', ['session-a']) } },
      }),
    )
    const panel = registered.find((row) => row.name === MAIN_SLOT)
    const Panel = panel?.component as SlotComponent
    render(
      <>
        <Scene registered={registered} />
        <Panel {...(panel?.inject?.() ?? {})} />
      </>,
    )
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
    // 一次：面板挂载那一次（探测走 `/ping`，不再读清单——2026-10-17）
    expect(list).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }))

    // 第二次 = 删除成功后的那次重读（本轮修的就是它）
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('/code-review')).toBeInTheDocument()
    expect(screen.queryByText('回收站是空的')).not.toBeInTheDocument()
  })
})

// **探测不过 ⇒ 一个槽位贡献都不注册**（通道换了几版，这条形状不变）。
// 为什么必须如此：前端启动自检对「有客户端模块但没激活成功」走的是致命路径
// （`web boot: N entry did not activate` ⇒ 桌面壳 `reportFatal`，整个进程结束）。
// 前缀路由缺席时（Node 半没接线、宿主没起来）本插件就是"不存在"，不是一个能让外壳死掉的理由。
describe('取数通道探测不过（路由缺席态）', () => {
  it('inject 只声明一定存在的服务（slots）：通道不是 inject 的成员', () => {
    expect(inject).toEqual(['slots'])
  })

  it('fetch 打不通（reject）：apply 正常返回、零抛错、一个槽位贡献都不注册', async () => {
    const { injected, registered } = await bootstrap(rawRemote(), 'throwing')
    expect(injected).toEqual([])
    expect(registered).toEqual([])
  })

  it('回的压根不是信封（前缀路由没注册时落到 SPA 兜底）：同样零注册、零抛错', async () => {
    const { injected, registered } = await bootstrap(rawRemote(), 'not-json')
    expect(injected).toEqual([])
    expect(registered).toEqual([])
  })
})

describe('deps 装配：信封的失败支落到界面上的后果', () => {
  it('delete 回 { ok: false, error } 时原文上屏、确认框留着——不走「已移入回收站」那条成功路径', async () => {
    const { registered } = await bootstrap(
      rawRemote({
        apply: async () => ({ ok: false, error: { code: 'sessiondelete/live', message: '会话正在运行' } }) as const,
      }),
    )
    render(<Scene registered={registered} />)

    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }))

    expect(await screen.findByText(/会话正在运行/)).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: '删除这个会话？' })).toBeInTheDocument()
    expect(screen.queryByText(/已移入回收站/)).not.toBeInTheDocument()
  })

  it('list 回 { ok: false } 时原文摆上面板——不是空态、也不是 TypeError', async () => {
    const { seat } = await bootstrap(
      rawRemote({
        list: async () => ({ ok: false, error: { code: 'sessiondelete/io', message: '回收站清单损坏' } }),
      }),
    )
    const { Component, props } = seat(MAIN_SLOT)
    render(<Component {...props} />)

    expect(await screen.findByText(/回收站清单损坏/)).toBeInTheDocument()
    expect(screen.queryByText('回收站是空的')).not.toBeInTheDocument()
    expect(screen.queryByText('undefined')).not.toBeInTheDocument()
  })

  it('单条支展成裸值时撤销拿到真的条目 id（不是信封本体）', async () => {
    const apply = vi.fn(async (action: 'delete' | 'restore', ids: string[]) => ({
      ok: true as const,
      value: ids.map((id) => ({ id, action, ok: true as const, value: ROW })),
    }))
    const { registered } = await bootstrap(rawRemote({ apply }))
    render(<Scene registered={registered} />)
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }))
    expect(await screen.findByText(/\/code-review 已移入回收站/)).toBeInTheDocument()

    // 展开前 `outcome.value` 是 `{ ok, value }`，拿 `.id` 会得到 undefined——撤销会去打 restore(undefined)。
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(apply).toHaveBeenCalledWith('restore', ['a']))
  })
})

describe('live selector（MenuRow 的 props 桥）', () => {
  const evaluate = (state: RowState): FakeUseSessions => (select) => select(state)

  it('取的是 state.byId[id].running === true，形状不对一律不算在跑', async () => {
    const selectors: Select[] = []
    const useSessions: FakeUseSessions = (select) => {
      selectors.push(select)
      return false
    }
    const { seat } = await bootstrap()
    const { Component, props } = seat(MENU_SLOT)
    render(<Component {...props} sessionId="session-a" displayTitle="t" useSessions={useSessions} />)

    expect(selectors.length).toBeGreaterThan(0)
    const select = selectors[0] as Select
    expect(select({ byId: { 'session-a': { running: true } } })).toBe(true)
    expect(select({ byId: { 'session-a': { running: false } } })).toBe(false)
    // 别的会话在跑不算这一行在跑；`byId` 缺失 / 整个 state 缺失都不算。
    expect(select({ byId: { 'session-b': { running: true } } })).toBe(false)
    expect(select({ byId: {} })).toBe(false)
    expect(select({})).toBe(false)
  })

  it('running 的会话那一行置灰，不 running 的不置灰', async () => {
    const { seat } = await bootstrap()
    const { Component, props } = seat(MENU_SLOT)
    const row = { ...props, sessionId: 'session-a', displayTitle: 't' }

    const { unmount } = render(
      <Component {...row} useSessions={evaluate({ byId: { 'session-a': { running: true } } })} />,
    )
    expect(screen.getByRole('menuitem', { name: '删除' })).toBeDisabled()
    unmount()

    render(<Component {...row} useSessions={evaluate({ byId: { 'session-a': { running: false } } })} />)
    expect(screen.getByRole('menuitem', { name: '删除' })).not.toBeDisabled()
  })

  it('槽位 hook 缺失时兜底成「永不 live」，不炸', async () => {
    const { seat } = await bootstrap()
    const { Component, props } = seat(MENU_SLOT)
    render(<Component {...props} sessionId="session-a" displayTitle="t" />)
    expect(screen.getByRole('menuitem', { name: '删除' })).not.toBeDisabled()
  })
})

describe('行首勾选的 props 桥（槽位只投 sessionId）', () => {
  it('标题从 root hook 的 byId[id].title 读，拼出 aria 名字', async () => {
    enterSelection()
    const { seat } = await bootstrap()
    const { Component, props } = seat(LEADING_SLOT)
    const useSessions = (select: (state: RowState) => unknown): unknown =>
      select({ byId: { 'session-a': { title: '/code-review' } } })
    render(<Component {...props} sessionId="session-a" useSessions={useSessions} />)
    expect(screen.getByRole('checkbox', { name: '勾选「/code-review」以批量删除' })).toBeInTheDocument()
  })

  it('root hook 缺失时也不炸：多选态里勾选框照样出来，标题按空串处理', async () => {
    enterSelection()
    const { seat } = await bootstrap()
    const { Component, props } = seat(LEADING_SLOT)
    render(<Component {...props} sessionId="session-a" />)
    expect(screen.getByRole('checkbox')).toBeInTheDocument()
  })
})

describe('菜单收起 = 行子树卸载（真 Menu 的那条门）', () => {
  it('按下这一行：菜单 owner 收到「收起」（不是自己偷偷留着菜单）', async () => {
    const { registered } = await bootstrap()
    const closes: boolean[] = []
    render(<Scene registered={registered} onMenuClose={(next) => closes.push(next)} />)

    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))

    expect(closes).toEqual([false])
  })

  it('按下这一行后菜单关掉、行没了——确认框仍在、且「移入回收站」点得到', async () => {
    const apply = vi.fn(async (action: 'delete', ids: string[]) => ({
      ok: true as const,
      value: ids.map((id) => ({ id, action, ok: true as const, value: ROW })),
    }))
    const { registered } = await bootstrap(rawRemote({ apply }))
    render(<Scene registered={registered} />)

    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))

    // 门确实关了：行随菜单一起卸载（真机上是同一个门）。
    expect(screen.queryByRole('menuitem', { name: '删除' })).not.toBeInTheDocument()
    // 确认框不住在行里，所以这次卸载带不走它。
    expect(screen.getByRole('dialog', { name: '删除这个会话？' })).toBeInTheDocument()
    const confirmButton = screen.getByRole('button', { name: '移入回收站' })
    expect(confirmButton).not.toBeDisabled()
    fireEvent.click(confirmButton)
    await waitFor(() => expect(apply).toHaveBeenCalledWith('delete', ['session-a']))
  })
})

describe('全局面板行（`sidebar.panellist` 的占用者）', () => {
  it('只出 glyph：按 owner 给的 size 画回收站图标；按钮、名字、选中态、折叠 tooltip 全归宿主', async () => {
    const { seat } = await bootstrap()
    const { Component, props } = seat(PANEL_SLOT)
    const { container } = render(<Component {...props} size={18} active />)

    const glyph = container.querySelector('svg')
    expect(glyph).not.toBeNull()
    expect(glyph?.getAttribute('width')).toBe('18')
    expect(glyph?.getAttribute('height')).toBe('18')
    // 行本体（宿主的 `<button class=panelRow>` + `.panelTitle` + Tooltip + aria-current）不归我们，
    // 所以这条贡献里一个按钮都不该有——有了就是又画了一行，与「插件/任务/小说」三行必然错位。
    expect(container.querySelector('button')).toBeNull()
    expect(screen.queryByText('回收站')).not.toBeInTheDocument()
  })

  it('owner props 缺席也不炸（size 缺省 16；active 不参与绘制）', async () => {
    const { seat } = await bootstrap()
    const { Component, props } = seat(PANEL_SLOT)
    const { container } = render(<Component {...props} />)
    const glyph = container.querySelector('svg')
    expect(glyph?.getAttribute('width')).toBe('16')
  })
})

describe('中央面板（`main` 的占用者）', () => {
  it('渲染回收站清单本体：标题在、行读得到', async () => {
    const { seat } = await bootstrap()
    const { Component, props } = seat(MAIN_SLOT)
    render(<Component {...props} />)

    expect(await screen.findByText('/code-review')).toBeInTheDocument()
    expect(screen.getByText('回收站')).toBeInTheDocument()
  })
})

describe('插件设置页（`plugins.bundle.config` 的占用者）', () => {
  it('注入面给 deps/t；挂载只渲染卡片，不自动发检查请求', async () => {
    const { seat, fetchCalls } = await bootstrap()
    const { Component, props } = seat(SETTINGS_SLOT)
    render(<Component {...props} />)

    expect(screen.getByText('维护')).toBeInTheDocument()
    expect(screen.getAllByText('尚未检查')).toHaveLength(2)
    // 探测那一问是注册的前提；之后没有任何自动扫描（手动触发）。
    expect(fetchCalls.map((call) => call.path)).toEqual([
      `${SESSION_DELETE_API_PREFIX}${ROUTES.ping}`,
    ])
  })
})
