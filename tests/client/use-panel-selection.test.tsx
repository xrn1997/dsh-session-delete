/**
 * 清单上的选中面（`use-panel-selection.ts`，通用；回收站/归档各一台实例）。
 *
 * 这块判据原先在两台面板控制器里各写一遍，其中归档那遍把自动选中写成了 passive 阶段——
 * 面板测试只能断言最终 DOM，看不见"画没画那一帧"，所以漂移一路活到真机。住一处之后，
 * 这里钉的是接口上的六件事：接住屏幕上第一条、未知不算没了、折叠不清场、onGone 只收到
 * 那个没了的 id、失败原文按行存且不空转。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { usePanelSelection } from '../../src/client/use-panel-selection.js'
import { useListSelection } from '../../src/client/use-list-selection.js'
import { groupByProject } from '../../src/client/trash-view.js'
import { zhTranslate } from '../../src/client/copy.js'

interface TestRow {
  readonly id: string
  readonly projectDir: string
  readonly at: number
}

const row = (id: string, projectDir: string, at: number): TestRow => ({ id, projectDir, at })
/** 两个项目：A 里 a1/a2（a2 最新）、B 里 b1 ⇒ 屏幕顺序 a2, a1, b1。 */
const a1 = row('a1', '--A--', 1)
const a2 = row('a2', '--A--', 3)
const b1 = row('b1', '--B--', 2)
const rows: readonly TestRow[] = [a1, a2, b1]
const idOf = (r: TestRow): string => r.id

function mount(
  initialRows: readonly TestRow[] | null = rows,
  over: { canAutoSelect?: boolean; initialId?: string | null } = {},
) {
  const picked = vi.fn()
  const gone = vi.fn()
  const view = renderHook(({ list, canAutoSelect }: { list: readonly TestRow[] | null; canAutoSelect: boolean }) => {
    const groups = groupByProject(list ?? [], zhTranslate, { timeOf: (r) => r.at, projectDirOf: (r) => r.projectDir })
    const selection = useListSelection({ rows: list, groups, idOf })
    return {
      ...usePanelSelection<TestRow>({
        rows: list,
        idOf,
        ordered: selection.ordered,
        canAutoSelect,
        initialId: over.initialId ?? null,
        onPick: picked,
        onGone: gone,
      }),
      toggleGroup: selection.toggleGroup,
    }
  }, { initialProps: { list: initialRows, canAutoSelect: over.canAutoSelect ?? false } })
  return { view, picked, gone }
}

describe('选中面 · 宽档自动选中', () => {
  it('接住屏幕上的第一条并把这一行交给读路', () => {
    const { view, picked } = mount(rows, { canAutoSelect: true })
    expect(view.result.current.selected?.id).toBe('a2')
    expect(picked).toHaveBeenCalledWith(a2)
  })

  it('走的是展开后的屏幕顺序：第一条所在组折叠 ⇒ 接住剩下那组的第一条', () => {
    const { view } = mount(rows, { canAutoSelect: false })
    act(() => { view.result.current.toggleGroup('--A--') })
    view.rerender({ list: rows, canAutoSelect: true })
    expect(view.result.current.selected?.id).toBe('b1')
  })

  it('窄档不自动选中：右栏由用户点出来', () => {
    const { view, picked } = mount(rows, { canAutoSelect: false })
    expect(view.result.current.selected).toBeNull()
    expect(picked).not.toHaveBeenCalled()
  })

  it('快照续位有效时不抢：挂载即指着那一条，读路交给选中时刻', () => {
    const { view, picked } = mount(rows, { canAutoSelect: true, initialId: 'a1' })
    expect(view.result.current.selectedId).toBe('a1')
    expect(view.result.current.selected?.id).toBe('a1')
    expect(picked).not.toHaveBeenCalled()
  })
})

describe('选中面 · 清单换版清场', () => {
  it('选中行被清单收走 ⇒ 清选中，并只把那一个 id 交给调用方清场', () => {
    const { view, gone } = mount(rows, { canAutoSelect: false })
    act(() => { void view.result.current.pick(a1) })
    view.rerender({ list: rows.filter((r) => r.id !== 'a1'), canAutoSelect: false })
    expect(view.result.current.selectedId).toBeNull()
    expect(gone).toHaveBeenCalledTimes(1)
    expect(gone).toHaveBeenCalledWith('a1')
  })

  it('清单未知（null）不算「行没了」：选中留着，恢复后直接续上', () => {
    const { view, gone } = mount(rows, { canAutoSelect: false })
    act(() => { void view.result.current.pick(a1) })
    view.rerender({ list: null, canAutoSelect: false })
    expect(gone).not.toHaveBeenCalled()
    expect(view.result.current.selectedId).toBe('a1')
    view.rerender({ list: rows, canAutoSelect: false })
    expect(view.result.current.selected?.id).toBe('a1')
    expect(gone).not.toHaveBeenCalled()
  })

  it('选中行住在折叠起来的组里：清场不看清单怎么分段', () => {
    const { view, gone } = mount(rows, { canAutoSelect: false })
    act(() => { void view.result.current.pick(a1) })
    act(() => { view.result.current.toggleGroup('--A--') })
    expect(view.result.current.selected?.id).toBe('a1')
    expect(gone).not.toHaveBeenCalled()
  })

  it('清场之后自动选中当拍接住新清单第一条：右栏不停在「未选中」', () => {
    const { view } = mount(rows, { canAutoSelect: true })
    expect(view.result.current.selected?.id).toBe('a2')
    view.rerender({ list: [row('c1', '--C--', 9), row('b1', '--B--', 2)], canAutoSelect: true })
    expect(view.result.current.selected?.id).toBe('c1')
  })
})

describe('选中面 · 失败原文按行落', () => {
  it('setRowFailures 只铺带失败的那几行，别行不串台', () => {
    const { view } = mount(rows)
    act(() => { view.result.current.setRowFailures(new Map([['a1', '原项目目录已不存在']])) })
    expect(view.result.current.actionFailure).toEqual({ a1: '原项目目录已不存在' })
    act(() => { view.result.current.setRowFailures(new Map([['b1', '读日志失败']])) })
    expect(view.result.current.actionFailure).toEqual({ a1: '原项目目录已不存在', b1: '读日志失败' })
  })

  it('空读数与没命中的清理都不多触发一拍：返回同一份引用', () => {
    const { view } = mount(rows)
    const before = view.result.current.actionFailure
    act(() => { view.result.current.setRowFailures(new Map()) })
    expect(view.result.current.actionFailure).toBe(before)
    act(() => { view.result.current.clearRowFailures(['没有挂着失败的行']) })
    expect(view.result.current.actionFailure).toBe(before)
  })

  it('再点一次不该还挂着上一次的原文：命中的那些行被清掉', () => {
    const { view } = mount(rows)
    act(() => { view.result.current.setRowFailures(new Map([['a1', '上一次'], ['b1', '上一次']])) })
    act(() => { view.result.current.clearRowFailures(['a1']) })
    expect(view.result.current.actionFailure).toEqual({ b1: '上一次' })
  })
})

describe('选中面 · pick 与 drop', () => {
  it('pick 落选中并把整行交给读路；drop 只收选中', async () => {
    const { view, picked } = mount(rows, { canAutoSelect: false })
    await act(async () => { await view.result.current.pick(b1) })
    expect(view.result.current.selectedId).toBe('b1')
    expect(picked).toHaveBeenCalledWith(b1)
    act(() => { view.result.current.drop() })
    expect(view.result.current.selectedId).toBeNull()
    expect(view.result.current.selected).toBeNull()
  })
})
