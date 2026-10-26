/**
 * 清单上的选择面（`use-trash-selection.ts`）。
 *
 * 三条承重规矩此前只能"整块渲染面板 + 点 DOM"才够得着：
 * ① **勾选顺序 = 清单从上往下**（不是点击顺序）；
 * ② **折叠起来的条目照样算在勾选里**，但它们不进键盘走的 `ordered`；
 * ③ **清单换了就把已经不在的勾选剔掉**（否则页脚那颗会带着"看不见的勾选"去删一条已经不在的东西）。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useTrashSelection } from '../../src/client/use-trash-selection.js'
import { groupByProject } from '../../src/client/trash-view.js'
import { zhTranslate } from '../../src/client/copy.js'
import type { TrashEntryLike } from '../../src/client/remote.js'

const row = (id: string, projectDir: string, deletedAt: number): TrashEntryLike => ({
  id, sessionId: id, projectDir, workspaceId: 'ws', wasArchived: false,
  deletedAt, title: id, sizeBytes: 10, releaseBytes: 10,
})

/** 两个项目：A 里 a1/a2（a2 更新）、B 里 b1。组间按各组最新一条倒序 ⇒ A 在前。 */
const rows: TrashEntryLike[] = [row('a1', '--A--', 1), row('a2', '--A--', 3), row('b1', '--B--', 2)]

function mount() {
  const groups = groupByProject(rows, zhTranslate)
  return renderHook(() => useTrashSelection({ entries: rows, groups }))
}

describe('选择面 · 勾选', () => {
  it('checkedIds 走清单从上往下，不是点击顺序', () => {
    const { result } = mount()
    act(() => { result.current.toggleCheck('b1') })
    act(() => { result.current.toggleCheck('a1') })
    // 屏幕顺序是 A(a2,a1 组内删除时间倒序) → B(b1)，所以 a1 在 b1 之前
    expect(result.current.checkedIds).toEqual(['a1', 'b1'])
  })

  it('勾选是翻转：再点一次就取消', () => {
    const { result } = mount()
    act(() => { result.current.toggleCheck('a1') })
    act(() => { result.current.toggleCheck('a1') })
    expect(result.current.checkedIds).toEqual([])
  })

  it('退出多选把名单一起清空（模式与名单是同一次交互的两半）', () => {
    const { result } = mount()
    act(() => { result.current.enterSelect() })
    act(() => { result.current.toggleCheck('a1') })
    act(() => { result.current.exitSelect() })
    expect(result.current.selectMode).toBe(false)
    expect(result.current.checkedIds).toEqual([])
  })
})

describe('选择面 · 组头的三态', () => {
  it('半选 / 全选 / 勾满再点是整组取消', () => {
    const { result } = mount()
    const groupA = { entries: rows.filter((entry) => entry.projectDir === '--A--') }
    act(() => { result.current.toggleCheck('a1') })
    expect(result.current.groupPartiallyChecked(groupA)).toBe(true)
    expect(result.current.groupFullyChecked(groupA)).toBe(false)
    act(() => { result.current.toggleGroupCheck(groupA) })
    expect(result.current.groupFullyChecked(groupA)).toBe(true)
    act(() => { result.current.toggleGroupCheck(groupA) })
    expect(result.current.groupFullyChecked(groupA)).toBe(false)
  })
})

describe('选择面 · 折叠', () => {
  it('折叠的组不进 ordered（键盘别停在看不见的行上），但勾选照旧算在组里', () => {
    const { result } = mount()
    act(() => { result.current.toggleGroup('--A--') })
    expect(result.current.ordered.map((entry) => entry.id)).toEqual(['b1'])
    act(() => { result.current.toggleCheck('a1') })
    expect(result.current.checkedIds).toEqual(['a1'])
    expect(result.current.allCollapsed).toBe(false)
  })

  it('一键全折 / 全展', () => {
    const { result } = mount()
    act(() => { result.current.toggleAllGroups() })
    expect(result.current.allCollapsed).toBe(true)
    expect(result.current.ordered).toEqual([])
    act(() => { result.current.toggleAllGroups() })
    expect(result.current.allCollapsed).toBe(false)
    expect(result.current.ordered).toHaveLength(3)
  })
})

describe('选择面 · 清单换了', () => {
  it('已经不在清单里的勾选被剔掉（别处删掉了那一条）', () => {
    const groups = groupByProject(rows, zhTranslate)
    const { result, rerender } = renderHook(
      ({ entries }) => useTrashSelection({ entries, groups: groupByProject(entries, zhTranslate) }),
      { initialProps: { entries: rows } },
    )
    act(() => { result.current.toggleCheck('a1') })
    act(() => { result.current.toggleCheck('b1') })
    rerender({ entries: rows.filter((entry) => entry.id !== 'a1') })
    expect(result.current.checkedIds).toEqual(['b1'])
    void groups
  })

  it('清单未知（null）⇒ 勾选保留：未知只是不知道，不拿它当"没了"；读数回来再剔掉真不在的', () => {
    const { result, rerender } = renderHook(
      ({ entries }: { entries: readonly TrashEntryLike[] | null }) =>
        useTrashSelection({ entries, groups: groupByProject(entries ?? [], zhTranslate) }),
      { initialProps: { entries: rows as readonly TrashEntryLike[] | null } },
    )
    act(() => { result.current.toggleCheck('a1') })
    act(() => { result.current.toggleCheck('b1') })
    rerender({ entries: null })
    // 未知这一拍清单不交行，`checkedIds` 自然无从派生；要看的是现场本身有没有被清掉。
    expect([...result.current.checked].sort()).toEqual(['a1', 'b1'])
    rerender({ entries: rows.filter((entry) => entry.id !== 'a1') })
    expect(result.current.checkedIds).toEqual(['b1'])
  })
})
