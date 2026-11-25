/**
 * 清单的分组列（回收站/归档共用，各交一份行视图）：grid 容器与 ARIA、组头、行壳与三格、非就绪的三张卡。
 *
 * 只有真有行才挂 grid 与它的 aria（ADR-0028）：失败/加载/空是一块普通内容；`aria-busy` 在容器上（刷新不是第四态，ADR-0048）。
 * 底色（详情正画这一条）与 `aria-selected`（勾选集）是两套判据，互不冒充；行 id 在这侧编码，原始身份留 `dom.idAttr`。
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

/** 清单 grid 的列数：行恒为两格，组头用 colspan 横跨；各行列数一致是 grid 的播报契约（ADR-0028）。 */
const COLUMN_COUNT = 2

/** 一档清单进 DOM 的身份：档位名与行身份属性成对出现（`useRowFocus` 也读它）。 */
export interface ListDom {
  /** 档位名前缀：拼容器/行/组头的 `data-dsh-session-delete` 与 DOM id（`sd-trash-` / `sd-archive-`）。 */
  readonly kind: 'trash' | 'archive'
  /** 行原始身份写进哪个属性（条目 id / 会话 id 本是两种东西，不混名）。 */
  readonly idAttr: string
}

/** 把焦点交还清单某一行：按属性值自己比，不把行 id 拼进选择器——宿主目录名带引号时选择器直接抛。 */
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

/** 一行的可见读数；勾选 / 活动行 / tab 落点是清单态，由本模块自己算。 */
export interface SessionRowView {
  /** 行的原始身份（回收站 = 条目 id，归档 = 会话 id）：DOM 属性、`aria-selected` 判定都走它。 */
  readonly id: string
  readonly title: string
  /** 标题悬停的全文；`null` ⇒ 不挂 `title`（未命名行没有可展开的原文）。 */
  readonly titleTip: string | null
  readonly meta: string
  readonly metaTip: string
  readonly checkLabel: string
  readonly failure: string | null
  readonly actions: ReactNode
  /** 点行 = 选中看详情；多选态由本模块先拦成「勾 / 取消这一条」。 */
  readonly onSelect: () => void
}

export interface SessionListProps<R> {
  listRef: RefObject<HTMLDivElement>
  dom: ListDom
  gridLabel: string
  /** 重读在飞 ⇒ 容器 `aria-busy`（不是第四态，ADR-0048）。 */
  refreshing: boolean
  /** 非「有行」那一档的整块内容（加载 / 失败 / 语料缺席 / 空态）：在场就不挂 grid。 */
  notice: ReactNode
  groups: readonly ProjectGroup<R>[]
  selection: ListSelection<R>
  nav: TrashNav
  /** hover / focus 的延时预取：四件事的接线只在这一处。 */
  prefetch: DelayedPrefetch<R>
  /** 当前活动行（选中行，或窄档方向键的光标）：底色与 `aria-activedescendant` 读它。 */
  activeId: string | null
  rowOf: (row: R) => SessionRowView
  t: Translate
}

/** 分组列本体：`notice` 在场时容器仍渲染（焦点与滚动要它），但 grid 的 role 与 aria 不挂。 */
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
  // 档位名进 DOM、行 id 只编码——原始 entry id 是回收站目录名，不许改形（`trash/entry.ts` 往返契约）。
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
              // 行之间不留缝：无边框行靠 padding 撑节奏，组头与首行的 4px 挂在组头行上，这里的 gap 只管行。
              style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}
            >
              <div
                role="row"
                data-dsh-session-delete={`${dom.kind}-group-row`}
                className="sd-session-group-row"
                style={GROUP_ROW}
              >
                {/* 组头一格收勾选框与折叠钮：row 的直接子代必须是 cell，colspan 与条目行对齐。 */}
                <div role="gridcell" aria-colspan={COLUMN_COUNT} style={GROUP_CELL}>
                  {selection.selectMode ? (
                    <Checkbox
                      checked={selection.groupFullyChecked(group)}
                      indeterminate={selection.groupPartiallyChecked(group)}
                      label={t('list.select.group', { project: group.label, count: group.rows.length })}
                      onChange={() => { selection.toggleGroupCheck(group) }}
                    />
                  ) : null}
                  {/* 折叠头抄宿主 `DisclosureRow`（文件夹图标 + 悬停三角，条件住 `layout.css`）：差异① 可点部分是 `<button>`，显式 `text-align:start`；
                      ② 多选勾选框住在按钮外（`<input>` 不能嵌进 `<button>`）。组头不跟着收掉，计数仍可见。 */}
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
                // Shift 只在 click 上有、onChange 带不出来 ⇒ click 记一笔、change 分派。
                // map 里不能用 hook，用每行一个闭包标志（与 BatchPickCheckbox 的 ref 同一判据）。
                let rowShift = false
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
                    onMouseDown={(event) => {
                      // 浏览器原生 Shift+点选字发生在 mousedown；多选态拦住它以免拉出大面积文字选中。
                      if (selection.selectMode && event.shiftKey) event.preventDefault()
                    }}
                    onClick={(event) => {
                      // 多选态下点行是「勾上/取消这一条」，不再切详情（`docs/ui-spec.md` §2 ④）。
                      // Shift+点 = 范围勾选（锚点→本行整段）。
                      if (selection.selectMode) {
                        if (event.shiftKey) {
                          selection.rangeCheck(view.id)
                          return
                        }
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
                          onClick={(event) => { rowShift = event.shiftKey }}
                          onChange={() => {
                            if (rowShift) {
                              rowShift = false
                              selection.rangeCheck(view.id)
                              return
                            }
                            selection.toggleCheck(view.id)
                          }}
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
                    {/* 动作住右侧自己的格子：常驻低强调，悬停/聚焦/选中提亮，窄档常亮；多选态整排退场。 */}
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
  title: string
  /** 标题下面那句：失败原文或语料缺席的提示。 */
  detail: string
  /** 读数是失败来的 ⇒ 红色警告图标；只是「看不见」⇒ 低调灰（看不见 ≠ 没有，ADR-0019）。 */
  tone: 'error' | 'muted'
  onRetry: () => void
  retryLabel: string
}

/** 打断块：图标 + 标题 + 原文/提示 + 重试；`CARD` 那一族带底色边框，与清单行不是一套长相。 */
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
