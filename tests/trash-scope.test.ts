import zlib from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { createTrashScope } from '../src/verbs/trash-scope.js'
import { executeAttachmentTail, executeRemoval, planTrashRemoval, type RemovalPlan } from '../src/verbs/permanent-removal.js'
import { planBatchImageAttachmentRemoval, attachmentPathOf } from '../src/trash/attachments.js'
import { runPurgeBatch, type StatsOutcome } from '../src/verbs/batch.js'
import { sessionDirOf, trashDirOf, type TrashEntry } from '../src/trash/entry.js'
import { createLogWorld, trashEntry } from './support/world.js'

const HOME = '/h'

const IMAGE = `sha256:${'a'.repeat(64)}`
const imagePath = attachmentPathOf(HOME, 'image', IMAGE)
/** 一条带独占图片引用的会话日志（压缩格式与 `pickSessionLog` 认的那一代一致）。 */
const imageLog = () => zlib.zstdCompressSync(Buffer.from(
  `${JSON.stringify({ type: 'session', version: 4, id: 'session-a', createdAt: 1, cwd: 'C:/p' })}\n` +
  `${JSON.stringify({
    type: 'user/message',
    time: 2,
    data: {
      source: { kind: 'user' },
      content: [{ type: 'image', attachment: { attachmentId: IMAGE, mediaType: 'image/png', bytes: 3, width: 1, height: 1 } }],
    },
  })}\n`,
  'utf8',
))

/** 一个附件都没碰的回执（现有的普通条目不涉及图片）。 */
const NOTHING_CLEANED = { removed: 0, freedBytes: 0, failed: 0 } as const

/** 内存里那第二个 adapter（`tests/support/fake-deps.ts`）：世界由参数描述，不再自己凑端口。
 *  日志只记 evictLive / announceRemoved 两件——彻底删除对宿主内存做的事就这两件。 */
function deps(seed: TrashEntry[]) {
  const made = createLogWorld({
    seed,
    fs: { size: 512 },
    logMethods: ['evictLive', 'announceRemoved'],
    format: (method, args) => `${method}(${String(args[0])})`,
  })
  const { deps: d, fs, host, manifest } = made

  /** 一条的批执行结果 → 回执或抛（与动词时代同形：失败原样抛、carried 回幂等零）。 */
  async function unwrap(outcomes: readonly StatsOutcome[]) {
    const outcome = outcomes[0]
    if (outcome === undefined) throw new Error('批驱动没有交回结果')
    if (outcome.ok) return outcome.value
    // 失败支是线上失败形状（不是 Error）：按原样交回给 rejects 断言——包一层只为了满足 throw 的对象形。
    throw Object.assign(new Error(outcome.error.message), outcome.error)
  }

  /** 直调路径自己开一个作用域：清册读一次、选组与收缩都在 scope 里（批量层同样整批只开一次）。
   *  这里的条目 id 是合成串（不是回收站目录名）⇒ 读 **raw** 算组：ledger 的对账会把它们当外人目录。
   *  这条用例集钉的是 purge 的组语义与执行顺序，对账已由 `tests/ledger.test.ts` 单独验穿。 */
  async function open() {
    const rows = await manifest.list()
    const scope = createTrashScope(rows, (plan) => executeRemoval(d, plan))
    // 这份作用域上的单条批执行：多条共用一个作用域的用例走它（carried / 收缩语义长在同一份视图上）。
    const purgeOn = (id: string) => runPurgeBatch(d, scope, rows, [id]).then(unwrap)
    // `/empty` 同构：全量一组 → 组内计划 → 一次批一扫 → 执行 → 批尾；回执 = stats + 尾读数。
    // 这里不复用生产的 `runEmptyBatch`：这些用例钉的是**同一份作用域**上的收缩语义，而那函数自开作用域
    //（`/empty` 的驱动序与进度 tick 由 `tests/api.test.ts` 经真 `runEmptyBatch` 端到端钉住）。
    const emptyAll = async () => {
      const plan = await planTrashRemoval(d, rows, rows)
      const batch = await planBatchImageAttachmentRemoval(d, [{ id: 'empty', dirs: plan.attachmentDirs }])
      const stats = await scope.purgeAll(plan)
      const tail = await executeAttachmentTail(d, batch)
      return { removed: stats.removed, freedBytes: stats.freedBytes, attachments: tail.run }
    }
    return { scope, purgeOn, emptyAll }
  }

  async function purge(entryId?: string) {
    const { purgeOn, emptyAll } = await open()
    return entryId === undefined ? await emptyAll() : await purgeOn(entryId)
  }

  return { calls: made.calls, fs, host, manifest, d, open, purge }
}

describe('彻底删除', () => {
  it('删一条：目录被移除、清单少一条、返回释放字节', async () => {
    const { fs, purge, manifest } = deps([trashEntry('a'), trashEntry('b')])
    const r = await purge('a')
    expect(r).toEqual({ removed: 1, freedBytes: 512, attachments: NOTHING_CLEANED })
    expect(fs.removeDir).toHaveBeenCalledTimes(1)
    expect(await manifest.list()).toHaveLength(1)
  })

  it('purgeAll = 清空：移除全部并移除各自的目录', async () => {
    const { fs, purge, manifest } = deps([trashEntry('a'), trashEntry('b')])
    const r = await purge()
    expect(r).toEqual({ removed: 2, freedBytes: 1024, attachments: NOTHING_CLEANED })
    expect(fs.removeDir).toHaveBeenCalledTimes(2)
    expect(await manifest.list()).toHaveLength(0)
  })

  it('purgeAll = 清空：空清册回零，不报 trash-empty', async () => {
    const { fs, purge } = deps([])
    const r = await purge()
    expect(r).toEqual({ removed: 0, freedBytes: 0, attachments: NOTHING_CLEANED })
    expect(fs.removeDir).not.toHaveBeenCalled()
  })

  // 彻底删除也必须把宿主内存里那一份请掉、并如实通告——否则文件与清单都没了，侧栏却还留着一行、还能点开
  //（真机上就是这个形状）。摘内存是尽力而为；通告只在知道宿主列表已经干净时才发。
  it('每条被彻底删除的会话都尽力从宿主内存里摘掉并通告移除', async () => {
    const { calls, purge } = deps([trashEntry('a'), trashEntry('b')])
    await purge()
    expect(calls).toEqual([
      'evictLive(a)', 'announceRemoved(a)',
      'evictLive(b)', 'announceRemoved(b)',
    ])
  })

  it('摘内存结果未知（unknown）时不发通告，彻底删除的结果不受影响', async () => {
    const { host, purge, manifest } = deps([trashEntry('a')])
    host.evictLive = vi.fn(async () => 'unknown' as const)
    const r = await purge('a')
    expect(r).toEqual({ removed: 1, freedBytes: 512, attachments: NOTHING_CLEANED })
    expect(await manifest.list()).toHaveLength(0)
    expect(host.evictLive).toHaveBeenCalledWith('a')
    expect(host.announceRemoved).not.toHaveBeenCalled()
  })

  it('条目不在清单里时报 trash-empty，且原文点名那条 id', async () => {
    const { purge } = deps([])
    const message: unknown = expect.stringContaining('nope')
    await expect(purge('nope')).rejects.toMatchObject({ code: 'sessiondelete/trash-empty', message })
  })

  it('目录已被手工删掉：仍移除清单行，不报错', async () => {
    const { fs, purge } = deps([trashEntry('a')])
    fs.exists.mockImplementation(async () => false)
    const r = await purge('a')
    expect(r.removed).toBe(1)
  })

  // 级联：彻底删除点的是**父那一行**（清单只列父行），所以整组都得走——留下孩子的行与目录，
  // 就等于让用户"彻底删除"之后又看见一堆点不到的行。
  it('彻底删除父 ⇒ 整组一起清（孩子的目录与行都跟着走）', async () => {
    const parent = { ...trashEntry('p'), title: '父' }
    const kidA = { ...trashEntry('kA'), parentEntryId: 'p' }
    const kidB = { ...trashEntry('kB'), parentEntryId: 'p' }
    const other = trashEntry('z')
    const { fs, purge, manifest } = deps([parent, kidA, kidB, other])
    const r = await purge('p')
    expect(r.removed).toBe(3)
    expect(fs.removeDir).toHaveBeenCalledTimes(3)
    const left = await manifest.list()
    expect(left.map(x => x.id)).toEqual(['z'])
  })

  it('按孩子的 id 单独彻底删除 ⇒ 只清它自己，父那一行留着', async () => {
    const parent = trashEntry('p')
    const kid = { ...trashEntry('k'), parentEntryId: 'p' }
    const { fs, purge } = deps([parent, kid])
    const r = await purge('k')
    expect(r.removed).toBe(1)
    expect(fs.removeDir).toHaveBeenCalledTimes(1)
  })

  // 级联落地前删掉的父：孩子在盘上还剩着，purge 必须收尾把它们一起清掉——先 unarchive（盘上后代
  // 本来没被删过，账本也可能是挂着的），再删目录；`removed` 与 `freedBytes` 都算上这些目录。
  it('盘上还剩的后代跟着一起清：先 unarchive，再删目录，字节与条数都算上', async () => {
    const { fs, host, calls, purge } = deps([trashEntry('p')])
    host.subagentMembersOf = vi.fn(async () => ({
      available: true as const,
      value: { p: [{ sessionId: 'session-kid', projectDir: '--p--' }] },
    }))
    const r = await purge('p')
    expect(r).toEqual({ removed: 2, freedBytes: 1024, attachments: NOTHING_CLEANED })
    expect(host.unarchive).toHaveBeenCalledWith('p')
    expect(host.unarchive).toHaveBeenCalledWith('session-kid')
    expect(fs.removeDir).toHaveBeenCalledWith(sessionDirOf('--p--', 'session-kid', HOME))
    expect(calls).toEqual([
      'evictLive(p)', 'announceRemoved(p)',
      'evictLive(session-kid)', 'announceRemoved(session-kid)',
    ])
  })

  // 独占图片在会话目录删完之后才清；附件字节单独走 `attachments`，不改 `freedBytes`。
  it('连带清理独占图片：先删目录再删对象，回执带附件读数', async () => {
    const { fs, purge } = deps([trashEntry('a')])
    const dir = trashDirOf('a', HOME)
    const order: string[] = []
    fs.listDirs.mockImplementation(async () => [])
    fs.listFiles.mockImplementation(async (p: string) => p === dir ? ['session.v4.jsonl.zstd'] : [])
    fs.readFile.mockImplementation(async () => imageLog())
    fs.statFile.mockImplementation(async (p: string) => ({ size: p === imagePath ? 7 : 0 }))
    fs.removeDir.mockImplementation(async (p: string) => { order.push(`removeDir:${p}`) })
    fs.removeFile.mockImplementation(async (p: string) => { order.push(`removeFile:${p}`) })

    const r = await purge('a')

    expect(r).toEqual({ removed: 1, freedBytes: 512, attachments: { removed: 1, freedBytes: 7, failed: 0 } })
    expect(order).toEqual([`removeDir:${dir}`, `removeFile:${imagePath}`])
  })

  // 语料看不见不是失败：这次只清清册里的那部分，盘上残留留给 `GET /orphans` 兜底（与 delete 的降级一致）。
  it('语料看不见（available:false）⇒ 静默降级，只清清册里的那一部分', async () => {
    const { fs, host, purge } = deps([trashEntry('p')])
    host.subagentMembersOf = vi.fn(async () => ({ available: false as const }))
    const r = await purge('p')
    expect(r).toEqual({ removed: 1, freedBytes: 512, attachments: NOTHING_CLEANED })
    expect(fs.removeDir).toHaveBeenCalledTimes(1)
    expect(host.unarchive).toHaveBeenCalledWith('p')
    expect(host.subagentMembersOf).toHaveBeenCalledTimes(1)
  })

  it('盘上后代在跑 ⇒ live，整个条目一条目录都不删，归档/账本/清册也零副作用', async () => {
    const { fs, host, purge, manifest } = deps([trashEntry('p')])
    host.subagentMembersOf = vi.fn(async () => ({
      available: true as const,
      value: { p: [{ sessionId: 'session-kid', projectDir: '--p--' }] },
    }))
    host.isLive = vi.fn(async (id: string) => id === 'session-kid')
    await expect(purge('p')).rejects.toMatchObject({ code: 'sessiondelete/live' })
    expect(fs.removeDir).not.toHaveBeenCalled()
    expect(host.unarchive).not.toHaveBeenCalled()
    expect(host.detach).not.toHaveBeenCalled()
    expect(await manifest.list()).toHaveLength(1)
  })

  // 迁移前后有意接受的差异（ADR-0027 决定 3；原 ADR-0006 行为差异第 1 条）：过去 purge 只查盘上后代，
  // target 自己在跑也照删；现在计划先查 targets、再查后代，任一在跑整条拒绝。
  it('target 自己在跑 ⇒ live，同样零副作用（目标不再能绕过活体准入）', async () => {
    const { fs, host, purge, manifest } = deps([trashEntry('p')])
    host.isLive = vi.fn(async (id: string) => id === 'p')
    await expect(purge('p')).rejects.toMatchObject({ code: 'sessiondelete/live' })
    expect(fs.removeDir).not.toHaveBeenCalled()
    expect(host.unarchive).not.toHaveBeenCalled()
    expect(host.detach).not.toHaveBeenCalled()
    expect(await manifest.list()).toHaveLength(1)
  })

  // 宿主目录段编码（`src/shared/session-path.ts`）：`../escape` 不是"响亮失败"，而是先编成安全段
  // `..~002Fescape` 再拼路径——寻址永远留在 `sessions/<项目>/` 下，递归删除带不出根外。
  it('盘上后代的 session id 非单段 ⇒ 编成安全目录段后照常清，路径留在 sessions/ 下', async () => {
    const { fs, host, purge, manifest } = deps([trashEntry('p')])
    host.subagentMembersOf = vi.fn(async () => ({
      available: true as const,
      value: { p: [{ sessionId: '../escape', projectDir: '--p--' }] },
    }))
    const result = await purge('p')
    const encodedDir = sessionDirOf('--p--', '..~002Fescape', HOME)
    expect(result.removed).toBe(2)
    expect(fs.removeDir).toHaveBeenCalledWith(encodedDir)
    expect(encodedDir.startsWith(`${HOME}/sessions/--p--/`)).toBe(true)
    // 一次都不拿原始 id 拼路径：被删的只有回收站条目目录与**项目目录内部**的成员目录
    //（`..` 只是编码段里的普通字符——整段不是 `.` / `..`，路径解析不会上跳）。
    for (const [dir] of fs.removeDir.mock.calls) {
      expect(dir === trashDirOf('p', HOME) || dir.startsWith(`${HOME}/sessions/--p--/`)).toBe(true)
    }
    expect(await manifest.list()).toHaveLength(0)
  })

  it('清册里已经有的孩子不按盘上后代重复删', async () => {
    const parent = trashEntry('p')
    const kid = { ...trashEntry('k'), parentEntryId: 'p' }
    const { fs, host, purge } = deps([parent, kid])
    host.subagentMembersOf = vi.fn(async () => ({
      available: true as const,
      value: { p: [{ sessionId: 'k', projectDir: '--p--' }] },
    }))
    await purge('p')
    expect(fs.removeDir).toHaveBeenCalledTimes(2) // p 与 k 的回收站目录，不是 3
    expect(fs.removeDir).not.toHaveBeenCalledWith(sessionDirOf('--p--', 'k', HOME))
  })

  // ADR-0001 的行为收口：此前这里是 `id === x || parentEntryId === x`，不认根行 ⇒ 在**嵌套组**
  // （父行自己也是孩子）上会把不属于这一组的孙代一起删掉，而彻底删除不可恢复。
  it('嵌套组（父自己也是孩子）⇒ 只清它自己，不连带孙代', async () => {
    const top = trashEntry('top')
    const mid = { ...trashEntry('mid'), parentEntryId: 'top' }
    const leaf = { ...trashEntry('leaf'), parentEntryId: 'mid' }
    const { fs, manifest, purge } = deps([top, mid, leaf])
    const r = await purge('mid')
    expect(r.removed).toBe(1)
    expect(fs.removeDir).toHaveBeenCalledTimes(1)
    expect((await manifest.list()).map(x => x.id).sort()).toEqual(['leaf', 'top'])
  })

  it('unarchive 失败 ⇒ io，目录与清册行都不动', async () => {
    const { fs, host, purge, manifest } = deps([trashEntry('p')])
    host.unarchive = vi.fn(async () => { throw new Error('archive boom') })
    await expect(purge('p')).rejects.toMatchObject({ code: 'sessiondelete/io' })
    expect(fs.removeDir).not.toHaveBeenCalled()
    expect(await manifest.list()).toHaveLength(1)
  })
})

describe('清册作用域：一份快照上的选面、选组与收缩', () => {
  const parent = trashEntry('p')
  const kid = { ...trashEntry('k'), parentEntryId: 'p' }

  it('同批第一条清完后，第二条 idempotent 回 {removed:0,freedBytes:0}（不带附件读数）', async () => {
    const { fs, open, manifest } = deps([parent, kid])
    const { purgeOn } = await open()
    const first = await purgeOn('p')
    expect(first.removed).toBe(2) // 父那一组：父 + 孩子
    const second = await purgeOn('k')
    // 与旧批量回执同形：这一趟没有附件读数，`attachments` 缺席，不拿零冒充"清过"。
    expect(second).toEqual({ removed: 0, freedBytes: 0 })
    expect(fs.removeDir).toHaveBeenCalledTimes(2)
    expect(await manifest.list()).toHaveLength(0)
  })

  it('absent（原始快照里就认不出）⇒ trash-empty 且原文点名 id，不当成"被带走"', async () => {
    const { open, fs } = deps([parent])
    const { purgeOn } = await open()
    const message: unknown = expect.stringContaining('ghost')
    await expect(purgeOn('ghost')).rejects.toMatchObject({ code: 'sessiondelete/trash-empty', message })
    expect(fs.removeDir).not.toHaveBeenCalled()
  })

  it('收缩视图按组摘：先清孩子再清父，父那一组不再连带已经清掉的孩子（经 purge 行为间接钉收缩）', async () => {
    const { fs, open } = deps([parent, kid])
    const { purgeOn } = await open()
    expect((await purgeOn('k')).removed).toBe(1)
    // 收缩若没发生，父那一组会把快照里还在的 kid 行再数一遍（removed 2）——这道断言钉的正是那一次收缩
    expect((await purgeOn('p')).removed).toBe(1)
    expect(fs.removeDir).toHaveBeenCalledTimes(2)
  })

  it('purgeAll 把全部行当一组递进执行器：一条都不剩', async () => {
    const { fs, manifest, open } = deps([parent, kid, trashEntry('z')])
    const { emptyAll } = await open()
    const r = await emptyAll()
    expect(r).toEqual({ removed: 3, freedBytes: 1536, attachments: NOTHING_CLEANED })
    expect(fs.removeDir).toHaveBeenCalledTimes(3)
    expect(await manifest.list()).toHaveLength(0)
  })

  it('purgeAll 之后收缩到底：同一作用域再 purge 走 carried 幂等', async () => {
    const { fs, open } = deps([trashEntry('a'), trashEntry('b')])
    const { emptyAll, purgeOn } = await open()
    await emptyAll()
    expect(await purgeOn('a')).toEqual({ removed: 0, freedBytes: 0 })
    expect(fs.removeDir).toHaveBeenCalledTimes(2)
  })
})

// 批预裁决面（「一次批一扫」的批驱动序第一步）：claimAll 在**输入序**上把每条裁成 fresh/carried/absent，
// 裁决视图按 claim 序演化——与逐条 claim 的判据同一份（`groups.ts` 的 `claimOf`），只是提前算干净。
describe('清册作用域：批预裁决（claimAll）与组执行（runGroup）', () => {
  const parent = trashEntry('p')
  const kid = { ...trashEntry('k'), parentEntryId: 'p' }

  it('claimAll 语义 = 依次逐条 claim：同批两条同组 ⇒ 后者 carried；幽灵 id ⇒ absent', async () => {
    const { open } = deps([parent, kid])
    const { scope } = await open()
    const claims = scope.claimAll([parent.id, kid.id, 'ghost'])
    // fresh 带整组（父那一组含孩子）；carried / 没有组可交。
    expect(claims.map((claim) => (claim.verdict === 'fresh' ? claim.group.map((row) => row.id) : claim.verdict))).toEqual([
      [parent.id, kid.id],
      'carried',
      'absent',
    ])
  })

  it('runGroup 成功后视图收缩：被带走的组在下一轮 claimAll 是 carried', async () => {
    const { d, fs, manifest, open } = deps([parent, kid])
    const { scope } = await open()
    const claim = scope.claimAll([parent.id])[0]
    const plan = await planTrashRemoval(d, await manifest.list(), claim?.verdict === 'fresh' ? claim.group : [])
    await scope.runGroup(plan)
    expect(scope.claimAll([kid.id]).map((c) => c.verdict)).toEqual(['carried'])
    expect(fs.removeDir).toHaveBeenCalledTimes(2)
  })

  it('runGroup 失败视图不动：这一组的后来者仍认领得到（第二波补跑的前提）', async () => {
    const { d, fs, manifest, open } = deps([parent, kid])
    const { scope } = await open()
    fs.removeDir.mockImplementation(async () => { throw new Error('boom') })
    const claim = scope.claimAll([parent.id])[0]
    const plan = await planTrashRemoval(d, await manifest.list(), claim?.verdict === 'fresh' ? claim.group : [])
    await expect(scope.runGroup(plan)).rejects.toMatchObject({ code: 'sessiondelete/io' })
    expect(scope.claimAll([kid.id]).map((c) => c.verdict)).toEqual(['fresh'])
    expect(fs.removeDir).toHaveBeenCalled()
  })
})

/**
 * 删的能力经类型表达（同 `PresenceCapability` 品牌门替换源码扫描的先例）：作用域只收清册快照与注入的执行器
 * ——连 deps 都不进手，purge 的删除只可能出自那注入的一支；假执行器记录收到的计划，
 * 假 fs 的 `removeDir` 一次都不该响（作用域自己没有删除路径）。
 */
describe('purge 只经注入的执行器动删', () => {
  it('作用域把计划原样递交给执行器，自己不碰 fs.removeDir', async () => {
    const { fs, d, manifest } = deps([trashEntry('a')])
    const received: RemovalPlan[] = []
    const fakeExecute = vi.fn(async (plan: RemovalPlan) => {
      received.push(plan)
      return { removed: plan.trash.length, freedBytes: plan.bytes }
    })
    const rows = await manifest.list()
    const scope = createTrashScope(rows, fakeExecute)
    const claim = scope.claimAll(['a'])[0]
    const plan = await planTrashRemoval(d, rows, claim?.verdict === 'fresh' ? claim.group : [])
    const r = await scope.runGroup(plan)
    // 回执就是执行器交回的那一份：作用域只做选组与收缩，不改写读数。
    expect(r).toEqual({ removed: 1, freedBytes: 512 })
    expect(fakeExecute).toHaveBeenCalledTimes(1)
    expect(received).toHaveLength(1)
    expect(received[0]?.kind).toBe('trash')
    expect(received[0]?.trash.map((row) => row.entry.id)).toEqual(['a'])
    // 假执行器没动盘：若作用域自己还有第二条删除路径，这一格就会响。
    expect(fs.removeDir).not.toHaveBeenCalled()
  })
})
