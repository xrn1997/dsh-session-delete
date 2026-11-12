/**
 * 回收站中央面板（main 槽占用者）：页面骨架、清单/详情两栏或下钻、清单行与确认框开合。
 *
 * 布局与行为：
 * - 中央列本身没有 padding 也不是滚动容器，面板自己收滚动。
 * - 面板 border-box 宽达到 SPLIT_MIN_WIDTH 且清单有条目时走左右两栏；否则单列/下钻，
 *   详情铺满并给返回。
 * - 动作留在清单行右侧；详情只负责看，失败原文留在出事的那一行。
 * - 空态不出现「清空回收站…」；「读不到」与「空的」分开。
 * - 危险层级：页脚那排的最后一颗是整页唯一的实心红（非多选是「清空回收站…」，
 *   多选是「彻底删除 N 条」）；行内「彻底删除」图标默认只给字色，不铺实心底，悬停才转红。
 *
 * 样式：结构与布局用内联样式；配色与圆角走宿主 token；控件与清单行样式在 `src/client/ui/`
 * （`ui.css` 是宿主抄本，`forms.css` / `layout.css` 是自造规则），由 `ui/styles.ts` 注入 style。
 * 界面规格见 docs/ui-spec.md；
 * 改断点或列宽前先看 SPLIT_MIN_WIDTH、LIST_COLUMN_DEFAULT / LIST_COLUMN_MIN、DETAIL_RESERVE 与 usePanelWidth。
 */
import {
  type CSSProperties,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { TRASH_DIR_LABEL, type ArchiveRowWire, type TrashEntryWire } from '../shared/wire.js'
import { useBusyGate } from './busy-gate.js'
import { absoluteText, splitOn, unitWord, zhTranslate, type Translate } from './copy.js'
import { Notice } from './notice.js'
import { type SessionDeleteRemote, type TrashEntryLike } from './remote.js'
import { TrashDetail } from './trash-detail.js'
import { ArchiveDetail } from './archive-detail.js'
import type { DetailNav } from './session-detail.js'
import { ArchiveFooter, ArchiveList, ArchiveToolbar, ARCHIVE_LIST_DOM, archiveRowIdOf } from './archive-pane.js'
import { useArchiveQuery } from './use-archive-query.js'
import { useArchivePanelController } from './use-archive-panel-controller.js'
import { useColumnResize } from './use-column-resize.js'
import { usePanelWidth } from './use-panel-width.js'
import { useTrashNav } from './trash-nav.js'
import { Button } from './ui/Button.js'
import { fileSizeText, relativeTime } from './ui/format.js'
import {
  IconRestoreOutlineRegular,
  IconTrashOutlineRegular,
} from './ui/icons.js'
import { ELLIPSIS } from './ui/recipe.js'
import { Tooltip } from './ui/Tooltip.js'
import { TrashConfirm } from './trash-confirm.js'
import { ListEmpty, ListLoading, ListNotice, SessionList, useRowFocus, type ListDom, type SessionRowView } from './session-list.js'
import { useTrashPanelController } from './use-trash-panel-controller.js'
import { useDelayedPrefetch } from './use-prefetch.js'
import { listView, useTrashQuery } from './use-trash-query.js'
import { useListSelection } from './use-list-selection.js'
import { useDetailRail } from './use-detail-rail.js'
import { DetailPane, ListPane } from './detail-pane.js'
import { BULK_DANGER, displayNameOf, groupByProject } from './trash-view.js'

/** 面板的依赖面：两个读（`list` / `detail`）+ **一段 `apply`** + 清空。
 *  **没有第二条路**：「恢复一条」也走 `apply`（N=1），面板不再同时吃
 *  `applyOutcomes` 与一个便捷的 `restore`。无主子会话的检查/清理不在这里——它是插件设置页
 *  维护卡的手动动作（`use-maintenance.ts`），面板一次都不自动扫（ADR-0021）。 */
export type TrashPanelDeps = Pick<
  SessionDeleteRemote,
  'list' | 'detail' | 'applyOutcomes' | 'emptyTrash' | 'archiveList' | 'archiveDetail'
>

export interface TrashPanelProps {
  deps: TrashPanelDeps
  /** 文案（缺省 = 内置 zh，见 `copy.ts`：这不是"忘了传"，而是"这次没有 locale 服务"）。 */
  t?: Translate
}

/** 回收站相对宿主**数据根**的位置。**不写 `~/.dsh/`**：数据根可以是 `$DSH_HOME` 指的别处。
 *  字面量住 `shared/wire.ts`（`TRASH_DIR_LABEL`）——Node 半拼的就是同一个名字（ADR-0003）。 */
const TRASH_DIR = TRASH_DIR_LABEL

/**
 * 断点：面板盒子宽 ≥ 此值走两栏，窄于此走下钻（docs/ui-spec.md）。
 * 两栏要成立，详情列至少 399，加两道 gap 32、把手 10、页内边距 48 ⇒ 地板 489；
 * 900 这一档清单为 411，刚好守住两边可读下限。改数字前先同步 DETAIL_RESERVE 与 usePanelWidth。
 */
const SPLIT_MIN_WIDTH = 900
/** 左栏默认宽：为“行内有动作”设计——两颗 28px 图标按钮加间距与行内边距约 80px，
 *  剩下约 340px 给标题与元信息。可拖范围见 LIST_COLUMN_MIN / DETAIL_RESERVE。 */
const LIST_COLUMN_DEFAULT = 420
/** 左栏下限 330：再窄时「删除于 … · 224KB」那行就会开始被省略号截断。
 *  按钮 flex:none，不参与这个下限。 */
const LIST_COLUMN_MIN = 330
/** 拖到最右时给详情留的地板：正文最小宽 399 + 两道 gap 32 + 把手 10 + 页内边距 48 = 489。
 *  900 − 489 = 411，断点下沿清单抢不动宽度。 */
const DETAIL_RESERVE = 489
/** 分隔线键盘一格的像素数（←→）。 */
const HANDLE_STEP = 20

/**
 * 页面骨架：撑满中央列（`height:100%` 落在 `.centerCol` 这个有定高的网格项上），自收滚动。
 *
 * `boxSizing:'border-box'` **不是装饰**：宿主文档没有全局 border-box reset（220 处 `box-sizing`
 * 声明全是组件自己带的），默认是 content-box ⇒ `height:100%` 再加 20px 上边距会溢出 20px，
 * 把页脚整块推到中央列底边之外（真机浅色截图上页脚贴着窗口下缘就是这个）。
 */
const PAGE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  height: '100%',
  minWidth: 0,
  padding: '20px 24px 12px',
}

/** 两栏/下钻那一行（页脚之上，自收滚动）。 */
const BODY: CSSProperties = {
  display: 'flex',
  flex: '1 1 auto',
  gap: 16,
  minHeight: 0,
  minWidth: 0,
}

/**
 * 清单那一栏的**布局**（宽与 `flex` 不在这里——由调用点在渲染时现给：两栏时是可拖的定宽，
 * 单列时 `flex:'1 1 auto'` 铺满）。两栏不成立时（窄档，或宽档但清单为空/读不到）同一个配方
 * 直接铺满：**不再限宽 760 居中**，那条关心得只适用于正文（见 `detail-pane.tsx` 的 `DETAIL_TEXT_MAX_WIDTH`）。
 * 滚动配方（overflow / 内边距 / 滚动条档位）住 `detail-pane.tsx` 的 `SCROLL_COLUMN`，`ListPane` 自己合上。
 */
const LIST_COLUMN: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  gap: 7,
  minWidth: 0,
  minHeight: 0,
}

/**
 * 视图开关（全部折叠 / 全部展开、多选）。住在面板体顶端，不进滚动容器，长清单滚到底也不会滚走。
 * 宽度上限由用它的地方现给：两栏时跟清单列宽，单列时不设上限。
 */
const TOOLBAR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flex: 'none',
  minWidth: 0,
  width: '100%',
  paddingBottom: 8,
}

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

/** 导航的身份函数：模块级稳定引用（`useTrashNav` 把它放进回调依赖，逐渲染换引用会白重建）。 */
const entryIdOf = (entry: TrashEntryWire): string => entry.id

/** 回收站档进 DOM 的身份：行身份是条目 id（归档那边是会话 id）。清单与详情两栏共用这一份。 */
const TRASH_LIST_DOM: ListDom = { kind: 'trash', idAttr: 'data-entry-id' }

/* 「这一次彻底删除会释放多少」**不在这里算**：它是存储侧的事实（本行 + 跟着进来的孩子
 * + 盘上还留着的后代，彻底删除删的正是这三样），由 Node 半算一次、`releaseBytes` 过线。浏览器半照单念——
 * 头部合计与单条确认卡片都读它，于是同一屏不可能有两套口径，也就不再有"两行都算到同一个后代"那种偏差。 */

export function TrashPanel({ deps, t = zhTranslate }: TrashPanelProps) {
  /** 面板唯一的一枚全局闸（写动作在飞时按住一排按钮）：本体住 `busy-gate.ts`，查询侧的写动作也吃它。 */
  const gate = useBusyGate()
  /** 分段按钮的计数说明 id：可见计数已画在按钮里，`aria-describedby` 把它带进可及描述，
   *  按钮的可及名仍保持纯档名（不把 N/M 拼进 name，读屏念「归档」而不是「归档 2 按钮」）。 */
  const tabCountId = useId()

  // 取数编排（清单状态 + 附件回执）整块住在 `use-trash-query.ts`。
  const query = useTrashQuery({ deps, t, gate })
  const { list: listState, reload } = query
  // 清单状态的解读只住 `use-trash-query.ts`：面板不再自己从 status 反推失败/加载/空态。
  // 第二参是「画着的行来自首帧快照、重读还在飞」：只给 `aria-busy`，不改变三态。
  const view = listView(listState, query.refreshing)
  const entries = view.rows

  const listRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** 详情栏的滚动容器：分页 prepend 后按高度差补偿滚动位置（归 `trash-detail.tsx` 消费）。 */
  const detailScrollRef = useRef<HTMLDivElement | null>(null)
  const width = usePanelWidth(rootRef)
  const wide = width >= SPLIT_MIN_WIDTH
  /**
   * 真走两栏的条件：盒子够宽 **且清单里有东西可看**。空态与读数失败时右栏不出现——那一栏既没有
   * 可选项也没有动作，白占一半宽度（docs/ui-spec.md）。失败那块自己的「重试」
   * 负责把清单读回来，读回来之后右栏跟着回来。
   */
  const split = wide && entries !== null && entries.length > 0
  /** 两栏之间那根可拖的把手（窄档不渲染它，但 hook 照样得在——不能在条件里调）。 */
  const resize = useColumnResize({
    panelWidth: width,
    defaultValue: LIST_COLUMN_DEFAULT,
    min: LIST_COLUMN_MIN,
    reserve: DETAIL_RESERVE,
    step: HANDLE_STEP,
    label: t('list.divider.label'),
  })

  const groups = useMemo(() => groupByProject(entries ?? [], t, {
    timeOf: (entry) => entry.deletedAt,
    projectDirOf: (entry) => entry.projectDir,
    ungroupedOf: (entry) => entry.workspaceMissing === true,
  }), [entries, t])
  // 选择面（多选 / 折叠 / 勾选与它们派生的只读）整块住在 `use-list-selection.ts`。
  const selection = useListSelection({ rows: entries, groups, idOf: (entry) => entry.id })

  // ── 归档档（平级分段）：查询/选择面/控制器**常驻挂载**（同一次挂载内切档保留已读缓存，卸载即丢）；
  // `active` 门控读取（不活动只置脏不读，不为可能不打开的档付全语料读）。三台现场与回收站档完全独立。
  const [tab, setTab] = useState<'trash' | 'archive'>('trash')
  const archiveQuery = useArchiveQuery({ deps, active: tab === 'archive' })
  const archiveRowsList = archiveQuery.list.status === 'ready' ? archiveQuery.list.rows : null
  /** 归档档自己的分栏判据：回收站空着不代表归档该缩成单列（两档数据源独立）。 */
  const archiveSplit = wide && archiveRowsList !== null && archiveRowsList.length > 0
  const archiveGroups = useMemo(
    () => groupByProject(archiveRowsList ?? [], t, {
      timeOf: (row) => row.updatedAt ?? 0, // 仅排序哨兵：显示口径住 archive-pane（缺席说「时间未知」）
      projectDirOf: (row) => row.projectDir,
    }),
    [archiveRowsList, t],
  )
  const archiveSelection = useListSelection({ rows: archiveRowsList, groups: archiveGroups, idOf: (row) => row.sessionId })
  const archiveController = useArchivePanelController({
    deps,
    gate,
    query: archiveQuery,
    ordered: archiveSelection.ordered,
    // 档位不活动时不替用户读详情（归档档只在该档可见时自动选中）。
    canAutoSelect: archiveSplit && tab === 'archive',
    t,
  })
  const archiveScrollRef = useRef<HTMLDivElement>(null)
  const archiveListRef = useRef<HTMLDivElement>(null)
  const [archiveCursorId, setArchiveCursorId] = useState<string | null>(null)

  /** 归档清单的键盘面住面板：窄档下钻时清单卸载，导航与 Esc 仍要活着（与回收站同一条）。 */
  const archiveFocusRow = useRowFocus(archiveListRef, ARCHIVE_LIST_DOM.idAttr)
  const archiveSelect = useCallback(async (
    row: ArchiveRowWire,
    options?: { drill?: boolean },
  ): Promise<void> => {
    setArchiveCursorId(row.sessionId)
    // 方向键只移动活动行；Enter/Space（drill）或宽档才真正选中并读详情。
    if (options?.drill === true || archiveSplit) await archiveController.select(row)
  }, [archiveController, archiveSplit])
  /** 选中行优先；没有选中（窄档方向键只移动光标）时用光标，光标已不在清单就落空。 */
  const archiveActiveId = archiveController.selected?.sessionId
    ?? (archiveCursorId !== null && (archiveRowsList?.some((row) => row.sessionId === archiveCursorId) ?? false)
      ? archiveCursorId
      : null)
  /** 归档详情里的孩子：已归档的仍是选中清单那一行；未归档的进只读孩子视图（父行做只读根）。 */
  const openArchiveChild = useCallback((sessionId: string): void => {
    const child = archiveRowsList?.find((row) => row.sessionId === sessionId)
    if (child !== undefined) { void archiveController.select(child); return }
    void archiveController.openChild(sessionId)
  }, [archiveController, archiveRowsList])
  /** 归档详情的导航面：父视图交开孩子/预取；孩子视图只交返回父，不再开下一层（单级）。 */
  const archiveDetailNav = useMemo<DetailNav>(() => {
    if (archiveController.childView !== null) {
      const parent = archiveController.selected
      return {
        parentContext: {
          title: parent === null ? '' : displayNameOf(parent, t),
          onBack: archiveController.closeChild,
        },
      }
    }
    return {
      onOpenChild: openArchiveChild,
      onPrefetchChild: archiveController.prefetch,
    }
  }, [archiveController.childView, archiveController.selected, archiveController.closeChild, archiveController.prefetch, openArchiveChild, t])
  const archiveNav = useTrashNav({
    ordered: archiveSelection.ordered,
    idOf: archiveRowIdOf,
    selectedId: archiveActiveId,
    selectMode: archiveSelection.selectMode,
    // 键盘契约只跟着**当前档**：两台导航都听 `document` 的 Esc，屏上却只有一档。不按档收口，
    // 在回收站档按一次 Esc 会把归档档看不见的下钻一起收走（两档状态互不相通，ADR-0060 决定第 4 条）。
    drillEnabled: !archiveSplit && tab === 'archive',
    drilled: !archiveSplit && archiveController.selected !== null,
    select: archiveSelect,
    toggleCheck: archiveSelection.toggleCheck,
    back: archiveController.back,
    focusRow: archiveFocusRow,
    scope: rootRef,
  })

  /** 归档详情的提问轨：与回收站档走同一份接线（`use-detail-rail.ts`），只换主体与挂载判据。 */
  const archivePaneMounted = tab === 'archive' && (archiveSplit || archiveController.selected !== null)
  const archiveRail = useDetailRail({
    state: archiveController.detail,
    loadingOlder: archiveController.loadingOlder,
    olderFailure: archiveController.olderFailure,
    loadOlder: archiveController.loadOlder,
    scrollRef: archiveScrollRef,
    paneMounted: archivePaneMounted,
  })
  /** 切档 = 两台选择面**双向清空**（跨档不带名单）；折叠集天然按档独立（各是各的实例）。 */
  const switchTab = (next: 'trash' | 'archive'): void => {
    if (tab === next) return
    selection.exitSelect()
    archiveSelection.exitSelect()
    setTab(next)
  }
  const {
    selectMode, checkedIds, ordered, allCollapsed,
    enterSelect, exitSelect, toggleAllGroups, toggleCheck,
  } = selection

  /** 行的 DOM 查询留给清单那一侧（`useRowFocus`）；导航只拿"把焦点还给哪一行"这个动作。 */
  const focusRow = useRowFocus(listRef, TRASH_LIST_DOM.idAttr)

  /**
   * 选中 / 详情账本 / 清单换版清场 / 宽档自动选中 / 写动作与失败落点，整块住在
   * `use-trash-panel-controller.ts`。布局常量不搬进控制器：面板只交两样从布局算出来的面——
   * 屏幕上的顺序 `ordered`（只含展开的组）与"这一档要不要自动选中"（`canAutoSelect: split`）。
   */
  const controller = useTrashPanelController({
    deps,
    gate,
    query,
    ordered,
    canAutoSelect: split,
  })

  /**
   * 详情右缘的提问轨（ADR-0057）：整条会话的提问索引随详情首次读过线，当前那句与跳转住在
   * `use-prompt-rail.ts`。读数中 / 失败没有轨（那一帧没有正文）；保持期给上一条的轨但整条禁用
   * ——帧还是上一条的，跳转会把别人的游标补进来。
   */
  /** 详情栏的挂载判据与下面那段 JSX 同一支：宽档常驻；窄档要下钻且有选中条目才画。 */
  const detailPaneMounted = split || (controller.drilled && controller.selected !== null)
  const trashRail = useDetailRail({
    state: controller.detail,
    loadingOlder: controller.loadingOlder,
    olderFailure: controller.olderFailure,
    loadOlder: controller.loadOlder,
    scrollRef: detailScrollRef,
    paneMounted: detailPaneMounted,
  })

  /** 清单行的意图预取：hover / focus 150ms 后才读；只热身，不动选中与当前详情。 */
  const prefetchRow = useDelayedPrefetch(controller.prefetch)

  /**
   * 键盘导航（↑↓ 走环、Enter/Space、tab 落点、Esc 交还焦点）整块住在 `trash-nav.ts`。
   * 屏幕顺序与四个动作从这里进去；它不查行 DOM——`focusRow` 是面板交出去的那一动作，
   * 顶层浮层的让路判据由 `ui/top-layer.ts` 回答。
   */
  const nav = useTrashNav({
    ordered,
    idOf: entryIdOf,
    selectedId: controller.selectedId,
    selectMode,
    // 键盘契约只跟着当前档（同一条判据的为什么写在上方的 `archiveNav`）。
    drillEnabled: !split && tab === 'trash',
    drilled: controller.drilled,
    select: controller.select,
    toggleCheck,
    back: controller.back,
    focusRow,
    // Esc 只在面板里归清单：焦点在侧栏/宿主别的面板时，别把下钻退掉、更别把焦点拽进来。
    scope: rootRef,
  })

  // 恢复确认框要摆的条目由控制器从勾选与当前清单派生（顺序与"清单从上往下"一致）。
  const pending = controller.pending
  const restoreEntries = controller.pendingEntries

  // 头部合计要把组里孩子与盘上后代的字节都算上：它们不单独列行，只加父那一格就会少报（少报的就是那 74.6 MB 那一类）
  const totalBytes = (entries ?? []).reduce((sum, entry) => sum + entry.releaseBytes, 0)
  // 分桶在**每次渲染**时按当前时刻算，但本面板**没有计时器**：一条"59分钟"可以挂到下次重读、
  // 交互或失效通告为止（桶最细到分钟，而回收站不是盯着看的界面）。这是取舍，不是"不会停在旧读数"。
  const now = Date.now()
  const hasEntries = entries !== null && entries.length > 0
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
      onRetry={() => { void reload() }}
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
   *  （`trash-view.ts` 的 UNGROUPED_PROJECT_DIR）。 */
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
      onSelect: () => { void controller.select(entry, { drill: !split }) },
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
      listRef={listRef}
      dom={TRASH_LIST_DOM}
      gridLabel={t('detail.list.label')}
      refreshing={view.refreshing}
      notice={notice}
      groups={groups}
      selection={selection}
      nav={nav}
      prefetch={prefetchRow}
      activeId={controller.selectedId}
      rowOf={rowOf}
      t={t}
    />
  )

  /**
   * 孩子视图的开与回（ADR-0055 单级判据）住控制器的 `detailNav`：这里只转交，不再自己拼
   * openChild / parentContext 两个派生块——判据的第二个家会让视图与测试各自复述一遍语义。
   */
  const detailPane = (
    <DetailPane kind={TRASH_LIST_DOM.kind} scrollRef={detailScrollRef} rail={trashRail} t={t}>
      <TrashDetail
        state={controller.detail}
        busy={controller.busy}
        wide={split}
        onRetry={() => controller.retry()}
        onBack={() => controller.back()}
        detailNav={controller.detailNav}
        pager={{
          loadingOlder: controller.loadingOlder,
          olderFailure: controller.olderFailure,
          onLoadOlder: () => { void controller.loadOlder() },
          scrollRef: detailScrollRef,
        }}
        t={t}
      />
    </DetailPane>
  )

  /**
   * 视图开关常驻面板体顶端，不进滚动容器；宽度上限跟清单列走，视觉上仍属于清单。
   * 不设「刷新」按钮：每次读清单都会先对账（见 reconcile.ts），开面板、切回、重启都会同步。
   */
  const toolbar = (
    <div
      style={{ ...TOOLBAR, maxWidth: split ? resize.listWidth : 'none' }}
      data-dsh-session-delete="trash-toolbar"
    >
      <Button variant="ghost" size="sm" onClick={toggleAllGroups} disabled={!hasEntries}>
        {allCollapsed ? t('list.group.expandAll') : t('list.group.collapseAll')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        // 多选态永远留出口：清单被清空或读失败后 `hasEntries` 为假，退出按钮仍要能点。
        disabled={!hasEntries && !selectMode}
        aria-pressed={selectMode}
        onClick={() => {
          if (selectMode) exitSelect()
          else enterSelect()
        }}
      >
        {selectMode ? t('list.select.exit') : t('list.select.enter')}
      </Button>
    </div>
  )

  /** 归档档的两栏（宽档）/下钻（窄档）：详情视图是 `ArchiveDetail`（归档投影，子会话段与回收站共用）。 */
  const archiveDetailPane = (
    <DetailPane kind={ARCHIVE_LIST_DOM.kind} scrollRef={archiveScrollRef} rail={archiveRail} t={t}>
      <ArchiveDetail
        state={archiveController.detail}
        busy={archiveController.busy}
        wide={archiveSplit}
        detailNav={archiveDetailNav}
        onRetry={() => archiveController.retry()}
        onBack={() => archiveController.back()}
        pager={{
          loadingOlder: archiveController.loadingOlder,
          olderFailure: archiveController.olderFailure,
          onLoadOlder: () => { void archiveController.loadOlder() },
          scrollRef: archiveScrollRef,
        }}
        t={t}
      />
    </DetailPane>
  )
  const archiveList = (
    <ArchiveList
      query={archiveQuery}
      selection={archiveSelection}
      groups={archiveGroups}
      controller={archiveController}
      listRef={archiveListRef}
      nav={archiveNav}
      activeId={archiveActiveId}
      onCursor={setArchiveCursorId}
      onRetry={() => { void archiveQuery.reload() }}
      t={t}
    />
  )
  const archiveBody = archiveSplit ? (
    <>
      <ListPane style={{ ...LIST_COLUMN, flex: `0 0 ${resize.listWidth}px`, width: resize.listWidth }}>{archiveList}</ListPane>
      <span className="sd-width-handle" {...resize.handleProps} />
      {archiveDetailPane}
    </>
  ) : archiveController.selected !== null ? (
    archiveDetailPane
  ) : (
    <ListPane style={{ ...LIST_COLUMN, flex: '1 1 auto' }}>{archiveList}</ListPane>
  )

  return (
    <div
      ref={rootRef}
      data-dsh-session-delete="trash-panel"
      className={[resize.resizing ? 'sd-resizing' : '', wide ? '' : 'sd-narrow'].filter(Boolean).join(' ') || undefined}
      style={PAGE}
    >
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, paddingBottom: 14 }}>
        <div style={{ ...ELLIPSIS, minWidth: 0 }}>
          {/* 平级分段（H1 让位）：`回收站 N | 归档 M`——M 是惰性读数，归档档首次成功读取前不显示。 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* 拍板形态「回收站 N | 归档 M」：计数画进各自的分段按钮，并由 `aria-describedby`
                带进可及描述；组标签用中性名，不拿「回收站」统称两档。N 与 M 都是惰性读数
                （读到行才显示，不摆假 0）。 */}
            <span className="sd-seg sd-seg-lg" role="group" aria-label={t('panel.tabs.label')}>
              <button
                type="button"
                aria-label={t('trash.title')}
                {...(entries === null ? {} : { 'aria-describedby': `${tabCountId}-trash` })}
                aria-pressed={tab === 'trash'}
                onClick={() => { switchTab('trash') }}
              >
                {t('trash.title')}
                {entries === null ? null : (
                  <span
                    id={`${tabCountId}-trash`}
                    className="sd-seg-count"
                    data-dsh-session-delete="trash-count"
                    style={{ color: 'var(--sd-label-tertiary)' }}
                  >{entries.length}</span>
                )}
              </button>
              <button
                type="button"
                aria-label={t('archive.tab')}
                {...(archiveQuery.count === null ? {} : { 'aria-describedby': `${tabCountId}-archive` })}
                aria-pressed={tab === 'archive'}
                onClick={() => { switchTab('archive') }}
              >
                {t('archive.tab')}
                {archiveQuery.count === null ? null : (
                  <span
                    id={`${tabCountId}-archive`}
                    className="sd-seg-count"
                    data-dsh-session-delete="archive-count"
                    style={{ color: 'var(--sd-label-tertiary)' }}
                  >{archiveQuery.count}</span>
                )}
              </button>
            </span>
          </div>
          {tab === 'archive' ? (
            archiveSelection.selectMode ? (
              <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--sd-label-tertiary)' }}>
                {t('list.select.count', { count: archiveSelection.checkedIds.length })}
              </div>
            ) : archiveQuery.list.status === 'ready' ? (
              // 归档档副标题：不写「可释放」——解除归档不释放任何字节。
              <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--sd-label-tertiary)' }}>
                {t('archive.summary', { count: archiveQuery.list.rows.length, size: fileSizeText(archiveQuery.list.totalBytes) })}
                {archiveQuery.list.missingSizeCount > 0
                  ? t('archive.summary.missingSize', { count: archiveQuery.list.missingSizeCount })
                  : ''}
              </div>
            ) : null
          ) : selectMode ? (
            // 多选态下头部这一行说的是"勾了几条"——共可释放那句这时候不是主角，勾选数才是。
            <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--sd-label-tertiary)' }}>
              {t('list.select.count', { count: checkedIds.length })}
            </div>
          ) : hasEntries ? (
            <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--sd-label-tertiary)' }}>
              {t('trash.summary', { count: entries.length, size: fileSizeText(totalBytes) })}
            </div>
          ) : null}
        </div>
      </div>

      {/* 上一趟写动作的附件那半句（彻底删除 / 清空）：它**不是清单状态**，
          清单读不出来，所以摆在清单之外；文案与"什么时候该有这句"都归 `use-trash-query.ts`。 */}
      <Notice message={query.attachmentNotice} gapBelow />

      {tab === 'archive' ? (
        <div style={{ ...TOOLBAR, maxWidth: archiveSplit ? resize.listWidth : 'none' }}>
          <ArchiveToolbar selection={archiveSelection} groups={archiveGroups} t={t} />
        </div>
      ) : toolbar}

      <div style={BODY}>
        {tab === 'archive' ? archiveBody : split ? (
          <>
            <ListPane style={{ ...LIST_COLUMN, flex: `0 0 ${resize.listWidth}px`, width: resize.listWidth }}>{list}</ListPane>
            <span className="sd-width-handle" {...resize.handleProps} />
            {detailPane}
          </>
        ) : detailPaneMounted ? (
          detailPane
        ) : (
          // 单列时铺满 BODY：不给 flex，这一栏会按内容宽缩在行的左边（空态时约 390px）
          <ListPane style={{ ...LIST_COLUMN, flex: '1 1 auto' }}>{list}</ListPane>
        )}
      </div>

      {tab === 'archive' ? (
        <ArchiveFooter selection={archiveSelection} controller={archiveController} t={t} />
      ) : hasEntries ? (
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
            {/* 多选态下这里住两颗：**恢复 N 条**（描边款，无确认框的单行「恢复」的批量版——它带确认框，
                因为一批条目多、去向是各自的旧项目目录）与**彻底删除 N 条**（实心红）。危险那颗位置不换：
                docs/ui-spec.md「危险层级」那句"整页唯一一块实心红"靠"它永远是这一排的最后一个"来守。
                一条没勾时两颗都置灰，原因走 Tooltip——置灰的按钮自己不吃 hover，anchor 用一层 span，
                与 `delete-menu-item` 那处运行中置灰是同一个路子。 */}
            {selectMode ? (
              <>
                <Tooltip label={t('list.select.needOne')} side="top" portal disabled={checkedIds.length > 0}>
                  <span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={checkedIds.length === 0 || controller.busy}
                      onClick={() => controller.request({ kind: 'restore', ids: checkedIds })}
                    >
                      {t('trash.select.restore', { count: checkedIds.length })}
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip label={t('list.select.needOne')} side="top" portal disabled={checkedIds.length > 0}>
                  <span>
                    <Button
                      variant="primary"
                      size="sm"
                      style={BULK_DANGER}
                      icon={<IconTrashOutlineRegular size={13} />}
                      disabled={checkedIds.length === 0 || controller.busy}
                      onClick={() => controller.request({ kind: 'entries', ids: checkedIds })}
                    >
                      {t('trash.select.purge', { count: checkedIds.length })}
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
      ) : null}

      {pending === null ? null : (
        <TrashConfirm
          pending={pending}
          restoreEntries={restoreEntries}
          busy={controller.busy}
          t={t}
          onCancel={controller.cancelPending}
          onConfirmPurge={() => void controller.confirmPurge()}
          onConfirmRestore={(ids) => void controller.confirmApply('restore', ids)}
        />
      )}
    </div>
  )
}
