/**
 * 回收站档：adapter（两档差异的回收站那一半）+ 本档四个视图件（清单行读数 / 详情投影 / 工具行 / 页脚）。
 * 装配线住 `use-panel-tab.ts`，四格版面住 `panel-tab.tsx`；判据与 DOM 身份不变。
 */
import { TRASH_DIR_LABEL, type TrashEntryWire } from '../shared/wire.js'
import { type Translate } from './copy.js'
import { absoluteText, splitOn, unitWord } from './copy.js'
import { fileSizeText, relativeTime } from './ui/format.js'
import { IconRestoreOutlineRegular, IconTrashOutlineRegular } from './ui/icons.js'
import { Button } from './ui/Button.js'
import { Tooltip } from './ui/Tooltip.js'
import { TrashDetail } from './trash-detail.js'
import type { TrashDetailLike } from './remote.js'
import type { TrashEntryLike } from './remote.js'
import { rowsOf, useTrashQuery, type TrashQuery } from './use-trash-query.js'
import { useTrashPanelController, type TrashPanelController } from './use-trash-panel-controller.js'
import { BULK_DANGER, groupByProject } from './trash-view.js'
import { ListEmpty, ListLoading, ListNotice, SessionList, type ListDom, type SessionRowView } from './session-list.js'
import {
  usePanelTab,
  type PanelTab,
  type PanelTabAdapter,
  type PanelTabContext,
  type PanelTabControllerContext,
} from './use-panel-tab.js'
import { PanelTabFrame, type PanelTabFrameLayout } from './panel-tab.js'

/** 回收站相对宿主**数据根**的位置。**不写 `~/.dsh/`**：数据根可以是 `$DSH_HOME` 指的别处；
 *  字面量住 `shared/wire.ts` 的 `TRASH_DIR_LABEL`（ADR-0003）。 */
const TRASH_DIR = TRASH_DIR_LABEL

const TRASH_LIST_DOM: ListDom = { kind: 'trash', idAttr: 'data-entry-id' }

const entryIdOf = (entry: TrashEntryWire): string => entry.id

/** 行那句「删除于 3小时前」：整句模板住字典（两种语言各钉语序），单位词走 `unitWord` / `relativeTime`；
 *  `now` 桶不套模板。 */
function deletedAgo(at: number, now: number, t: Translate): string {
  const { unit, n } = relativeTime(at, now)
  return unit === 'now'
    ? t('trash.row.deletedNow')
    : t('trash.row.deletedAgo', { n, unit: unitWord(unit, t) })
}

function useTrashTabQuery(ctx: PanelTabContext): TrashQuery {
  return useTrashQuery({ deps: ctx.deps, t: ctx.t, gate: ctx.gate })
}

function useTrashTabController(
  ctx: PanelTabControllerContext<TrashQuery, TrashEntryLike>,
): TrashPanelController {
  return useTrashPanelController({
    deps: ctx.deps,
    gate: ctx.gate,
    query: ctx.query,
    ordered: ctx.ordered,
    canAutoSelect: ctx.canAutoSelect,
    readOnPick: ctx.split,
    active: ctx.active,
  })
}

export const TRASH_TAB_ADAPTER: PanelTabAdapter<
  TrashQuery, TrashEntryLike, TrashEntryWire, TrashDetailLike, TrashPanelController
> = {
  dom: TRASH_LIST_DOM,
  idOf: entryIdOf,
  viewOf: (query) => ({ rows: rowsOf(query.list), refreshing: query.refreshing }),
  groupsOf: (rows, t) => groupByProject(rows, t, {
    timeOf: (entry) => entry.deletedAt,
    projectDirOf: (entry) => entry.projectDir,
    // 原工作区已被删掉的条目直接归入「未分组」组（沉底）；行上不再挂一句提示。
    ungroupedOf: (entry) => entry.workspaceMissing === true,
  }),
  useQuery: useTrashTabQuery,
  useController: useTrashTabController,
  activeRowId: (controller) => controller.selectedId,
  navDrilled: (controller) => controller.drilled,
  navSelect: (controller) => controller.select,
  prefetchOf: (controller) => controller.prefetch,
  detailMountedNarrow: (controller) => controller.drilled && controller.selected !== null,
}

export type TrashPanelTab = PanelTab<
  TrashQuery, TrashEntryLike, TrashEntryWire, TrashDetailLike, TrashPanelController
>

export interface TrashTabViewProps {
  readonly tab: TrashPanelTab
  readonly layout: PanelTabFrameLayout
  readonly t: Translate
}

/** 回收站档的四格视图：清单、详情、工具行（折叠 / 多选）、页脚（「不自动过期」+ 清空 / 批量两颗）。 */
export function TrashTabView({ tab, layout, t }: TrashTabViewProps) {
  const { controller, selection, query, view } = tab
  const entries = view.rows
  const hasEntries = entries !== null && entries.length > 0
  /**
   * 分桶在**每次渲染**时按当前时刻算，但本面板**没有计时器**：一条"59分钟"可以挂到下次重读或失效
   * 通告为止（桶最细到分钟，而回收站不是盯着看的界面）。这是取舍，不是"不会停在旧读数"。
   */
  const now = Date.now()
  /**
   * 页脚那句两种模式共用：多选态能删也能恢复，"选中的 N 条不可恢复"是假话——具体警告归确认框，
   * 这里只留两件事：回收站在哪、不自动过期。
   */
  const noteParts = splitOn(t('trash.footer.note', { dir: TRASH_DIR }), TRASH_DIR)

  /**
   * 清单列：grid 容器、组头、行壳与三张状态卡住 `session-list.tsx`，这一档只交行读数与动作。
   * 非「有行」的三档各是一块普通内容，不是「空的 grid」（ADR-0028）；刷新在飞只挂 `aria-busy`（ADR-0048）。
   */
  const notice = query.list.status === 'unknown' ? (
    <ListNotice
      title={t('trash.readFailed')}
      detail={query.list.failure}
      tone="error"
      onRetry={() => { void query.reload() }}
      retryLabel={t('common.retry')}
    />
  ) : query.list.status === 'loading' ? <ListLoading label={t('trash.loading')} />
    : query.list.rows.length === 0 ? (
      <ListEmpty
        icon={<IconTrashOutlineRegular size={20} />}
        title={t('trash.empty.title')}
        hint={t('trash.empty.hint')}
      />
    ) : null

  const rowOf = (entry: TrashEntryLike): SessionRowView => {
    const title = entry.title === '' ? t('common.untitled') : entry.title
    const kids = entry.subagentCount ?? 0
    const stranded = entry.strandedSubagents ?? 0
    return {
      id: entry.id,
      title,
      titleTip: entry.title === '' ? null : entry.title,
      meta: [
        deletedAgo(entry.deletedAt, now, t),
        fileSizeText(entry.sizeBytes),
        // 两个数各说各的：进了回收站的说"含"，还在盘上的说"还剩"——混成一个就是假话
        kids > 0 ? t('trash.row.subagents', { n: kids }) : '',
        stranded > 0 ? t('trash.row.strandedSubagents', { n: stranded }) : '',
      ].filter(Boolean).join(' · '),
      metaTip: absoluteText(entry.deletedAt),
      checkLabel: t('trash.select.row', { title }),
      // 恢复/彻底删除的失败原文留在这一行：动作与原因同一行（docs/ui-spec.md「失败落点」）。
      failure: controller.actionFailure[entry.id] ?? null,
      onSelect: () => { void controller.select(entry, { drill: !tab.split }) },
      // 两颗动作常驻但默认低强调，悬停/聚焦/选中时提亮，窄档常亮（触屏没有 hover）；多选态整排退场由
      // `SessionList` 决定。
      actions: (
        <>
          <button
            type="button"
            className="sd-icon-btn"
            title={t('trash.row.restore')}
            aria-label={t('trash.row.restore')}
            disabled={controller.busy}
            onClick={(event) => {
              event.stopPropagation()
              void controller.restore(entry)
            }}
          >
            <IconRestoreOutlineRegular size={14} />
          </button>
          <button
            type="button"
            className="sd-icon-btn sd-icon-btn-danger"
            title={t('trash.row.purge')}
            aria-label={t('trash.row.purgeOne', { title })}
            disabled={controller.busy}
            onClick={(event) => {
              event.stopPropagation()
              controller.request({ kind: 'entry', entry })
            }}
          >
            <IconTrashOutlineRegular size={14} />
          </button>
        </>
      ),
    }
  }
  const list = (
    <SessionList
      listRef={tab.listRef}
      dom={TRASH_LIST_DOM}
      gridLabel={t('detail.list.label')}
      refreshing={view.refreshing}
      notice={notice}
      groups={tab.groups}
      selection={selection}
      nav={tab.nav}
      prefetch={tab.prefetch}
      activeId={tab.activeId}
      rowOf={rowOf}
      t={t}
    />
  )

  /**
   * 视图开关常驻面板体顶端，不进滚动容器；宽度上限跟清单列走。不设「刷新」按钮：每次读清单都会先对账。
   */
  const toolbar = (
    <>
      <Button variant="ghost" size="sm" onClick={selection.toggleAllGroups} disabled={!hasEntries}>
        {selection.allCollapsed ? t('list.group.expandAll') : t('list.group.collapseAll')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        // 多选态永远留出口：清单被清空或读失败后 `hasEntries` 为假，退出按钮仍要能点。
        disabled={!hasEntries && !selection.selectMode}
        aria-pressed={selection.selectMode}
        onClick={() => {
          if (selection.selectMode) selection.exitSelect()
          else selection.enterSelect()
        }}
      >
        {selection.selectMode ? t('list.select.exit') : t('list.select.enter')}
      </Button>
    </>
  )

  /**
   * 页脚：非多选态「清空回收站…」，多选态「恢复 N 条」+ 彻底删除（实心红，永远排最后）。
   */
  const footer = !hasEntries ? null : (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 2px',
        borderTop: '0.5px solid var(--dsw-alias-border-l2)',
      }}
    >
      {/* 「不自动过期」必须完整可见，所以不用 ELLIPSIS；句子整体一个 key，渲染时按 {dir} 切一刀把目录包成 code。 */}
      <span style={{ minWidth: 0, fontSize: 11, lineHeight: '16px', color: 'var(--sd-label-tertiary)' }}>
        {noteParts[0]}
        <span style={{ fontFamily: 'var(--ds-font-family-code)', fontSize: 11 }}>{noteParts[1]}</span>
        {noteParts[2]}
      </span>
      <span style={{ marginLeft: 'auto', flex: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* 多选态两颗：恢复（描边款，带确认框）与彻底删除（实心红）；一条没勾时置灰，原因走 Tooltip——
            置灰按钮自己不吃 hover，anchor 用一层 span。 */}
        {selection.selectMode ? (
          <>
            <Tooltip label={t('list.select.needOne')} side="top" portal disabled={selection.checkedIds.length > 0}>
              <span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={selection.checkedIds.length === 0 || controller.busy}
                  onClick={() => controller.request({ kind: 'restore', ids: selection.checkedIds })}
                >
                  {t('trash.select.restore', { count: selection.checkedIds.length })}
                </Button>
              </span>
            </Tooltip>
            <Tooltip label={t('list.select.needOne')} side="top" portal disabled={selection.checkedIds.length > 0}>
              <span>
                <Button
                  variant="primary"
                  size="sm"
                  style={BULK_DANGER}
                  icon={<IconTrashOutlineRegular size={13} />}
                  disabled={selection.checkedIds.length === 0 || controller.busy}
                  onClick={() => controller.request({ kind: 'entries', ids: selection.checkedIds })}
                >
                  {t('trash.select.purge', { count: selection.checkedIds.length })}
                </Button>
              </span>
            </Tooltip>
          </>
        ) : (
          <Button
            variant="primary"
            size="sm"
            style={BULK_DANGER}
            icon={<IconTrashOutlineRegular size={13} />}
            disabled={controller.busy}
            onClick={() => controller.request({ kind: 'all', ids: entries.map((entry) => entry.id) })}
          >
            {t('trash.emptyAll')}
          </Button>
        )}
      </span>
    </div>
  )

  const detail = {
    kind: TRASH_LIST_DOM.kind,
    scrollRef: tab.scrollRef,
    rail: tab.frame.rail,
    children: (
      <TrashDetail
        frame={tab.frame}
        busy={controller.busy}
        wide={tab.split}
        onRetry={() => controller.retry()}
        onBack={() => controller.back()}
        detailNav={controller.detailNav}
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
      toolbarAttr="trash-toolbar"
      toolbar={toolbar}
      list={list}
      detail={detail}
      footer={footer}
      t={t}
    />
  )
}

export function useTrashTab(ctx: PanelTabContext): TrashPanelTab {
  return usePanelTab(TRASH_TAB_ADAPTER, ctx)
}
