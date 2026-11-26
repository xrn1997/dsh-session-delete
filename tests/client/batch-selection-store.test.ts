// 选中集现场（2026-10-20）：多选模式与名单是一份合并快照。
//
// 语义钉在这里：点击序 = 名单序、重勾排队尾、enter 幂等、exit 清两半、clear 留模式、
// addPicks 只追加未见、shrink 只留失败。**没变就不发通告**——快照引用不变就是"没变"
// （`createStore.update` 回同一引用时不通知）。
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  addPicks,
  clearPicks,
  enterSelection,
  exitSelection,
  getPicks,
  getSelection,
  isSelecting,
  resetSelection,
  shrinkPicksToFailures,
  togglePick,
  toggleRangePick,
  useSelection,
} from '../../src/client/batch-selection-store.js'



const ids = (): string[] => getPicks().map((item) => item.sessionId)

describe('选中集', () => {
  it('初始态：不在模式内、名单为空', () => {
    expect(isSelecting()).toBe(false)
    expect(getSelection()).toEqual({ selecting: false, picks: [] })
  })

  it('按勾选顺序记；对已勾的再勾一次是取消，不出现重复；重勾排队尾', () => {
    togglePick({ sessionId: 'a', title: 'A' })
    togglePick({ sessionId: 'b', title: 'B' })
    expect(ids()).toEqual(['a', 'b'])
    togglePick({ sessionId: 'a', title: 'A' })
    expect(ids()).toEqual(['b'])
    togglePick({ sessionId: 'a', title: 'A' })
    expect(ids()).toEqual(['b', 'a'])
  })

  it('点行/勾选框只改名单，不改变模式', () => {
    togglePick({ sessionId: 'a', title: 'A' })
    expect(isSelecting()).toBe(false)
    // 名单条目原样收下"选中"那一次传入的 {sessionId,title}；翻转只认 id（摘下时传的标题不参与）。
    expect(getPicks()).toEqual([{ sessionId: 'a', title: 'A' }])
  })

  it('shrinkPicksToFailures 只留失败名单；空名单 = 全清', () => {
    togglePick({ sessionId: 'a', title: 'A' })
    togglePick({ sessionId: 'b', title: 'B' })
    togglePick({ sessionId: 'c', title: 'C' })
    shrinkPicksToFailures(['c'])
    expect(ids()).toEqual(['c'])
    shrinkPicksToFailures([])
    expect(getPicks()).toEqual([])
  })

  it('shrinkPicksToFailures 传入 submittedSessionIds 时只剔除本批成功项，保留失败与在飞期间新勾项', () => {
    togglePick({ sessionId: 'a', title: 'A' })
    togglePick({ sessionId: 'b', title: 'B' })
    // 假定在飞期间用户新勾了 c；提交时名单只有 a、b，落地后 a 成功、b 失败。
    togglePick({ sessionId: 'c', title: 'C' })
    shrinkPicksToFailures(['b'], ['a', 'b'])
    expect(ids()).toEqual(['b', 'c'])
    // c 的锚点不受影响（只有被剔除成功的锚点才清空）。
    toggleRangePick(
      { sessionId: 'd', title: 'D' },
      [
        { sessionId: 'a', title: 'A' },
        { sessionId: 'b', title: 'B' },
        { sessionId: 'c', title: 'C' },
        { sessionId: 'd', title: 'D' },
      ],
    )
    expect(ids()).toEqual(['b', 'c', 'd'])
  })

  it('shrinkPicksToFailures 保持既有语义：一条都没剔掉也发一次通告（执行后订阅方重读）', () => {
    togglePick({ sessionId: 'a', title: 'A' })
    const before = getSelection()
    shrinkPicksToFailures(['a'])
    expect(ids()).toEqual(['a'])
    expect(getSelection()).not.toBe(before)
  })
})

describe('多选模式', () => {
  it('进入/退出；退出把选中集一起清掉', () => {
    expect(isSelecting()).toBe(false)
    enterSelection()
    expect(isSelecting()).toBe(true)
    togglePick({ sessionId: 'a', title: 'A' })
    exitSelection()
    expect(isSelecting()).toBe(false)
    expect(getPicks()).toEqual([])
  })

  it('重复进入是幂等的：同一份快照（不发通告）', () => {
    enterSelection()
    const snapshot = getSelection()
    enterSelection()
    expect(getSelection()).toBe(snapshot)
  })

  it('已经两半都空时再退出：不发通告', () => {
    const snapshot = getSelection()
    exitSelection()
    expect(getSelection()).toBe(snapshot)
  })

  it('退出不只清名单，也退模式', () => {
    enterSelection()
    togglePick({ sessionId: 'a', title: 'A' })
    const snapshot = getSelection()
    expect(snapshot.selecting).toBe(true)
    exitSelection()
    expect(getSelection()).toEqual({ selecting: false, picks: [] })
    expect(getSelection()).not.toBe(snapshot)
  })
})

describe('清空与追加', () => {
  it('clearPicks 留在模式内；名单已经空了就不发通告', () => {
    enterSelection()
    togglePick({ sessionId: 'a', title: 'A' })
    clearPicks()
    expect(isSelecting()).toBe(true)
    expect(getPicks()).toEqual([])
    const snapshot = getSelection()
    clearPicks()
    expect(getSelection()).toBe(snapshot)
  })

  it('addPicks 只追加没选过的：原有选中保持在前、新条目按传入序接在后面', () => {
    enterSelection()
    togglePick({ sessionId: 'b', title: 'B' })
    addPicks([
      { sessionId: 'a', title: 'A' },
      { sessionId: 'b', title: 'B' },
      { sessionId: 'c', title: 'C' },
      { sessionId: 'a', title: 'A' },
    ])
    expect(ids()).toEqual(['b', 'a', 'c'])
    expect(getPicks().map((item) => item.title)).toEqual(['B', 'A', 'C'])
  })

  it('addPicks 没有新条目就不发通告（同一份快照）', () => {
    togglePick({ sessionId: 'a', title: 'A' })
    const snapshot = getSelection()
    addPicks([])
    addPicks([{ sessionId: 'a', title: 'A' }])
    expect(getSelection()).toBe(snapshot)
  })
})

describe('范围勾选（Shift+点）', () => {
  const item = (sessionId: string): { sessionId: string; title: string } =>
    ({ sessionId, title: sessionId.toUpperCase() })
  const rows = ['a', 'b', 'c', 'd'].map(item)

  it('toggleRange 勾上锚点到目标整段：原勾选在前、新条目按 rows 序接后', () => {
    togglePick(item('a'))
    toggleRangePick(item('c'), rows)
    expect(ids()).toEqual(['a', 'b', 'c'])
  })

  it('toggleRange 无锚点时退化为 toggle 并立锚', () => {
    toggleRangePick(item('b'), rows.slice(0, 2))
    expect(ids()).toEqual(['b'])
    toggleRangePick(item('d'), rows)
    expect(ids()).toEqual(['b', 'c', 'd'])
  })

  it('exit 清锚点：重新进模式后 toggleRange 退化单条', () => {
    togglePick(item('a'))
    exitSelection()
    enterSelection()
    toggleRangePick(item('c'), rows.slice(0, 3))
    expect(ids()).toEqual(['c'])
  })

  it('反向 Shift+点：从下方锚点上选到上方目标', () => {
    togglePick(item('d'))
    toggleRangePick(item('b'), rows)
    expect(ids()).toEqual(['d', 'b', 'c'])
  })

  it('取消勾选某条也以它立锚，且连续 Shift+点不移锚', () => {
    togglePick(item('a'))
    togglePick(item('b'))
    // 取消 b，锚点落在 b
    togglePick(item('b'))
    toggleRangePick(item('d'), rows)
    expect(ids()).toEqual(['a', 'b', 'c', 'd'])
    // 锚点仍是 b，不因上一次 range 移走：清掉 d 后再 Shift+点 a 应勾上 a..b，不把 c/d 重勾回来
    togglePick(item('d'))
    // 重新以 b 立锚验证连续 range 不移锚
    clearPicks()
    togglePick(item('b'))
    toggleRangePick(item('d'), rows)
    expect(ids()).toEqual(['b', 'c', 'd'])
    toggleRangePick(item('a'), rows)
    expect(ids()).toEqual(['b', 'c', 'd', 'a'])
  })

  it('clearPicks 与 shrinkPicksToFailures 会清理失效锚点', () => {
    togglePick(item('a'))
    clearPicks()
    toggleRangePick(item('c'), rows)
    expect(ids()).toEqual(['c'])

    togglePick(item('a'))
    togglePick(item('b'))
    // b 留存、a 被剔除 ⇒ 退化单条只勾 c，但若锚点留在失败集里则仍可起算
    togglePick(item('a'))
    shrinkPicksToFailures(['b'])
    toggleRangePick(item('d'), rows)
    expect(ids()).toEqual(['b', 'd'])
  })
})

describe('resetSelection', () => {
  it('模式与名单一起回初值', () => {
    enterSelection()
    togglePick({ sessionId: 'a', title: 'A' })
    resetSelection()
    expect(getSelection()).toEqual({ selecting: false, picks: [] })
  })
})

describe('useSelection', () => {
  it('组件订阅合并快照：进模式、勾选、退出都触发重渲染', () => {
    const { result } = renderHook(() => useSelection())
    expect(result.current).toEqual({ selecting: false, picks: [] })
    act(() => {
      enterSelection()
    })
    expect(result.current.selecting).toBe(true)
    act(() => {
      togglePick({ sessionId: 'a', title: 'A' })
    })
    expect(result.current.picks.map((item) => item.sessionId)).toEqual(['a'])
    act(() => {
      exitSelection()
    })
    expect(result.current).toEqual({ selecting: false, picks: [] })
  })
})
