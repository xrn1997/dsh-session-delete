/**
 * 回收站中央面板（main 槽占用者）：页面骨架、两档平级分段、布局几何，以及两档的互斥。
 * 一档的装配线住 `use-panel-tab.ts`，四格版面住 `panel-tab.tsx`，视图件与 adapter 住 `trash-tab.tsx`
 * / `archive-pane.tsx`。两个 `usePanelTab` 无条件调用：两档常驻挂载、同一次挂载内切档保留已读缓存。
 */
import { useId, useRef, useState, type CSSProperties } from 'react'
import { useBusyGate } from './busy-gate.js'
import { zhTranslate, type Translate } from './copy.js'
import { Notice } from './notice.js'
import { ArchiveTabView, useArchiveTab } from './archive-pane.js'
import { TrashConfirm } from './trash-confirm.js'
import { TrashTabView, useTrashTab } from './trash-tab.js'
import { useColumnResize } from './use-column-resize.js'
import { usePanelWidth } from './use-panel-width.js'
import type { PanelTabDeps } from './use-panel-tab.js'
import { ELLIPSIS } from './ui/recipe.js'
import { fileSizeText } from './ui/format.js'

/** 页面骨架：撑满中央列，自收滚动。`boxSizing:'border-box'` 不是装饰：宿主没有全局 border-box reset，
 *  默认 content-box ⇒ `height:100%` 再加 20px 上边距会溢出，把页脚推到中央列底边之外。 */
const PANEL_PAGE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  height: '100%',
  minWidth: 0,
  padding: '20px 24px 12px',
}

/** 面板的依赖面：两个读 + 一段 `apply` + 清空 + 归档两读；**没有第二条路**（N=1 也走 `apply`）。
 *  无主子会话检查是维护卡的手动动作（ADR-0021），面板不自动扫。 */
export type TrashPanelDeps = PanelTabDeps

export interface TrashPanelProps {
  deps: TrashPanelDeps
  /** 文案（缺省 = 内置 zh，见 `copy.ts`：这不是"忘了传"，而是"这次没有 locale 服务"）。 */
  t?: Translate
}

/** 断点：盒子宽 ≥ 此值走两栏，窄于此走下钻。两栏要成立，详情列至少 399 + 两道 gap 32 + 把手 10 +
 *  页内边距 48 = 489；900 这一档清单为 411，刚好守住两边可读下限。改数字前同步 DETAIL_RESERVE 与 usePanelWidth。 */
const SPLIT_MIN_WIDTH = 900
/** 左栏默认宽：为「行内有动作」设计——两颗 28px 图标按钮加间距与行内边距约 80px，剩下给标题与元信息。 */
const LIST_COLUMN_DEFAULT = 420
/** 左栏下限 330：再窄「删除于 … · 224KB」那行就会被省略号截断；按钮 flex:none，不参与这个下限。 */
const LIST_COLUMN_MIN = 330
/** 拖到最右时给详情留的地板：正文 399 + 两道 gap 32 + 把手 10 + 页内边距 48 = 489。 */
const DETAIL_RESERVE = 489
/** 分隔线键盘一格的像素数（←→）。 */
const HANDLE_STEP = 20

export function TrashPanel({ deps, t = zhTranslate }: TrashPanelProps) {
  /** 面板唯一的一枚全局闸（写动作在飞时按住一排按钮）：本体住 `busy-gate.ts`，查询侧的写动作也吃它。 */
  const gate = useBusyGate()
  /** 分段按钮的计数说明 id：可见计数已画在按钮里，`aria-describedby` 带进可及描述，可及名仍保持纯档名。 */
  const tabCountId = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const width = usePanelWidth(rootRef)
  const wide = width >= SPLIT_MIN_WIDTH
  /** 两栏之间那根可拖的把手（窄档不渲染它，但 hook 照样得在——不能在条件里调）。 */
  const resize = useColumnResize({
    panelWidth: width,
    defaultValue: LIST_COLUMN_DEFAULT,
    min: LIST_COLUMN_MIN,
    reserve: DETAIL_RESERVE,
    step: HANDLE_STEP,
    label: t('list.divider.label'),
  })

  // 两档查询/选择面/控制器/详情读路常驻挂载（切档保留已读缓存）；`active` 门控读取，不活动只置脏。
  const [tab, setTab] = useState<'trash' | 'archive'>('trash')
  const trashTab = useTrashTab({
    deps,
    gate,
    t,
    wide,
    active: tab === 'trash',
    scope: rootRef,
  })
  const archiveTab = useArchiveTab({
    deps,
    gate,
    t,
    wide,
    active: tab === 'archive',
    scope: rootRef,
  })

  // 头部两档共用的读数：回收站侧行集来自本档查询的视图面；归档侧是惰性计数与四态清单。
  const entries = trashTab.view.rows
  const hasEntries = entries !== null && entries.length > 0
  // 头部合计要把组里孩子与盘上后代的字节都算上：它们不单独列行，只加父那一格就会少报。
  const totalBytes = (entries ?? []).reduce((sum, entry) => sum + entry.releaseBytes, 0)
  const archiveList = archiveTab.query.list

  /** 切档 = 两台选择面**双向清空**（跨档不带名单）；折叠集天然按档独立（各是各的实例）。 */
  const switchTab = (next: 'trash' | 'archive'): void => {
    if (tab === next) return
    trashTab.selection.exitSelect()
    archiveTab.selection.exitSelect()
    setTab(next)
  }

  /** 视图件要的布局事实在面板现拼（几何只有一个来源：断点与列宽都在本文件）。 */
  const layout = { listWidth: resize.listWidth, handleProps: resize.handleProps }

  return (
    <div
      ref={rootRef}
      data-dsh-session-delete="trash-panel"
      className={[resize.resizing ? 'sd-resizing' : '', wide ? '' : 'sd-narrow'].filter(Boolean).join(' ') || undefined}
      style={PANEL_PAGE}
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
                {...(archiveTab.query.count === null ? {} : { 'aria-describedby': `${tabCountId}-archive` })}
                aria-pressed={tab === 'archive'}
                onClick={() => { switchTab('archive') }}
              >
                {t('archive.tab')}
                {archiveTab.query.count === null ? null : (
                  <span
                    id={`${tabCountId}-archive`}
                    className="sd-seg-count"
                    data-dsh-session-delete="archive-count"
                    style={{ color: 'var(--sd-label-tertiary)' }}
                  >{archiveTab.query.count}</span>
                )}
              </button>
            </span>
          </div>
          {tab === 'archive' ? (
            archiveTab.selection.selectMode ? (
              <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--sd-label-tertiary)' }}>
                {t('list.select.count', { count: archiveTab.selection.checkedIds.length })}
              </div>
            ) : archiveList.status === 'ready' ? (
              // 归档档副标题：不写「可释放」——解除归档不释放任何字节。
              <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--sd-label-tertiary)' }}>
                {t('archive.summary', { count: archiveList.rows.length, size: fileSizeText(archiveList.totalBytes) })}
                {archiveList.missingSizeCount > 0
                  ? t('archive.summary.missingSize', { count: archiveList.missingSizeCount })
                  : ''}
              </div>
            ) : null
          ) : trashTab.selection.selectMode ? (
            // 多选态下头部这一行说的是"勾了几条"——共可释放那句这时候不是主角，勾选数才是。
            <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--sd-label-tertiary)' }}>
              {t('list.select.count', { count: trashTab.selection.checkedIds.length })}
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
      <Notice message={trashTab.query.attachmentNotice} gapBelow />

      {tab === 'archive'
        ? <ArchiveTabView tab={archiveTab} layout={layout} t={t} />
        : <TrashTabView tab={trashTab} layout={layout} t={t} />}

      {trashTab.controller.pending === null ? null : (
        <TrashConfirm
          pending={trashTab.controller.pending}
          restoreEntries={trashTab.controller.pendingEntries}
          busy={trashTab.controller.busy}
          t={t}
          onCancel={trashTab.controller.cancelPending}
          onConfirmPurge={() => void trashTab.controller.confirmPurge()}
          onConfirmRestore={(ids) => void trashTab.controller.confirmApply('restore', ids)}
        />
      )}
    </div>
  )
}
