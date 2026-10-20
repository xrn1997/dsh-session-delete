// 选中集现场（2026-10-20）：多选模式与名单是一份合并快照。
//
// 语义钉在这里：点击序 = 名单序、重勾排队尾、enter 幂等、exit 清两半、clear 留模式、
// addPicks 只追加未见、shrink 只留失败。**没变就不发通告**——快照引用不变就是"没变"
// （`createStore.update` 回同一引用时不通知）。
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  useSelection,
} from '../../src/client/batch-selection-store.js'

beforeEach(() => {
  resetSelection()
})

afterEach(() => {
  resetSelection()
})

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
