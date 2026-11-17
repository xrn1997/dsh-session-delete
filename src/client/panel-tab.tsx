/**
 * 一档的**四格版面**：工具行 / 清单 / 详情 / 页脚。两档共用这一份容器与分栏/下钻分支，视图件只交
 * 四个槽位（工具行内容、清单内容、详情槽、页脚内容）与三格布局事实（`split` / `detailMounted` /
 * 清单列宽）。之前这几行在 `trash-panel.tsx` 里按档各写一遍，容器与样式只差一个 data 属性。
 *
 * 版面的判据（为什么这么摆）仍住 `docs/ui-spec.md` §3：
 * - 工具行住在 body **之外**（长清单滚到底也不滚走），仍是面板根的直接子级；
 * - 两栏成立时清单是可拖的定宽、详情吃余下；否则详情铺满（下钻）或清单铺满单列；
 * - 单列时清单 `flex:'1 1 auto'` 铺满，不按内容宽缩在左；不再限宽 760 居中；
 * - 详情栏外壳（滚动容器 + 提问轨）由 `detail-pane.tsx` 的 `DetailPane` 画，槽位只交
 *   `{ kind, scrollRef, rail, children }`——两档不再各自拼一遍。
 *
 * 本组件返回 **fragment**（不新增 DOM 容器）：面板根的子级顺序与直接子级关系保持不变。
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
 * 清单那一栏的**布局**（宽与 `flex` 不在这里——由本组件按 `split` 现给：两栏时是可拖的定宽，
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
 * 视图开关（全部折叠 / 全部展开、多选）的容器。住在面板体顶端，不进滚动容器，长清单滚到底也不会滚走。
 * 宽度上限由 `split` 现给：两栏时跟清单列宽，单列时不设上限。
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
  /** 清单列宽（`useColumnResize` 的 `listWidth`）。 */
  readonly listWidth: number
  /** 两栏之间那根把手的 props（`useColumnResize` 的 `handleProps`）。 */
  readonly handleProps: ColumnResizeHandleProps
  /** 工具行的 DOM 身份（回收站档带 `trash-toolbar`，归档档的标识挂在它自己的工具行里）。 */
  readonly toolbarAttr?: string
  readonly toolbar: ReactNode
  readonly list: ReactNode
  readonly detail: PanelTabDetail
  readonly footer: ReactNode
  readonly t: Translate
}

/**
 * 四格版面本体。`split` 时清单定宽 + 把手 + 详情；否则 `detailMounted` 时详情铺满，其余清单铺满。
 * 页脚内容原样摆（两档各自的页脚件自己决定出不出现）。
 */
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
