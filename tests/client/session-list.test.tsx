/**
 * 清单的分组列（`session-list.tsx`，通用；回收站档与归档档各交一份行视图）。
 *
 * 这里钉的是那一档**不该各自决定**的四件事：
 * ① `notice` 在场时容器不挂 grid 与它的一串 aria（ADR-0028：失败/加载/空是普通内容，不是空 grid）；
 * ② 底色说的是「详情正画着这一条」，多选态只把 `aria-selected` 让给勾选，底色不退场；
 * ③ 多选态点行 = 「勾/取消这一条」，交给选择面，不碰详情；动作列整排退场；
 * ④ 行的 DOM id 在 DOM 这一侧编码，原始身份留在 `data-*`。
 *
 * 选择面在这里是**替身**：`useListSelection` 自己的规矩归它那份测试，本模块只负责"读它的读数、
 * 把动作交回去"，所以钉接口这一侧就够。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode, RefObject } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionList, type SessionRowView } from '../../src/client/session-list.js'
import type { ListSelection } from '../../src/client/use-list-selection.js'
import { groupByProject } from '../../src/client/trash-view.js'
import { zhTranslate } from '../../src/client/copy.js'
import type { TrashNav } from '../../src/client/trash-nav.js'
import type { DelayedPrefetch } from '../../src/client/use-prefetch.js'

interface TestRow {
  readonly id: string
  readonly projectDir: string
  readonly at: number
}

const row = (id: string, projectDir = '--A--', at = 1): TestRow => ({ id, projectDir, at })
/** A 组 a1/a2（a2 最新）、B 组 b1 ⇒ 屏幕顺序 a2, a1, b1。 */
const rows: readonly TestRow[] = [row('a1', '--A--', 1), row('a2', '--A--', 3), row('b1', '--B--', 2)]
const SELECTED_FILL = 'var(--sd-button-ghost-active-fill)'
const domId = (id: string): string => `sd-trash-${encodeURIComponent(id)}`

/** 这一行被点时记下它，用来区分「选中」与「勾选」两条语义。 */
const picked: string[] = []
const rowOf = (r: TestRow): SessionRowView => ({
  id: r.id,
  title: `标题 ${r.id}`,
  titleTip: `全文 ${r.id}`,
  meta: '删除于 1天前 · 10 KB',
  metaTip: '2026-01-01 00:00:00',
  checkLabel: `勾选「${r.id}」这条会话`,
  failure: r.id === 'a1' ? '原项目目录已不存在' : null,
  actions: <button type="button">动作 {r.id}</button>,
  onSelect: () => { picked.push(r.id) },
})

function makeSelection(over: {
  selectMode?: boolean
  checked?: readonly string[]
  collapsed?: readonly string[]
}): ListSelection<TestRow> & { toggleCheck: ReturnType<typeof vi.fn>; toggleGroupCheck: ReturnType<typeof vi.fn> } {
  const checked = new Set(over.checked ?? [])
  const collapsed = new Set(over.collapsed ?? [])
  const fully = (group: { rows: readonly TestRow[] }): boolean =>
    group.rows.length > 0 && group.rows.every((r) => checked.has(r.id))
  return {
    selectMode: over.selectMode ?? false,
    checked,
    checkedRows: rows.filter((r) => checked.has(r.id)),
    checkedIds: [...checked],
    ordered: rows.filter((r) => !collapsed.has(r.projectDir)),
    allCollapsed: false,
    isCollapsed: (projectDir) => collapsed.has(projectDir),
    enterSelect: vi.fn(),
    exitSelect: vi.fn(),
    toggleGroup: vi.fn(),
    toggleAllGroups: vi.fn(),
    toggleCheck: vi.fn(),
    toggleGroupCheck: vi.fn(),
    groupFullyChecked: fully,
    groupPartiallyChecked: (group) => !fully(group) && group.rows.some((r) => checked.has(r.id)),
  }
}

function renderList(over: {
  rows?: readonly TestRow[] | null
  notice?: ReactNode
  activeId?: string | null
  selectMode?: boolean
  checked?: readonly string[]
  collapsed?: readonly string[]
  refreshing?: boolean
  navActiveId?: string | null
} = {}) {
  const listRef: RefObject<HTMLDivElement> = { current: null }
  const selection = makeSelection(over)
  const nav: TrashNav = {
    activeDescendantId: over.navActiveId === undefined ? 'a2' : over.navActiveId,
    tabStopId: 'a2',
    onListKeyDown: vi.fn(),
  }
  const prefetch: DelayedPrefetch<TestRow> = { schedule: vi.fn(), cancel: vi.fn() }
  const list = over.rows ?? rows
  render(
    <SessionList
      listRef={listRef}
      dom={{ kind: 'trash', idAttr: 'data-entry-id' }}
      gridLabel="回收站会话"
      refreshing={over.refreshing ?? false}
      notice={over.notice === undefined ? null : over.notice}
      groups={groupByProject(list, zhTranslate, { timeOf: (r) => r.at, projectDirOf: (r) => r.projectDir })}
      selection={selection}
      nav={nav}
      prefetch={prefetch}
      activeId={over.activeId ?? null}
      rowOf={rowOf}
      t={zhTranslate}
    />,
  )
  return { listRef, selection }
}

beforeEach(() => { picked.length = 0 })

describe('分组列 · grid 的挂载判据', () => {
  it('有行才挂 grid 与那一串 aria：列数、活动行的 DOM id、刷新中的 aria-busy', () => {
    renderList({ activeId: 'a2', refreshing: true })
    const grid = screen.getByRole('grid', { name: '回收站会话' })
    expect(grid).toHaveAttribute('aria-colcount', '2')
    expect(grid).toHaveAttribute('aria-activedescendant', domId('a2'))
    expect(grid).toHaveAttribute('aria-busy', 'true')
  })

  it('notice 在场 = 一块普通内容：容器不挂 grid、不挂 aria 名字，也不画组', () => {
    renderList({ notice: <div>正在读回收站…</div> })
    expect(screen.getByText('正在读回收站…')).toBeInTheDocument()
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
    expect(document.querySelector('[role="rowgroup"]')).toBeNull()
  })

  it('没有刷新中就不挂 aria-busy（它是读数，不是第四态）', () => {
    renderList({ activeId: 'a2' })
    expect(screen.getByRole('grid').hasAttribute('aria-busy')).toBe(false)
  })

  it('行 id 带空白：DOM id 已编码，data 属性仍是原始 id', () => {
    renderList({ rows: [row('my session')], navActiveId: 'my session', activeId: 'my session' })
    const el = screen.getByRole('row', { name: /标题 my session/ })
    expect(el.id).toBe(domId('my session'))
    expect(el.getAttribute('data-entry-id')).toBe('my session')
  })

  it('tab 落点只有一枚，其余行是 -1', () => {
    renderList()
    const stops = screen.getAllByRole('row').filter((el) => el.tabIndex === 0)
    expect(stops).toHaveLength(1)
    expect(stops[0]).toHaveAttribute('data-entry-id', 'a2')
  })
})

describe('分组列 · 底色与勾选是两件事', () => {
  it('非多选态：活动行有底色与 aria-selected，其它行两样都没有', () => {
    renderList({ activeId: 'a1' })
    const active = screen.getByRole('row', { name: /标题 a1/ })
    const plain = screen.getByRole('row', { name: /标题 a2/ })
    expect(active).toHaveAttribute('aria-selected', 'true')
    expect(active.style.background).toBe(SELECTED_FILL)
    expect(plain).toHaveAttribute('aria-selected', 'false')
    expect(plain.style.background).toBe('')
  })

  it('多选态：底色仍跟着活动行走，aria-selected 说的是勾选', () => {
    renderList({ selectMode: true, activeId: 'a1', checked: ['a2'] })
    const active = screen.getByRole('row', { name: /标题 a1/ })
    const checkedRow = screen.getByRole('row', { name: /标题 a2/ })
    expect(active.style.background).toBe(SELECTED_FILL)
    expect(active).toHaveAttribute('aria-selected', 'false')
    expect(checkedRow).toHaveAttribute('aria-selected', 'true')
  })

  it('多选态点行 = 把这一条交回选择面，不碰详情；动作列整排退场', () => {
    const { selection } = renderList({ selectMode: true })
    fireEvent.click(screen.getByRole('row', { name: /标题 a2/ }))
    expect(picked).toEqual([])
    expect(selection.toggleCheck).toHaveBeenCalledWith('a2')
    expect(screen.queryByRole('button', { name: '动作 a2' })).not.toBeInTheDocument()
  })

  it('非多选态点行才走选中；动作住在行右侧自己的格子里', () => {
    renderList()
    fireEvent.click(screen.getByRole('row', { name: /标题 a2/ }))
    expect(picked).toEqual(['a2'])
    const button = screen.getByRole('button', { name: '动作 a2' })
    expect(button.parentElement?.getAttribute('role')).toBe('gridcell')
  })

  it('多选态里勾选框自己那一下也交回选择面（不与整行点击两套语义抢）', () => {
    const { selection } = renderList({ selectMode: true })
    fireEvent.click(screen.getByRole('checkbox', { name: '勾选「a1」这条会话' }))
    expect(selection.toggleCheck).toHaveBeenCalledWith('a1')
    expect(picked).toEqual([])
  })
})

describe('分组列 · 组头与失败落点', () => {
  it('折叠的组不收组头：还能点回来，计数也看得见', () => {
    renderList({ collapsed: ['--A--'] })
    const head = screen.getByRole('button', { expanded: false })
    expect(head).toHaveTextContent('A')
    expect(head).toHaveTextContent('2')
    expect(screen.queryByRole('row', { name: /标题 a2/ })).not.toBeInTheDocument()
    expect(screen.getByRole('row', { name: /标题 b1/ })).toBeInTheDocument()
  })

  it('组头那颗说「这个项目全部会话」，折叠起来的条目也算在内', () => {
    const { selection } = renderList({ selectMode: true, collapsed: ['--A--'] })
    fireEvent.click(screen.getByRole('checkbox', { name: '勾选「A」这 2 条会话' }))
    const group = selection.toggleGroupCheck.mock.calls[0]?.[0] as { rows: readonly TestRow[] }
    expect(group.rows.map((r) => r.id)).toEqual(['a2', 'a1'])
  })

  it('失败原文落在那一行里，别行不画', () => {
    renderList()
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('原项目目录已不存在')
    expect(status.closest('[data-entry-id]')).toBe(screen.getByRole('row', { name: /标题 a1/ }))
    expect(document.querySelectorAll('[data-entry-id]')).toHaveLength(3)
  })
})
