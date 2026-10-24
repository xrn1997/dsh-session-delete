/**
 * 同批已带走集（ADR-0002 的内部实现）：entry 域与 session 域各一个 adapter，两域都有
 * claim / take，但 claim 形状不同；当前只读视图 `rows` 只在 entry 域上。entry 适配的三态判据读
 * `trash/groups.ts` 的 `claimOf`；session 适配没有原始清册视图，只记 take 过的会话 id。
 */
import { describe, expect, it } from 'vitest'
import { createEntryCarried, createSessionCarried } from '../src/verbs/batch-carried.js'
import { makeEntryId, type TrashEntry } from '../src/trash/entry.js'
import { trashEntry } from './support/world.js'

const NOW = Date.UTC(2026, 8, 30, 13, 5, 0)
const parent: TrashEntry = trashEntry(makeEntryId(NOW, 'session-parent'), {
  sessionId: 'session-parent', deletedAt: NOW, title: '父', sizeBytes: 10,
})
const kid: TrashEntry = {
  ...parent, id: makeEntryId(NOW, 'session-kid'), sessionId: 'session-kid', title: '孩', parentEntryId: parent.id,
}

describe('entry 适配', () => {
  it('fresh → take → carried；原始快照里没有的是 absent', () => {
    const carried = createEntryCarried([parent, kid])
    const first = carried.claim(parent.id)
    expect(first.verdict).toBe('fresh')
    if (first.verdict !== 'fresh') return
    expect(first.group.map((row) => row.sessionId)).toEqual(['session-parent', 'session-kid'])
    carried.take(parent.id)
    expect(carried.claim(kid.id).verdict).toBe('carried')
    expect(carried.claim('ghost').verdict).toBe('absent')
    expect(carried.rows()).toEqual([])
  })

  it('take 只摘这一组，不动同批别的行', () => {
    const solo: TrashEntry = {
      ...parent, id: makeEntryId(NOW, 'solo'), sessionId: 'solo', parentEntryId: undefined,
    }
    const carried = createEntryCarried([parent, kid, solo])
    carried.take(kid.id)
    expect(carried.rows().map((row) => row.sessionId)).toEqual(['session-parent', 'solo'])
    const claim = carried.claim(parent.id)
    expect(claim.verdict).toBe('fresh')
    if (claim.verdict !== 'fresh') return
    expect(claim.group.map((row) => row.sessionId)).toEqual(['session-parent'])
  })
})

describe('session 适配', () => {
  it('按 bare session id 归一：先 take 父，再点带前缀的孩子就是 carried', () => {
    const carried = createSessionCarried()
    expect(carried.claim('session-a')).toEqual({ verdict: 'fresh' })
    carried.take('session-a')
    expect(carried.claim('a')).toEqual({ verdict: 'carried' })
    expect(carried.claim('b')).toEqual({ verdict: 'fresh' })
  })
})
