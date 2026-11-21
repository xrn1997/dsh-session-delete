/**
 * 会话菜单的两个面：0.2.2+ 的数据动作**定义**，以及旧宿主的 legacy 槽位行 + 双轨协商。
 * 条目注册的唯一落点仍是 `index.tsx`；**例外是会话菜单这两行**（`docs/architecture.md` §3 的双轨注册），
 * 由 `installSessionMenus` 注册。0.2.2 把内置动作迁到 contextMenus，legacy 行固定排在 Archive 之前，
 * 所以这两行也注册成 afterContent、order 700 以恢复 0.2.1 的顺序：Archive → 多选 → 删除。
 * 数据动作没有 `disabledReason`（MenuActionView 没透传），运行中禁用改 label；legacy 路径保留 tooltip。
 */
import type { ComponentProps, ComponentType } from 'react'
import { BatchSelectMenuItem } from './batch-menu-item.js'
import { enterSelection, exitSelection, isSelecting } from './batch-selection-store.js'
import type { ClientContextLike } from './context.js'
import { requestDelete } from './delete-confirm.js'
import { DeleteMenuItem } from './delete-menu-item.js'
import { PLUGIN_ID, PLUGIN_KEY_PREFIX } from './plugin.js'
import type { Translate } from './copy.js'
import { runningOf, useSessionLive, type SessionsStateLike, type UseSessions } from './session-live.js'
import { withErrorBoundary } from './ui/ErrorBoundary.js'
import { IconCheckOutlineRegular, IconTrashOutlineRegular } from './ui/icons.js'

/** legacy 菜单槽：只在 contextMenus 不可用时注册（0.2.2+ 的内置动作已迁到数据动作）。 */
export const SESSION_MENU_SLOT = 'sidebar.workspaces.session.menu.item'

interface MenuTarget {
  readonly sessionId: string
  readonly displayTitle: string
}

export interface MenuActionLike {
  id: string
  label: string
  disabled?: boolean
  icon?: { key: string }
  danger?: boolean
  separatorBefore?: boolean
  afterContent?: boolean
  run: () => void | Promise<void>
}

export interface ObservableSnapshotLike<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

export interface SessionsServiceLike {
  list?: ObservableSnapshotLike<SessionsStateLike>
}

export interface MenuContributionLike {
  id: string
  target: 'session'
  order: number
  observe?: (target: MenuTarget) => readonly ObservableSnapshotLike<unknown>[]
  resolve: (target: MenuTarget) => readonly MenuActionLike[] | Promise<readonly MenuActionLike[]>
}

export interface ContextMenusLike {
  register(contribution: MenuContributionLike): () => void
}

export const ICON_BATCH = `${PLUGIN_KEY_PREFIX}.batch-select`
export const ICON_DELETE = `${PLUGIN_KEY_PREFIX}.delete`

const CONTRIBUTION_ID = `${PLUGIN_KEY_PREFIX}.session-menu`

function deleteLabel(t: Translate, live: boolean): string {
  return live ? t('menu.deleteLive') : t('menu.delete')
}

/** 会话是否在跑；服务缺席或读数抛错都按「不知道」处理（Node 半仍会拒绝 live 删除）。 */
function liveOf(sessionList: ObservableSnapshotLike<SessionsStateLike> | undefined, sessionId: string): boolean {
  try {
    return runningOf(sessionList?.getSnapshot(), sessionId)
  } catch {
    return false
  }
}

/** 造 0.2.2+ 的会话菜单贡献：order 700 落在内置 Archive(600) 之后，两行都是 `afterContent`。 */
export function createSessionMenuContribution(
  t: Translate,
  sessionList?: ObservableSnapshotLike<SessionsStateLike>,
): MenuContributionLike {
  /** 解析器跑在宿主菜单渲染路径上：抛出去会把整张菜单打空——吞成「这两行这次不出现」，原文留给 console。 */
  const resolve = (target: MenuTarget): readonly MenuActionLike[] => {
    try {
      const live = liveOf(sessionList, target.sessionId)
      return [
        {
          id: 'batch-select',
          label: isSelecting() ? t('list.select.exit') : t('list.select.enter'),
          icon: { key: ICON_BATCH },
          separatorBefore: true,
          afterContent: true,
          run: () => {
            if (isSelecting()) exitSelection()
            else enterSelection()
          },
        },
        {
          id: 'delete',
          label: deleteLabel(t, live),
          disabled: live,
          icon: { key: ICON_DELETE },
          danger: true,
          afterContent: true,
          run: () => {
            requestDelete({ sessionId: target.sessionId, title: target.displayTitle })
          },
        },
      ]
    } catch (error) {
      console.error('[dsh-session-delete] 会话菜单动作解析失败，本次不提供这两行：', error)
      return []
    }
  }

  return {
    id: CONTRIBUTION_ID,
    target: 'session',
    order: 700,
    ...(sessionList === undefined ? {} : { observe: () => [sessionList] }),
    resolve,
  }
}

/* ── legacy 槽位行 + 双轨协商 ─────────────────────────────────────────────
 * 两条路径只能留一条：数据动作可用时 legacy 两行根本不注册；不可用时先注册，再等 `contextMenus` 迟到
 * （旧宿主没有这个服务时回调永不到来，legacy 留着）。 */

/** 菜单槽注入的 `useMenuOpenState`：官方 `menuOpenStateFactory` 交回一对开合状态（asar @46195835）。 */
export type UseMenuOpenState = () => readonly [boolean, (open: boolean) => void]

interface MenuRowProps {
  sessionId: string
  displayTitle: string
  useSessions?: UseSessions
  useMenuOpenState?: UseMenuOpenState
}

/** 槽位 hook 缺失时的兜底：什么都不关（同样恒等身份）。 */
const NEVER_MENU_OPEN_STATE: UseMenuOpenState = () => [false, () => undefined]

function DeleteRow({ sessionId, displayTitle, useSessions, useMenuOpenState, t }: MenuRowProps & { t: Translate }) {
  const live = useSessionLive(useSessions, sessionId)
  // 菜单收不收是 owner（本槽位的宿主菜单）的决定：按下这一行时先发请求、再让 owner 收菜单。
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

function SelectRow({ useMenuOpenState, t }: { useMenuOpenState?: UseMenuOpenState; t: Translate }) {
  const useMenuState = typeof useMenuOpenState === 'function' ? useMenuOpenState : NEVER_MENU_OPEN_STATE
  const [, setMenuOpen] = useMenuState()
  return <BatchSelectMenuItem dismissMenu={() => setMenuOpen(false)} t={t} />
}

/** legacy 两行各自的完整 Props：注册时只注入 `t`，其余由宿主菜单槽派发。 */
type LegacyRowComponent =
  | ComponentType<ComponentProps<typeof DeleteRow>>
  | ComponentType<ComponentProps<typeof SelectRow>>

/** legacy 两行的注册表。**数组顺序 = 注册顺序**（宿主渲染时按 order 排，不靠注册顺序）。 */
const LEGACY_ROWS: readonly {
  readonly suffix: string
  readonly order: number
  readonly component: LegacyRowComponent
}[] = [
  { suffix: 'delete', order: 900, component: DeleteRow },
  { suffix: 'batch-select', order: 850, component: SelectRow },
]

/** 注册菜单两行：数据动作可用就走数据动作（+ 两个 icon key），否则注册 legacy 行并等 `contextMenus` 迟到。 */
export function installSessionMenus(client: ClientContextLike, t: Translate): void {
  const registerData = (target: ClientContextLike): boolean => {
    /**
     * 可选服务的读面：`ctx.get` 在动态包沙箱 / 换代宿主上可能对未放行的成员抛错
     * （`copy.ts` 的 `detectLocaleService` 与 `main-view.ts` 的 `uiWorkspaceOf` 同一条判据）。
     * 这里跑在**任何槽位注册之前**，读失败若往上抛，整个客户端条目会零注册——一个可选服务
     * 读不到只该退回 legacy，不该把其余座位一起拖没。
     */
    const readOptional = (name: 'contextMenus' | 'sessions'): unknown => {
      try {
        return target.get?.(name)
      } catch (error) {
        console.warn(`[dsh-session-delete] 读取可选服务 ${name} 失败，按缺席处理：`, error)
        return undefined
      }
    }
    const menus = readOptional('contextMenus') as ContextMenusLike | null | undefined
    if (menus === null || menus === undefined || typeof menus.register !== 'function') return false
    const sessions = readOptional('sessions') as SessionsServiceLike | null | undefined
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
        target.slots.register({ name: 'contextMenu.icon', key: ICON_BATCH },
          withErrorBoundary(IconCheckOutlineRegular as ComponentType<never>, t('common.renderFailed'))))
      target.slots.inject('contextMenu.icon', () =>
        target.slots.register({ name: 'contextMenu.icon', key: ICON_DELETE },
          withErrorBoundary(IconTrashOutlineRegular as ComponentType<never>, t('common.renderFailed'))))
    } catch (error) {
      console.warn('[dsh-session-delete] context menu 图标注册失败：', error)
    }
    return true
  }

  const registerLegacy = (target: ClientContextLike): Array<() => void> => {
    const disposers: Array<() => void> = []
    for (const row of LEGACY_ROWS) {
      // 与贡献表的注册处同一条：legacy 行也是一条独立贡献，崩了只收起这一行。
      const guard = withErrorBoundary(row.component as ComponentType<never>, t('common.renderFailed'))
      const dispose = target.slots.inject(SESSION_MENU_SLOT, () =>
        target.slots.register(
          { name: SESSION_MENU_SLOT, id: `${PLUGIN_ID}.${row.suffix}`, order: row.order, inject: () => ({ t }) },
          guard,
        ))
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    }
    return disposers
  }

  if (registerData(client)) return
  const legacy = registerLegacy(client)
  let legacyDisposed = false
  try {
    // 先问 `in`：读成员本身也可能抛——动态包沙箱的 ctx 是只放行白名单动词的 Proxy（`has` 老实回 false）；直接调用保持 `this`。
    if ('inject' in client) {
      client.inject(['contextMenus'], (child) => {
        if (!registerData(child)) return
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
