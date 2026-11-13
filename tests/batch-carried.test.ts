/**
 * 同批已带走集（ADR-0002 的内部实现）：entry 域与 session 域各一个 adapter，两域都有
 * claim / take，但 claim 形状不同；收缩中的当前视图不再外递（purge 那一半的实例住
 * `src/verbs/trash-scope.ts`）。entry 适配是 `src/trash/shrinking-view.ts` 的
 * `createShrinkingView` 薄壳（持有机制在那边，判据仍读 `src/trash/groups.ts` 的 `claimOf`，
 * 不抄第二遍）；session 适配没有原始清册视图，只记 take 过的会话 id。
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
  })

  it('take 只摘这一组，不动同批别的行', () => {
    // solo 是根行：清册那一行的「没有父」就是**不建这个键**（键的缺席承载语义，见 `src/trash/entry.ts`
    // 的 parentEntryId 条），所以这里不写一个 undefined 进那一格。
    const solo: TrashEntry = {
      ...parent, id: makeEntryId(NOW, 'solo'), sessionId: 'solo',
    }
    const carried = createEntryCarried([parent, kid, solo])
    carried.take(kid.id)
    const claim = carried.claim(parent.id)
    expect(claim.verdict).toBe('fresh')
    if (claim.verdict !== 'fresh') return
    expect(claim.group.map((row) => row.sessionId)).toEqual(['session-parent'])
    expect(carried.claim(solo.id).verdict).toBe('fresh')
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
