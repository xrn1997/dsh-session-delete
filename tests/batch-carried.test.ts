/**
 * 同批已带走集（ADR-0002 的内部实现）：entry 域与 session 域各一个 adapter，两域都有
 * claim / take，但 claim 形状不同；收缩中的当前视图不再外递（purge 那一半的实例住
 * `src/verbs/trash-scope.ts`）。entry 适配是 `src/trash/shrinking-view.ts` 的
 * `createShrinkingView` 薄壳（持有机制在那边，判据仍读 `src/trash/groups.ts` 的 `claimOf`，
 * 不抄第二遍）；session 适配没有原始清册视图，只记 take 过的会话 id。
 */
import { describe, expect, it } from 'vitest'
import { createEntryCarried, createSessionCarried, preAdjudicateSession } from '../src/verbs/batch-carried.js'
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

  it('takeRows 只摘本次实际执行的行，不二次整组收缩误抹未删子', () => {
    const carried = createEntryCarried([parent, kid])
    carried.takeRows([parent.id])
    expect(carried.claim(kid.id)).toMatchObject({ verdict: 'fresh', group: [kid] })
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

// 预裁决表（输入序）：**预判只管调度**——carried 挂不挂先落表，实况为准在动词与第二波。预测组按 `firstByBare`
// 去重（共享后代归第一个声明者）；幽灵 id 不是「被带走」，幂等只留给「被同批前一条带走」。
describe('session 域预裁决表（输入序）', () => {
  it('同批父子：孩子已被父的预测组收走 ⇒ 挂第二波（carried）', () => {
    const table = preAdjudicateSession(
      ['session-parent', 'session-kid'],
      new Map([
        ['session-parent', ['session-parent', 'session-kid']],
        ['session-kid', ['session-kid']],
      ]),
    )
    expect(table).toEqual([
      { id: 'session-parent', verdict: 'fresh' },
      { id: 'session-kid', verdict: 'carried' },
    ])
  })

  it('共享后代归第一个声明者：后声明者只带走自己的，共享的那个挂第二波', () => {
    const table = preAdjudicateSession(
      ['session-a', 'session-b', 'session-m'],
      new Map([
        ['session-a', ['session-a', 'session-m']],
        ['session-b', ['session-b', 'session-m']],
        ['session-m', ['session-m']],
      ]),
    )
    expect(table.map((claim) => [claim.id, claim.verdict])).toEqual([
      ['session-a', 'fresh'],
      // session-m 归先者 session-a：这一条的预测组里不再有它，但两条仍会碰同一处（串行归组判据，不在表里）。
      ['session-b', 'fresh'],
      ['session-m', 'carried'],
    ])
  })

  it('幽灵 id 不是"被带走"：没人预测会带走它 ⇒ fresh，照旧进执行路响亮失败', () => {
    const table = preAdjudicateSession(['ghost'], new Map([['ghost', ['ghost']]]))
    expect(table).toEqual([{ id: 'ghost', verdict: 'fresh' }])
  })

  it('bare 归一（session- 前缀）：同一条会话的两种写法，后来者照样判 carried', () => {
    const table = preAdjudicateSession(
      ['session-x', 'x'],
      new Map([['session-x', ['session-x']], ['x', ['x']]]),
    )
    expect(table.map((claim) => claim.verdict)).toEqual(['fresh', 'carried'])
  })
})

// 第二波判定（实况为准）：预判 carried 的 id 在载体跑完后按实况裁决——载体真的带走了 ⇒ 幂等支；
// 载体失败 / 没搬它 ⇒ 转 fresh 补跑。两域的判据都是「视图有没有收缩 / 带走集有没有收它」。
describe('第二波判定（载体成功 ⇒ carried，载体失败 ⇒ 转 fresh）', () => {
  it('entry 域：载体没 take（失败）⇒ claim 转 fresh 且带自己的组；take 后 ⇒ carried', () => {
    const failed = createEntryCarried([parent, kid])
    expect(failed.claim(kid.id)).toMatchObject({ verdict: 'fresh', group: [kid] })
    const taken = createEntryCarried([parent, kid])
    taken.take(parent.id)
    expect(taken.claim(kid.id)).toEqual({ verdict: 'carried' })
  })

  it('session 域：载体的 movedSessionIds 没带走它 ⇒ fresh；带走 ⇒ carried', () => {
    const carried = createSessionCarried()
    expect(carried.claim('session-kid')).toEqual({ verdict: 'fresh' })
    // 载体成功：它的 movedSessionIds 里有这条 ⇒ 后来者回幂等支
    carried.take('session-parent')
    carried.take('session-kid')
    expect(carried.claim('session-kid')).toEqual({ verdict: 'carried' })
  })
})
