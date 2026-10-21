import { describe, expect, it, vi } from 'vitest'
import { deleteSession } from '../src/verbs/delete-session.js'
import { makeEntryId, sessionDirOf, trashDirOf } from '../src/trash/entry.js'
import { createFakeDeps, type FakeDeps, type FakeDepsOptions, type FakeFs, type FakeHost } from './support/fake-deps.js'

const HOME = '/h'
/** 内存里那第二个 adapter（`tests/support/fake-deps.ts`）：17 个宿主方法一次到位，用例只描述世界。
 *  日志按**发生顺序**记 fs 与 host 两端——删除的顺序（摘账本 → 搬目录 → 摘活体 → 通告）是一条断言。
 *  **删除不碰归档**：回收站与归档解耦；活体靠 `evictLive`（session + agent）离开宿主。 */
function deps(over: {
  host?: Partial<FakeHost>
  fs?: Partial<FakeFs>
  /** 父 → 盘上后代（`subagentMembersOf` 的值）；缺席的父回空表。 */
  members?: FakeDepsOptions['members']
  /** `false` = 语料看不见（`subagentMembersOf` 回 `{ available:false }`）。 */
  membersAvailable?: boolean
} = {}) {
  const calls: string[] = []
  const made = createFakeDeps({
    now: Date.UTC(2026, 8, 30, 13, 5, 0),
    projectDirOf: '--C-develop-GitHub-dsh-ebook--',
    members: over.members,
    membersAvailable: over.membersAvailable,
    log: calls,
    logMethods: ['archive', 'detach', 'unarchive', 'attach', 'evictLive', 'announceRemoved', 'announceRestored', 'rename'],
  })
  Object.assign(made.host, over.host)
  Object.assign(made.fs, over.fs)
  return { calls, fs: made.fs, host: made.host, manifest: made.manifest, deps: made.deps }
}

// 回滚断言要能看见反向调用，所以把错误连 cause 一起取出来
async function failureOf(d: FakeDeps, sessionId: string) {
  try {
    await deleteSession(d)(sessionId)
  } catch (error) {
    return error as Error & { code?: string; cause?: unknown; details?: { rollbackFailures?: string[] } }
  }
  throw new Error('expected deleteSession to reject')
}

describe('删除动词', () => {
  it('运行中的会话一律拒绝，且不产生任何写操作', async () => {
    const { deps: d, calls, host, fs } = deps()
    host.isLive = vi.fn(async () => true)
    await expect(deleteSession(d)('session-abc')).rejects.toMatchObject({ code: 'sessiondelete/live' })
    expect(calls).toEqual([])
    expect(host.archive).not.toHaveBeenCalled()
    expect(host.unarchive).not.toHaveBeenCalled()
    expect(host.detach).not.toHaveBeenCalled()
    expect(fs.rename).not.toHaveBeenCalled()
  })

  // 删除不再用归档藏会话：先摘账本，搬目录，再让 `memberGone` 把 session + agent 一起摘掉，
  // 最后发 `api-session/removed`。归档集在删除前后都不变（用户原本归档的仍归档）。
  it('顺序固定为 detach → rename → evictLive → announceRemoved（不碰归档）', async () => {
    const { deps: d, calls, host } = deps()
    await deleteSession(d)('session-abc')
    expect(calls).toEqual(['detach', 'rename', 'evictLive', 'announceRemoved'])
    expect(host.archive).not.toHaveBeenCalled()
    expect(host.unarchive).not.toHaveBeenCalled()
  })

  it('删除前已归档的会话：不碰归档集，清单里记下"原本就是归档态"', async () => {
    const { deps: d, calls, host } = deps()
    host.isArchived = vi.fn(async () => true)
    const entry = await deleteSession(d)('session-abc')
    expect(calls).toEqual(['detach', 'rename', 'evictLive', 'announceRemoved'])
    expect(entry).toMatchObject({ wasArchived: true })
    expect(host.archive).not.toHaveBeenCalled()
    expect(host.unarchive).not.toHaveBeenCalled()
  })

  it('rename 失败即回滚已摘的账本，并把原始错误带出', async () => {
    const { deps: d, calls, fs } = deps()
    const boom = new Error('EXDEV')
    fs.rename = vi.fn(async () => { calls.push('rename'); throw boom })
    const err = await failureOf(d, 'session-abc')
    expect(err).toMatchObject({ code: 'sessiondelete/io' })
    expect(err.cause).toBe(boom)
    // 反向调用序：attach 挂回账本；归档没被碰过
    expect(calls).toEqual(['detach', 'rename', 'attach'])
  })

  // 清单登记是最后一件写：它失败也必须把账本 / 文件全部退回去，否则会话就成了
  // 「文件在回收站里、面板却看不见」的孤儿（判据住 `src/verbs/delete-session.ts`：清册行是最后一件写，
  // 它失败就把前几步全退回去）。
  it('清单登记失败即整体回退：目录搬回原处、账本挂回', async () => {
    const { deps: d, calls, fs, manifest } = deps()
    const boom = new Error('storage boom')
    manifest.add = vi.fn(async () => { throw boom })
    const err = await failureOf(d, 'session-abc')
    expect(err).toMatchObject({ code: 'sessiondelete/io' })
    expect(err.cause).toBe(boom)
    expect(calls).toEqual(['detach', 'rename', 'rename', 'attach'])
    const rename = fs.rename
    expect(rename.mock.calls).toEqual([
      [sessionDirOf('--C-develop-GitHub-dsh-ebook--', 'session-abc', HOME),
        trashDirOf('20260930T130500Z-session-abc', HOME)],
      [trashDirOf('20260930T130500Z-session-abc', HOME),
        sessionDirOf('--C-develop-GitHub-dsh-ebook--', 'session-abc', HOME)],
    ])
  })

  it('detach 失败即退出，文件一动不动', async () => {
    const { deps: d, calls, host, fs } = deps()
    const boom = new Error('detach boom')
    host.detach = vi.fn(async () => { calls.push('detach'); throw boom })
    const err = await failureOf(d, 'session-abc')
    expect(err).toMatchObject({ code: 'sessiondelete/io' })
    expect(err.cause).toBe(boom)
    expect(calls).toEqual(['detach'])
    expect(fs.rename).not.toHaveBeenCalled()
  })

  it('三件纯读失败即退出，不留下任何写过的痕迹（读在写之前）', async () => {
    const { deps: d, calls, host } = deps()
    const boom = new Error('读取标题失败')
    host.titleOf = vi.fn(async () => { throw boom })
    const err = await failureOf(d, 'session-abc')
    expect(err).toMatchObject({ code: 'sessiondelete/io' })
    expect(err.cause).toBe(boom)
    expect(calls).toEqual([])
  })

  it('成功后清单里有且只有一条，记录了原目录名、工作区与归档态', async () => {
    const { deps: d, manifest } = deps()
    const entry = await deleteSession(d)('session-abc')
    expect(entry).toMatchObject({
      id: '20260930T130500Z-session-abc', sessionId: 'session-abc',
      projectDir: '--C-develop-GitHub-dsh-ebook--', workspaceId: 'ws-1', wasArchived: false,
      title: '会话标题', sizeBytes: 1024,
    })
    expect(await manifest.list()).toHaveLength(1)
  })

  // 未分组的会话（宿主自己的"删除工作区"就会造出这种：目录与日志都留着，只是没有账目）
  // 照样可删：账本那一步没有可摘的东西，清单里把工作区记成空串，恢复时也不再挂账本。
  it('未分组的会话照样能删：不摘账本，清单里工作区记空串', async () => {
    const { deps: d, calls, host } = deps()
    host.workspaceOf = vi.fn(async () => undefined)
    const entry = await deleteSession(d)('session-abc')
    expect(calls).toEqual(['rename', 'evictLive', 'announceRemoved'])
    expect(entry).toMatchObject({ workspaceId: '', wasArchived: false })
  })

  it('未分组 + 已归档：只动文件', async () => {
    const { deps: d, calls, host } = deps()
    host.workspaceOf = vi.fn(async () => undefined)
    host.isArchived = vi.fn(async () => true)
    const entry = await deleteSession(d)('session-abc')
    expect(calls).toEqual(['rename', 'evictLive', 'announceRemoved'])
    expect(entry).toMatchObject({ workspaceId: '', wasArchived: true })
  })

  it('未分组 + rename 失败：不回挂账本，也不碰归档', async () => {
    const { deps: d, calls, host, fs } = deps()
    host.workspaceOf = vi.fn(async () => undefined)
    const boom = new Error('EXDEV')
    fs.rename = vi.fn(async () => { calls.push('rename'); throw boom })
    const err = await failureOf(d, 'session-abc')
    expect(err).toMatchObject({ code: 'sessiondelete/io' })
    expect(calls).toEqual(['rename'])
    expect(host.attach).not.toHaveBeenCalled()
    expect(host.archive).not.toHaveBeenCalled()
    expect(host.unarchive).not.toHaveBeenCalled()
  })

  it('只有推不出项目目录（账本 header 里查不到）才判 not-found，且零副作用', async () => {
    const { deps: d, calls, host } = deps()
    host.projectDirOf = vi.fn(async () => undefined)
    await expect(deleteSession(d)('session-abc')).rejects.toMatchObject({ code: 'sessiondelete/not-found' })
    expect(calls).toEqual([])
  })

  // 通告只在**知道宿主列表已经干净**时才发：`unknown`（live store 读不到 / 形状不符 / detach 抛）
  // 意味着它可能还活着、还挂在列表上，这时候发"已移除"就是假话（重连后那一行会自己长回来）。
  // 请不动也不影响删除结果——端口契约是不抛。
  it('摘内存结果未知（unknown）时不发移除通告，删除照样成功', async () => {
    const { deps: d, host, manifest } = deps()
    host.evictLive = vi.fn(async () => 'unknown' as const)
    const entry = await deleteSession(d)('session-abc')
    expect(entry).toMatchObject({ sessionId: 'session-abc', workspaceId: 'ws-1' })
    expect(await manifest.list()).toHaveLength(1)
    expect(host.evictLive).toHaveBeenCalledWith('session-abc')
    expect(host.announceRemoved).not.toHaveBeenCalled()
  })

  it('会话目录不存在时报 not-found，不静默当作成功', async () => {
    const { deps: d, fs } = deps()
    fs.exists = vi.fn(async () => false)
    await expect(deleteSession(d)('session-abc')).rejects.toMatchObject({ code: 'sessiondelete/not-found' })
  })
})

// 级联（判据住 `src/trash/groups.ts`，词表见 CONTEXT.md 的「无主子会话」条）：宿主的客户端把 `origin:"subagent"` 整排藏了 ⇒ 用户点掉的是一条父会话，
// 而它留在盘上的孩子既看不见也占着字节（本机实测 41 条父留了 320 个目录 / 74.6 MB）。
// 这一格把它们**一起搬进回收站**：孩子各自成目录、各自一行，`parentEntryId` 指向父那一行；恢复与彻底删除都按整组走。
describe('删除动词 · 级联（盘上的孩子一起进回收站）', () => {
  const kidA = { sessionId: 'session-kidA', projectDir: '--p--' }
  const kidB = { sessionId: 'session-kidB', projectDir: '--p--' }

  it('父搬进去之后，每个孩子各自成目录、各自一行，清册记 parentEntryId 指向父那一行', async () => {
    const d = deps({ members: { 'session-parent': [kidA, kidB] } })
    const parent = await deleteSession(d.deps)('session-parent')
    const rows = await d.manifest.list()
    expect(rows.map(r => r.sessionId).sort()).toEqual(['session-kidA', 'session-kidB', 'session-parent'])
    expect(rows.find(r => r.sessionId === 'session-parent')?.id).toBe(parent.id)
    expect(rows.filter(r => r.sessionId !== 'session-parent').map(r => r.parentEntryId)).toEqual([parent.id, parent.id])
    expect(parent.parentEntryId).toBeUndefined() // 父那一行自己不记 parent
    // 三个目录都真的搬了，且每个孩子落在**自己**的回收站目录里（不是塞进父的目录）
    expect(d.fs.rename).toHaveBeenCalledTimes(3)
    // 每个孩子落在**自己**的回收站目录里（不是塞进父那一格）；同一刻删除 ⇒ id 只差在目录名那一段
    const NOW = Date.UTC(2026, 8, 30, 13, 5, 0)
    const movedTo = d.fs.rename.mock.calls.map(c => String(c[1])).sort()
    expect(movedTo).toEqual([
      trashDirOf(makeEntryId(NOW, 'session-kidA'), HOME),
      trashDirOf(makeEntryId(NOW, 'session-kidB'), HOME),
      trashDirOf(parent.id, HOME),
    ].sort())
  })

  // 语料看不见不是"盘上没有后代"，但写侧只许降级：父照样删，盘上残留留给 `GET /orphans` 兜底。
  it('语料看不见（available:false）⇒ 只删父，不因此失败', async () => {
    const d = deps({ membersAvailable: false })
    const parent = await deleteSession(d.deps)('session-parent')
    expect(parent).toMatchObject({ sessionId: 'session-parent' })
    // 写侧真的读了这一格（不是碰巧走了"没有孩子"的默认值）：缺席也必须点名问过这个父。
    expect(d.host.subagentMembersOf).toHaveBeenCalledWith(['session-parent'])
    const rows = await d.manifest.list()
    expect(rows.map(r => r.sessionId)).toEqual(['session-parent'])
    expect(d.fs.rename).toHaveBeenCalledTimes(1)
  })

  it('宿主报了孩子但盘上没有那个目录 ⇒ 跳过它，其余照搬，不让整次删除失败', async () => {
    const d = deps({ members: { 'session-parent': [kidA, kidB] } })
    d.fs.exists = vi.fn(async (p: string) => !p.includes('session-kidB'))
    const parent = await deleteSession(d.deps)('session-parent')
    const rows = await d.manifest.list()
    expect(rows.map(r => r.sessionId).sort()).toEqual(['session-kidA', 'session-parent'])
    expect(rows.find(r => r.sessionId === 'session-kidA')?.parentEntryId).toBe(parent.id)
  })

  it('孩子在跑 ⇒ 整组拒绝，一个字节都不动（不替用户终止正在跑的活）', async () => {
    const d = deps({
      members: { 'session-parent': [kidA, kidB] },
      host: {
        isLive: vi.fn(async (id: string) => id === 'session-kidB'),
      },
    })
    await expect(deleteSession(d.deps)('session-parent')).rejects.toMatchObject({ code: 'sessiondelete/live' })
    expect(d.fs.rename).not.toHaveBeenCalled()
    expect(d.host.archive).not.toHaveBeenCalled()
    expect(await d.manifest.list()).toEqual([])
  })

  it('第二个孩子搬不动 ⇒ 已经搬进去的（父与第一个孩子）一起滚回原处', async () => {
    const d = deps({ members: { 'session-parent': [kidA, kidB] } })
    d.fs.rename = vi.fn(async (_from: string, to: string) => {
      if (to.includes('session-kidB')) throw new Error('EBUSY')
    })
    await expect(deleteSession(d.deps)('session-parent')).rejects.toMatchObject({ code: 'sessiondelete/io' })
    // 反向 rename：搬进去的两个都搬回去（父与 kidA），且失败的那个不留下半行清册
    const rolled = d.fs.rename.mock.calls.filter((c) => String(c[0]).includes('session-trash') && String(c[1]).includes('/sessions/'))
    expect(rolled.length).toBe(2)
    expect(await d.manifest.list()).toEqual([])
    // 这两条已经收过"已移除"通告；回滚成功必须补"已恢复"，否则客户端那一行要等到重连才回来。
    expect(d.host.announceRestored).toHaveBeenCalledWith('session-parent')
    expect(d.host.announceRestored).toHaveBeenCalledWith('session-kidA')
  })

  it('回滚本身失败 ⇒ 原错误保留，回滚失败进 details，且不发"已恢复"', async () => {
    const { deps: d, fs, host } = deps({ members: { 'session-parent': [kidA, kidB] } })
    fs.rename = vi.fn(
      async (from: string, to: string) => {
        if (to.includes('session-kidB')) throw new Error('EBUSY')
        if (from.includes('session-trash') && to.includes('/sessions/')) throw new Error('EACCES')
      },
    )
    const err = await failureOf(d, 'session-parent')
    expect(err.code).toBe('sessiondelete/io')
    expect(err.details).toMatchObject({
      rollbackFailures: expect.arrayContaining([expect.stringContaining('EACCES')]),
    })
    expect(host.announceRestored).not.toHaveBeenCalled()
  })
})
