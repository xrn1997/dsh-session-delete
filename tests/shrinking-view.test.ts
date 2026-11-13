/**
 * 收缩视图的持有机制（`src/trash/shrinking-view.ts`）：一份「原始快照 + 会收缩的当前视图」，
 * entry 适配与清册作用域共用。判据不在这份测试里重写——三态与按组收缩的口径由
 * `tests/groups.test.ts` 钉住，这里钉的是**持有**：claim 只读可重复、take / takeAll 收缩当前视图、
 * view 交当前行。
 */
import { describe, expect, it } from 'vitest'
import type { TrashEntry } from '../src/trash/entry.js'
import { createShrinkingView } from '../src/trash/shrinking-view.js'
import { trashEntry } from './support/world.js'

const row = (id: string, parentEntryId?: string): TrashEntry =>
  trashEntry(id, { title: id, sizeBytes: 10, ...(parentEntryId === undefined ? {} : { parentEntryId }) })

const ids = (rows: readonly TrashEntry[]): string[] => rows.map((entry) => entry.id)

describe('createShrinkingView：收缩视图的持有机制（entry 适配与清册作用域共用这一份）', () => {
  const rows = [row('p'), row('k', 'p'), row('solo')]

  it('claim 三态：起手 fresh 带整组；take 后原组 carried；原始快照认不出的 id 是 absent', () => {
    const view = createShrinkingView(rows)
    const first = view.claim('p')
    expect(first.verdict).toBe('fresh')
    if (first.verdict !== 'fresh') return
    expect(ids(first.group)).toEqual(['p', 'k'])
    view.take('p')
    expect(view.claim('p').verdict).toBe('carried')
    expect(view.claim('k').verdict).toBe('carried')
    expect(view.claim('ghost').verdict).toBe('absent')
  })

  it('take 按组收缩当前视图：组根整组走（判据与 withoutGroup 同一条口径）', () => {
    const view = createShrinkingView(rows)
    expect(ids(view.view())).toEqual(['p', 'k', 'solo'])
    view.take('p')
    expect(ids(view.view())).toEqual(['solo'])
  })

  it('take 只摘一条 id 的组，不动同批别的行', () => {
    const view = createShrinkingView(rows)
    view.take('k')
    expect(ids(view.view())).toEqual(['p', 'solo'])
  })

  it('takeAll 收缩到底：视图空、原始快照里认得出的全 carried，认不出的仍是 absent', () => {
    const view = createShrinkingView(rows)
    view.takeAll()
    expect(ids(view.view())).toEqual([])
    expect(view.claim('p').verdict).toBe('carried')
    expect(view.claim('solo').verdict).toBe('carried')
    expect(view.claim('ghost').verdict).toBe('absent')
  })

  it('claim 只读：连问两次不改视图，view 仍按清册原序', () => {
    const view = createShrinkingView(rows)
    expect(view.claim('p').verdict).toBe('fresh')
    expect(view.claim('p').verdict).toBe('fresh')
    expect(ids(view.view())).toEqual(['p', 'k', 'solo'])
  })
})
