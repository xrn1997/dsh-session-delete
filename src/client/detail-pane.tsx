/**
 * 两档共用的**栏外壳**：详情栏（滚动容器 + 贴右缘的提问轨）与清单栏（滚动容器）。
 * 回收站档与归档档的正文视图不同（`TrashDetail` / `ArchiveDetail`），但装它们的那两层壳、
 * 滚动条档位、正文收口宽度与轨的右缘是同一份几何——住这里，两档各交一个孩子与一台轨接线。
 *
 * 几何只有一个来源：右缘是正文列宽的函数（`DETAIL_TEXT_MAX_WIDTH`），轨宽住 `PromptRail` 的
 * `RAIL_WIDTH`、右槽从它派生。样式表里再抄一份列宽或轨宽就是第二份事实，迟早与内层 `maxWidth`
 * 漂开——轨会离开正文列、间距也不再是那一档（`tests/layout-css.test.ts` 钉住这条）。
 */
import type { CSSProperties, ReactNode, RefObject } from 'react'
import type { Translate } from './copy.js'
import { PromptRail, RAIL_WIDTH } from './prompt-rail.js'
import type { ListDom } from './session-list.js'
import type { DetailRail } from './use-detail-rail.js'

/** 详情正文的收口宽度：中央列再宽也不把文字拉成长线。 */
export const DETAIL_TEXT_MAX_WIDTH = 860

/** 提问轨占的右槽宽度：轨宽（`RAIL_WIDTH`，唯一来源在 `PromptRail`）+ 它与正文之间的 14。
 *  **无条件**留出来——轨在读数中 / 保持期会暂时不画，槽位跟着收放会让正文横向抖一下
 *  （ADR-0050 的版面稳定判据）。 */
const RAIL_GUTTER = RAIL_WIDTH + 14

/**
 * 提问轨的右缘：**与正文列右缘同一条线**。正文列左对齐、最宽 `DETAIL_TEXT_MAX_WIDTH`，所以
 * 面板比它宽时 `100% - 列宽` 正好落在列右缘；面板更窄时退到离边 14px（给滚动条让位）。
 */
const RAIL_RIGHT = `max(14px, calc(100% - ${DETAIL_TEXT_MAX_WIDTH}px))`

const DETAIL_INNER: CSSProperties = {
  minWidth: 0,
  maxWidth: DETAIL_TEXT_MAX_WIDTH,
  width: '100%',
  paddingRight: RAIL_GUTTER,
  boxSizing: 'border-box',
}

/** 详情栏的外壳：滚动容器 + 贴右缘的提问轨（ADR-0057）。轨是绝对定位的兄弟节点，不占正文布局。 */
const DETAIL_PANE: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flex: '1 1 auto',
  minWidth: 0,
  minHeight: 0,
}

/**
 * 两栏共用的滚动配方。**滚动条不用注入任何 CSS 就已经是宿主的**：宿主在 `body` 上给出一组量
 * （`--dsh-scrollbar-width:5px` 等），再用全局 `::-webkit-scrollbar*` 规则消费它们 ⇒ 一个
 * `overflow:auto` 拿到的就是 5px 圆角 token 条。这里把 thumb 提到 `-l2` 那一档，与宿主自己的
 * 长滚动面同档——清单栏与详情栏同一份，按栏各抄一份就是漂移的入口。
 */
const SCROLL_COLUMN = {
  overflow: 'auto',
  paddingRight: 10,
  paddingBottom: 8,
  // 自定义属性不在 csstype 的属性表里，走断言（与 `BULK_DANGER` 同一处写法）
  '--dsh-scrollbar-thumb': 'var(--sd-scrollbar-bg-l2)',
  '--dsh-scrollbar-thumb-hover': 'var(--sd-scrollbar-hover-l2)',
} as CSSProperties

const DETAIL_COLUMN: CSSProperties = {
  display: 'flex',
  flex: '1 1 auto',
  minWidth: 0,
  minHeight: 0,
  ...SCROLL_COLUMN,
}

export interface DetailPaneProps {
  /** 这一档的 DOM 身份：详情容器标成 `<kind>-detail`。 */
  kind: ListDom['kind']
  /** 详情栏的滚动容器：分页 prepend 后按高度差补偿滚动位置，提问轨也按它算当前那句。 */
  scrollRef: RefObject<HTMLDivElement>
  /** 这一档的提问轨接线（`useDetailRail`）：没有轨那一拍只画正文。 */
  rail: DetailRail
  /** 正文视图（`TrashDetail` / `ArchiveDetail`）。 */
  children: ReactNode
  t: Translate
}

export function DetailPane({ kind, scrollRef, rail, children, t }: DetailPaneProps) {
  return (
    <div style={DETAIL_PANE}>
      <div
        ref={scrollRef}
        className="sd-stable-scroll"
        data-dsh-session-delete={`${kind}-detail`}
        style={DETAIL_COLUMN}
      >
        <div style={DETAIL_INNER}>{children}</div>
      </div>
      {rail.hasRail ? (
        <PromptRail
          prompts={rail.prompts}
          loadedIds={rail.loadedIds}
          activeId={rail.handle.activeId}
          busyId={rail.handle.busyId}
          notice={rail.handle.notice}
          onJump={rail.handle.jump}
          right={RAIL_RIGHT}
          disabled={rail.disabled}
          t={t}
        />
      ) : null}
    </div>
  )
}

/** 清单那一栏的滚动外壳：宽与 `flex` 由调用点现给（两栏时是可拖的定宽，单列时铺满），
 *  滚动配方与详情栏同一份（`SCROLL_COLUMN`）。两档都无条件预留滚动条槽（`layout.css` 的 `.sd-stable-scroll`）。 */
export function ListPane({ style, children }: { style: CSSProperties; children: ReactNode }) {
  return <div className="sd-stable-scroll" style={{ ...SCROLL_COLUMN, ...style }}>{children}</div>
}