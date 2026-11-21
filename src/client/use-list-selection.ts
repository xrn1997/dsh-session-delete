/**
 * 清单上的**选择面**（通用；两档各一台实例）：多选态、折叠组、勾选集合与派生只读。
 * 两条承重规矩：**勾选顺序 = 清单从上往下**（不是点击顺序，折叠组里的行也算）；**清单换了就把已不
 * 存在的勾选剔掉**（清单未知 ≠ 没了）。行身份由 `idOf` 取，`groups` 由面板算好传进来。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLatest } from './store.js'
import type { ProjectGroup } from './trash-view.js'

export interface ListSelection<R> {
  /** 多选模式：入口在工具排（「多选」/「退出多选」），模式内点行说的是"勾/取消"。 */
  readonly selectMode: boolean
  readonly checked: ReadonlySet<string>
  /** 勾中的**行本身**，按清单从上往下排（页脚要标题时用这一份，别再从 groups 重算一遍）。 */
  readonly checkedRows: readonly R[]
  /** 按**清单从上往下**排好的勾选 id（页脚两颗与批量执行都读这一份）。 */
  readonly checkedIds: readonly string[]
  /** 键盘 ↑↓ 与下钻走这个顺序：**只含展开的组**（折叠的行不在 DOM 里，方向键别停过去）。 */
  readonly ordered: readonly R[]
  readonly allCollapsed: boolean
  /** 方法一律写成**属性声明**：面板会把它们摘下来传给导航/行组件，实现体也都不读 `this`——方法简写会被
   *  `unbound-method` 误报。 */
  isCollapsed: (projectDir: string) => boolean
  enterSelect: () => void
  exitSelect: () => void
  toggleGroup: (projectDir: string) => void
  toggleAllGroups: () => void
  toggleCheck: (id: string) => void
  /** 组头那颗：说的是"这个项目的全部会话"，折叠起来的行也算。勾满再点 = 整组取消。 */
  toggleGroupCheck: (group: { rows: readonly R[] }) => void
  groupFullyChecked: (group: { rows: readonly R[] }) => boolean
  groupPartiallyChecked: (group: { rows: readonly R[] }) => boolean
}

export function useListSelection<R>({
  rows,
  groups,
  idOf,
}: {
  rows: readonly R[] | null
  groups: readonly ProjectGroup<R>[]
  idOf: (row: R) => string
}): ListSelection<R> {
  const [selectMode, setSelectMode] = useState(false)
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  /** `idOf` 允许调用方内联传箭头（逐渲染换新引用）：经 `useLatest` 归一成恒稳回调（判据住 `store.ts`）。 */
  const idOfLatest = useLatest(idOf)
  const keyOf = useCallback((row: R): string => idOfLatest.current(row), [idOfLatest])
  /**
   * 折叠起来的组（键 = `projectDir`）；只活在面板这次打开——视图偏好，而宿主 webview 的 origin 是
   * 不透明的 `null`，`localStorage` 那条路在真机上大概率直接抛。
   */
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set())

  // 清单换了 ⇒ 勾着的那条可能已不存在（别处删了 / 恢复了）：剔掉它。清单未知（null）不算“没了”：
  // 这一拍只是不知道，勾选留着；读数回来 effect 会再跑一次，把真不在的行剔掉。
  useEffect(() => {
    if (rows === null) return
    setChecked((current) => {
      if (current.size === 0) return current
      const alive = new Set(rows.map(keyOf))
      const next = new Set([...current].filter((id) => alive.has(id)))
      return next.size === current.size ? current : next
    })
  }, [rows, keyOf])

  const checkedRows = useMemo(
    () => groups.flatMap((group) => group.rows).filter((row) => checked.has(keyOf(row))),
    [groups, checked, keyOf],
  )
  const checkedIds = useMemo(() => checkedRows.map(keyOf), [checkedRows, keyOf])

  const isCollapsed = (projectDir: string): boolean => collapsedGroups.has(projectDir)
  const allCollapsed = groups.length > 0 && groups.every((group) => isCollapsed(group.projectDir))

  const ordered = useMemo(
    () => groups.filter((group) => !isCollapsed(group.projectDir)).flatMap((group) => group.rows),
    // `collapsedGroups` 是 `isCollapsed` 的闭包来源，必须进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 漏的 `isCollapsed` 读数就是数组里已有的 `collapsedGroups`（它是闭包来源），再加一层反而制造第二判据。
    [groups, collapsedGroups],
  )

  const groupFullyChecked = (group: { rows: readonly R[] }): boolean =>
    group.rows.length > 0 && group.rows.every((row) => checked.has(keyOf(row)))
  const groupPartiallyChecked = (group: { rows: readonly R[] }): boolean =>
    !groupFullyChecked(group) && group.rows.some((row) => checked.has(keyOf(row)))

  return {
    selectMode,
    checked,
    checkedRows,
    checkedIds,
    ordered,
    allCollapsed,
    isCollapsed,
    enterSelect: () => { setSelectMode(true) },
    /** 退出模式并清空名单：多选态和选中集是同一次交互的两半，退出后不该留下看不见的名单。 */
    exitSelect: () => {
      setSelectMode(false)
      setChecked(new Set())
    },
    toggleGroup: (projectDir) => {
      setCollapsedGroups((current) => {
        const next = new Set(current)
        if (next.delete(projectDir)) return next
        next.add(projectDir)
        return next
      })
    },
    toggleAllGroups: () => {
      setCollapsedGroups(allCollapsed ? new Set() : new Set(groups.map((group) => group.projectDir)))
    },
    toggleCheck: (id) => {
      setChecked((current) => {
        const next = new Set(current)
        if (next.delete(id)) return next
        next.add(id)
        return next
      })
    },
    toggleGroupCheck: (group) => {
      const ids = group.rows.map(keyOf)
      const clear = groupFullyChecked(group)
      setChecked((current) => {
        const next = new Set(current)
        for (const id of ids) {
          if (clear) next.delete(id)
          else next.add(id)
        }
        return next
      })
    },
    groupFullyChecked,
    groupPartiallyChecked,
  }
}
