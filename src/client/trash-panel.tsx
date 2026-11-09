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
  useMemo,
  useRef,
} from 'react'
import { TRASH_DIR_LABEL, type TrashDetailBlockWire, type TrashDetailPromptWire } from '../shared/wire.js'
import { useBusyGate } from './busy-gate.js'
import { AttachmentNotice } from './attachment-view.js'
import { absoluteText, splitOn, unitWord, zhTranslate, type Translate } from './copy.js'
import { type SessionDeleteRemote } from './remote.js'
import { TrashDetail } from './trash-detail.js'
import { useColumnResize } from './use-column-resize.js'
import { usePanelWidth } from './use-panel-width.js'
import { useTrashNav } from './trash-nav.js'
import { Button } from './ui/Button.js'
import { Checkbox } from './ui/Checkbox.js'
import { fileSizeText, relativeTime } from './ui/format.js'
import {
  IconFolderCloseRegular,
  IconFolderOpenRegular,
  IconRestoreOutlineRegular,
  IconTrashOutlineRegular,
  IconTriangleRightFillRegular,
  IconWarningOutlineRegular,
} from './ui/icons.js'
import { ELLIPSIS, TABULAR_NUMS } from './ui/recipe.js'
import { Tooltip } from './ui/Tooltip.js'
import { TrashConfirm } from './trash-confirm.js'
import { useTrashPanelController } from './use-trash-panel-controller.js'
import { intentPrefetchHandlers, useDelayedPrefetch } from './use-prefetch.js'
import { listView, useTrashQuery } from './use-trash-query.js'
import { useTrashSelection } from './use-trash-selection.js'
import { PromptRail, RAIL_WIDTH } from './prompt-rail.js'
import { usePromptRail } from './use-prompt-rail.js'
import { BULK_DANGER, CARD, ROW, ROW_SELECTED, groupByProject } from './trash-view.js'

/** 面板的依赖面：两个读（`list` / `detail`）+ **一段 `apply`** + 清空。
 *  **没有第二条路**：「恢复一条」也走 `apply`（N=1），面板不再同时吃
 *  `applyOutcomes` 与一个便捷的 `restore`。无主子会话的检查/清理不在这里——它是插件设置页
 *  维护卡的手动动作（`use-maintenance.ts`），面板一次都不自动扫（ADR-0021）。 */
export type TrashPanelDeps = Pick<
  SessionDeleteRemote,
  'list' | 'detail' | 'applyOutcomes' | 'emptyTrash'
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
/** 详情正文的收口宽度：中央列再宽也不把文字拉成长线。 */
const DETAIL_TEXT_MAX_WIDTH = 860
/** 清单 grid 的列数：条目行恒为两格（常态：内容 + 动作；多选态：勾选框占内容前的一格、动作列退场）；
 *  组头只有一格，用 colspan 横跨整行——各行列数一致是 grid 的播报契约（ADR-0028）。 */
const LIST_COLUMN_COUNT = 2

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
 * 清单那一栏的**外壳**（宽与 `flex` 不在这里——由调用点在渲染时现给：两栏时是可拖的定宽，
 * 单列时 `flex:'1 1 auto'` 铺满）。两栏不成立时（窄档，或宽档但清单为空/读不到）同一个配方
 * 直接铺满：**不再限宽 760 居中**，那条关心得只适用于正文（见 `DETAIL_TEXT_MAX_WIDTH`）。
 *
 * **滚动条不用注入任何 CSS 就已经是宿主的**：宿主在 `body` 上给出一组量（`--dsh-scrollbar-width:5px`
 * 等），再用全局 `::-webkit-scrollbar*` 规则消费它们（asar @45064180 起）⇒ 这里一个 `overflow:auto`
 * 拿到的就是 5px 圆角 token 条。下面把 thumb 提到 `-l2` 那一档，与宿主自己的长滚动面同档。
 */
const LIST_COLUMN = {
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  gap: 7,
  minWidth: 0,
  minHeight: 0,
  overflow: 'auto',
  paddingRight: 10,
  paddingBottom: 8,
  // 自定义属性不在 csstype 的属性表里，走断言（与 `BULK_DANGER` 同一处写法）
  '--dsh-scrollbar-thumb': 'var(--sd-scrollbar-bg-l2)',
  '--dsh-scrollbar-thumb-hover': 'var(--sd-scrollbar-hover-l2)',
} as CSSProperties

/** 详情那一栏的外壳（滚动归它自己，正文限宽在内部）。 */
const DETAIL_COLUMN = {
  display: 'flex',
  flex: '1 1 auto',
  minWidth: 0,
  minHeight: 0,
  overflow: 'auto',
  paddingRight: 10,
  paddingBottom: 8,
  '--dsh-scrollbar-thumb': 'var(--sd-scrollbar-bg-l2)',
  '--dsh-scrollbar-thumb-hover': 'var(--sd-scrollbar-hover-l2)',
} as CSSProperties

/** 提问轨占的右槽宽度：轨宽（`RAIL_WIDTH`，唯一来源在 `PromptRail`）+ 它与正文之间的 14。
 *  **无条件**留出来——轨在读数中 / 保持期会暂时不画，槽位跟着收放会让正文横向抖一下
 *  （ADR-0050 的版面稳定判据）。 */
const RAIL_GUTTER = RAIL_WIDTH + 14

/**
 * 提问轨的右缘：**与正文列右缘同一条线**。正文列左对齐、最宽 `DETAIL_TEXT_MAX_WIDTH`，所以
 * 面板比它宽时 `100% - 列宽` 正好落在列右缘；面板更窄时退到离边 14px（给滚动条让位）。
 * 列宽只有 `DETAIL_TEXT_MAX_WIDTH` 一个来源，行内交给 `PromptRail`；样式表若另写一个常量，
 * 就与 `DETAIL_INNER` 的 `maxWidth` 成了两份 860，轨会离开正文列、间距也不再是 `RAIL_GUTTER` 那一档。
 */
const RAIL_RIGHT = `max(14px, calc(100% - ${DETAIL_TEXT_MAX_WIDTH}px))`

const DETAIL_INNER: CSSProperties = {
  minWidth: 0,
  maxWidth: DETAIL_TEXT_MAX_WIDTH,
  width: '100%',
  paddingRight: RAIL_GUTTER,
  boxSizing: 'border-box',
}

/**
 * 详情栏的外壳：滚动容器 + 贴右缘的提问轨（ADR-0057）。轨是绝对定位的兄弟节点，不占正文布局。
 */
const DETAIL_PANE: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flex: '1 1 auto',
  minWidth: 0,
  minHeight: 0,
}

/** 没有主体时给 hook 的稳定空数组：每次新建数组会让轨的 effect 每帧重跑。 */
const EMPTY_BLOCKS: readonly TrashDetailBlockWire[] = []
const EMPTY_PROMPTS: readonly TrashDetailPromptWire[] = []

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

/**
 * 行的 DOM id。entry id 里可能带空白/引号（目录名只挡路径分隔符），直接拼进 HTML id 是非法值、
 * `aria-activedescendant` 也会失配——所以**在 DOM 这一侧编码**（issue #8 第 7 条）：`data-entry-id`
 * 仍留原始 id，焦点交还按属性值比对不受影响。entry id 本身不许改形：它是回收站目录名，
 * 恢复要按它反推原目录名放回（`trash/entry.ts` 的往返契约）。
 */
function domRowId(entryId: string): string {
  return `sd-trash-${encodeURIComponent(entryId)}`
}

/* 「这一次彻底删除会释放多少」**不在这里算**：它是存储侧的事实（本行 + 跟着进来的孩子
 * + 盘上还留着的后代，彻底删除删的正是这三样），由 Node 半算一次、`releaseBytes` 过线。浏览器半照单念——
 * 头部合计与单条确认卡片都读它，于是同一屏不可能有两套口径，也就不再有"两行都算到同一个后代"那种偏差。 */

export function TrashPanel({ deps, t = zhTranslate }: TrashPanelProps) {
  /** 面板唯一的一枚全局闸（写动作在飞时按住一排按钮）：本体住 `busy-gate.ts`，查询侧的写动作也吃它。 */
  const gate = useBusyGate()

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
    label: t('trash.divider.label'),
  })

  const groups = useMemo(() => groupByProject(entries ?? [], t), [entries, t])
  // 选择面（多选 / 折叠 / 勾选与它们派生的三样只读）整块住在 `use-trash-selection.ts`。
  const selection = useTrashSelection({ entries, groups })
  const {
    selectMode, checked, checkedIds, ordered, allCollapsed,
    isCollapsed, enterSelect, exitSelect, toggleGroup, toggleAllGroups,
    toggleCheck, toggleGroupCheck, groupFullyChecked, groupPartiallyChecked,
  } = selection

  /** 行的 DOM 查询留给面板；导航只拿"把焦点还给哪一行"这个动作（不认行选择器）。
   *  按属性值自己比，不把 `entryId` 拼进选择器：id 只挡路径分隔符（`trash/entry.ts`），另一半是
   *  宿主给的目录名，带引号时选择器直接抛。 */
  const focusRow = useCallback((entryId: string): void => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-entry-id]')
    if (rows === undefined) return
    for (const row of rows) {
      if (row.getAttribute('data-entry-id') === entryId) {
        row.focus()
        return
      }
    }
  }, [])

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
  const railState = controller.detail.kind === 'ready' || controller.detail.kind === 'holding'
    ? controller.detail
    : null
  const railDetail = railState?.detail ?? null
  const railDisabled = railState?.kind === 'holding'
  const railPrompts = railDetail?.prompts ?? EMPTY_PROMPTS
  const hasRail = railPrompts.length > 0
  /** 详情栏的挂载判据与下面那段 JSX 同一支：宽档常驻；窄档要下钻且有选中条目才画。 */
  const detailPaneMounted = split || (controller.drilled && controller.selected !== null)
  const promptRail = usePromptRail({
    prompts: hasRail ? railPrompts : null,
    blocks: railDetail?.blocks ?? EMPTY_BLOCKS,
    olderCursor: railDetail?.olderCursor ?? null,
    loadingOlder: controller.loadingOlder,
    olderFailure: controller.olderFailure,
    onLoadOlder: () => { void controller.loadOlder() },
    scrollRef: detailScrollRef,
    paneMounted: detailPaneMounted,
    disabled: railDisabled,
  })
  /** 已加载的块 id：轨上未加载的刻度更短更淡，预览卡里也明说「会先补页」。 */
  const loadedPromptIds = useMemo(
    () => new Set((railDetail?.blocks ?? EMPTY_BLOCKS).map((block) => block.id)),
    [railDetail],
  )

  /** 清单行的意图预取：hover / focus 150ms 后才读；只热身，不动选中与当前详情。 */
  const prefetchRow = useDelayedPrefetch(controller.prefetch)

  /**
   * 键盘导航（↑↓ 走环、Enter/Space、tab 落点、Esc 交还焦点）整块住在 `trash-nav.ts`。
   * 屏幕顺序与四个动作从这里进去；它不查行 DOM——`focusRow` 是面板交出去的那一动作，
   * 顶层浮层的让路判据由 `ui/top-layer.ts` 回答。
   */
  const nav = useTrashNav({
    ordered,
    selectedId: controller.selectedId,
    selectMode,
    drillEnabled: !split,
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
   * 清单容器（roving tabindex 的唯一 tab 巢）。`flex:'1 1 auto'` 撑起空态居中的父链；
   * `min-height:auto` 让长清单保持内容高，滚动交给外层。
   *
   * ARIA 模式是 **grid** 而不是 listbox（为什么：裁决见 ADR-0028）。只有真有行时才挂 grid
   * 与它的 aria：失败/加载/空态是一块普通内容，不是「空的 grid」，generic div 不背 aria 名字。
   */
  const gridActive = view.failure === null && hasEntries
  const list = (
    <div
      ref={listRef}
      data-dsh-session-delete="trash-list"
      aria-busy={view.refreshing || undefined}
      role={gridActive ? 'grid' : undefined}
      aria-label={gridActive ? t('detail.list.label') : undefined}
      aria-colcount={gridActive ? LIST_COLUMN_COUNT : undefined}
      aria-activedescendant={
        gridActive && nav.activeDescendantId !== null ? domRowId(nav.activeDescendantId) : undefined
      }
      aria-multiselectable={gridActive && selectMode ? true : undefined}
      tabIndex={-1}
      onKeyDown={nav.onListKeyDown}
      style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: '1 1 auto', minWidth: 0 }}
    >
      {view.failure !== null ? (
        <div role="status" style={{ ...CARD, alignItems: 'flex-start', gap: 12, padding: '14px' }}>
          <span
            style={{ display: 'inline-flex', flex: 'none', paddingTop: 2, color: 'var(--dsw-alias-state-error-primary)' }}
            aria-hidden="true"
          >
            <IconWarningOutlineRegular size={16} />
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 auto', minWidth: 0 }}>
            <div style={{ fontSize: 13, lineHeight: '19px' }}>{t('trash.readFailed')}</div>
            <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--sd-label-tertiary)', wordBreak: 'break-word' }}>
              {view.failure}
            </div>
          </div>
          <Button variant="outline" size="sm" style={{ flex: 'none' }} onClick={() => void reload()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : view.loading ? (
        <div style={{ padding: '20px 2px', fontSize: 12, color: 'var(--sd-label-tertiary)' }}>{t('trash.loading')}</div>
      ) : view.empty ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            flex: '1 1 auto',
            padding: '24px',
            textAlign: 'center',
          }}
        >
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 46,
              height: 46,
              flex: 'none',
              borderRadius: 999,
              background: 'var(--dsw-alias-bg-layer-2)',
              color: 'var(--sd-label-tertiary)',
            }}
            aria-hidden="true"
          >
            <IconTrashOutlineRegular size={20} />
          </span>
          <div style={{ fontSize: 14, color: 'var(--dsw-alias-label-secondary)' }}>{t('trash.empty.title')}</div>
          <div style={{ maxWidth: 340, fontSize: 12, lineHeight: '18px', color: 'var(--sd-label-tertiary)' }}>
            {t('trash.empty.hint')}
          </div>
        </div>
      ) : (
        groups.map((group) => (
          <section
            key={group.projectDir}
            role="rowgroup"
            data-dsh-session-delete="trash-group"
            aria-label={group.label}
            // 行与行之间不再留缝：无边框的行靠自己的 padding 撑节奏，行间距一加就散成一叠碎片。
            // 组头与首行之间那 4px 挂在组头行上（`marginBottom`），所以这里的 gap 只管行。
            style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}
          >
            {/* 折叠头抄宿主的 `DisclosureRow`（`ui.css` 里那一段）：前导是官方文件夹图标
                （展开=开盖、收起=闭盒），`aria-expanded` 给读屏；鼠标经过时换成旋转的实心三角
                （条件住 `layout.css`）。组头本身**不跟着收掉**——收掉就没有再点开的地方了。
                计数留在组头上，所以折叠之后"这个项目还有几条"仍然看得见。
                两处与宿主那份的必要差别：① 我们这一行的可点部分是 `<button>`，UA 的
                `text-align:center` 会渗进里面的文字（真机上项目名整个居中就是这个），显式压成 `start`；
                ② 多选态下勾选框住在按钮**外面**——`<input>` 是交互内容，不能嵌进 `<button>`。 */}
            <div
              role="row"
              data-dsh-session-delete="trash-group-row"
              style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, marginBottom: 4 }}
            >
              {/* 组头一格收下勾选框与折叠钮：row 的直接子代必须是 cell（rowgroup > row > gridcell）。
                  组头行也是 row，这一格 colspan 横跨整行，与条目行的两格对齐列数。 */}
              <div
                role="gridcell"
                aria-colspan={LIST_COLUMN_COUNT}
                style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 auto', minWidth: 0 }}
              >
                {selectMode ? (
                  <Checkbox
                    checked={groupFullyChecked(group)}
                    indeterminate={groupPartiallyChecked(group)}
                    label={t('trash.select.group', { project: group.label, count: group.entries.length })}
                    onChange={() => { toggleGroupCheck(group) }}
                  />
                ) : null}
                <button
                  type="button"
                  className="sd-disclosure-row"
                  data-dsh-session-delete="trash-group-head"
                  data-expandable=""
                  aria-expanded={!isCollapsed(group.projectDir)}
                  onClick={() => { toggleGroup(group.projectDir) }}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    font: 'inherit',
                    textAlign: 'start',
                    flex: '1 1 auto',
                    gap: 6,
                  }}
                >
                  <span className="sd-disclosure-leading sd-group-folder" aria-hidden="true">
                    {isCollapsed(group.projectDir)
                      ? <IconFolderCloseRegular size={14} />
                      : <IconFolderOpenRegular size={14} />}
                  </span>
                  {/* 悬停时文件夹换成实心三角并旋转 90°（与宿主工作区行同法，住 `ui/layout.css`）；
                      触屏没有 hover，保持文件夹本身表达开合。 */}
                  <span className="sd-disclosure-leading sd-group-chevron" aria-hidden="true">
                    <span className={isCollapsed(group.projectDir) ? 'sd-group-arrow' : 'sd-group-arrow sd-group-arrow-open'}>
                      <IconTriangleRightFillRegular size={14} />
                    </span>
                  </span>
                  <span
                    className="sd-disclosure-title"
                    style={{ ...ELLIPSIS, minWidth: 0, flex: '1 1 auto', fontWeight: 500 }}
                    title={group.title}
                  >
                    {group.label}
                  </span>
                  <span style={{ marginLeft: 'auto', flex: 'none', fontSize: 11, color: 'var(--sd-label-tertiary)' }}>
                    {t('trash.group.count', { count: group.entries.length })}
                  </span>
                </button>
              </div>
            </div>

            {isCollapsed(group.projectDir) ? null : group.entries.map((entry) => {
              const isSelected = entry.id === controller.selectedId
              const isChecked = checked.has(entry.id)
              const title = entry.title === '' ? t('common.untitled') : entry.title
              const kids = entry.subagentCount ?? 0
              const stranded = entry.strandedSubagents ?? 0
              return (
                <div
                  key={entry.id}
                  id={domRowId(entry.id)}
                  role="row"
                  aria-selected={selectMode ? isChecked : isSelected}
                  tabIndex={entry.id === nav.tabStopId ? 0 : -1}
                  data-dsh-session-delete="trash-row"
                  data-entry-id={entry.id}
                  style={isSelected ? ROW_SELECTED : ROW}
                  {...intentPrefetchHandlers(prefetchRow, entry)}
                  onClick={() => {
                    // 多选态下点行说的是"勾上/取消这一条"，不再切换详情：两套语义同时活在一次点击里
                    // 一定有一套是错的（docs/ui-spec.md 状态④）。
                    if (selectMode) {
                      toggleCheck(entry.id)
                      return
                    }
                    void controller.select(entry, { drill: !split })
                  }}
                >
                  {/* 勾选框在**标题左侧**（照用户给的参考图那一版布局）。两颗动作按钮这时整排退场：
                      一次只给一种动作语义，不会在批量确认框旁边再手滑点到单条「彻底删除」。
                      勾选框住进自己的 gridcell：row 的直接子代必须是 cell，交互内容在 cell 里才够得着。 */}
                  {selectMode ? (
                    <div role="gridcell" style={{ display: 'flex', alignItems: 'center' }}>
                      <Checkbox
                        checked={isChecked}
                        label={t('trash.select.row', { title })}
                        onChange={() => { toggleCheck(entry.id) }}
                      />
                    </div>
                  ) : null}
                  <div role="gridcell" style={{ display: 'flex', flexDirection: 'column', gap: 1, flex: '1 1 auto', minWidth: 0 }}>
                    <div style={{ ...ELLIPSIS, fontSize: 14, lineHeight: '20px' }} title={entry.title === '' ? undefined : entry.title}>
                      {title}
                    </div>
                    <div
                      style={{
                        ...ELLIPSIS,
                        ...TABULAR_NUMS,
                        fontSize: 12,
                        lineHeight: '16px',
                        color: 'var(--dsw-alias-label-secondary)',
                      }}
                      title={absoluteText(entry.deletedAt)}
                    >
                      {[
                        deletedAgo(entry.deletedAt, now, t),
                        fileSizeText(entry.sizeBytes),
                        // 两个数各说各的：进了回收站的说"含"，还在盘上的说"还剩"——混成一个就是假话
                        kids > 0 ? t('trash.row.subagents', { n: kids }) : '',
                        stranded > 0 ? t('trash.row.strandedSubagents', { n: stranded }) : '',
                      ].filter(Boolean).join(' · ')}
                    </div>
                    {/* 原工作区已被删掉的条目直接归入「未分组」组，行上不再挂一句提示：
                        分组本身就是去向的说明（`trash-view.ts` 的 UNGROUPED_PROJECT_DIR）。 */}
                    {/* 恢复/彻底删除的失败原文留在这一行：动作与原因同一行（docs/ui-spec.md「失败落点」）。 */}
                    {controller.actionFailure[entry.id] === undefined ? null : (
                      <div
                        role="status"
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 6,
                          paddingTop: 3,
                          fontSize: 12,
                          lineHeight: '16px',
                          color: 'var(--dsw-alias-state-error-primary)',
                        }}
                      >
                        <span style={{ display: 'inline-flex', flex: 'none' }} aria-hidden="true">
                          <IconWarningOutlineRegular size={13} />
                        </span>
                        <span>{controller.actionFailure[entry.id]}</span>
                      </div>
                    )}
                  </div>
                  {/* 两颗动作按钮住在行右侧，常驻但默认低强调（图标按钮的几何与悬停住在
                      `ui/layout.css`）；悬停/选中/聚焦时提亮，窄档常亮——触屏没有 hover，
                      点行即下钻，不能靠"先选中才出场"拿到动作。多选态整排退场。 */}
                  {selectMode ? null : (
                    <div role="gridcell" style={{ display: 'flex', gap: 2, flex: 'none' }}>
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
                    </div>
                  )}
                </div>
              )
            })}
          </section>
        ))
      )}
    </div>
  )

  /**
   * 孩子视图的开与回（ADR-0055 单级判据）住控制器的 `detailNav`：这里只转交，不再自己拼
   * openChild / parentContext 两个派生块——判据的第二个家会让视图与测试各自复述一遍语义。
   */
  const detailPane = (
    <div style={DETAIL_PANE}>
      <div ref={detailScrollRef} className="sd-stable-scroll" data-dsh-session-delete="trash-detail" style={DETAIL_COLUMN}>
        <div style={DETAIL_INNER}>
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
        </div>
      </div>
      {hasRail ? (
        <PromptRail
          prompts={railPrompts}
          loadedIds={loadedPromptIds}
          activeId={promptRail.activeId}
          busyId={promptRail.busyId}
          notice={promptRail.notice}
          onJump={promptRail.jump}
          right={RAIL_RIGHT}
          disabled={railDisabled}
          t={t}
        />
      ) : null}
    </div>
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
        {allCollapsed ? t('trash.toolbar.expandAll') : t('trash.toolbar.collapseAll')}
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
        {selectMode ? t('trash.toolbar.selectExit') : t('trash.toolbar.select')}
      </Button>
    </div>
  )

  /** 清单列：宽档定宽（可拖）、窄档铺满；两档都无条件预留滚动条槽（`layout.css` 的 `.sd-stable-scroll`）。 */
  const listPane = (style: CSSProperties) => <div className="sd-stable-scroll" style={style}>{list}</div>

  return (
    <div
      ref={rootRef}
      data-dsh-session-delete="trash-panel"
      className={[resize.resizing ? 'sd-resizing' : '', wide ? '' : 'sd-narrow'].filter(Boolean).join(' ') || undefined}
      style={PAGE}
    >
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, paddingBottom: 14 }}>
        <div style={{ ...ELLIPSIS, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600, lineHeight: '24px' }}>{t('trash.title')}</div>
          {selectMode ? (
            // 多选态下头部这一行说的是"勾了几条"——共可释放那句这时候不是主角，勾选数才是。
            <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--sd-label-tertiary)' }}>
              {t('trash.select.count', { count: checkedIds.length })}
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
      <AttachmentNotice message={query.attachmentNotice} />

      {toolbar}

      <div style={BODY}>
        {split ? (
          <>
            {listPane({ ...LIST_COLUMN, flex: `0 0 ${resize.listWidth}px`, width: resize.listWidth })}
            <span className="sd-width-handle" {...resize.handleProps} />
            {detailPane}
          </>
        ) : detailPaneMounted ? (
          detailPane
        ) : (
          // 单列时铺满 BODY：不给 flex，这一栏会按内容宽缩在行的左边（空态时约 390px）
          listPane({ ...LIST_COLUMN, flex: '1 1 auto' })
        )}
      </div>

      {hasEntries ? (
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
                <Tooltip label={t('trash.select.needOne')} side="top" portal disabled={checkedIds.length > 0}>
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
                <Tooltip label={t('trash.select.needOne')} side="top" portal disabled={checkedIds.length > 0}>
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
