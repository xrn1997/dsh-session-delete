/**
 * 0.2.2+ 会话菜单的数据动作**定义**：只造贡献对象，不碰客户端注册表。
 * 注册仍统一住 `index.tsx`（客户端条目注册只住那里），这样旧宿主的 legacy 回退与
 * contextMenus 路径的互斥判断也只有一个地方。
 *
 * 为什么需要这一层：0.2.2 把内置会话动作迁到 contextMenus，legacy React 槽位
 * (`sidebar.workspaces.session.menu.item`) 的条目固定渲染在 `afterContent` 动作之前；Archive
 * 是 `afterContent: true` 的 footer 动作，于是 legacy 行会跑到 Archive 前面。把这两行也注册成
 * `afterContent` 数据动作、order 排在 Archive(600) 之后，才能恢复 0.2.1 的顺序：
 * Archive → 多选 → 删除。
 *
 * 数据动作没有 `disabledReason`（底层 MenuRow 有，但 MenuActionView 没透传），所以运行中禁用时
 * 改 label 为「删除（运行中）」；legacy 路径仍保留原来的 tooltip。
 */
import { enterSelection, exitSelection, isSelecting } from './batch-selection-store.js'
import { requestDelete } from './delete-confirm.js'
import type { Translate } from './copy.js'

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

interface SessionsStateLike {
  byId?: Record<string, { running?: boolean } | undefined>
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

export const ICON_BATCH = 'xrn1997.session-delete.batch-select'
export const ICON_DELETE = 'xrn1997.session-delete.delete'

const CONTRIBUTION_ID = 'xrn1997.session-delete.session-menu'

/** 运行中把 label 换成短句：数据动作没有 disabledReason，不能再用 tooltip 解释。 */
function deleteLabel(t: Translate, live: boolean): string {
  return live ? t('menu.deleteLive') : t('menu.delete')
}

/** 会话是否在跑；服务缺席或读数抛错都按「不知道」处理（Node 半仍会拒绝 live 删除）。 */
function liveOf(sessionList: ObservableSnapshotLike<SessionsStateLike> | undefined, sessionId: string): boolean {
  try {
    return sessionList?.getSnapshot().byId?.[sessionId]?.running === true
  } catch {
    return false
  }
}

/**
 * 造 0.2.2+ 的会话菜单贡献。order 700 落在内置 Archive(600) 之后；两行都是 `afterContent`，
 * 所以它们与 Archive 一起排掉 legacy 组件行，恢复「归档在多选/删除之前」。
 */
export function createSessionMenuContribution(
  t: Translate,
  sessionList?: ObservableSnapshotLike<SessionsStateLike>,
): MenuContributionLike {
  const resolve = (target: MenuTarget): readonly MenuActionLike[] => {
    const live = liveOf(sessionList, target.sessionId)
    return [
      {
        id: 'batch-select',
        label: isSelecting() ? t('trash.toolbar.selectExit') : t('trash.toolbar.select'),
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
  }

  return {
    id: CONTRIBUTION_ID,
    target: 'session',
    order: 700,
    ...(sessionList === undefined ? {} : { observe: () => [sessionList] }),
    resolve,
  }
}
