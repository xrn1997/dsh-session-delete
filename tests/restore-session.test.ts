import { describe, expect, it, vi } from 'vitest'
import { restoreSession } from '../src/verbs/restore-session.js'
import { createMemoryManifest } from '../src/trash/manifest.js'
import { sessionDirOf, trashDirOf, type TrashEntry } from '../src/trash/entry.js'

const HOME = '/h'
const entry: TrashEntry = {
  id: '20260930T130500Z-session-abc', sessionId: 'session-abc',
  projectDir: '--C-develop-GitHub-dsh-ebook--', workspaceId: 'ws-1', wasArchived: true,
  deletedAt: Date.UTC(2026, 8, 30, 13, 5, 0),
  title: '会话标题', sizeBytes: 2048,
}
const trashDir = trashDirOf(entry.id, HOME)
const sessionDir = sessionDirOf(entry.projectDir, entry.sessionId, HOME)

function deps(over: Partial<{ dirExists: boolean }> = {}) {
  const calls: string[] = []
  const fs = {
    exists: vi.fn(async (p: string) => ('projectDir' in over ? false : true) && !p.includes('trash') ? (over.dirExists ?? true) : true),
    rename: vi.fn(async () => { calls.push('rename') }),
    removeDir: vi.fn(async () => {}), sizeOfDir: vi.fn(async () => 0),
  }
  const host = {
    workspaceOf: vi.fn(async () => 'ws-1'), projectDirOf: vi.fn(async () => entry.projectDir),
    isLive: vi.fn(async () => false), isArchived: vi.fn(async () => false),
    evictLive: vi.fn(async () => 'not-live' as const),
    announceRemoved: vi.fn(async () => { calls.push('announceRemoved') }),
    announceRestored: vi.fn(async () => { calls.push('announceRestored') }),
    unarchive: vi.fn(async () => { calls.push('unarchive') }),
    detach: vi.fn(async () => {}),
    attach: vi.fn(async () => { calls.push('attach') }),
    archive: vi.fn(async () => { calls.push('archive') }),
  }
  return { calls, d: { fs, host, manifest: createMemoryManifest([entry]), home: HOME, now: () => 0 } as never }
}

describe('恢复动词', () => {
  // 可见性由 wasArchived 反推：删除时"原本未归档"的会话是被我们归档才藏起来的，
  // 恢复就得把它放回树里；"原本已归档"的删前删后都在归档集里，恢复不该动它。
  // 删除时客户端那一行是**靠通告**掉下去的（宿主不再列出它），所以恢复也必须通告回来
  // ——用宿主自己列出来的那行摘要（`api-session/added`），不自己造一行。
  it('顺序固定为 rename → attach → unarchive → announceRestored（原本未归档的：放回树里）', async () => {
    const { d, calls } = deps()
    await (d as never as { manifest: { add(e: TrashEntry): Promise<void> } }).manifest.add({ ...entry, wasArchived: false })
    await restoreSession(d)(entry.id)
    expect(calls).toEqual(['rename', 'attach', 'unarchive', 'announceRestored'])
  })

  it('原本已归档的：恢复后仍处归档态，不动归档集', async () => {
    const { d, calls } = deps()
    await restoreSession(d)(entry.id)
    expect(calls).toEqual(['rename', 'attach', 'announceRestored'])
    expect((d as never as { host: { archive: ReturnType<typeof vi.fn>; unarchive: ReturnType<typeof vi.fn> } }).host.archive)
      .not.toHaveBeenCalled()
    expect((d as never as { host: { unarchive: ReturnType<typeof vi.fn> } }).host.unarchive).not.toHaveBeenCalled()
  })

  // 删除时就没有工作区账目的会话（未分组），清单里记空串 ⇒ 恢复没有账本可挂，只把文件与可见性还原。
  it('未分组会话（清单里工作区是空串）恢复时不挂账本', async () => {
    const { d, calls } = deps()
    const manifest = (d as never as { manifest: { add(e: TrashEntry): Promise<void> } }).manifest
    await manifest.add({ ...entry, wasArchived: false, workspaceId: '' })
    await restoreSession(d)(entry.id)
    expect(calls).toEqual(['rename', 'unarchive', 'announceRestored'])
    expect((d as never as { host: { attach: ReturnType<typeof vi.fn> } }).host.attach).not.toHaveBeenCalled()
  })

  it('未分组 + 取消归档失败：回滚里没有摘账本那一步', async () => {
    const { d, calls } = deps()
    const manifest = (d as never as { manifest: { add(e: TrashEntry): Promise<void> } }).manifest
    await manifest.add({ ...entry, wasArchived: false, workspaceId: '' })
    const host = (d as never as { host: { unarchive: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> } }).host
    host.unarchive = vi.fn(async () => { throw new Error('unarchive boom') })
    const rename = (d as never as { fs: { rename: ReturnType<typeof vi.fn> } }).fs.rename
    await expect(restoreSession(d)(entry.id)).rejects.toMatchObject({ code: 'sessiondelete/io' })
    expect(calls).toEqual(['rename', 'archive', 'rename'])
    expect(host.detach).not.toHaveBeenCalled()
    expect(rename.mock.calls).toEqual([[trashDir, sessionDir], [sessionDir, trashDir]])
    expect(await (d as never as { manifest: { list(): Promise<unknown[]> } }).manifest.list()).toHaveLength(1)
  })

  it('清单里没有该条目时报 trash-empty', async () => {
    const { d } = deps()
    await expect(restoreSession(d)('nope')).rejects.toMatchObject({ code: 'sessiondelete/trash-empty' })
  })

  it('目标项目目录不存在时报 project-missing，且不静默建目录', async () => {
    const { d } = deps()
    ;(d as never as { fs: { exists: ReturnType<typeof vi.fn> } }).fs.exists = vi.fn(async (p: string) => !p.endsWith('/sessions'))
    await expect(restoreSession(d)(entry.id)).rejects.toMatchObject({ code: 'sessiondelete/project-missing' })
  })

  it('恢复成功后清单里不再有它，账本挂回原工作区', async () => {
    const { d } = deps()
    await restoreSession(d)(entry.id)
    expect(await (d as never as { manifest: { list(): Promise<unknown[]> } }).manifest.list()).toHaveLength(0)
    expect((d as never as { host: { attach: ReturnType<typeof vi.fn> } }).host.attach)
      .toHaveBeenCalledWith('session-abc', 'ws-1')
  })

  it('attach 失败即把会话目录放回回收站，并把原始错误带出', async () => {
    const { d } = deps()
    ;(d as never as { host: { attach: ReturnType<typeof vi.fn> } }).host.attach =
      vi.fn(async () => { throw new Error('ledger boom') })
    const rename = (d as never as { fs: { rename: ReturnType<typeof vi.fn> } }).fs.rename
    await expect(restoreSession(d)(entry.id)).rejects.toMatchObject({
      code: 'sessiondelete/io', cause: expect.objectContaining({ message: 'ledger boom' }),
    })
    expect(rename.mock.calls).toEqual([[trashDir, sessionDir], [sessionDir, trashDir]])
    expect(await (d as never as { manifest: { list(): Promise<unknown[]> } }).manifest.list()).toHaveLength(1)
  })

  it('取消归档失败即整体回退：重新归档（藏回去）+ 摘账本 + 目录回回收站，清单行仍留着', async () => {
    const { d, calls } = deps()
    await (d as never as { manifest: { add(e: TrashEntry): Promise<void> } }).manifest.add({ ...entry, wasArchived: false })
    const host = (d as never as { host: { unarchive: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> } }).host
    host.unarchive = vi.fn(async () => { throw new Error('unarchive boom') })
    const rename = (d as never as { fs: { rename: ReturnType<typeof vi.fn> } }).fs.rename
    await expect(restoreSession(d)(entry.id)).rejects.toMatchObject({
      code: 'sessiondelete/io', cause: expect.objectContaining({ message: 'unarchive boom' }),
    })
    // 末尾那个 rename 是回滚（目录放回回收站），下一行按 rename 的两对入参逐对核对
    expect(calls).toEqual(['rename', 'attach', 'archive', 'rename'])
    expect(host.detach).toHaveBeenCalledWith('session-abc', 'ws-1')
    expect(rename.mock.calls).toEqual([[trashDir, sessionDir], [sessionDir, trashDir]])
    expect(await (d as never as { manifest: { list(): Promise<unknown[]> } }).manifest.list()).toHaveLength(1)
  })

  // 摘清单行同样是最后一件写：它失败也要把前面几步退回去，否则回收站里会留一条
  // 「恢复不了也清不掉的幽灵行」（目录已经回了 `sessions/`，行却还在回收站里挂着）。
  it('摘清单行失败即整体回退：重新归档 + 摘账本 + 目录放回回收站', async () => {
    const { d, calls } = deps()
    const manifest = (d as never as {
      manifest: { add(e: TrashEntry): Promise<void>; remove(id: string): Promise<void> }
    }).manifest
    await manifest.add({ ...entry, wasArchived: false })
    manifest.remove = vi.fn(async () => { throw new Error('storage boom') })
    const host = (d as never as { host: { detach: ReturnType<typeof vi.fn> } }).host
    const rename = (d as never as { fs: { rename: ReturnType<typeof vi.fn> } }).fs.rename
    await expect(restoreSession(d)(entry.id)).rejects.toMatchObject({
      code: 'sessiondelete/io', cause: expect.objectContaining({ message: 'storage boom' }),
    })
    // 反向：archive 藏回去 → detach 摘账本 → rename 把目录放回回收站（detach 不在 calls 里，见夹具）
    expect(calls).toEqual(['rename', 'attach', 'unarchive', 'archive', 'rename'])
    expect(host.detach).toHaveBeenCalledWith('session-abc', 'ws-1')
    expect(rename.mock.calls).toEqual([[trashDir, sessionDir], [sessionDir, trashDir]])
    expect(await (d as never as { manifest: { list(): Promise<unknown[]> } }).manifest.list()).toHaveLength(1)
  })
})
