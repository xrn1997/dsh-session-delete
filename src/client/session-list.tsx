/**
 * 清单的**分组列**（通用；回收站档与归档档各交一份行视图）：grid 容器与它的 ARIA、项目组的
 * 组头、一行的壳与三格，外加非就绪那一档的三张卡（加载 / 打断块 / 空态）。DOM 只在这里拼一次。
 *
 * 三条规矩：
 * - **只有真有行才挂 grid 与它的 aria**（ADR-0028）：失败 / 加载 / 空是一块普通内容，不是
 *   「空的 grid」；`aria-busy` 住在容器上（刷新中不是第四态，ADR-0048）。
 * - **底色与 `aria-selected` 不是同一判据**：底色说的是「详情正画着这一条」，多选态只把
 *   `aria-selected` 让给勾选集，底色不退场（一次只给一种动作语义，但两者不许互相冒充）。
 * - **行的 DOM id 在 DOM 这一侧编码**：id 里可能带空白/引号，直接拼进 HTML id 是非法值、
 *   `aria-activedescendant` 也会失配（issue #8 第 7 条）；原始身份留在 `dom.idAttr`，焦点交还
 *   按属性值比对（`useRowFocus`）。
 *
 * 视觉配方走 `trash-view.ts` 那三份（`CARD` / `ROW` / `ROW_SELECTED`）；行与组的悬停、动作列
 * 提亮、焦点环住在 `ui/layout.css` 的 `.sd-session-row` / `.sd-session-group-row` 上——两档吃同一份
 * 类名。`data-dsh-session-delete` 上的档位名（`trash-*` / `archive-*`）是「这一行属于哪一档」的
 * 身份，测试与 `useRowFocus` 靠它分辨在屏上的是哪一列。
 */
import { useCallback, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { CARD, ROW, ROW_SELECTED, type ProjectGroup } from './trash-view.js'
import type { ListSelection } from './use-list-selection.js'
import type { TrashNav } from './trash-nav.js'
import type { DelayedPrefetch } from './use-prefetch.js'
import { intentPrefetchHandlers } from './use-prefetch.js'
import { Button } from './ui/Button.js'
import { Checkbox } from './ui/Checkbox.js'
import {
  IconFolderCloseRegular,
  IconFolderOpenRegular,
  IconTriangleRightFillRegular,
  IconWarningOutlineRegular,
} from './ui/icons.js'
import { ELLIPSIS, TABULAR_NUMS } from './ui/recipe.js'
import type { Translate } from './copy.js'

const GROUP_ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, marginBottom: 4 }
const GROUP_CELL: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 auto', minWidth: 0 }
const GROUP_HEAD: CSSProperties = { background: 'none', border: 'none', padding: 0, font: 'inherit', textAlign: 'start', flex: '1 1 auto', gap: 6 }
const GROUP_TITLE: CSSProperties = { ...ELLIPSIS, minWidth: 0, flex: '1 1 auto', fontWeight: 500 }
const GROUP_COUNT: CSSProperties = { marginLeft: 'auto', flex: 'none', fontSize: 11, color: 'var(--sd-label-tertiary)' }
const ROW_CELL: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 1, flex: '1 1 auto', minWidth: 0 }
const ROW_TITLE: CSSProperties = { ...ELLIPSIS, fontSize: 14, lineHeight: '20px' }
const ROW_META: CSSProperties = {
  ...ELLIPSIS,
  ...TABULAR_NUMS,
  fontSize: 12,
  lineHeight: '16px',
  color: 'var(--dsw-alias-label-secondary)',
}
const CHECK_CELL: CSSProperties = { display: 'flex', alignItems: 'center' }
const ACTION_CELL: CSSProperties = { display: 'flex', gap: 2, flex: 'none' }
const LIST_COLUMN: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16, flex: '1 1 auto', minWidth: 0 }
const FAILURE_ICON: CSSProperties = {
  display: 'inline-flex',
  flex: 'none',
  paddingTop: 2,
  color: 'var(--dsw-alias-state-error-primary)',
}
const ROW_FAILURE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 6,
  paddingTop: 3,
  fontSize: 12,
  lineHeight: '16px',
  color: 'var(--dsw-alias-state-error-primary)',
}

/** 清单 grid 的列数：行恒为两格（常态：内容 + 动作；多选态：勾选框占内容前的一格、动作列退场）；
 *  组头只有一格，用 colspan 横跨整行——各行列数一致是 grid 的播报契约（ADR-0028）。两档同值。 */
const COLUMN_COUNT = 2

/** 一档清单进 DOM 的身份：档位名与行身份属性总是成对出现，两档各给一份常量（`useRowFocus` 也读它）。 */
export interface ListDom {
  /** 档位名前缀：拼出容器与行、组头的 `data-dsh-session-delete` 值，以及 DOM id 的前缀
   *  （`sd-trash-` / `sd-archive-`）。 */
  readonly kind: 'trash' | 'archive'
  /** 行的原始身份写进哪个 DOM 属性（回收站 = `data-entry-id`，归档 = `data-session-id`）：
   *  两档的身份本来就是两种东西（条目 id / 会话 id），不混成一个名字。 */
  readonly idAttr: string
}

/**
 * 把焦点交还给清单里的某一行（导航只拿这个动作，不认行选择器）。**按属性值自己比**，不把行 id
 * 拼进选择器：id 只挡路径分隔符（`trash/entry.ts`），另一半是宿主给的目录名，带引号时选择器直接抛。
 */
export function useRowFocus(
  listRef: RefObject<HTMLDivElement | null>,
  idAttr: string,
): (rowId: string) => void {
  return useCallback((rowId: string): void => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>(`[${idAttr}]`)
    if (rows === undefined) return
    for (const row of rows) {
      if (row.getAttribute(idAttr) === rowId) {
        row.focus()
        return
      }
    }
  }, [listRef, idAttr])
}

/**
 * 一行的可见读数：调用方只交文案、数字与那一排动作，格子、ARIA、底色与指针接线由这里拼。
 * 「勾上了没有」「是不是活动行」「tab 落点」不在这一份里——那是清单态，由本模块自己算。
 */
export interface SessionRowView {
  /** 行的原始身份（回收站 = 条目 id，归档 = 会话 id）：DOM 属性、`aria-selected` 判定都走它。 */
  readonly id: string
  readonly title: string
  /** 标题悬停的全文；`null` ⇒ 不挂 `title`（未命名行没有可展开的原文）。 */
  readonly titleTip: string | null
  /** 第二行那句读数（时间 · 大小 · 计数），已按档拼好。 */
  readonly meta: string
  readonly metaTip: string
  /** 多选态那颗勾选框的无障碍名（两档语序不同，各自给）。 */
  readonly checkLabel: string
  /** 这一行动作的失败原文；没有就传 `null`。 */
  readonly failure: string | null
  /** 行右那一排动作（多选态整排退场由本模块决定，调用方只管给）。 */
  readonly actions: ReactNode
  /** 点行 = 选中看详情；多选态由本模块先拦成「勾 / 取消这一条」。 */
  readonly onSelect: () => void
}

export interface SessionListProps<R> {
  listRef: RefObject<HTMLDivElement>
  /** 这一档进 DOM 的身份：档位名 + 行身份写进哪个属性（两档各给一份常量）。 */
  dom: ListDom
  /** 就绪时 grid 的可访问名（`detail.list.label` / `archive.tab`）。 */
  gridLabel: string
  /** 重读在飞 ⇒ 容器 `aria-busy`（不是第四态，ADR-0048）。 */
  refreshing: boolean
  /** 非「有行」那一档的整块内容（加载 / 失败 / 语料缺席 / 空态）：在场就不挂 grid。 */
  notice: ReactNode
  groups: readonly ProjectGroup<R>[]
  selection: ListSelection<R>
  /** 键盘契约与焦点意图（导航状态住面板）。 */
  nav: TrashNav
  /** hover / focus 的延时预取：四件事的接线只在这一处。 */
  prefetch: DelayedPrefetch<R>
  /** 当前活动行（选中行，或窄档方向键的光标）：底色与 `aria-activedescendant` 读它。 */
  activeId: string | null
  rowOf: (row: R) => SessionRowView
  t: Translate
}

/**
 * 分组列本体。`notice` 在场时容器仍渲染（`useRowFocus` 与滚动容器都要它），但 grid 的 role 与
 * 那一串 aria 一律不挂。
 */
export function SessionList<R>({
  listRef,
  dom,
  gridLabel,
  refreshing,
  notice,
  groups,
  selection,
  nav,
  prefetch,
  activeId,
  rowOf,
  t,
}: SessionListProps<R>) {
  // 档位名进 DOM 而不是进选择器字符串：行 id 里可能带空白/引号，拼进 `querySelector` 直接抛。
  // entry id 本身不许改形——它是回收站目录名，恢复要按它反推原目录名放回（`trash/entry.ts` 的往返契约）。
  const domIdOf = (id: string): string => `sd-${dom.kind}-${encodeURIComponent(id)}`
  const gridActive = notice === null && groups.length > 0
  return (
    <div
      ref={listRef}
      data-dsh-session-delete={`${dom.kind}-list`}
      aria-busy={refreshing || undefined}
      role={gridActive ? 'grid' : undefined}
      aria-label={gridActive ? gridLabel : undefined}
      aria-colcount={gridActive ? COLUMN_COUNT : undefined}
      aria-activedescendant={
        gridActive && nav.activeDescendantId !== null ? domIdOf(nav.activeDescendantId) : undefined
      }
      aria-multiselectable={gridActive && selection.selectMode ? true : undefined}
      tabIndex={-1}
      onKeyDown={nav.onListKeyDown}
      style={LIST_COLUMN}
    >
      {notice}
      {gridActive
        ? groups.map((group) => {
          const collapsed = selection.isCollapsed(group.projectDir)
          return (
            <section
              key={group.projectDir}
              role="rowgroup"
              data-dsh-session-delete={`${dom.kind}-group`}
              aria-label={group.label}
              // 行与行之间不再留缝：无边框的行靠自己的 padding 撑节奏，组头与首行那 4px 挂在
              // 组头行的 `marginBottom` 上，所以这里的 gap 只管行。
              style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}
            >
              <div
                role="row"
                data-dsh-session-delete={`${dom.kind}-group-row`}
                className="sd-session-group-row"
                style={GROUP_ROW}
              >
                {/* 组头一格收下勾选框与折叠钮：row 的直接子代必须是 cell（rowgroup > row > gridcell），
                    这一格 colspan 横跨整行，与条目行的格数对齐。 */}
                <div role="gridcell" aria-colspan={COLUMN_COUNT} style={GROUP_CELL}>
                  {selection.selectMode ? (
                    <Checkbox
                      checked={selection.groupFullyChecked(group)}
                      indeterminate={selection.groupPartiallyChecked(group)}
                      label={t('list.select.group', { project: group.label, count: group.rows.length })}
                      onChange={() => { selection.toggleGroupCheck(group) }}
                    />
                  ) : null}
                  {/* 折叠头抄宿主的 `DisclosureRow`：前导是官方文件夹图标（展开=开盖、收起=闭盒），
                      悬停时换成旋转的实心三角（条件住 `layout.css`）。组头本身不跟着收掉——收掉就没有
                      再点开的地方；计数留在组头上，折叠后「这个项目还有几条」仍然看得见。
                      两处与宿主那份的必要差别：① 可点部分是 `<button>`，UA 的 `text-align:center`
                      会渗进文字，显式压成 `start`；② 多选态的勾选框住在按钮**外面**（`<input>` 是
                      交互内容，不能嵌进 `<button>`）。 */}
                  <button
                    type="button"
                    className="sd-disclosure-row"
                    data-dsh-session-delete={`${dom.kind}-group-head`}
                    data-expandable=""
                    aria-expanded={!collapsed}
                    onClick={() => { selection.toggleGroup(group.projectDir) }}
                    style={GROUP_HEAD}
                  >
                    <span className="sd-disclosure-leading sd-group-folder" aria-hidden="true">
                      {collapsed ? <IconFolderCloseRegular size={14} /> : <IconFolderOpenRegular size={14} />}
                    </span>
                    <span className="sd-disclosure-leading sd-group-chevron" aria-hidden="true">
                      <span className={collapsed ? 'sd-group-arrow' : 'sd-group-arrow sd-group-arrow-open'}>
                        <IconTriangleRightFillRegular size={14} />
                      </span>
                    </span>
                    <span className="sd-disclosure-title" style={GROUP_TITLE} title={group.title}>
                      {group.label}
                    </span>
                    <span style={GROUP_COUNT}>{t('list.group.count', { count: group.rows.length })}</span>
                  </button>
                </div>
              </div>

              {collapsed ? null : group.rows.map((row) => {
                const view = rowOf(row)
                const checked = selection.checked.has(view.id)
                const selected = view.id === activeId
                return (
                  <div
                    key={view.id}
                    id={domIdOf(view.id)}
                    role="row"
                    aria-selected={selection.selectMode ? checked : selected}
                    tabIndex={view.id === nav.tabStopId ? 0 : -1}
                    data-dsh-session-delete={`${dom.kind}-row`}
                    className="sd-session-row"
                    {...{ [dom.idAttr]: view.id }}
                    style={selected ? ROW_SELECTED : ROW}
                    {...intentPrefetchHandlers(prefetch, row)}
                    onClick={() => {
                      // 多选态下点行说的是「勾上/取消这一条」，不再切换详情：两套语义同时活在一次点击里
                      // 一定有一套是错的（docs/ui-spec.md 状态④）。
                      if (selection.selectMode) {
                        selection.toggleCheck(view.id)
                        return
                      }
                      view.onSelect()
                    }}
                  >
                    {selection.selectMode ? (
                      <div role="gridcell" style={CHECK_CELL}>
                        <Checkbox
                          checked={checked}
                          label={view.checkLabel}
                          onChange={() => { selection.toggleCheck(view.id) }}
                        />
                      </div>
                    ) : null}
                    <div role="gridcell" style={ROW_CELL}>
                      <div style={ROW_TITLE} title={view.titleTip ?? undefined}>{view.title}</div>
                      <div style={ROW_META} title={view.metaTip}>{view.meta}</div>
                      {/* 动作与原因同一行（docs/ui-spec.md「失败落点」）：失败只坏这一行，不冻结清单。 */}
                      {view.failure === null ? null : (
                        <div role="status" style={ROW_FAILURE}>
                          <span style={{ display: 'inline-flex', flex: 'none' }} aria-hidden="true">
                            <IconWarningOutlineRegular size={13} />
                          </span>
                          <span>{view.failure}</span>
                        </div>
                      )}
                    </div>
                    {/* 两颗动作住在行右侧自己的格子里：常驻但默认低强调，悬停/聚焦/选中时提亮，
                        窄档常亮（触屏没有 hover）。多选态整排退场。 */}
                    {selection.selectMode ? null : (
                      <div role="gridcell" style={ACTION_CELL}>
                        {view.actions}
                      </div>
                    )}
                  </div>
                )
              })}
            </section>
          )
        })
        : null}
    </div>
  )
}

/** 加载那一拍：一句轻读数，不画骨架（清单还不知道有几条）。 */
export function ListLoading({ label }: { label: string }) {
  return <div style={{ padding: '20px 2px', fontSize: 12, color: 'var(--sd-label-tertiary)' }}>{label}</div>
}

export interface ListNoticeProps {
  /** 那句标题（`archive.readFailed` / `archive.corpusMissing.title` / `trash.readFailed`）。 */
  title: string
  /** 标题下面那句：失败原文或语料缺席的提示。 */
  detail: string
  /** 读数是失败来的 ⇒ 红色警告图标；只是「看不见」⇒ 低调灰（看不见 ≠ 没有，ADR-0019）。 */
  tone: 'error' | 'muted'
  onRetry: () => void
  retryLabel: string
}

/**
 * 打断块：图标 + 一句标题 + 原文/提示 + 重试。`CARD` 那一族是「要打断你视线的一块」，
 * 带底色与边框才对，与清单行不是一套长相。
 */
export function ListNotice({ title, detail, tone, onRetry, retryLabel }: ListNoticeProps) {
  return (
    <div role="status" style={{ ...CARD, alignItems: 'flex-start', gap: 12, padding: '14px' }}>
      <span
        style={tone === 'error'
          ? FAILURE_ICON
          : { display: 'inline-flex', flex: 'none', paddingTop: 2, color: 'var(--sd-label-tertiary)' }}
        aria-hidden="true"
      >
        <IconWarningOutlineRegular size={16} />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 auto', minWidth: 0 }}>
        <div style={{ fontSize: 13, lineHeight: '19px' }}>{title}</div>
        <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--sd-label-tertiary)', wordBreak: 'break-word' }}>
          {detail}
        </div>
      </div>
      <Button variant="outline" size="sm" style={{ flex: 'none' }} onClick={onRetry}>{retryLabel}</Button>
    </div>
  )
}

export interface ListEmptyProps {
  icon: ReactNode
  title: string
  hint: string
}

/** 空态：居中一块，图标 + 标题 + 一句提示。空清单是读数，不是失败。 */
export function ListEmpty({ icon, title, hint }: ListEmptyProps) {
  return (
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
        {icon}
      </span>
      <div style={{ fontSize: 14, color: 'var(--dsw-alias-label-secondary)' }}>{title}</div>
      <div style={{ maxWidth: 340, fontSize: 12, lineHeight: '18px', color: 'var(--sd-label-tertiary)' }}>{hint}</div>
    </div>
  )
}
