/**
 * 一档的**四格版面**：工具行 / 清单 / 详情 / 页脚。两档共用容器与分栏/下钻分支，视图件只交四个槽位与
 * 三格布局事实。版面判据住 `docs/ui-spec.md` §3：工具行住在 body **之外**（长清单滚到底也不滚走）；
 * 两栏成立时清单可拖定宽、详情吃余下，否则铺满。返回 **fragment**（不新增 DOM 容器）。
 */
import type { CSSProperties, ReactNode, RefObject } from 'react'
import type { Translate } from './copy.js'
import { DetailPane, ListPane } from './detail-pane.js'
import type { ListDom } from './session-list.js'
import type { ColumnResizeHandleProps } from './use-column-resize.js'
import type { DetailRail } from './use-detail-rail.js'

/** 两栏/下钻那一行（页脚之上，自收滚动）。 */
const BODY: CSSProperties = {
  display: 'flex',
  flex: '1 1 auto',
  gap: 16,
  minHeight: 0,
  minWidth: 0,
}

/**
 * 清单那一栏的**布局**（宽与 `flex` 由本组件按 `split` 现给）。两栏不成立时同一个配方直接铺满：
 * **不再限宽 760 居中**（那条只适用于正文，见 `DETAIL_TEXT_MAX_WIDTH`）；滚动配方住 `SCROLL_COLUMN`。
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
 * 视图开关（全部折叠 / 全部展开、多选）的容器：住面板体顶端、不进滚动容器，长清单滚到底也不滚走；
 * 宽度上限由 `split` 现给（两栏时跟清单列宽，单列时不设上限）。
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

/** 详情格的槽位：外壳由帧统一画，调用方只交外壳要的四格（档位、滚动容器、轨接线、正文）。 */
export interface PanelTabDetail {
  readonly kind: ListDom['kind']
  readonly scrollRef: RefObject<HTMLDivElement>
  readonly rail: DetailRail
  readonly children: ReactNode
}

/** 一档视图要的布局事实（几何住面板：断点与列宽拖拽不搬进档里；帧与视图只消费这两格）。 */
export interface PanelTabFrameLayout {
  readonly listWidth: number
  readonly handleProps: ColumnResizeHandleProps
}

export interface PanelTabFrameProps {
  /** 两栏成立（宽槽 + 清单有行）。 */
  readonly split: boolean
  /** 窄档下详情栏在 DOM 里（宽档恒真，本组件按 `split` 先用）。 */
  readonly detailMounted: boolean
  readonly listWidth: number
  readonly handleProps: ColumnResizeHandleProps
  /** 工具行的 DOM 身份（回收站档带 `trash-toolbar`，归档档的标识挂在它自己的工具行里）。 */
  readonly toolbarAttr?: string
  readonly toolbar: ReactNode
  readonly list: ReactNode
  readonly detail: PanelTabDetail
  readonly footer: ReactNode
  readonly t: Translate
}

/** 四格版面本体。`split` 时清单定宽 + 把手 + 详情；否则 `detailMounted` 时详情铺满，其余清单铺满。 */
export function PanelTabFrame({
  split,
  detailMounted,
  listWidth,
  handleProps,
  toolbarAttr,
  toolbar,
  list,
  detail,
  footer,
  t,
}: PanelTabFrameProps) {
  const detailNode = (
    <DetailPane kind={detail.kind} scrollRef={detail.scrollRef} rail={detail.rail} t={t}>
      {detail.children}
    </DetailPane>
  )
  return (
    <>
      <div
        style={{ ...TOOLBAR, maxWidth: split ? listWidth : 'none' }}
        {...(toolbarAttr === undefined ? {} : { 'data-dsh-session-delete': toolbarAttr })}
      >
        {toolbar}
      </div>
      <div style={BODY}>
        {split ? (
          <>
            <ListPane style={{ ...LIST_COLUMN, flex: `0 0 ${listWidth}px`, width: listWidth }}>{list}</ListPane>
            <span className="sd-width-handle" {...handleProps} />
            {detailNode}
          </>
        ) : detailMounted ? (
          detailNode
        ) : (
          // 单列时铺满 BODY：不给 flex，这一栏会按内容宽缩在行的左边（空态时约 390px）
          <ListPane style={{ ...LIST_COLUMN, flex: '1 1 auto' }}>{list}</ListPane>
        )}
      </div>
      {footer}
    </>
  )
}
