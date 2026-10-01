import { describe, expect, it, vi } from 'vitest'
import { purgeTrash } from '../src/verbs/purge-trash.js'
import { createMemoryManifest } from '../src/trash/manifest.js'
import type { TrashEntry } from '../src/trash/entry.js'

const HOME = '/h'
const e = (id: string): TrashEntry => ({
  id, sessionId: id, projectDir: '--p--', workspaceId: 'ws-1', wasArchived: false,
  deletedAt: 1, title: '', sizeBytes: 0,
})

function deps(seed: TrashEntry[]) {
  const fs = {
    exists: vi.fn(async () => true), rename: vi.fn(async () => {}),
    removeDir: vi.fn(async () => {}), sizeOfDir: vi.fn(async () => 512),
  }
  const calls: string[] = []
  const host = {
    workspaceOf: vi.fn(async () => 'ws-1'), projectDirOf: vi.fn(async () => '--p--'),
    isLive: vi.fn(async () => false), isArchived: vi.fn(async () => false),
    evictLive: vi.fn(async (sessionId: string) => { calls.push(`evictLive(${sessionId})`); return 'evicted' as const }),
    announceRemoved: vi.fn(async (sessionId: string) => { calls.push(`announceRemoved(${sessionId})`) }),
    announceRestored: vi.fn(async () => {}),
    unarchive: vi.fn(async () => {}), detach: vi.fn(async () => {}),
    attach: vi.fn(async () => {}), archive: vi.fn(async () => {}),
  }
  return { calls, fs, d: { fs, host, manifest: createMemoryManifest(seed), home: HOME, now: () => 0 } as never }
}

describe('彻底删除', () => {
  it('删一条：目录被移除、清单少一条、返回释放字节', async () => {
    const { d, fs } = deps([e('a'), e('b')])
    const r = await purgeTrash(d)('a')
    expect(r).toEqual({ removed: 1, freedBytes: 512 })
    expect(fs.removeDir).toHaveBeenCalledTimes(1)
    expect(await (d as never as { manifest: { list(): Promise<unknown[]> } }).manifest.list()).toHaveLength(1)
  })

  it('不传 entryId = 清空：移除全部并移除各自的目录', async () => {
    const { d, fs } = deps([e('a'), e('b')])
    const r = await purgeTrash(d)()
    expect(r.removed).toBe(2)
    expect(fs.removeDir).toHaveBeenCalledTimes(2)
    expect(await (d as never as { manifest: { list(): Promise<unknown[]> } }).manifest.list()).toHaveLength(0)
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
    const { d } = deps([e('a')])
    const host = (d as never as { host: { evictLive: ReturnType<typeof vi.fn>; announceRemoved: ReturnType<typeof vi.fn> } }).host
    host.evictLive = vi.fn(async () => 'unknown' as const)
    const r = await purgeTrash(d)('a')
    expect(r).toEqual({ removed: 1, freedBytes: 512 })
    expect(await (d as never as { manifest: { list(): Promise<unknown[]> } }).manifest.list()).toHaveLength(0)
    expect(host.evictLive).toHaveBeenCalledWith('a')
    expect(host.announceRemoved).not.toHaveBeenCalled()
  })

  it('条目不在清单里时报 trash-empty', async () => {
    const { d } = deps([])
    await expect(purgeTrash(d)('nope')).rejects.toMatchObject({ code: 'sessiondelete/trash-empty' })
  })

  it('目录已被手工删掉：仍移除清单行，不报错', async () => {
    const { d } = deps([e('a')])
    ;(d as never as { fs: { exists: ReturnType<typeof vi.fn> } }).fs.exists = vi.fn(async () => false)
    const r = await purgeTrash(d)('a')
    expect(r.removed).toBe(1)
  })
})
