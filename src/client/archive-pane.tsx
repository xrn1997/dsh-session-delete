/**
 * 归档档的三个纯视图件（清单列 / 工具行 / 页脚）：状态面来自 `useArchiveQuery`（四态），
 * 动作面来自 `useArchivePanelController`，勾选面来自 `useListSelection`（归档自己的那一台）。
 *
 * 清单的 DOM 不在这里拼——grid、组头、行壳与那三张状态卡都由 `src/client/session-list.tsx` 的
 * `SessionList` 交出，这一档只交**行读数**与**那一排动作**。
 *
 * 行语义（docs/ui-spec.md §3.1）：显示名（`displayNameOf`，label 优先）+ 最后活动/创建于 + 大小
 * （缺席显式「—」）+ 行右两枚图标按钮（解除归档 / 删除，均带 `aria-label`、不写 emoji）；行点击 =
 * 选中看详情（不做原生打开）；孤儿子会话照常显示并带「子代理」标签。
 *
 * 「最后活动」与「创建于」是归档档自己的口径（`updatedAtSource`），与回收站的「删除于」不是同一句；
 * 数据标签按档不同，界面语言按档相同（ADR-0060 边界）。
 */
import type { RefObject } from 'react'
import { absoluteText, agoText, type Translate } from './copy.js'
import type { ArchiveRowWire } from '../shared/wire.js'
import { BULK_DANGER, displayNameOf, type ProjectGroup } from './trash-view.js'
import { ListEmpty, ListLoading, ListNotice, SessionList, type ListDom, type SessionRowView } from './session-list.js'
import type { ArchiveQuery } from './use-archive-query.js'
import type { ListSelection } from './use-list-selection.js'
import type { ArchivePanelController } from './use-archive-panel-controller.js'
import type { TrashNav } from './trash-nav.js'
import { useDelayedPrefetch } from './use-prefetch.js'
import { Button } from './ui/Button.js'
import { Tooltip } from './ui/Tooltip.js'
import { fileSizeText } from './ui/format.js'
import {
  IconFolderOpenRegular,
  IconTrashOutlineRegular,
  IconUnarchiveOutlineRegular,
} from './ui/icons.js'

/** 这一档进 DOM 的身份：行身份是会话 id（回收站那边是条目 id）。 */
export const ARCHIVE_LIST_DOM: ListDom = { kind: 'archive', idAttr: 'data-session-id' }
/** 行身份：模块级稳定引用（面板把导航接在这里）。 */
export const archiveRowIdOf = (row: ArchiveRowWire): string => row.sessionId

export interface ArchiveListProps {
  query: ArchiveQuery
  selection: ListSelection<ArchiveRowWire>
  groups: readonly ProjectGroup<ArchiveRowWire>[]
  controller: Pick<ArchivePanelController, 'select' | 'prefetch' | 'unarchive' | 'requestDeleteOne' | 'actionFailure' | 'busy'>
  /** 清单的 grid 节点：面板的 `useRowFocus` 按 `ARCHIVE_LIST_DOM.idAttr` 查询它。 */
  listRef: RefObject<HTMLDivElement>
  /** 键盘契约（导航状态住面板，窄档下钻时清单卸载也不丢 Esc 与焦点交还）。 */
  nav: TrashNav
  /** 当前活动行（键盘光标或选中行）：说「详情正画着这一条」，也只在非多选态参与 `aria-selected`。 */
  activeId: string | null
  /** 方向键移动活动行时回报面板。 */
  onCursor: (sessionId: string) => void
  onRetry: () => void
  t: Translate
}

/** 清单列：四态里非「有行」的三档各交一块普通内容；有行时只交读数与动作给 `SessionList`。 */
export function ArchiveList({ query, selection, groups, controller, listRef, nav, activeId, onCursor, onRetry, t }: ArchiveListProps) {
  const prefetchRow = useDelayedPrefetch((row: ArchiveRowWire) => { controller.prefetch(row.sessionId) })
  const state = query.list
  const notice = state.status === 'loading' ? <ListLoading label={t('archive.loading')} />
    : state.status === 'failure' ? (
      <ListNotice
        title={t('archive.readFailed')}
        detail={state.message}
        tone="error"
        onRetry={onRetry}
        retryLabel={t('common.retry')}
      />
    ) : state.status === 'corpus-missing' ? (
      <ListNotice
        title={t('archive.corpusMissing.title')}
        detail={t('archive.corpusMissing.hint')}
        tone="muted"
        onRetry={onRetry}
        retryLabel={t('common.retry')}
      />
    ) : state.rows.length === 0 ? (
      <ListEmpty
        icon={<IconFolderOpenRegular size={20} />}
        title={t('archive.empty.title')}
        hint={t('archive.empty.hint')}
      />
    ) : null
  const rowOf = (row: ArchiveRowWire): SessionRowView => {
    const displayName = displayNameOf(row, t)
    const sizeText = row.sizeBytes === undefined ? t('archive.size.absent') : fileSizeText(row.sizeBytes)
    const meta = [
      // 时间格缺席不拿 0 冒充 1970：用一句话说明「时间未知」，与大小缺席的「—」同一条口径。
      row.updatedAt === undefined
        ? t('archive.row.timeAbsent')
        : `${row.updatedAtSource === 'prompt' ? t('archive.row.lastActivity') : t('archive.row.created')} `
          + agoText(row.updatedAt, Date.now(), t),
      sizeText,
      row.subagent ? t('archive.row.subagent') : '',
    ].filter(Boolean).join(' · ')
    return {
      id: row.sessionId,
      title: displayName,
      titleTip: displayName,
      meta,
      metaTip: row.updatedAt === undefined ? '' : absoluteText(row.updatedAt),
      checkLabel: displayName,
      failure: controller.actionFailure[row.sessionId] ?? null,
      onSelect: () => {
        onCursor(row.sessionId)
        void controller.select(row)
      },
      actions: (
        <>
          <button
            type="button"
            className="sd-icon-btn"
            aria-label={t('archive.row.unarchive')}
            title={t('archive.row.unarchive')}
            disabled={controller.busy}
            onClick={(event) => {
              event.stopPropagation()
              void controller.unarchive([row.sessionId])
            }}
          >
            <IconUnarchiveOutlineRegular size={14} />
          </button>
          <button
            type="button"
            className="sd-icon-btn sd-icon-btn-danger"
            aria-label={t('archive.row.delete')}
            title={t('archive.row.deleteHint')}
            disabled={controller.busy}
            onClick={(event) => {
              event.stopPropagation()
              controller.requestDeleteOne(row)
            }}
          >
            <IconTrashOutlineRegular size={14} />
          </button>
        </>
      ),
    }
  }
  return (
    <SessionList
      listRef={listRef}
      dom={ARCHIVE_LIST_DOM}
      gridLabel={t('archive.tab')}
      refreshing={query.refreshing}
      notice={notice}
      groups={groups}
      selection={selection}
      nav={nav}
      prefetch={prefetchRow}
      activeId={activeId}
      rowOf={rowOf}
      t={t}
    />
  )
}

export interface ArchiveToolbarProps {
  selection: ListSelection<ArchiveRowWire>
  groups: readonly ProjectGroup<ArchiveRowWire>[]
  t: Translate
}

/** 工具行随档位：全部折叠 / 多选（归档档自己的选择面）。 */
export function ArchiveToolbar({ selection, groups, t }: ArchiveToolbarProps) {
  return (
    <div style={{ display: 'flex', gap: 6 }} data-dsh-session-delete="archive-toolbar">
      <Button variant="ghost" size="sm" onClick={() => { selection.toggleAllGroups() }} disabled={groups.length === 0}>
        {selection.allCollapsed ? t('list.group.expandAll') : t('list.group.collapseAll')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={selection.selectMode}
        // 与回收站档同一颗判据：没东西可选时不进多选，但已经进来的要能自己退出去。
        disabled={groups.length === 0 && !selection.selectMode}
        onClick={() => {
          if (selection.selectMode) selection.exitSelect()
          else selection.enterSelect()
        }}
      >
        {selection.selectMode ? t('list.select.exit') : t('list.select.enter')}
      </Button>
    </div>
  )
}

export interface ArchiveFooterProps {
  selection: ListSelection<ArchiveRowWire>
  controller: Pick<ArchivePanelController, 'unarchive' | 'requestDeleteMany' | 'busy'>
  t: Translate
}

/** 页脚随档位：多选态 = 「解除所选」（无确认框）/「删除所选」（实心红，确认框语义同批量删除）。
 *  危险那颗仍是这一排的最后一个（「整页唯一一块实心红」的位置契约）。
 *  勾中的行读选择面那一份派生（`checkedRows`，含折叠组），不在这里从 groups 重算。 */
export function ArchiveFooter({ selection, controller, t }: ArchiveFooterProps) {
  if (!selection.selectMode) return null
  const checkedRows = selection.checkedRows
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 2px',
        borderTop: '0.5px solid var(--dsw-alias-border-l2)',
      }}
    >
      <span style={{ marginLeft: 'auto', flex: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Tooltip label={t('list.select.needOne')} side="top" portal disabled={checkedRows.length > 0}>
          <span>
            <Button
              variant="outline"
              size="sm"
              disabled={checkedRows.length === 0 || controller.busy}
              onClick={() => { void controller.unarchive(checkedRows.map((row) => row.sessionId)) }}
            >
              {t('archive.select.unarchive', { count: checkedRows.length })}
            </Button>
          </span>
        </Tooltip>
        <Tooltip label={t('list.select.needOne')} side="top" portal disabled={checkedRows.length > 0}>
          <span>
            <Button
              variant="primary"
              size="sm"
              style={BULK_DANGER}
              icon={<IconTrashOutlineRegular size={13} />}
              disabled={checkedRows.length === 0 || controller.busy}
              onClick={() => {
                controller.requestDeleteMany(checkedRows.map((row) => ({ sessionId: row.sessionId, title: displayNameOf(row, t) })))
              }}
            >
              {t('archive.select.delete', { count: checkedRows.length })}
            </Button>
          </span>
        </Tooltip>
      </span>
    </div>
  )
}
