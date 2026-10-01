import { describe, expect, it, vi } from 'vitest'
import { deleteSession } from '../src/verbs/delete-session.js'
import { createMemoryManifest } from '../src/trash/manifest.js'
import { sessionDirOf, trashDirOf } from '../src/trash/entry.js'

const HOME = '/h'
function deps(over: Record<string, unknown> = {}) {
  const calls: string[] = []
  const fs = {
    exists: vi.fn(async () => true),
    rename: vi.fn(async (a: string, b: string) => { calls.push('rename'); void a; void b }),
    removeDir: vi.fn(async () => {}),
    ensureDir: vi.fn(async () => {}),
    sizeOfDir: vi.fn(async () => 1024),
  }
  const host = {
    workspaceOf: vi.fn(async () => 'ws-1'),
    projectDirOf: vi.fn(async () => '--C-develop-GitHub-dsh-ebook--'),
    titleOf: vi.fn(async () => '会话标题'),
    isLive: vi.fn(async () => false),
    isArchived: vi.fn(async () => false),
    evictLive: vi.fn(async () => { calls.push('evictLive'); return 'evicted' as const }),
    announceRemoved: vi.fn(async () => { calls.push('announceRemoved') }),
    announceRestored: vi.fn(async () => { calls.push('announceRestored') }),
    unarchive: vi.fn(async () => { calls.push('unarchive') }),
    detach: vi.fn(async () => { calls.push('detach') }),
    attach: vi.fn(async () => { calls.push('attach') }),
    archive: vi.fn(async () => { calls.push('archive') }),
  }
  return { calls, deps: { fs, host, manifest: createMemoryManifest(), home: HOME, now: () => Date.UTC(2026, 8, 30, 13, 5, 0), ...over } as never }
}

// 回滚断言要能看见反向调用，所以把错误连 cause 一起取出来
async function failureOf(d: unknown, sessionId: string) {
  try {
    await deleteSession(d as never)(sessionId)
  } catch (error) {
    return error as Error & { code?: string; cause?: unknown }
  }
  throw new Error('expected deleteSession to reject')
}

describe('删除动词', () => {
  it('运行中的会话一律拒绝，且不产生任何写操作', async () => {
    const { deps: d, calls } = deps()
    ;(d as never as { host: { isLive: ReturnType<typeof vi.fn> } }).host.isLive = vi.fn(async () => true)
    await expect(deleteSession(d)('session-abc')).rejects.toMatchObject({ code: 'sessiondelete/live' })
    expect(calls).toEqual([])
    const w = d as never as { host: { archive: ReturnType<typeof vi.fn>; unarchive: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> }; fs: { rename: ReturnType<typeof vi.fn> } }
    expect(w.host.archive).not.toHaveBeenCalled()
    expect(w.host.unarchive).not.toHaveBeenCalled()
    expect(w.host.detach).not.toHaveBeenCalled()
    expect(w.fs.rename).not.toHaveBeenCalled()
  })

  // 归档在摘账本与动文件之前：删除后会话必须**一上来就被挡在分组面外**。
  // 反过来的话，detach 与归档之间会有一段"无主且可见"的窗口，客户端正好把它派生成「未分组」
  // ——真机上就是这个形状（会话文件已进回收站、账本已摘，侧栏却留着一行在未分组下）。
  // 收尾两步才是"让它从客户端那一行里也消失"：evictLive 摘掉宿主的活体，
  // announceRemoved 把这件事**如实通告**给客户端（宿主自己的转发事件 `api-session/removed`，
  // 冷会话没有活体可摘、但同样需要这一条通告——否则客户端那一行要等到重连才消失）。
  it('顺序固定为 archive → detach → rename → evictLive → announceRemoved', async () => {
    const { deps: d, calls } = deps()
    await deleteSession(d)('session-abc')
    expect(calls).toEqual(['archive', 'detach', 'rename', 'evictLive', 'announceRemoved'])
  })

  it('删除前已归档的会话不动归档集，清单里记下"原本就是归档态"', async () => {
    const { deps: d, calls } = deps()
    ;(d as never as { host: { isArchived: ReturnType<typeof vi.fn> } }).host.isArchived = vi.fn(async () => true)
    const entry = await deleteSession(d)('session-abc')
    expect(calls).toEqual(['detach', 'rename', 'evictLive', 'announceRemoved'])
    expect(entry).toMatchObject({ wasArchived: true })
  })

  it('rename 失败即回滚已摘的账本与归档态，并把原始错误带出', async () => {
    const { deps: d, calls } = deps()
    const boom = new Error('EXDEV')
    ;(d as never as { fs: { rename: ReturnType<typeof vi.fn> } }).fs.rename = vi.fn(async () => { calls.push('rename'); throw boom })
    const err = await failureOf(d, 'session-abc')
    expect(err).toMatchObject({ code: 'sessiondelete/io' })
    expect(err.cause).toBe(boom)
    // 反向调用序：attach 挂回账本 + unarchive 复原可见性（wasArchived: false ⇒ 归档是我们加的）
    expect(calls).toEqual(['archive', 'detach', 'rename', 'attach', 'unarchive'])
  })

  // 清单登记是最后一件写：它失败也必须把归档 / 账本 / 文件全部退回去，否则会话就成了
  // 「文件在回收站里、面板却看不见」的孤儿（设计稿 §5 的"不做删一半的状态"）。
  it('清单登记失败即整体回退：目录搬回原处、账本挂回、归档态还原', async () => {
    const { deps: d, calls } = deps()
    const boom = new Error('storage boom')
    ;(d as never as { manifest: { add(entry: unknown): Promise<void> } }).manifest.add =
      vi.fn(async () => { throw boom })
    const err = await failureOf(d, 'session-abc')
    expect(err).toMatchObject({ code: 'sessiondelete/io' })
    expect(err.cause).toBe(boom)
    expect(calls).toEqual(['archive', 'detach', 'rename', 'rename', 'attach', 'unarchive'])
    const rename = (d as never as { fs: { rename: ReturnType<typeof vi.fn> } }).fs.rename
    expect(rename.mock.calls).toEqual([
      [sessionDirOf('--C-develop-GitHub-dsh-ebook--', 'session-abc', HOME),
        trashDirOf('20260930T130500Z-session-abc', HOME)],
      [trashDirOf('20260930T130500Z-session-abc', HOME),
        sessionDirOf('--C-develop-GitHub-dsh-ebook--', 'session-abc', HOME)],
    ])
  })

  it('detach 失败即复原归档态，文件一动不动', async () => {
    const { deps: d, calls } = deps()
    const boom = new Error('detach boom')
    ;(d as never as { host: { detach: ReturnType<typeof vi.fn> } }).host.detach = vi.fn(async () => { calls.push('detach'); throw boom })
    const err = await failureOf(d, 'session-abc')
    expect(err).toMatchObject({ code: 'sessiondelete/io' })
    expect(err.cause).toBe(boom)
    expect(calls).toEqual(['archive', 'detach', 'unarchive'])
    expect((d as never as { fs: { rename: ReturnType<typeof vi.fn> } }).fs.rename).not.toHaveBeenCalled()
  })

  it('archive 失败时报 io，还是第一步，无需回滚也不动后续', async () => {
    const { deps: d, calls } = deps()
    const boom = new Error('archive boom')
    ;(d as never as { host: { archive: ReturnType<typeof vi.fn> } }).host.archive = vi.fn(async () => { calls.push('archive'); throw boom })
    const err = await failureOf(d, 'session-abc')
    expect(err).toMatchObject({ code: 'sessiondelete/io' })
    expect(err.cause).toBe(boom)
    expect(calls).toEqual(['archive'])
    expect((d as never as { host: { detach: ReturnType<typeof vi.fn> } }).host.detach).not.toHaveBeenCalled()
    expect((d as never as { fs: { rename: ReturnType<typeof vi.fn> } }).fs.rename).not.toHaveBeenCalled()
  })

  it('三件纯读失败即退出，不留下任何写过的痕迹（读在写之前）', async () => {
    const { deps: d, calls } = deps()
    const boom = new Error('读取标题失败')
    ;(d as never as { host: { titleOf: ReturnType<typeof vi.fn> } }).host.titleOf = vi.fn(async () => { throw boom })
    const err = await failureOf(d, 'session-abc')
    expect(err).toMatchObject({ code: 'sessiondelete/io' })
    expect(err.cause).toBe(boom)
    expect(calls).toEqual([])
  })

  it('成功后清单里有且只有一条，记录了原目录名、工作区与归档态', async () => {
    const { deps: d } = deps()
    const entry = await deleteSession(d)('session-abc')
    expect(entry).toMatchObject({
      id: '20260930T130500Z-session-abc', sessionId: 'session-abc',
      projectDir: '--C-develop-GitHub-dsh-ebook--', workspaceId: 'ws-1', wasArchived: false,
      title: '会话标题', sizeBytes: 1024,
    })
    expect(await (d as never as { manifest: { list(): Promise<unknown[]> } }).manifest.list()).toHaveLength(1)
  })

  // 未分组的会话（宿主自己的"删除工作区"就会造出这种：目录与日志都留着，只是没有账目）
  // 照样可删：账本那一步没有可摘的东西，清单里把工作区记成空串，恢复时也不再挂账本。
  it('未分组的会话照样能删：不摘账本，清单里工作区记空串', async () => {
    const { deps: d, calls } = deps()
    ;(d as never as { host: { workspaceOf: ReturnType<typeof vi.fn> } }).host.workspaceOf = vi.fn(async () => undefined)
    const entry = await deleteSession(d)('session-abc')
    expect(calls).toEqual(['archive', 'rename', 'evictLive', 'announceRemoved'])
    expect(entry).toMatchObject({ workspaceId: '', wasArchived: false })
  })

  it('未分组 + 已归档：只动文件', async () => {
    const { deps: d, calls } = deps()
    const host = (d as never as { host: { workspaceOf: ReturnType<typeof vi.fn>; isArchived: ReturnType<typeof vi.fn> } }).host
    host.workspaceOf = vi.fn(async () => undefined)
    host.isArchived = vi.fn(async () => true)
    const entry = await deleteSession(d)('session-abc')
    expect(calls).toEqual(['rename', 'evictLive', 'announceRemoved'])
    expect(entry).toMatchObject({ workspaceId: '', wasArchived: true })
  })

  it('未分组 + rename 失败：只撤销归档，不回挂账本', async () => {
    const { deps: d, calls } = deps()
    ;(d as never as { host: { workspaceOf: ReturnType<typeof vi.fn> } }).host.workspaceOf = vi.fn(async () => undefined)
    const boom = new Error('EXDEV')
    ;(d as never as { fs: { rename: ReturnType<typeof vi.fn> } }).fs.rename = vi.fn(async () => { calls.push('rename'); throw boom })
    const err = await failureOf(d, 'session-abc')
    expect(err).toMatchObject({ code: 'sessiondelete/io' })
    expect(calls).toEqual(['archive', 'rename', 'unarchive'])
    expect((d as never as { host: { attach: ReturnType<typeof vi.fn> } }).host.attach).not.toHaveBeenCalled()
  })

  it('只有推不出项目目录（账本 header 里查不到）才判 not-found，且零副作用', async () => {
    const { deps: d, calls } = deps()
    ;(d as never as { host: { projectDirOf: ReturnType<typeof vi.fn> } }).host.projectDirOf = vi.fn(async () => undefined)
    await expect(deleteSession(d)('session-abc')).rejects.toMatchObject({ code: 'sessiondelete/not-found' })
    expect(calls).toEqual([])
  })

  // 通告只在**知道宿主列表已经干净**时才发：`unknown`（live store 读不到 / 形状不符 / detach 抛）
  // 意味着它可能还活着、还挂在列表上，这时候发"已移除"就是假话（重连后那一行会自己长回来）。
  // 请不动也不影响删除结果——端口契约是不抛。
  it('摘内存结果未知（unknown）时不发移除通告，删除照样成功', async () => {
    const { deps: d } = deps()
    const host = (d as never as { host: { evictLive: ReturnType<typeof vi.fn>; announceRemoved: ReturnType<typeof vi.fn> } }).host
    host.evictLive = vi.fn(async () => 'unknown' as const)
    const entry = await deleteSession(d)('session-abc')
    expect(entry).toMatchObject({ sessionId: 'session-abc', workspaceId: 'ws-1' })
    expect(await (d as never as { manifest: { list(): Promise<unknown[]> } }).manifest.list()).toHaveLength(1)
    expect(host.evictLive).toHaveBeenCalledWith('session-abc')
    expect(host.announceRemoved).not.toHaveBeenCalled()
  })

  it('会话目录不存在时报 not-found，不静默当作成功', async () => {
    const { deps: d } = deps()
    ;(d as never as { fs: { exists: ReturnType<typeof vi.fn> } }).fs.exists = vi.fn(async () => false)
    await expect(deleteSession(d)('session-abc')).rejects.toMatchObject({ code: 'sessiondelete/not-found' })
  })
})
