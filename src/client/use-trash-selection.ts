/**
 * 清单上的**选择面**：多选态、折叠起来的组、勾选集合，
 * 以及由它们派生的三样只读（`checkedIds` / `ordered` / 两种三态判定）。
 *
 * 从 `trash-panel.tsx` 的函数体里整块搬出来的两条承重规矩：
 * - **勾选顺序 = 清单从上往下**（组间按各组最新一条、组内按删除时间），不是点击顺序：页脚两颗按
 *   **屏幕上的顺序**执行，否则"我先后点了哪几条"会改变一批动作的执行次序读感。折叠组里的条目
 *   照样算在内——折叠只是不收它们进 DOM。
 * - **清单换了就把已经不存在的勾选剔掉**：别处（侧栏菜单、撤销提示）动过回收站时，留着一条
 *   "看不见的勾选"会让页脚那颗带着它去删一条已经不在的东西。
 *
 * 组装这件事不在这里：`groups` 由面板（或它的取数一侧）算好再传进来，这个 module 只回答
 * "哪些被勾了、屏幕上从上到下是哪些行"。
 */
import { useEffect, useMemo, useState } from 'react'
import type { TrashEntryLike } from './remote.js'
import type { ProjectGroup } from './trash-view.js'

export interface TrashSelection {
  /** 多选模式：入口在工具排（「多选」/「退出多选」），模式内点行说的是"勾/取消"。 */
  readonly selectMode: boolean
  readonly checked: ReadonlySet<string>
  /** 按**清单从上往下**排好的勾选 id（页脚两颗与批量执行都读这一份）。 */
  readonly checkedIds: readonly string[]
  /** 键盘 ↑↓ 与下钻走这个顺序：**只含展开的组**（折叠的行不在 DOM 里，方向键别停过去）。 */
  readonly ordered: readonly TrashEntryLike[]
  readonly allCollapsed: boolean
  isCollapsed(projectDir: string): boolean
  enterSelect(): void
  exitSelect(): void
  toggleGroup(projectDir: string): void
  toggleAllGroups(): void
  toggleCheck(entryId: string): void
  /** 组头那颗：说的是"这个项目的全部会话"，折叠起来的条目也算。勾满再点 = 整组取消。 */
  toggleGroupCheck(group: { entries: readonly TrashEntryLike[] }): void
  groupFullyChecked(group: { entries: readonly TrashEntryLike[] }): boolean
  groupPartiallyChecked(group: { entries: readonly TrashEntryLike[] }): boolean
}

export function useTrashSelection({
  entries,
  groups,
}: {
  entries: readonly TrashEntryLike[] | null
  groups: readonly ProjectGroup[]
}): TrashSelection {
  const [selectMode, setSelectMode] = useState(false)
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
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
    if (entries === null) return
    setChecked((current) => {
      if (current.size === 0) return current
      const alive = new Set(entries.map((entry) => entry.id))
      const next = new Set([...current].filter((id) => alive.has(id)))
      return next.size === current.size ? current : next
    })
  }, [entries])

  const checkedIds = useMemo(
    () => groups.flatMap((group) => group.entries).filter((entry) => checked.has(entry.id)).map((entry) => entry.id),
    [groups, checked],
  )

  const isCollapsed = (projectDir: string): boolean => collapsedGroups.has(projectDir)
  const allCollapsed = groups.length > 0 && groups.every((group) => isCollapsed(group.projectDir))

  const ordered = useMemo(
    () => groups.filter((group) => !isCollapsed(group.projectDir)).flatMap((group) => group.entries as readonly TrashEntryLike[]),
    // `collapsedGroups` 是 `isCollapsed` 的闭包来源，必须进依赖
    [groups, collapsedGroups],
  )

  const groupFullyChecked = (group: { entries: readonly TrashEntryLike[] }): boolean =>
    group.entries.length > 0 && group.entries.every((entry) => checked.has(entry.id))
  const groupPartiallyChecked = (group: { entries: readonly TrashEntryLike[] }): boolean =>
    !groupFullyChecked(group) && group.entries.some((entry) => checked.has(entry.id))

  return {
    selectMode,
    checked,
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
    toggleCheck: (entryId) => {
      setChecked((current) => {
        const next = new Set(current)
        if (next.delete(entryId)) return next
        next.add(entryId)
        return next
      })
    },
    toggleGroupCheck: (group) => {
      const ids = group.entries.map((entry) => entry.id)
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
