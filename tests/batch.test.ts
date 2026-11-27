/**
 * 「这一批」的契约（ADR-0002）：去重保序、幂等（已被同批前一条带走）、逐条信封、一批一次通告、
 * 清册只读一次。
 *
 * 这些断言此前散在路由层用例里（`tests/api.test.ts` 通过 http 看同一件事）。收成一份的直接原因：
 * 恢复的通告从动词搬到了这一层——覆盖不能跟着搬家丢掉，得在新家把它钉住。
 */
import zlib from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { applyActions } from '../src/verbs/batch.js'
import { readWriteProgress, resetWriteProgress, writeProgress } from '../src/verbs/write-progress.js'
import { ATTACHMENT_CLEANUP_SCHEMA } from '../src/shared/apply-values.js'
import { FAILURE_DETAILS_ATTACHMENTS_KEY } from '../src/shared/wire.js'
import { attachmentPathOf } from '../src/trash/attachments.js'
import type { DeleteDeps } from '../src/deps.js'
import type { SessionIdentity, SubagentMember } from '../src/ports/host-port.js'
import type { TrashLedger } from '../src/trash/ledger.js'
import type { ManifestPort } from '../src/trash/manifest.js'
import { makeEntryId, sessionDirForId, trashDirOf, type TrashEntry } from '../src/trash/entry.js'
import { createFakeDeps } from './support/fake-deps.js'
import { holdCalls, trashEntry } from './support/world.js'

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

function world(
  seed: TrashEntry[],
  over: {
    corpus?: readonly SessionIdentity[]
    members?: Record<string, readonly SubagentMember[] | undefined> | undefined
    membersAvailable?: boolean
  } = {},
) {
  const made = createFakeDeps({
    seed, now: NOW, fs: { size: 0 }, corpus: over.corpus,
    members: over.members, membersAvailable: over.membersAvailable,
  })
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

  it('restore：坏清册 id 只失败自己这一组，不在调度期中断整批', async () => {
    const badKid = { ...kid, id: 'not-an-entry-id' }
    const solo = { ...parent, id: makeEntryId(NOW, 'solo'), sessionId: 'solo', title: '独条' }
    const { deps } = world([parent, badKid, solo])
    const outcomes = await applyActions(deps, 'restore', [parent.id, solo.id])
    expect(outcomes[0]).toMatchObject({ ok: false, error: { code: 'sessiondelete/io' } })
    expect(outcomes[1]).toMatchObject({ ok: true, value: solo })
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

  it('orphan-clean 一批：对账行读一次，批量层把它原样交给扫描、不读第二遍 raw 索引', async () => {
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

describe('批量层 · 条目级 tick（done 与完成条数同义，含失败条）', () => {
  it('单条失败、第二条成功：失败那条也 advance——在飞读到的 done 已计入失败条', async () => {
    resetWriteProgress()
    const { deps, fs } = world([parent])
    const held = holdCalls(fs.removeDir)
    const batch = applyActions(deps, 'purge', ['ghost', parent.id])
    // 第一条（ghost）已按失败收尾、第二条删到一半挂在闸上：done 是 1——失败条也 tick。
    await vi.waitFor(() => { expect(held.waiting).toBe(1) })
    expect(readWriteProgress()).toMatchObject({
      status: 'running', action: 'purge', ids: ['ghost', parent.id], done: 1, total: 2,
    })
    held.release()
    const outcomes = await batch
    expect(outcomes.map((item) => item.ok)).toEqual([false, true])
    // 成败都收尾：整批落定回 idle。
    expect(readWriteProgress()).toEqual({ status: 'idle' })
  })

  it('重复 id 不撑大 total：身份与总数都按去重后的名单', async () => {
    resetWriteProgress()
    const { deps, fs } = world([parent])
    const held = holdCalls(fs.removeDir)
    const batch = applyActions(deps, 'purge', [parent.id, parent.id])
    await vi.waitFor(() => { expect(held.waiting).toBe(1) })
    expect(readWriteProgress()).toMatchObject({
      status: 'running', action: 'purge', ids: [parent.id], done: 0, total: 1,
    })
    held.release()
    await batch
  })
})

// carried 预裁决 + 第二波补跑 + 批内有界并发：预判只管调度（fresh 进波次 1 有界并发、carried 挂第二波），
// 实况为准（载体真带走了回幂等支，没带走就补跑）；信封按输入序落位，值不因乱序完成而串位。
describe('批量层 · carried 预裁决 + 第二波补跑 + 批内有界并发', () => {
  const kidMember = { sessionId: 'session-kid', projectDir: '--p--' }

  it('① 父+子同批删除 ⇒ 子回 null（幂等）且孩子的目录只搬一次', async () => {
    const { deps, fs } = world([], { members: { 'session-parent': [kidMember] } })
    const outcomes = await applyActions(deps, 'delete', ['session-parent', 'session-kid'])
    expect(outcomes.map((item) => item.ok)).toEqual([true, true])
    // 载体成功 ⇒ 幂等 null（不是报错、不是自己的信封）
    expect(outcomes[1]).toMatchObject({ ok: true, value: null })
    const kidMoves = fs.rename.mock.calls.filter((call) => call.some((p) => p.includes('session-kid')))
    expect(kidMoves).toHaveLength(1)
  })

  it('② delete：载体（父）执行失败 ⇒ 子在第二波被搬走、回自己的成功信封（不是幂等 null）', async () => {
    const { deps, host, fs } = world([], { members: { 'session-parent': [kidMember] } })
    host.detach = vi.fn(async (id: string) => {
      if (id === 'session-parent') throw new Error('摘账本失败')
    })
    const outcomes = await applyActions(deps, 'delete', ['session-parent', 'session-kid'])
    expect(outcomes[0]).toMatchObject({ ok: false })
    // 载体没带走 ⇒ 转 fresh 补跑：回它自己的成功信封
    expect(outcomes[1]).toMatchObject({ ok: true, value: { sessionId: 'session-kid' } })
    const kidMoves = fs.rename.mock.calls.filter((call) => call.some((p) => p.includes('session-kid')))
    expect(kidMoves).toHaveLength(1)
  })

  it('② purge：载体（父）执行失败 ⇒ 子不再回 carried-0，走第二波补跑回自己的成功信封', async () => {
    const { deps, manifest } = world([parent, kid])
    manifest.remove = vi.fn(async (id: string) => {
      if (id === parent.id) throw new Error('boom')
    })
    const outcomes = await applyActions(deps, 'purge', [parent.id, kid.id])
    expect(outcomes[0]).toMatchObject({ ok: false })
    // runGroup 失败视图不动 ⇒ 同组后来者第二波重新认领、自己跑，回自己的读数（ADR-0070）。
    expect(outcomes[1]).toMatchObject({ ok: true, value: { removed: 1 } })
    expect(outcomes[1]).not.toMatchObject({ ok: true, value: { removed: 0, freedBytes: 0 } })
  })

  it('② restore：载体（父）摘清册行失败 ⇒ 子第二波补跑回自己的成功信封，通告名单只带补跑回来的子', async () => {
    const { deps, host, fs, manifest } = world([parent, kid])
    manifest.remove = vi.fn(async (id: string) => {
      if (id === parent.id) throw new Error('boom')
    })
    const outcomes = await applyActions(deps, 'restore', [parent.id, kid.id])
    expect(outcomes[0]).toMatchObject({ ok: false, error: { code: 'sessiondelete/io' } })
    // 载体失败没 take ⇒ 第二波按**当前视图**重裁成 fresh、带组补跑：回孩子自己的成功信封（不是幂等 null）
    expect(outcomes[1]).toMatchObject({ ok: true, value: { sessionId: 'session-kid' } })
    const kidMoves = fs.rename.mock.calls.filter((call) => call.some((p) => p.includes('session-kid')))
    expect(kidMoves).toHaveLength(1)
    // 批尾通告是跨波次汇的名单：失败载体那组的会话 id 不进名单（不能骗宿主说它回来了），
    // 第二波补跑回来的孩子必须进——否则它在宿主里隐身到重连
    expect(host.announceRestored).toHaveBeenCalledTimes(1)
    expect(host.announceRestored.mock.calls[0]?.[0]).toEqual(['session-kid'])
  })

  it('③ 一条失败不传染后续条：前一条的失败不挡后面的删除', async () => {
    const { deps, host } = world([], { members: { 'session-parent': [kidMember] } })
    host.projectDirOf = vi.fn(async (id: string) => (id === 'session-bad' ? undefined : '--p--'))
    const outcomes = await applyActions(deps, 'delete', ['session-bad', 'session-parent'])
    expect(outcomes[0]).toMatchObject({ ok: false, error: { code: 'sessiondelete/not-found' } })
    expect(outcomes[1]).toMatchObject({ ok: true, value: { sessionId: 'session-parent' } })
  })

  it('④ 回执顺序 = 输入序：乱序完成也按输入序落位，值不串位', async () => {
    const { deps, host, fs } = world([])
    let releaseA: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseA = resolve })
    const titleOf = host.titleOf
    host.titleOf = vi.fn(async (id: string) => {
      if (id === 'session-a') await gate
      return await titleOf(id)
    })
    const batch = applyActions(deps, 'delete', ['session-a', 'session-b'])
    // 乱序完成的证据：b 已经搬完、a 还挂在闸上（串行驱动在这里永远等不到第一笔 rename）
    await vi.waitFor(() => { expect(fs.rename).toHaveBeenCalledTimes(1) })
    releaseA()
    const outcomes = await batch
    expect(outcomes.map((item) => item.id)).toEqual(['session-a', 'session-b'])
    expect(outcomes[0]).toMatchObject({ ok: true, value: { sessionId: 'session-a' } })
    expect(outcomes[1]).toMatchObject({ ok: true, value: { sessionId: 'session-b' } })
  })

  it('波次 1 有界并发：6 条独立条目最多 4 条同时在跑（BATCH_RUN_CONCURRENCY = 4）', async () => {
    const { deps, host } = world([])
    let release: () => void = () => {}
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const titleOf = host.titleOf
    let inFlight = 0
    let peak = 0
    host.titleOf = vi.fn(async (id: string) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await barrier
      inFlight -= 1
      return await titleOf(id)
    })
    const batch = applyActions(deps, 'delete', ['s1', 's2', 's3', 's4', 's5', 's6'])
    // 并发确实发生了（串行驱动下永远只有 1 条在飞）
    await vi.waitFor(() => { expect(peak).toBeGreaterThanOrEqual(2) })
    release()
    await batch
    // 且有界：恰好封在旋钮值上
    expect(peak).toBe(4)
  })

  it('两条计划撞同一目录（共享盘上残离子会话）⇒ 并成一条链串行，不并发碰同一棵树', async () => {
    const rowA = trashEntry(makeEntryId(NOW, 'session-a'), { sessionId: 'session-a', deletedAt: NOW })
    const rowB = trashEntry(makeEntryId(NOW, 'session-b'), { sessionId: 'session-b', deletedAt: NOW })
    const shared = { sessionId: 'session-shared', projectDir: '--p--' }
    const { deps, fs } = world([rowA, rowB], {
      members: { 'session-a': [shared], 'session-b': [shared] },
    })
    const original = fs.removeDir
    let inFlight = 0
    let peak = 0
    fs.removeDir = vi.fn(async (p: string) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      await original(p)
      inFlight -= 1
    })
    const outcomes = await applyActions(deps, 'purge', [rowA.id, rowB.id])
    expect(outcomes.map((item) => item.ok)).toEqual([true, true])
    // 串行是组判据的目的：共享目录被两条计划命中 ⇒ 同一条链，删目录从不同时在飞。
    expect(peak).toBe(1)
  })

  it('第二波补跑的条目只 tick 一次：载体失败时两条各 advance 一次（done 与已处理条数同义）', async () => {
    const { deps, manifest } = world([parent, kid])
    manifest.remove = vi.fn(async (id: string) => {
      if (id === parent.id) throw new Error('boom')
    })
    resetWriteProgress()
    const advance = vi.spyOn(writeProgress, 'advance')
    try {
      const outcomes = await applyActions(deps, 'purge', [parent.id, kid.id])
      expect(outcomes[0]).toMatchObject({ ok: false })
      expect(outcomes[1]).toMatchObject({ ok: true })
      // 两条 = 两次：多 tick 会让第二波那条被数两遍，k/N 变成不可能完成的假进度。
      expect(advance).toHaveBeenCalledTimes(2)
    } finally {
      advance.mockRestore()
    }
  })
})
// per-id 附件读数合成（批级尾 → 逐条信封）：`byGroup` 按**组归属**拆回各条——ok 支挂自己的成功回执，
// 失败支挂自己 `error.details` 的同一格（对象读数不冒领别的条的回执），carried 幂等支不带 `attachments`
// （缺席与 0 是两件事）。批内各 id 的读数（成功回执 + 失败 details）相加 = 尾 run 的合计（对象单归属），
// 客户端「按批相加」的归并不动。
describe('批量层 · per-id 附件读数合成（批级尾拆回）', () => {
  const HOME = '/h'
  const LOG = 'session.v4.jsonl.zstd'
  const IMAGE_A = `sha256:${'a'.repeat(64)}`
  const IMAGE_B = `sha256:${'b'.repeat(64)}`
  const IMAGE_C = `sha256:${'c'.repeat(64)}`
  const imagePath = (id: string) => attachmentPathOf(HOME, 'image', id)
  const logWith = (id: string) => zlib.zstdCompressSync(Buffer.from(
    `${JSON.stringify({ type: 'session', version: 4, id: 'session-x', createdAt: 1, cwd: 'C:/p' })}\n` +
    `${JSON.stringify({
      type: 'user/message',
      time: 2,
      data: {
        source: { kind: 'user' },
        content: [{ type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', bytes: 3, width: 1, height: 1 } }],
      },
    })}\n`,
    'utf8',
  ))
  const rowOf = (name: string): TrashEntry =>
    trashEntry(makeEntryId(NOW, `session-${name}`), { sessionId: `session-${name}`, deletedAt: NOW })

  /** 「每条回收站目录各引用一张独占图」的盘上世界：目录真删（写口落墓碑）引用才消失。
   *  `images` 按回收站目录给图 id，`objectSizes` 按对象路径给字节；`over.members` 喂盘上残离子会话。 */
  function imageWorld(
    seed: readonly TrashEntry[],
    images: Readonly<Record<string, string>>,
    objectSizes: Readonly<Record<string, number>>,
    over: { members?: Record<string, readonly SubagentMember[] | undefined> } = {},
  ) {
    const made = world([...seed], over)
    made.fs.listDirs.mockImplementation(async (p: string) => {
      if (p !== `${HOME}/session-trash`) return []
      const out: string[] = []
      for (const dir of Object.keys(images)) {
        if (await made.fs.exists(dir)) out.push(dir.slice(dir.lastIndexOf('/') + 1))
      }
      return out
    })
    made.fs.listFiles.mockImplementation(async (p: string) => (images[p] === undefined ? [] : [LOG]))
    made.fs.readFile.mockImplementation(async (p: string) => {
      const id = images[p.slice(0, p.lastIndexOf('/'))]
      if (id === undefined) throw new Error(`no fixture for ${p}`)
      return logWith(id)
    })
    made.fs.statFile.mockImplementation(async (p: string) => ({ size: objectSizes[p] ?? 0 }))
    return made
  }

  it('两组各自独占的图片拆回各自的 attachments（byGroup 拆回）', async () => {
    const rowA = rowOf('a')
    const rowB = rowOf('b')
    const dirA = trashDirOf(rowA.id, HOME)
    const dirB = trashDirOf(rowB.id, HOME)
    const made = imageWorld([rowA, rowB], { [dirA]: IMAGE_A, [dirB]: IMAGE_B }, { [imagePath(IMAGE_A)]: 7, [imagePath(IMAGE_B)]: 8 })
    const outcomes = await applyActions(made.deps, 'purge', [rowA.id, rowB.id])
    expect(outcomes.map((item) => (item.ok ? item.value : null))).toEqual([
      { removed: 1, freedBytes: 0, attachments: { removed: 1, freedBytes: 7, failed: 0 } },
      { removed: 1, freedBytes: 0, attachments: { removed: 1, freedBytes: 8, failed: 0 } },
    ])
  })

  it('失败组的对象读数挂回自己失败条的 details，不冒领成功行回执（附件只随永久删除清，失败路径不泄漏）', async () => {
    const rowA = rowOf('a')
    const rowB = rowOf('b')
    const dirA = trashDirOf(rowA.id, HOME)
    const dirB = trashDirOf(rowB.id, HOME)
    const made = imageWorld([rowA, rowB], { [dirA]: IMAGE_A, [dirB]: IMAGE_B }, { [imagePath(IMAGE_A)]: 7, [imagePath(IMAGE_B)]: 8 })
    // 组 A 删完目录、摘清册行才失败 ⇒ 目录已删、组失败：它的独占图仍随尾清掉，读数挂回 A 自己的失败 details。
    made.manifest.remove = vi.fn(async (id: string) => { if (id === rowA.id) throw new Error('boom') })
    const outcomes = await applyActions(made.deps, 'purge', [rowA.id, rowB.id])
    expect(outcomes[0]).toMatchObject({
      ok: false,
      error: { code: 'sessiondelete/io', details: { attachments: { removed: 1, freedBytes: 7, failed: 0 } } },
    })
    // B 的回执只念自己那组的读数（1 件 / 8 字节），不替失败的 A 记账。
    expect(outcomes[1]).toMatchObject({ ok: true, value: { attachments: { removed: 1, freedBytes: 8, failed: 0 } } })
  })

  it('成功回执 + 失败 details 的读数相加 = 尾 run 的合计（客户端「按批相加」对得上）', async () => {
    const rowA = rowOf('a')
    const rowB = rowOf('b')
    const dirA = trashDirOf(rowA.id, HOME)
    const dirB = trashDirOf(rowB.id, HOME)
    const made = imageWorld([rowA, rowB], { [dirA]: IMAGE_A, [dirB]: IMAGE_B }, { [imagePath(IMAGE_A)]: 7, [imagePath(IMAGE_B)]: 8 })
    // 两组行目录都真删掉、图随尾清掉；A 在摘自己的清册行时失败 ⇒ 读数按组归属一成功一失败。
    made.manifest.remove = vi.fn(async (id: string) => { if (id === rowA.id) throw new Error('boom') })
    const outcomes = await applyActions(made.deps, 'purge', [rowA.id, rowB.id])
    expect(outcomes.map((item) => item.ok)).toEqual([false, true])
    // 两半都从信封现读：成功支 `value.attachments`、失败支 `details.attachments`（同一格名、同 schema）。
    const totals = { removed: 0, freedBytes: 0, failed: 0 }
    for (const outcome of outcomes) {
      const raw = !outcome.ok
        ? outcome.error.details?.[FAILURE_DETAILS_ATTACHMENTS_KEY]
        : outcome.action === 'purge' ? outcome.value.attachments : undefined
      if (!ATTACHMENT_CLEANUP_SCHEMA.check(raw)) throw new Error('信封缺附件读数')
      totals.removed += raw.removed
      totals.freedBytes += raw.freedBytes
      totals.failed += raw.failed
    }
    // 尾 run 的合计 = 两张独占图（7 + 8 字节）；客户端按批相加拿到的是同一份总量。
    expect(totals).toEqual({ removed: 2, freedBytes: 15, failed: 0 })
  })

  it('carried 幂等支不带 attachments：缺席与 0 是两件事', async () => {
    const { deps } = world([parent, kid])
    const outcomes = await applyActions(deps, 'purge', [parent.id, kid.id])
    expect(outcomes[1]).toEqual({ id: kid.id, action: 'purge', ok: true, value: { removed: 0, freedBytes: 0 } })
  })

  it('载体失败 ⇒ 子第二波补跑：被删目录的独占图随尾清掉，读数按组归属挂回失败载体的 details（附件尾修正）', async () => {
    const dirP = trashDirOf(parent.id, HOME)
    const dirK = trashDirOf(kid.id, HOME)
    const made = imageWorld([parent, kid], { [dirP]: IMAGE_A, [dirK]: IMAGE_B }, {
      [imagePath(IMAGE_A)]: 7, [imagePath(IMAGE_B)]: 8,
    })
    // 载体删完自己的目录、摘自己的清册行时失败 ⇒ 执行视图不动；孩子自己的目录还没动过，第二波补跑会删它。
    made.manifest.remove = vi.fn(async (id: string) => { if (id === parent.id) throw new Error('boom') })
    const outcomes = await applyActions(made.deps, 'purge', [parent.id, kid.id])
    // 两个目录都真删掉了、独占图随尾清掉、读数不能丢：对象单归属是组级（载体那组的计划覆盖整组行目录），
    // 读数挂回失败载体的 details；补跑条自己那组没有独占图，回执带零读数——相加照旧等于尾 run 的合计。
    expect(outcomes[0]).toMatchObject({
      ok: false,
      error: { details: { attachments: { removed: 2, freedBytes: 15, failed: 0 } } },
    })
    expect(outcomes[1]).toMatchObject({
      ok: true,
      value: { removed: 1, attachments: { removed: 0, freedBytes: 0, failed: 0 } },
    })
    expect(made.fs.removeFile).toHaveBeenCalledTimes(2)
  })

  it('载体计划期被闸拒 ⇒ 残离子会话目录也进过批级扫描：第二波补跑删掉的目录不泄漏独占图', async () => {
    const dirP = trashDirOf(parent.id, HOME)
    const dirK = trashDirOf(kid.id, HOME)
    const stranded = { sessionId: 'session-stranded', projectDir: '--p--' }
    const dirS = sessionDirForId('--p--', 'session-stranded', HOME)
    const made = imageWorld(
      [parent, kid],
      { [dirP]: IMAGE_A, [dirK]: IMAGE_B, [dirS]: IMAGE_C },
      { [imagePath(IMAGE_A)]: 7, [imagePath(IMAGE_B)]: 8, [imagePath(IMAGE_C)]: 9 },
      { members: { 'session-kid': [stranded] } },
    )
    // 计划期活体准入只拒一次（父在跑）：载体计划失败；第二波重试时闸已放行，补跑（孩子那一组）会删孩子的目录
    // 与它盘上残留的子会话目录——后者不是清册行目录，只有挂起条目的补扫面能把它带进批级扫描。
    let firstLive = true
    made.host.isLive = vi.fn(async (id: string) => {
      if (id !== 'session-parent' || !firstLive) return false
      firstLive = false
      return true
    })
    const outcomes = await applyActions(made.deps, 'purge', [parent.id, kid.id])
    expect(outcomes[0]).toMatchObject({ ok: false, error: { code: 'sessiondelete/live' } })
    expect(outcomes[1]).toMatchObject({ ok: true })
    // 孩子的目录图 B 与残离子会话目录图 C 都随尾清掉；父目录还在、图 A 不许动（没删掉的目录不泄漏也不误删）。
    expect(made.fs.removeFile).toHaveBeenCalledTimes(2)
    expect(made.fs.removeFile).toHaveBeenCalledWith(imagePath(IMAGE_C))
    expect(made.fs.removeFile).not.toHaveBeenCalledWith(imagePath(IMAGE_A))
    expect(outcomes[1]).toMatchObject({ ok: true, value: { attachments: { removed: 2, freedBytes: 17, failed: 0 } } })
  })

  it('扫描期读不出挂起条目的盘上后代 ⇒ 该组第二波补跑判失败（宁可不删，也不留孤儿附件）', async () => {
    const dirK = trashDirOf(kid.id, HOME)
    const stranded = { sessionId: 'session-stranded', projectDir: '--p--' }
    const dirS = sessionDirForId('--p--', 'session-stranded', HOME)
    const made = imageWorld(
      [parent, kid],
      { [dirK]: IMAGE_B, [dirS]: IMAGE_C },
      { [imagePath(IMAGE_B)]: 8, [imagePath(IMAGE_C)]: 9 },
      { members: { 'session-kid': [stranded] } },
    )
    // 计划期活体只拒一次（父在跑）；批级扫描读挂起条目的盘上后代时抛（第 2 次读）——第二波即便能重试成功也不许删。
    let liveChecks = 0
    made.host.isLive = vi.fn(async (id: string) => id === 'session-parent' && liveChecks++ === 0)
    const originalMembers = made.host.subagentMembersOf.getMockImplementation()
    if (originalMembers === undefined) throw new Error('假件没有 subagentMembersOf 实现')
    let memberReads = 0
    made.host.subagentMembersOf = vi.fn(async (parentIds: readonly string[]) => {
      memberReads += 1
      if (memberReads === 2) throw new Error('语料读不出')
      return await originalMembers(parentIds)
    })
    const outcomes = await applyActions(made.deps, 'purge', [parent.id, kid.id])
    expect(outcomes[0]).toMatchObject({ ok: false, error: { code: 'sessiondelete/live' } })
    // 扫描面不完整 ⇒ 补跑失败、目录一个都不动：留给人重试，不能制造孤儿附件。
    expect(outcomes[1]).toMatchObject({ ok: false, error: { code: 'sessiondelete/io' } })
    expect(made.fs.removeFile).not.toHaveBeenCalled()
  })

  it('第二波重规划长出扫描后新目录 ⇒ 补跑失败，不能删掉没进过附件候选面的目录', async () => {
    const dirP = trashDirOf(parent.id, HOME)
    const dirK = trashDirOf(kid.id, HOME)
    const stranded = { sessionId: 'session-stranded', projectDir: '--p--' }
    const dirS = sessionDirForId('--p--', 'session-stranded', HOME)
    const made = imageWorld(
      [parent, kid],
      { [dirP]: IMAGE_A, [dirK]: IMAGE_B, [dirS]: IMAGE_C },
      { [imagePath(IMAGE_A)]: 7, [imagePath(IMAGE_B)]: 8, [imagePath(IMAGE_C)]: 9 },
    )
    made.manifest.remove = vi.fn(async (id: string) => { if (id === parent.id) throw new Error('boom') })
    const originalMembers = made.host.subagentMembersOf.getMockImplementation()
    if (originalMembers === undefined) throw new Error('假件没有 subagentMembersOf 实现')
    let kidReads = 0
    made.host.subagentMembersOf = vi.fn(async (parentIds: readonly string[]) => {
      if (!parentIds.includes('session-kid')) return await originalMembers(parentIds)
      kidReads += 1
      return {
        available: true as const,
        value: { 'session-kid': kidReads === 2 ? [stranded] : [] },
      }
    })

    const outcomes = await applyActions(made.deps, 'purge', [parent.id, kid.id])
    expect(outcomes[0]).toMatchObject({ ok: false, error: { code: 'sessiondelete/io' } })
    expect(outcomes[1]).toMatchObject({ ok: false, error: { code: 'sessiondelete/io' } })
    const failed = outcomes[1]
    if (failed?.ok !== false) throw new Error('第二波补跑应当失败')
    expect(failed.error.message).toMatch(/未进入批级附件扫描面/)
    expect(made.fs.removeDir.mock.calls.some(([dir]) => dir === dirS)).toBe(false)
    expect(made.fs.removeFile).not.toHaveBeenCalledWith(imagePath(IMAGE_C))
  })

  it('扫描时缺席的回收站目录在补跑前出现 ⇒ 第二波失败，不删未扫描目录', async () => {
    const dirP = trashDirOf(parent.id, HOME)
    const dirK = trashDirOf(kid.id, HOME)
    const made = imageWorld([parent, kid], { [dirP]: IMAGE_A, [dirK]: IMAGE_B }, {
      [imagePath(IMAGE_A)]: 7, [imagePath(IMAGE_B)]: 8,
    })
    const originalExists = made.fs.exists.getMockImplementation()
    if (originalExists === undefined) throw new Error('假件没有 exists 实现')
    let kidPresent = false
    made.fs.exists.mockImplementation(async (p: string) => p === dirK ? kidPresent : await originalExists(p))
    // 载体删完自己的目录后失败，同时孩子目录在扫描面之后出现。
    made.manifest.remove = vi.fn(async (id: string) => {
      if (id !== parent.id) return
      kidPresent = true
      throw new Error('boom')
    })

    const outcomes = await applyActions(made.deps, 'purge', [parent.id, kid.id])
    expect(outcomes[0]).toMatchObject({ ok: false })
    expect(outcomes[1]).toMatchObject({ ok: false, error: { code: 'sessiondelete/io' } })
    const failed = outcomes[1]
    if (failed?.ok !== false) throw new Error('第二波补跑应当失败')
    expect(failed.error.message).toMatch(/未进入批级附件扫描面/)
    expect(made.fs.removeDir.mock.calls.some(([dir]) => dir === dirK)).toBe(false)
    expect(made.fs.removeFile).not.toHaveBeenCalledWith(imagePath(IMAGE_B))
  })

  it('runOrphanBatch：扫描时缺席的成员目录在补跑前出现 ⇒ 第二波失败，不删未扫描目录', async () => {
    const rootA = { sessionId: 'session-orphan-a', projectDir: '--p--', title: '甲', updatedAt: 1, bytes: 0 }
    const rootR = { sessionId: 'session-orphan-r', projectDir: '--p--', title: '乙', updatedAt: 1, bytes: 0 }
    const dirA = sessionDirForId('--p--', rootA.sessionId, HOME)
    const dirR = sessionDirForId('--p--', rootR.sessionId, HOME)
    const made = imageWorld([], { [dirA]: IMAGE_A, [dirR]: IMAGE_B }, {
      [imagePath(IMAGE_A)]: 7, [imagePath(IMAGE_B)]: 8,
    })
    const originalExists = made.fs.exists.getMockImplementation()
    const originalListDirs = made.fs.listDirs.getMockImplementation()
    if (originalExists === undefined || originalListDirs === undefined) throw new Error('假件缺少目录读实现')
    let rootPresent = false
    made.fs.exists.mockImplementation(async (p: string) => p === dirR ? rootPresent : await originalExists(p))
    made.fs.listDirs.mockImplementation(async (p: string) => {
      const names = await originalListDirs(p)
      // 候选已读完、开始扫剩余引用源时，让挂起根目录出现；它没进过候选扫描。
      if (p === `${HOME}/session-trash`) rootPresent = true
      return names
    })
    let liveChecks = 0
    made.host.isLive = vi.fn(async (id: string) => id === rootR.sessionId && liveChecks++ === 0)
    const { runOrphanBatch } = await import('../src/verbs/batch.js')
    const outcomes = await runOrphanBatch(
      made.deps,
      [
        { root: rootR, parentSessionId: 'session-dead-r', members: [rootR] },
        { root: rootA, parentSessionId: 'session-dead-a', members: [rootA] },
      ],
      ['orphan-r', rootR.sessionId, 'orphan-a'],
    )
    expect(outcomes[0]).toMatchObject({ ok: false, error: { code: 'sessiondelete/live' } })
    expect(outcomes[1]).toMatchObject({ ok: false, error: { code: 'sessiondelete/io' } })
    expect(outcomes[2]).toMatchObject({ ok: true })
    const failed = outcomes[1]
    if (failed?.ok !== false) throw new Error('第二波补跑应当失败')
    expect(failed.error.message).toMatch(/未进入批级附件扫描面/)
    expect(made.fs.removeDir.mock.calls.some(([dir]) => dir === dirR)).toBe(false)
    expect(made.fs.removeFile).not.toHaveBeenCalledWith(imagePath(IMAGE_B))
  })

  it('runOrphanBatch：首条的计划被闸拒掉时，同根挂起条目的补跑目录也进批级扫描（独占图随尾清掉，不留孤儿）', async () => {
    const root = { sessionId: 'session-orphan', projectDir: '--p--', title: '无主', updatedAt: 1, bytes: 0 }
    const dirR = sessionDirForId('--p--', 'session-orphan', HOME)
    const made = imageWorld([], { [dirR]: IMAGE_A }, { [imagePath(IMAGE_A)]: 7 })
    // 计划期活体只拒一次：首条（`orphan`）的计划被闸拒掉 ⇒ 这一组的目录没进任何计划；同根挂起条目
    // （`session-orphan`）补跑时闸已放行、会删根目录——它目录里的独占图必须提前进扫描面（ADR-0070 决定 5），
    // 否则目录删了、图却没人清，只剩孤儿附件。
    let liveChecks = 0
    made.host.isLive = vi.fn(async (id: string) => id === 'session-orphan' && liveChecks++ === 0)
    const { runOrphanBatch } = await import('../src/verbs/batch.js')
    const outcomes = await runOrphanBatch(
      made.deps,
      [{ root, parentSessionId: 'session-dead', members: [root] }],
      ['orphan', 'session-orphan'],
    )
    expect(outcomes[0]).toMatchObject({ ok: false, error: { code: 'sessiondelete/live' } })
    expect(outcomes[1]).toMatchObject({
      ok: true,
      value: { removed: 1, attachments: { removed: 1, freedBytes: 7, failed: 0 } },
    })
    expect(made.fs.removeFile).toHaveBeenCalledWith(imagePath(IMAGE_A))
  })

  // 逐组归因（ADR-0070 边界）：读不出是谁家目录的事，那句就上谁家的回执——挂到「有对象的组」
  // 是把 A 的故障写进 B 的账（串台），旧口径如此，这里钉新口径。
  it('skipped 逐组归因：候选日志读不出只落真正读不出的那一组的 ok 支', async () => {
    const rowA = rowOf('a')
    const rowB = rowOf('b')
    const dirA = trashDirOf(rowA.id, HOME)
    const dirB = trashDirOf(rowB.id, HOME)
    const made = world([rowA, rowB])
    // 组 A 的候选日志没有夹具 ⇒ 读不出（unreadableCandidatesByGroup 记 A）；组 B 的独占图照常进计划。
    made.fs.listDirs.mockImplementation(async (p: string) =>
      p === `${HOME}/session-trash` ? [rowA.id, rowB.id] : [])
    made.fs.listFiles.mockImplementation(async (p: string) => (p === dirA || p === dirB ? [LOG] : []))
    made.fs.readFile.mockImplementation(async (p: string) => {
      if (p === `${dirB}/${LOG}`) return logWith(IMAGE_B)
      throw new Error(`no fixture for ${p}`)
    })
    made.fs.statFile.mockImplementation(async (p: string) => ({ size: p === imagePath(IMAGE_B) ? 8 : 0 }))
    const outcomes = await applyActions(made.deps, 'purge', [rowA.id, rowB.id])
    const unreadable: unknown = expect.stringMatching(/1 个被删会话日志读不出/)
    expect(outcomes[0]).toEqual({
      id: rowA.id, action: 'purge', ok: true,
      value: { removed: 1, freedBytes: 0, attachments: { removed: 0, freedBytes: 0, failed: 0, skipped: unreadable } },
    })
    // B 的扫描与对象都读得出：它的回执一个字都不多。
    expect(outcomes[1]).toMatchObject({
      ok: true,
      value: { attachments: { removed: 1, freedBytes: 8, failed: 0 } },
    })
    const second = outcomes[1]
    if (second?.ok !== true || second.action !== 'purge') throw new Error('第二条应当成功')
    expect(second.value.attachments).not.toHaveProperty('skipped')
  })

  it('对象 stat 读不出也只落归属组的 ok 支（单归属的逐组账）', async () => {
    const rowA = rowOf('a')
    const rowB = rowOf('b')
    const dirA = trashDirOf(rowA.id, HOME)
    const dirB = trashDirOf(rowB.id, HOME)
    const made = imageWorld([rowA, rowB], { [dirA]: IMAGE_A, [dirB]: IMAGE_B }, { [imagePath(IMAGE_B)]: 8 })
    // A 的对象 stat 抛权限错（不是"不在"）⇒ 这一件这次没敢删：原因只上 A 的回执。
    made.fs.statFile.mockImplementation(async (p: string) => {
      if (p === imagePath(IMAGE_A)) throw new Error('EACCES: stat')
      return { size: p === imagePath(IMAGE_B) ? 8 : 0 }
    })
    const outcomes = await applyActions(made.deps, 'purge', [rowA.id, rowB.id])
    const unreadable: unknown = expect.stringMatching(/1 个附件对象读不出/)
    expect(outcomes[0]).toMatchObject({
      ok: true,
      value: { attachments: { removed: 0, freedBytes: 0, failed: 0, skipped: unreadable } },
    })
    const second = outcomes[1]
    expect(second).toMatchObject({ ok: true, value: { attachments: { removed: 1, freedBytes: 8, failed: 0 } } })
    if (second?.ok !== true || second.action !== 'purge') throw new Error('第二条应当成功')
    expect(second.value.attachments).not.toHaveProperty('skipped')
  })

  it('剩余引用源读不出（整体 skipped）⇒ 全部 ok 支挂同一句，原文不丢', async () => {
    const rowA = rowOf('a')
    const rowB = rowOf('b')
    const dirA = trashDirOf(rowA.id, HOME)
    const dirB = trashDirOf(rowB.id, HOME)
    const made = world([rowA, rowB])
    // 两条候选日志都在；剩余会话的日志读不出 ⇒ 整体 fail closed（谁都没进 entries，byGroup 空）。
    made.fs.listDirs.mockImplementation(async (p: string) =>
      p === `${HOME}/session-trash` ? [rowA.id, rowB.id]
        : p === `${HOME}/sessions` ? ['--p--']
          : p === `${HOME}/sessions/--p--` ? ['session-c'] : [])
    made.fs.listFiles.mockImplementation(async (p: string) =>
      p === dirA || p === dirB || p === `${HOME}/sessions/--p--/session-c` ? [LOG] : [])
    made.fs.readFile.mockImplementation(async (p: string) => {
      if (p === `${dirA}/${LOG}`) return logWith(IMAGE_A)
      if (p === `${dirB}/${LOG}`) return logWith(IMAGE_B)
      throw new Error('EACCES: permission denied')
    })
    const outcomes = await applyActions(made.deps, 'purge', [rowA.id, rowB.id])
    const reason: unknown = expect.stringMatching(/无法证明独占/)
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({
        ok: true,
        value: { attachments: { removed: 0, freedBytes: 0, failed: 0, skipped: reason } },
      })
    }
    expect(made.fs.removeFile).not.toHaveBeenCalled()
  })

  it('整批零 ok 支 ⇒ 读数按组挂回各自失败条的 details（不冒领、不丢）', async () => {
    const rowA = rowOf('a')
    const rowB = rowOf('b')
    const dirA = trashDirOf(rowA.id, HOME)
    const dirB = trashDirOf(rowB.id, HOME)
    const made = imageWorld([rowA, rowB], { [dirA]: IMAGE_A, [dirB]: IMAGE_B }, { [imagePath(IMAGE_A)]: 7, [imagePath(IMAGE_B)]: 8 })
    // 两组都删完目录、摘清册行才失败 ⇒ 目录已删、读数有：各回各家的失败 details，不再是「无处挂」。
    made.manifest.remove = vi.fn(async () => { throw new Error('boom') })
    const outcomes = await applyActions(made.deps, 'purge', [rowA.id, rowB.id])
    expect(outcomes.map((item) => item.ok)).toEqual([false, false])
    expect(outcomes[0]).toMatchObject({
      ok: false, error: { details: { attachments: { removed: 1, freedBytes: 7, failed: 0 } } },
    })
    expect(outcomes[1]).toMatchObject({
      ok: false, error: { details: { attachments: { removed: 1, freedBytes: 8, failed: 0 } } },
    })
  })

  it('部分失败时，失败组的候选日志读不出不串台到成功组回执', async () => {
    const rowA = rowOf('a')
    const rowB = rowOf('b')
    const dirA = trashDirOf(rowA.id, HOME)
    const dirB = trashDirOf(rowB.id, HOME)
    const made = imageWorld([rowA, rowB], { [dirA]: IMAGE_A, [dirB]: IMAGE_B }, { [imagePath(IMAGE_B)]: 8 })
    made.fs.listFiles.mockImplementation(async (p: string) => (p === dirA || p === dirB ? [LOG] : []))
    made.fs.readFile.mockImplementation(async (p: string) => {
      if (p === `${dirA}/${LOG}`) throw new Error('EACCES: permission denied')
      if (p === `${dirB}/${LOG}`) return logWith(IMAGE_B)
      return Buffer.alloc(0)
    })
    made.manifest.remove = vi.fn(async (id: string) => {
      if (id === rowA.id) throw new Error('boom')
    })
    const outcomes = await applyActions(made.deps, 'purge', [rowA.id, rowB.id])
    // A 自己的「读不出」原因挂回 A 的失败 details（fail-closed 原文不丢，也不串台到 B）。
    const unreadable: unknown = expect.stringMatching(/1 个被删会话日志读不出/)
    expect(outcomes[0]).toMatchObject({
      ok: false,
      error: { details: { attachments: { removed: 0, freedBytes: 0, failed: 0, skipped: unreadable } } },
    })
    const second = outcomes[1]
    expect(second).toMatchObject({
      ok: true,
      value: { attachments: { removed: 1, freedBytes: 8, failed: 0 } },
    })
    if (second?.ok !== true || second.action !== 'purge') throw new Error('第二条应当成功')
    expect(second.value.attachments).not.toHaveProperty('skipped')
  })

  it('全批证明失败（sharedSkipped）：只落到有候选图的组，不误挂 absent 失败条', async () => {
    const rowB = rowOf('b')
    const dirB = trashDirOf(rowB.id, HOME)
    const made = imageWorld([rowB], { [dirB]: IMAGE_B }, { [imagePath(IMAGE_B)]: 8 })
    made.fs.listDirs.mockImplementation(async (p: string) =>
      p === `${HOME}/session-trash` ? [rowB.id]
        : p === `${HOME}/sessions` ? ['--p--']
          : p === `${HOME}/sessions/--p--` ? ['session-c'] : [])
    made.fs.listFiles.mockImplementation(async (p: string) =>
      p === dirB || p === `${HOME}/sessions/--p--/session-c` ? [LOG] : [])
    made.fs.readFile.mockImplementation(async (p: string) => {
      if (p === `${dirB}/${LOG}`) return logWith(IMAGE_B)
      throw new Error('EACCES: permission denied')
    })
    const outcomes = await applyActions(made.deps, 'purge', ['ghost-absent', rowB.id])
    expect(outcomes[0]).toMatchObject({ ok: false, error: { code: 'sessiondelete/trash-empty' } })
    expect(outcomes[0]?.ok === false ? outcomes[0].error.details?.[FAILURE_DETAILS_ATTACHMENTS_KEY] : undefined).toBeUndefined()
    const reason: unknown = expect.stringMatching(/无法证明独占/)
    expect(outcomes[1]).toMatchObject({
      ok: true,
      value: { attachments: { removed: 0, freedBytes: 0, failed: 0, skipped: reason } },
    })
  })
})

describe('回归 · 同批异形同根与先子后父不误抹未删子', () => {
  it('runOrphanBatch：同批传 [orphan, session-orphan] 只计划/执行一次，后者幂等 {0,0}；目录缺席时也不并发 unarchive', async () => {
    const root = { sessionId: 'session-orphan', projectDir: '--p--', title: '无主', updatedAt: 1, bytes: 0 }
    const made = world([])
    made.fs.exists.mockResolvedValue(false)
    let activeUnarchive = 0
    let maxUnarchive = 0
    made.host.unarchive = vi.fn(async () => {
      activeUnarchive += 1
      maxUnarchive = Math.max(maxUnarchive, activeUnarchive)
      await Promise.resolve()
      activeUnarchive -= 1
    })
    const { runOrphanBatch } = await import('../src/verbs/batch.js')
    const outcomes = await runOrphanBatch(
      made.deps,
      [{ root, parentSessionId: 'session-dead', members: [root] }],
      ['orphan', 'session-orphan'],
    )
    expect(outcomes).toEqual([
      { id: 'orphan', action: 'orphan-clean', ok: true, value: { removed: 0, freedBytes: 0, attachments: { removed: 0, freedBytes: 0, failed: 0 } } },
      { id: 'session-orphan', action: 'orphan-clean', ok: true, value: { removed: 0, freedBytes: 0 } },
    ])
    expect(maxUnarchive).toBe(1)
    expect(made.host.unarchive).toHaveBeenCalledTimes(1)
  })

  it('purge 先子后父且子失败：父成功不误抹未删子，同一作用域下一轮仍可认领', async () => {
    const made = world([parent, kid])
    made.host.isLive = vi.fn(async (id: string) => id === kid.sessionId)
    const { createTrashScope } = await import('../src/verbs/trash-scope.js')
    const { executeRemoval } = await import('../src/verbs/permanent-removal.js')
    const { runPurgeBatch } = await import('../src/verbs/batch.js')
    const rows = [parent, kid]
    const scope = createTrashScope(rows, (plan) => executeRemoval(made.deps, plan))
    const first = await runPurgeBatch(made.deps, scope, rows, [kid.id, parent.id])
    expect(first[0]).toMatchObject({ ok: false, error: { code: 'sessiondelete/live' } })
    expect(first[1]).toMatchObject({ ok: true, value: { removed: 1 } })
    expect(scope.claimAll([kid.id])[0]?.verdict).toBe('fresh')
  })

  it('restore 先子后父且子失败：父只摘自己，不把未恢复的子误标成 carried', async () => {
    const made = world([parent, kid])
    made.manifest.remove = vi.fn(async (id: string) => {
      if (id === kid.id) throw new Error('boom')
    })
    const outcomes = await applyActions(made.deps, 'restore', [kid.id, parent.id])
    expect(outcomes[0]).toMatchObject({ ok: false })
    expect(outcomes[1]).toMatchObject({ ok: true })
    expect(outcomes[1]?.ok ? outcomes[1].value : null).not.toBeNull()
  })
})
