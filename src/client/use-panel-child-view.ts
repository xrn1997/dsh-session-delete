/**
 * 两档共用的**孩子视图收口**：状态归各档（ADR-0060 第 4 条），这里只收三处派生——收尾顺序、
 * 返回的两程、导航面的一次装配。
 */
import { useCallback, useMemo } from 'react'
import type { DetailNav } from './session-detail.js'
import { useLatest } from './store.js'
import { panelDetailNav } from './use-panel-tab.js'

export interface PanelChildViewInput<C, R> {
  readonly childView: C | null
  readonly setChildView: (next: C | null) => void
  readonly selected: R | null
  readonly parentTitle: (row: R) => string
  readonly openChild: (childId: string) => void | Promise<void>
  readonly prefetchChild: (childId: string) => void
  /** 收孩子视图时要作的废：回收站丢分页失败，归档丢孩子账本。 */
  readonly onClose?: (child: C) => void
  /** 窄档退下钻（回收站清 drilled；归档交选中面 drop）。 */
  readonly backWithoutChild: () => void
}

export interface PanelChildView {
  /** 收孩子视图并跑本档收尾（分页/账本作废）。属性声明：调用点会把它摘下来转交。 */
  readonly closeChild: () => void
  readonly back: () => void
  readonly detailNav: DetailNav
}

export function usePanelChildView<C, R>(input: PanelChildViewInput<C, R>): PanelChildView {
  const {
    childView, setChildView, selected,
    parentTitle, openChild, prefetchChild,
  } = input
  // 收尾与退下钻逐渲染换新身份（调用点传内联箭头）：经 `useLatest` 归一，`back` 才不会每渲染换新——
  // 它进 `useTrashNav` 的 Esc 监听依赖，身份一换监听就整条重挂。
  const onClose = useLatest(input.onClose)
  const backWithoutChild = useLatest(input.backWithoutChild)

  /** 先跑收尾再落状态：setState 的 updater 必须纯，副作用不能塞进去。 */
  const closeChild = useCallback((): void => {
    if (childView !== null) onClose.current?.(childView)
    setChildView(null)
  }, [childView, onClose, setChildView])

  const back = useCallback((): void => {
    if (childView !== null) closeChild()
    else backWithoutChild.current()
  }, [childView, closeChild, backWithoutChild])

  const detailNav = useMemo<DetailNav>(() => panelDetailNav({
    childViewOpen: childView !== null,
    selected,
    parentTitle,
    openChild,
    prefetchChild,
    closeChild,
  }), [childView, selected, parentTitle, openChild, prefetchChild, closeChild])

  return { closeChild, back, detailNav }
}
