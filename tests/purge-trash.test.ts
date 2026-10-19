import { describe, expect, it, vi } from 'vitest'
import { purgeTrash } from '../src/verbs/purge-trash.js'
import { sessionDirOf, type TrashEntry } from '../src/trash/entry.js'
import { createFakeDeps } from './support/fake-deps.js'

const HOME = '/h'
const e = (id: string): TrashEntry => ({
  id, sessionId: id, projectDir: '--p--', workspaceId: 'ws-1', wasArchived: false,
  deletedAt: 1, title: '', sizeBytes: 0,
})

/** 内存里那第二个 adapter（`tests/support/fake-deps.ts`）：世界由参数描述，不再自己凑端口。
 *  日志只记 evictLive / announceRemoved 两件——彻底删除对宿主内存做的事就这两件。 */
function deps(seed: TrashEntry[]) {
  const calls: string[] = []
  const { deps: d, fs, host, manifest } = createFakeDeps({
    seed,
    fs: { size: 512 },
    log: calls,
    logMethods: ['evictLive', 'announceRemoved'],
    format: (method, args) => `${method}(${String(args[0])})`,
  })
  return { calls, fs, host, manifest, d }
}

describe('彻底删除', () => {
  it('删一条：目录被移除、清单少一条、返回释放字节', async () => {
    const { d, fs } = deps([e('a'), e('b')])
    const r = await purgeTrash(d)('a')
    expect(r).toEqual({ removed: 1, freedBytes: 512 })
    expect(fs.removeDir).toHaveBeenCalledTimes(1)
    expect(await d.manifest.list()).toHaveLength(1)
  })

  it('不传 entryId = 清空：移除全部并移除各自的目录', async () => {
    const { d, fs } = deps([e('a'), e('b')])
    const r = await purgeTrash(d)()
    expect(r.removed).toBe(2)
    expect(fs.removeDir).toHaveBeenCalledTimes(2)
    expect(await d.manifest.list()).toHaveLength(0)
  })

  // 彻底删除也必须把宿主内存里那一份请掉、并如实通告——否则文件与清单都没了，侧栏却还留着一行、还能点开
  //（真机上就是这个形状）。摘内存是尽力而为；通告只在知道宿主列表已经干净时才发。
  it('每条被彻底删除的会话都尽力从宿主内存里摘掉并通告移除', async () => {
    const { d, calls } = deps([e('a'), e('b')])
    await purgeTrash(d)()
    expect(calls).toEqual([
      'evictLive(a)', 'announceRemoved(a)',
      'evictLive(b)', 'announceRemoved(b)',
    ])
  })

  it('摘内存结果未知（unknown）时不发通告，彻底删除的结果不受影响', async () => {
    const { d, host } = deps([e('a')])
    host.evictLive = vi.fn(async () => 'unknown' as const)
    const r = await purgeTrash(d)('a')
    expect(r).toEqual({ removed: 1, freedBytes: 512 })
    expect(await d.manifest.list()).toHaveLength(0)
    expect(host.evictLive).toHaveBeenCalledWith('a')
    expect(host.announceRemoved).not.toHaveBeenCalled()
  })

  it('条目不在清单里时报 trash-empty', async () => {
    const { d } = deps([])
    await expect(purgeTrash(d)('nope')).rejects.toMatchObject({ code: 'sessiondelete/trash-empty' })
  })

  it('目录已被手工删掉：仍移除清单行，不报错', async () => {
    const { d } = deps([e('a')])
    ;d.fs.exists.mockImplementation(async () => false)
    const r = await purgeTrash(d)('a')
    expect(r.removed).toBe(1)
  })

  // 级联：彻底删除点的是**父那一行**（清单只列父行），所以整组都得走——留下孩子的行与目录，
  // 就等于让用户"彻底删除"之后又看见一堆点不到的行。
  it('彻底删除父 ⇒ 整组一起清（孩子的目录与行都跟着走）', async () => {
    const parent = { ...e('p'), title: '父' }
    const kidA = { ...e('kA'), parentEntryId: 'p' }
    const kidB = { ...e('kB'), parentEntryId: 'p' }
    const other = e('z')
    const { d, fs } = deps([parent, kidA, kidB, other])
    const r = await purgeTrash(d)('p')
    expect(r.removed).toBe(3)
    expect(fs.removeDir).toHaveBeenCalledTimes(3)
    const left = await d.manifest.list()
    expect(left.map(x => x.id)).toEqual(['z'])
  })

  it('按孩子的 id 单独彻底删除 ⇒ 只清它自己，父那一行留着', async () => {
    const parent = e('p')
    const kid = { ...e('k'), parentEntryId: 'p' }
    const { d, fs } = deps([parent, kid])
    const r = await purgeTrash(d)('k')
    expect(r.removed).toBe(1)
    expect(fs.removeDir).toHaveBeenCalledTimes(1)
  })

  // 级联落地前删掉的父：孩子在盘上还剩着，purge 必须收尾把它们一起清掉——先 unarchive（盘上后代
  // 本来没被删过，账本也可能是挂着的），再删目录；`removed` 与 `freedBytes` 都算上这些目录。
  it('盘上还剩的后代跟着一起清：先 unarchive，再删目录，字节与条数都算上', async () => {
    const { d, fs, host } = deps([e('p')])
    host.subagentMembersBatch = vi.fn(async () => ({
      p: [{ sessionId: 'session-kid', projectDir: '--p--' }],
    }))
    const r = await purgeTrash(d)('p')
    expect(r).toEqual({ removed: 2, freedBytes: 1024 })
    expect(host.unarchive).toHaveBeenCalledWith('p')
    expect(host.unarchive).toHaveBeenCalledWith('session-kid')
    expect(fs.removeDir).toHaveBeenCalledWith(sessionDirOf('--p--', 'session-kid', HOME))
  })

  it('盘上后代在跑 ⇒ live，整个条目一条目录都不删，归档/账本/清册也零副作用', async () => {
    const { d, fs, host } = deps([e('p')])
    host.subagentMembersBatch = vi.fn(async () => ({
      p: [{ sessionId: 'session-kid', projectDir: '--p--' }],
    }))
    host.isLive = vi.fn(async (id: string) => id === 'session-kid')
    await expect(purgeTrash(d)('p')).rejects.toMatchObject({ code: 'sessiondelete/live' })
    expect(fs.removeDir).not.toHaveBeenCalled()
    expect(host.unarchive).not.toHaveBeenCalled()
    expect(host.detach).not.toHaveBeenCalled()
    expect(await d.manifest.list()).toHaveLength(1)
  })

  it('盘上后代的 session id 非单段 ⇒ 响亮失败，不删任何目录', async () => {
    const { d, fs, host } = deps([e('p')])
    host.subagentMembersBatch = vi.fn(async () => ({
      p: [{ sessionId: '../escape', projectDir: '--p--' }],
    }))
    await expect(purgeTrash(d)('p')).rejects.toThrow(/不是单段路径/)
    expect(fs.removeDir).not.toHaveBeenCalled()
    expect(await d.manifest.list()).toHaveLength(1)
  })

  it('清册里已经有的孩子不按盘上后代重复删', async () => {
    const parent = e('p')
    const kid = { ...e('k'), parentEntryId: 'p' }
    const { d, fs, host } = deps([parent, kid])
    host.subagentMembersBatch = vi.fn(async () => ({
      p: [{ sessionId: 'k', projectDir: '--p--' }],
    }))
    await purgeTrash(d)('p')
    expect(fs.removeDir).toHaveBeenCalledTimes(2) // p 与 k 的回收站目录，不是 3
    expect(fs.removeDir).not.toHaveBeenCalledWith(sessionDirOf('--p--', 'k', HOME))
  })

  // ADR-0001 的行为收口：此前这里是 `id === x || parentEntryId === x`，不认根行 ⇒ 在**嵌套组**
  // （父行自己也是孩子）上会把不属于这一组的孙代一起删掉，而彻底删除不可恢复。
  it('嵌套组（父自己也是孩子）⇒ 只清它自己，不连带孙代', async () => {
    const top = e('top')
    const mid = { ...e('mid'), parentEntryId: 'top' }
    const leaf = { ...e('leaf'), parentEntryId: 'mid' }
    const { d, fs, manifest } = deps([top, mid, leaf])
    const r = await purgeTrash(d)('mid')
    expect(r.removed).toBe(1)
    expect(fs.removeDir).toHaveBeenCalledTimes(1)
    expect((await manifest.list()).map(x => x.id).sort()).toEqual(['leaf', 'top'])
  })

  it('unarchive 失败 ⇒ io，目录与清册行都不动', async () => {
    const { d, fs, host } = deps([e('p')])
    host.unarchive = vi.fn(async () => { throw new Error('archive boom') })
    await expect(purgeTrash(d)('p')).rejects.toMatchObject({ code: 'sessiondelete/io' })
    expect(fs.removeDir).not.toHaveBeenCalled()
    expect(await d.manifest.list()).toHaveLength(1)
  })
})
