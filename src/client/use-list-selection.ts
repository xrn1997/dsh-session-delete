/**
 * 清单上的**选择面**（通用；回收站档与归档档各一台实例，互不干扰）：多选态、折叠起来的组、
 * 勾选集合，以及由它们派生的只读（`checkedRows` / `checkedIds` / `ordered` / 两种三态判定）。
 *
 * 两条承重规矩：
 * - **勾选顺序 = 清单从上往下**（组间按各组最新一条、组内按时间键），不是点击顺序：页脚两颗按
 *   **屏幕上的顺序**执行，否则"我先后点了哪几条"会改变一批动作的执行次序读感。折叠组里的行
 *   照样算在内——折叠只是不收它们进 DOM。
 * - **清单换了就把已经不存在的勾选剔掉**：别处（侧栏菜单、撤销提示）动过清单时，留着一条
 *   "看不见的勾选"会让页脚那颗带着它去删一条已经不在的东西。
 *
 * 行身份由 `idOf` 取（回收站 = 条目 id，归档 = 会话 id）；组装这件事不在这里：`groups` 由面板
 * （或它的取数一侧）算好再传进来，这个 module 只回答"哪些被勾了、屏幕上从上往下是哪些行"。
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
  /** 方法一律写成**属性声明**：面板会把它们摘下来传给导航/行组件，实现体也都不读 `this`。
   *  方法简写带来的隐式 `this: ListSelection<R>` 会让 `unbound-method` 误报，且会诱导调用点
   *  为了消警报去包箭头函数——那会让 `ListSelection` 每次渲染换新身份（见 ADR 外的回归教训）。 */
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
   * 折叠起来的组（键 = `projectDir`，也就是组头那一份身份）。**只活在面板这次打开**：
   * 这是一层视图偏好，为它开一条 Node 半的读写通道不值，而宿主 webview 的 origin 是不透明的
   * `null`（AGENTS.md 实测），`localStorage` 那条路在真机上大概率直接抛。
   */
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set())

  // 清单换了 ⇒ 勾着的那条可能已经不存在了（别处删了 / 恢复了 / 彻底删了）：剔掉它。
  // 清单未知（null）不算“没了”：这一拍只是不知道，勾选留着；读数回来 effect 会再跑一次，
  // 把真不在的行剔掉。与控制器“未知不算清场”同一条判据。
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
