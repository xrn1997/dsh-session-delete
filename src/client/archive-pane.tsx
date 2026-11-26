/**
 * 归档档的三个纯视图件（清单列 / 工具行 / 页脚）与 adapter：状态面来自 `useArchiveQuery`，
 * 装配线住 `use-panel-tab.ts`、四格版面住 `panel-tab.tsx`；这里只回答归档档与回收站不同的那几格。
 */
import { useState, type RefObject } from 'react'
import { absoluteText, agoText, type Translate } from './copy.js'
import type { ArchiveRowWire } from '../shared/wire.js'
import { displayNameOf, groupByProject, type ProjectGroup } from './trash-view.js'
import { ListEmpty, ListLoading, ListNotice, SessionList, type ListDom, type SessionRowView } from './session-list.js'
import type { ArchiveDetailLike } from './remote.js'
import type { ArchiveDetailSubject } from './use-archive-detail-reader.js'
import type { ArchiveQuery } from './use-archive-query.js'
import { archiveRowsOf, useArchiveQuery } from './use-archive-query.js'
import type { ListSelection } from './use-list-selection.js'
import { useArchivePanelController, type ArchivePanelController } from './use-archive-panel-controller.js'
import type { TrashNav } from './trash-nav.js'
import type { DelayedPrefetch } from './use-prefetch.js'
import { ArchiveDetail } from './archive-detail.js'
import { PanelTabFrame, type PanelTabFrameLayout } from './panel-tab.js'
import {
  usePanelTab,
  type PanelTab,
  type PanelTabAdapter,
  type PanelTabContext,
  type PanelTabControllerContext,
} from './use-panel-tab.js'
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
  controller: Pick<ArchivePanelController, 'selectRow' | 'unarchive' | 'deleteOne' | 'actionFailure' | 'busy'>
  prefetch: DelayedPrefetch<ArchiveRowWire>
  listRef: RefObject<HTMLDivElement>
  /** 键盘契约（导航状态住档的装配线，窄档下钻时清单卸载也不丢 Esc 与焦点交还）。 */
  nav: TrashNav
  /** 当前活动行（选中优先，回落光标）：只在非多选态参与 `aria-selected`。 */
  activeId: string | null
  onRetry: () => void
  t: Translate
}

export function ArchiveList({ query, selection, groups, controller, prefetch, listRef, nav, activeId, onRetry, t }: ArchiveListProps) {
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
      onSelect: () => { void controller.selectRow(row, { drill: true }) },
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
              void controller.deleteOne(row)
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
      prefetch={prefetch}
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
  controller: Pick<ArchivePanelController, 'unarchive' | 'deleteMany' | 'busy'>
  t: Translate
}

/** 页脚随档位：多选态 = 「解除所选」（无确认框）/「移入回收站所选」（普通主按钮，可恢复动作不用实心红）。
 *  勾中行读 `checkedRows` 派生，不从 groups 重算。 */
export function ArchiveFooter({ selection, controller, t }: ArchiveFooterProps) {
  const [moving, setMoving] = useState(false)
  if (!selection.selectMode) return null
  const checkedRows = selection.checkedRows
  const runDelete = async (): Promise<void> => {
    setMoving(true)
    try {
      await controller.deleteMany(checkedRows.map((row) => row.sessionId))
    } finally {
      setMoving(false)
    }
  }
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
              icon={moving ? undefined : <IconTrashOutlineRegular size={13} />}
              disabled={checkedRows.length === 0 || controller.busy}
              onClick={() => {
                void runDelete()
              }}
            >
              {moving ? (
                <>
                  <span className="sd-spinner" aria-hidden="true" />
                  {t('progress.action.delete')}
                </>
              ) : (
                t('archive.select.delete', { count: checkedRows.length })
              )}
            </Button>
          </span>
        </Tooltip>
      </span>
    </div>
  )
}

function useArchiveTabQuery(ctx: PanelTabContext): ArchiveQuery {
  return useArchiveQuery({ deps: ctx.deps, active: ctx.active })
}

function useArchiveTabController(
  ctx: PanelTabControllerContext<ArchiveQuery, ArchiveRowWire>,
): ArchivePanelController {
  return useArchivePanelController({
    deps: ctx.deps,
    gate: ctx.gate,
    query: ctx.query,
    ordered: ctx.ordered,
    active: ctx.active,
    split: ctx.split,
    t: ctx.t,
  })
}

/** 归档档 adapter：两档差异里属于归档的那一半。 */
export const ARCHIVE_TAB_ADAPTER: PanelTabAdapter<
  ArchiveQuery, ArchiveRowWire, ArchiveDetailSubject, ArchiveDetailLike, ArchivePanelController
> = {
  dom: ARCHIVE_LIST_DOM,
  idOf: archiveRowIdOf,
  viewOf: (query) => ({ rows: archiveRowsOf(query.list), refreshing: query.refreshing }),
  groupsOf: (rows, t) => groupByProject(rows, t, {
    // 仅排序哨兵：显示口径住本文件（缺席说「时间未知」），不在这里念时间。
    timeOf: (row) => row.updatedAt ?? 0,
    projectDirOf: (row) => row.projectDir,
  }),
  useQuery: useArchiveTabQuery,
  useController: useArchiveTabController,
  // 活动行：选中优先；窄档方向键只移光标时回落到光标（判据住控制器）。
  activeRowId: (controller) => controller.activeId,
  // 归档档没有回收站那样的独立 drilled 位：窄档选中即下钻，宽档不回退。
  navDrilled: (controller, split) => !split && controller.selected !== null,
  navSelect: (controller) => controller.selectRow,
  // 预取参数域是会话 id（回收站是清册行）：行 → 读路在这里收窄。
  prefetchOf: (controller) => (row) => { controller.prefetch(row.sessionId) },
  // 窄档下选中即等价于下钻（selectRow 只在 drill / split 时真正选中）。
  detailMountedNarrow: (controller) => controller.selected !== null,
  // 归档档不活动时详情帧不挂轨监听。
  framePaneMounted: (_controller, facts) => facts.active && facts.detailMounted,
}

export type ArchivePanelTab = PanelTab<
  ArchiveQuery, ArchiveRowWire, ArchiveDetailSubject, ArchiveDetailLike, ArchivePanelController
>

export interface ArchiveTabViewProps {
  readonly tab: ArchivePanelTab
  readonly layout: PanelTabFrameLayout
  readonly t: Translate
}

/** 归档档的四格视图：清单列 / 工具行 / 页脚三件住本文件，详情 `ArchiveDetail` 原样转交；
 *  四格容器与分栏/下钻分支由 `PanelTabFrame` 画（与回收站档同一份）。 */
export function ArchiveTabView({ tab, layout, t }: ArchiveTabViewProps) {
  const { query, selection, controller, groups } = tab
  const list = (
    <ArchiveList
      query={query}
      selection={selection}
      groups={groups}
      controller={controller}
      prefetch={tab.prefetch}
      listRef={tab.listRef}
      nav={tab.nav}
      activeId={tab.activeId}
      onRetry={() => { void query.reload() }}
      t={t}
    />
  )
  const detail = {
    kind: ARCHIVE_LIST_DOM.kind,
    scrollRef: tab.scrollRef,
    rail: tab.frame.rail,
    children: (
      <ArchiveDetail
        frame={tab.frame}
        busy={controller.busy}
        wide={tab.split}
        detailNav={controller.detailNav}
        onRetry={() => controller.retry()}
        onBack={() => controller.back()}
        t={t}
      />
    ),
  }
  return (
    <PanelTabFrame
      split={tab.split}
      detailMounted={tab.detailMounted}
      listWidth={layout.listWidth}
      handleProps={layout.handleProps}
      toolbar={<ArchiveToolbar selection={selection} groups={groups} t={t} />}
      list={list}
      detail={detail}
      footer={<ArchiveFooter selection={selection} controller={controller} t={t} />}
      t={t}
    />
  )
}

export function useArchiveTab(ctx: PanelTabContext): ArchivePanelTab {
  return usePanelTab(ARCHIVE_TAB_ADAPTER, ctx)
}
