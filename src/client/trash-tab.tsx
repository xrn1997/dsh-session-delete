/**
 * 回收站档：**adapter（两档差异的回收站那一半）+ 本档四个视图件**（清单行读数 / 详情投影 / 工具行 /
 * 页脚）。装配线住 `use-panel-tab.ts`，四格版面住 `panel-tab.tsx`；这里只回答「回收站这一档长什么样」。
 *
 * 为什么从 `trash-panel.tsx` 搬出来：面板本身只剩页面骨架、两档分段与布局几何；本档的视图件原先
 * 和归档档的装配混在同一个 700 行文件里，两档各一套接线。搬出后两档对称（归档那一半住
 * `archive-pane.tsx`），面板里不再有「这一档的 rowOf / 页脚 / 工具行」。
 *
 * 判据一个都没改：行读数（删除于 · 大小 · 含/还剩 N 个子会话）、危险层级（页脚最后一颗实心红）、
 * 空态三张卡、详情投影（`TrashDetail`）与 DOM 身份（`data-dsh-session-delete="trash-*"`）逐字保留。
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
import { listView, useTrashQuery, type TrashQuery } from './use-trash-query.js'
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

/** 回收站相对宿主**数据根**的位置。**不写 `~/.dsh/`**：数据根可以是 `$DSH_HOME` 指的别处。
 *  字面量住 `shared/wire.ts`（`TRASH_DIR_LABEL`）——Node 半拼的就是同一个名字（ADR-0003）。 */
const TRASH_DIR = TRASH_DIR_LABEL

/** 回收站档进 DOM 的身份：行身份是条目 id（归档那边是会话 id）。清单与详情两栏共用这一份。 */
const TRASH_LIST_DOM: ListDom = { kind: 'trash', idAttr: 'data-entry-id' }

/** 导航的身份函数：模块级稳定引用（`useTrashNav` 把它放进回调依赖，逐渲染换引用会白重建）。 */
const entryIdOf = (entry: TrashEntryWire): string => entry.id

/**
 * 行那句「删除于 3小时前」：整句模板住在字典里（两种语言各自钉语序），单位词走 `copy.ts`
 * 的 `unitWord` / `relativeTime`——子会话行的时间读同一族，别抄成两本账。`now` 桶不套模板：
 * "删除于 刚刚前"不是话。
 */
function deletedAgo(at: number, now: number, t: Translate): string {
  const { unit, n } = relativeTime(at, now)
  return unit === 'now'
    ? t('trash.row.deletedNow')
    : t('trash.row.deletedAgo', { n, unit: unitWord(unit, t) })
}

/** 回收站档的清单读 hook：面板的交过来的依赖 + 文案 + 闸原样转给 `use-trash-query.ts`。 */
function useTrashTabQuery(ctx: PanelTabContext): TrashQuery {
  return useTrashQuery({ deps: ctx.deps, t: ctx.t, gate: ctx.gate })
}

/** 回收站档的控制器：布局事实只交「屏幕顺序」「要不要自动选中」「选中即读」与档位门。 */
function useTrashTabController(
  ctx: PanelTabControllerContext<TrashQuery, TrashEntryLike>,
): TrashPanelController {
  return useTrashPanelController({
    deps: ctx.deps,
    gate: ctx.gate,
    query: ctx.query,
    ordered: ctx.ordered,
    canAutoSelect: ctx.canAutoSelect,
    // 布局事实：窄档方向键只移选中（详情栏不在眼前），宽档 / 下钻才读详情。
    readOnPick: ctx.split,
    active: ctx.active,
  })
}

/** 回收站档 adapter：两档差异里属于回收站的那一半（装配线不认识这些格子的语义）。 */
export const TRASH_TAB_ADAPTER: PanelTabAdapter<
  TrashQuery, TrashEntryLike, TrashEntryWire, TrashDetailLike, TrashPanelController
> = {
  dom: TRASH_LIST_DOM,
  idOf: entryIdOf,
  viewOf: (query) => listView(query.list, query.refreshing),
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
  // 窄档下钻（drill）之后详情栏才进 DOM；宽档由装配线的 split 覆盖。
  detailMountedNarrow: (controller) => controller.drilled && controller.selected !== null,
}

/** 回收站档装配完的现场（面板只拿它交给 `TrashTabView` 与 header）。 */
export type TrashPanelTab = PanelTab<
  TrashQuery, TrashEntryLike, TrashEntryWire, TrashDetailLike, TrashPanelController
>

/** 面板派给一档的布局事实（几何住面板：断点/列宽拖拽不搬进档里）。 */
export interface TrashTabViewProps {
  readonly tab: TrashPanelTab
  readonly layout: PanelTabFrameLayout
  readonly t: Translate
}

/**
 * 回收站档的四格视图：清单（行读数 + 动作）、详情（`TrashDetail`）、工具行（折叠 / 多选）、页脚
 * （「不自动过期」那句 + 清空 / 批量两颗）。DOM 与内联样式与搬出前逐字一致。
 */
export function TrashTabView({ tab, layout, t }: TrashTabViewProps) {
  const { controller, selection, query, view } = tab
  const entries = view.rows
  const hasEntries = entries !== null && entries.length > 0
  /**
   * 分桶在**每次渲染**时按当前时刻算，但本面板**没有计时器**：一条"59分钟"可以挂到下次重读、
   * 交互或失效通告为止（桶最细到分钟，而回收站不是盯着看的界面）。这是取舍，不是"不会停在旧读数"。
   */
  const now = Date.now()
  /**
   * 页脚那句在两种模式（清理 / 多选）下用同一份：多选态现在能删也能恢复，"选中的 N 条不可恢复"
   * 在准备批量恢复时是假话——那类具体警告归各自的确认框，这里只留两件事：回收站在哪、不自动过期。
   */
  const noteParts = splitOn(t('trash.footer.note', { dir: TRASH_DIR }), TRASH_DIR)

  /**
   * 清单列：grid 容器、组头、行壳与那三张状态卡都住在 `src/client/session-list.tsx`，这一档只交
   * **行读数**与**那一排动作**。四态里非「有行」的三档各是一块普通内容，不是「空的 grid」
   * （裁决见 ADR-0028）；刷新在飞只挂容器的 `aria-busy`，不是第四态（ADR-0048）。
   */
  const notice = view.failure !== null ? (
    <ListNotice
      title={t('trash.readFailed')}
      detail={view.failure}
      tone="error"
      onRetry={() => { void query.reload() }}
      retryLabel={t('common.retry')}
    />
  ) : view.loading ? <ListLoading label={t('trash.loading')} />
    : view.empty ? (
      <ListEmpty
        icon={<IconTrashOutlineRegular size={20} />}
        title={t('trash.empty.title')}
        hint={t('trash.empty.hint')}
      />
    ) : null

  /** 原工作区已被删掉的条目直接归入「未分组」组，行上不再挂一句提示：分组本身就是去向的说明
   *  （`trash-view.ts` 的 `UNGROUPED_PROJECT_DIR`）。 */
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
      // 两颗动作住在行右侧：图标按钮常驻但默认低强调，悬停/聚焦/选中时提亮，窄档常亮
      // （触屏没有 hover）。多选态整排退场由 `SessionList` 决定。
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
   * 视图开关常驻面板体顶端，不进滚动容器；宽度上限跟清单列走，视觉上仍属于清单。
   * 不设「刷新」按钮：每次读清单都会先对账（见 reconcile.ts），开面板、切回、重启都会同步。
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
   * 页脚：非多选态是「清空回收站…」，多选态是「恢复 N 条」「彻底删除 N 条」两颗。
   * 危险那颗位置不换：整页唯一一块实心红靠"它永远是这一排的最后一个"来守（docs/ui-spec.md）。
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
      {/* 「不自动过期」必须完整可见，所以这一处不用 ELLIPSIS；句子整体一个 key，
          渲染时按 {dir} 切一刀把目录包成 code，避免两种语言各钉一次语序。
          多选态共用这一份；动作专属警告归各自的确认框。 */}
      <span style={{ minWidth: 0, fontSize: 11, lineHeight: '16px', color: 'var(--sd-label-tertiary)' }}>
        {noteParts[0]}
        <span style={{ fontFamily: 'var(--ds-font-family-code)', fontSize: 11 }}>{noteParts[1]}</span>
        {noteParts[2]}
      </span>
      <span style={{ marginLeft: 'auto', flex: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* 多选态下这里住两颗：**恢复 N 条**（描边款，带确认框，因为一批条目多、去向是各自旧项目目录）
            与**彻底删除 N 条**（实心红）。一条没勾时两颗都置灰，原因走 Tooltip——置灰的按钮自己不吃
            hover，anchor 用一层 span。 */}
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
            onClick={() => controller.request({ kind: 'all' })}
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

/** 面板用的装配入口：一档 = 共享装配线 + 回收站 adapter（面板只调一次）。 */
export function useTrashTab(ctx: PanelTabContext): TrashPanelTab {
  return usePanelTab(TRASH_TAB_ADAPTER, ctx)
}
