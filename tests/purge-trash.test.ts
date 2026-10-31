import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { purgeTrash } from '../src/verbs/purge-trash.js'
import { attachmentPathOf } from '../src/trash/attachments.js'
import { sessionDirOf, trashDirOf, type TrashEntry } from '../src/trash/entry.js'
import { groupOf } from '../src/trash/groups.js'
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

  /** 直调路径自己按清册算组；批量层由 `batch-carried.ts` 递下来。
   *  这里的条目 id 是合成串（不是回收站目录名）⇒ 读 **raw** 算组：ledger 的对账会把它们当外人目录。
   *  这条用例集钉的是 purge 的组语义与执行顺序，对账已由 `tests/ledger.test.ts` 单独验穿。 */
  async function purge(entryId?: string) {
    const rows = await manifest.list()
    return await purgeTrash(d)(entryId === undefined ? undefined : groupOf(rows, entryId), rows, entryId)
  }

  return { calls: made.calls, fs, host, manifest, d, purge }
}

describe('彻底删除', () => {
  it('删一条：目录被移除、清单少一条、返回释放字节', async () => {
    const { fs, purge, manifest } = deps([trashEntry('a'), trashEntry('b')])
    const r = await purge('a')
    expect(r).toEqual({ removed: 1, freedBytes: 512, attachments: NOTHING_CLEANED })
    expect(fs.removeDir).toHaveBeenCalledTimes(1)
    expect(await manifest.list()).toHaveLength(1)
  })

  it('不传 entryId = 清空：移除全部并移除各自的目录', async () => {
    const { fs, purge, manifest } = deps([trashEntry('a'), trashEntry('b')])
    const r = await purge()
    expect(r.removed).toBe(2)
    expect(fs.removeDir).toHaveBeenCalledTimes(2)
    expect(await manifest.list()).toHaveLength(0)
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

  it('条目不在清单里时报 trash-empty', async () => {
    const { purge } = deps([])
    await expect(purge('nope')).rejects.toMatchObject({ code: 'sessiondelete/trash-empty' })
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

  it('盘上后代的 session id 非单段 ⇒ 响亮失败，不删任何目录', async () => {
    const { fs, host, purge, manifest } = deps([trashEntry('p')])
    host.subagentMembersOf = vi.fn(async () => ({
      available: true as const,
      value: { p: [{ sessionId: '../escape', projectDir: '--p--' }] },
    }))
    await expect(purge('p')).rejects.toThrow(/不是单段路径/)
    expect(fs.removeDir).not.toHaveBeenCalled()
    expect(await manifest.list()).toHaveLength(1)
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

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')

/**
 * 委托结构护栏：删目录与在场通告已由能力面守住；这里只钉「选完目标后把顺序交给执行器」，
 * 防止 purge 再长出一段自己的删除序列（能力面给不了「不要自己调」这条）。
 */
describe('purge 把删除顺序交给执行器', () => {
  it('选完目标之后直接接上计划与执行器', () => {
    const text = readFileSync(join(ROOT, 'src/verbs/purge-trash.ts'), 'utf8')
    expect(text).not.toContain('deps.fs.removeDir')
    expect(text).not.toContain('createJournal')
    expect(text).toContain('planTrashRemoval(')
    expect(text).toContain('executeRemoval(')
  })
})
