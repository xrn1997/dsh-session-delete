/**
 * 「这一批」的契约（ADR-0002）：去重保序、幂等（已被同批前一条带走）、逐条信封、一批一次通告、
 * 清册只读一次。
 *
 * 这些断言此前散在路由层用例里（`tests/api.test.ts` 通过 http 看同一件事）。收成一份的直接原因：
 * 恢复的通告从动词搬到了这一层——覆盖不能跟着搬家丢掉，得在新家把它钉住。
 */
import { describe, expect, it, vi } from 'vitest'
import { applyActions } from '../src/verbs/batch.js'
import type { DeleteDeps } from '../src/deps.js'
import type { SessionIdentity } from '../src/ports/host-port.js'
import type { TrashLedger } from '../src/trash/ledger.js'
import type { ManifestPort } from '../src/trash/manifest.js'
import { makeEntryId, type TrashEntry } from '../src/trash/entry.js'
import { createFakeDeps } from './support/fake-deps.js'
import { trashEntry } from './support/world.js'

const NOW = Date.UTC(2026, 8, 30, 13, 5, 0)

const parent: TrashEntry = trashEntry(makeEntryId(NOW, 'session-parent'), {
  sessionId: 'session-parent', deletedAt: NOW, title: '父', sizeBytes: 10,
})
const kid: TrashEntry = {
  ...parent, id: makeEntryId(NOW, 'session-kid'), sessionId: 'session-kid', title: '孩', parentEntryId: parent.id,
}

/** 清册读的次数要能被数：包一层计数，其余照旧委给内存清单。`raw()` 不算「一次真相读」，不计数。 */
function counting(manifest: ManifestPort): TrashLedger & { reads(): number } {
  let reads = 0
  return {
    reads: () => reads,
    list: async () => { reads += 1; return await manifest.list() },
    raw: () => manifest.list(),
    add: (entry) => manifest.add(entry),
    remove: (id) => manifest.remove(id),
  }
}

function world(seed: TrashEntry[], over: { corpus?: readonly SessionIdentity[] } = {}) {
  const made = createFakeDeps({ seed, now: NOW, fs: { size: 0 }, corpus: over.corpus })
  const ledger = counting(made.manifest)
  const deps: DeleteDeps = { ...made.deps, ledger }
  return { deps, host: made.host, fs: made.fs, manifest: ledger }
}

describe('批量层 · 一条 id 一条结果', () => {
  it('输入去重且保持顺序：重复 id 只出现一次', async () => {
    const { deps } = world([parent])
    const outcomes = await applyActions(deps, 'purge', [parent.id, parent.id])
    expect(outcomes.map((item) => item.id)).toEqual([parent.id])
    expect(outcomes).toHaveLength(1)
  })

  it('一条失败不传染下一条：成功的照回值，失败的带原文码', async () => {
    const { deps } = world([parent])
    const outcomes = await applyActions(deps, 'purge', [parent.id, 'ghost'])
    expect(outcomes).toHaveLength(2)
    expect(outcomes[0]).toMatchObject({ id: parent.id, ok: true })
    expect(outcomes[1]).toMatchObject({ id: 'ghost', ok: false, error: { code: 'sessiondelete/trash-empty' } })
  })

  it('count 是**整批一次**宿主调用，不是每条一次', async () => {
    const { deps, host } = world([parent])
    host.subagentMembersOf.mockImplementation(async (ids: readonly string[]) => ({
      available: true as const,
      value: Object.fromEntries(ids.map((id) => [id, [
        { sessionId: `${id}-1`, projectDir: '--p--' },
        { sessionId: `${id}-2`, projectDir: '--p--' },
      ]])),
    }))
    const outcomes = await applyActions(deps, 'count', ['a', 'b', 'c'])
    expect(outcomes.map((item) => (item.ok ? item.value : null))).toEqual([2, 2, 2])
    expect(host.subagentMembersOf).toHaveBeenCalledTimes(1)
  })

  it('count 在语料看不见（available:false）时整批回 0，不失败', async () => {
    const { deps, host } = world([parent])
    host.subagentMembersOf.mockResolvedValue({ available: false })
    const outcomes = await applyActions(deps, 'count', ['a', 'b'])
    expect(outcomes.map((item) => (item.ok ? item.value : null))).toEqual([0, 0])
    expect(host.subagentMembersOf).toHaveBeenCalledTimes(1)
  })
})

describe('批量层 · 已被同批前一条带走 = 幂等成功', () => {
  it('restore：先恢复组根，再点它的孩子 ⇒ 孩子那条是 no-op（值 null），不算失败', async () => {
    const { deps } = world([parent, kid])
    const outcomes = await applyActions(deps, 'restore', [parent.id, kid.id])
    expect(outcomes.map((item) => item.ok)).toEqual([true, true])
    expect(outcomes[1]).toMatchObject({ ok: true, value: null })
  })

  it('restore：一批只会**发一次**通告，且带的是整组的会话 id', async () => {
    const { deps, host } = world([parent, kid])
    await applyActions(deps, 'restore', [parent.id, kid.id])
    expect(host.announceRestored).toHaveBeenCalledTimes(1)
    expect(host.announceRestored.mock.calls[0]?.[0]).toEqual(['session-parent', 'session-kid'])
  })

  it('restore：先点孩子再点父 ⇒ 两条都成功，父那一组不再重放已经回来的孩子', async () => {
    const { deps, host } = world([parent, kid])
    const outcomes = await applyActions(deps, 'restore', [kid.id, parent.id])
    expect(outcomes.map((item) => item.ok)).toEqual([true, true])
    // 第一条只回孩子、第二条只回父；不会把第一条已经恢复过的孩子再通告一遍
    expect(host.announceRestored.mock.calls[0]?.[0]).toEqual(['session-kid', 'session-parent'])
  })

  it('purge：同批第二个被带走的孩子回 {removed:0,freedBytes:0}，不是 trash-empty', async () => {
    const { deps } = world([parent, kid])
    const outcomes = await applyActions(deps, 'purge', [parent.id, kid.id])
    expect(outcomes[1]).toMatchObject({ ok: true, value: { removed: 0, freedBytes: 0 } })
  })

  it('purge：先清孩子再清父 ⇒ 父那一组不再重复清已经不在的孩子', async () => {
    const { deps } = world([parent, kid])
    const outcomes = await applyActions(deps, 'purge', [kid.id, parent.id])
    expect(outcomes.map((item) => item.ok)).toEqual([true, true])
    // 第一条清孩子、第二条只清父；各报 1，而不是父那条把已经清掉的孩子再数一遍
    expect(outcomes[0]).toMatchObject({ ok: true, value: { removed: 1 } })
    expect(outcomes[1]).toMatchObject({ ok: true, value: { removed: 1 } })
  })

  it('delete：同批第二个孩子是幂等 no-op（值 null）——同批已带走集从动词结果长出', async () => {
    const { deps, host, manifest } = world([])
    host.subagentMembersOf.mockImplementation(async (ids: readonly string[]) => ({
      available: true as const,
      value: Object.fromEntries(ids.map((id) => [id, id === 'session-parent'
        ? [{ sessionId: 'session-kid', projectDir: '--p--' }]
        : []])),
    }))
    const outcomes = await applyActions(deps, 'delete', ['session-parent', 'session-kid'])
    expect(outcomes.map((item) => item.ok)).toEqual([true, true])
    expect(outcomes[1]).toMatchObject({ ok: true, value: null })
    expect(manifest.reads()).toBe(0)
  })

  it('幽灵 id 不是"被带走"：原始快照里本来就认不出 ⇒ 照样响亮失败', async () => {
    const { deps } = world([parent])
    const outcomes = await applyActions(deps, 'purge', ['ghost'])
    expect(outcomes[0]).toMatchObject({ ok: false, error: { code: 'sessiondelete/trash-empty' } })
  })
})

describe('批量层 · 清册只读一次', () => {
  it('restore 一批 N 条：批量层读一次，动词用的是那份**只读**快照', async () => {
    // solo 是根行：清册那一行的「没有父」就是**不建这个键**（键的缺席承载语义，见 `src/trash/entry.ts`
    // 的 parentEntryId 条），所以这里不往那一格写 undefined。
    const solo: TrashEntry = { ...parent, id: makeEntryId(NOW, 'solo'), sessionId: 'solo' }
    const { deps, manifest } = world([parent, kid, solo])
    const spy = vi.spyOn(manifest, 'list')
    await applyActions(deps, 'restore', [parent.id, makeEntryId(NOW, 'solo')])
    // 一次来自批量层（原始快照），动词不再自己各读一遍
    expect(spy).toHaveBeenCalledTimes(1)
    expect(manifest.reads()).toBe(1)
  })

  it('purge 一批 N 条：批量层读一次，清册作用域用的是那份**只读**快照', async () => {
    const { deps, manifest } = world([parent, kid])
    const spy = vi.spyOn(manifest, 'list')
    await applyActions(deps, 'purge', [parent.id, kid.id])
    // 一次来自批量层（原始快照），scope 的选组与收缩都在这份快照上，不再读第二遍
    expect(spy).toHaveBeenCalledTimes(1)
    expect(manifest.reads()).toBe(1)
  })

  it('orphan-clean 一批：对账行读一次，作用域把它原样交给扫描、不读第二遍 raw 索引', async () => {
    const { deps, manifest } = world([], {
      corpus: [{ sessionId: 'session-root', projectDir: '--p--', subagent: true, parentSessionId: 'gone', createdAt: 0 }],
    })
    const spy = vi.spyOn(manifest, 'list')
    const outcomes = await applyActions(deps, 'orphan-clean', ['session-root'])
    expect(outcomes.map((item) => item.ok)).toEqual([true])
    expect(spy).toHaveBeenCalledTimes(1)
    expect(manifest.reads()).toBe(1)
  })
})

describe('批量层 · unarchive（归档档的解除归档）', () => {
  it('unarchive：逐 id 调 host.unarchive，成功值恒为 1，一条失败不传染下一条', async () => {
    const { deps, host } = world([parent])
    host.unarchive.mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error('boom')
    })
    const outcomes = await applyActions(deps, 'unarchive', ['a', 'bad', 'b'])
    expect(outcomes.map((item) => item.action)).toEqual(['unarchive', 'unarchive', 'unarchive'])
    expect(outcomes.map((item) => (item.ok ? item.value : item.error.message))).toEqual([1, 'boom', 1])
    expect(outcomes[1]).toMatchObject({ id: 'bad', ok: false })
  })

  it('unarchive：幂等——未归档的 id 也是成功 1（宿主 unarchiveSession 是 no-op）', async () => {
    const { deps, host } = world([parent])
    host.unarchive.mockResolvedValue(undefined)
    const outcomes = await applyActions(deps, 'unarchive', ['never-archived'])
    expect(outcomes).toEqual([{ id: 'never-archived', action: 'unarchive', ok: true, value: 1 }])
  })
})
