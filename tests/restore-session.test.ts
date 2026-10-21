import { describe, expect, it, vi } from 'vitest'
import { attachableWorkspaceId, isWorkspaceMissing, restoreSession } from '../src/verbs/restore-session.js'
import { makeEntryId, sessionDirOf, trashDirOf, type TrashEntry } from '../src/trash/entry.js'
import type { HostIdentityPort } from '../src/ports/host-port.js'
import { createFakeDeps, type FakeDeps, type FakeFs, type FakeHost } from './support/fake-deps.js'

const HOME = '/h'
const entry: TrashEntry = {
  id: '20260930T130500Z-session-abc', sessionId: 'session-abc',
  projectDir: '--C-develop-GitHub-dsh-ebook--', workspaceId: 'ws-1', wasArchived: true,
  deletedAt: Date.UTC(2026, 8, 30, 13, 5, 0),
  title: '会话标题', sizeBytes: 2048,
}
const trashDir = trashDirOf(entry.id, HOME)
const sessionDir = sessionDirOf(entry.projectDir, entry.sessionId, HOME)

/** 内存里那第二个 adapter（`tests/support/fake-deps.ts`）。日志只记**恢复自己会做的那几件**：
 *  `detach` 故意不记——有一条用例断言的正是"回滚里没有摘账本那一步"。
 *  `archived` 缺省 true：`wasArchived:false` 的条目按**旧清单**处理（旧删除用归档藏会话），
 *  恢复时要迁移式取消归档；新清单用例显式传 false。 */
function deps(over: { workspaceExists?: boolean; archived?: boolean; host?: Partial<FakeHost>; fs?: Partial<FakeFs> } = {}) {
  const calls: string[] = []
  const made = createFakeDeps({
    seed: [entry],
    workspaceExists: over.workspaceExists ?? true,
    archived: over.archived ?? true,
    log: calls,
    logMethods: ['rename', 'attach', 'unarchive', 'archive', 'announceRestoredBatch'],
    format: (method, args) => method === 'announceRestoredBatch'
      ? `announceRestoredBatch(${(args[0] as readonly string[]).length})`
      : method,
  })
  Object.assign(made.host, over.host)
  Object.assign(made.fs, over.fs)
  return { calls, fs: made.fs, host: made.host, manifest: made.manifest, d: made.deps }
}

async function failureOf(d: FakeDeps, entryId: string) {
  try {
    await restoreSession(d)(entryId)
  } catch (error) {
    return error as Error & { code?: string; details?: { rollbackFailures?: string[] } }
  }
  throw new Error('expected restoreSession to reject')
}

describe('恢复动词', () => {
  // 旧清单（2026-10-21 之前的删除用归档藏会话）：`wasArchived:false` 但盘上仍归档 ⇒
  // 恢复时迁移式取消归档，把它放回树里；"原本已归档"的删前删后都在归档集里，恢复不该动它。
  // 新清单的删除不碰归档，见下面那条专门的用例。
  it('旧清单：rename → attach → unarchive（删前未归档、删除时被归档的）', async () => {
    const { d, calls } = deps()
    await d.manifest.add({ ...entry, wasArchived: false })
    await restoreSession(d)(entry.id)
    expect(calls).toEqual(['rename', 'attach', 'unarchive'])
  })

  it('新清单：删前未归档且当前未归档 ⇒ 恢复不碰归档', async () => {
    const { d, calls, host } = deps({ archived: false })
    await d.manifest.add({ ...entry, wasArchived: false })
    await restoreSession(d)(entry.id)
    expect(calls).toEqual(['rename', 'attach'])
    expect(host.unarchive).not.toHaveBeenCalled()
    expect(host.archive).not.toHaveBeenCalled()
  })

  it('原本已归档的：恢复后仍处归档态，不动归档集', async () => {
    const { d, calls } = deps()
    await restoreSession(d)(entry.id)
    expect(calls).toEqual(['rename', 'attach'])
    expect(d.host.archive)
      .not.toHaveBeenCalled()
    expect(d.host.unarchive).not.toHaveBeenCalled()
  })

  // 删除时就没有工作区账目的会话（未分组），清单里记空串 ⇒ 恢复没有账本可挂，只把文件放回。
  it('未分组会话（清单里工作区是空串）恢复时不挂账本', async () => {
    const { d, calls } = deps()
    const manifest = d.manifest
    await manifest.add({ ...entry, wasArchived: false, workspaceId: '' })
    await restoreSession(d)(entry.id)
    expect(calls).toEqual(['rename', 'unarchive'])
    expect(d.host.attach).not.toHaveBeenCalled()
  })

  // 宿主的「删除工作区」只删注册、保留目录与每一份会话日志（asar `WorkspaceRegistry.delete` 原文
  // "retaining its directory and every session log"）⇒ 回收站里那些**删在工作区之前**的条目，
  // 记下的 workspaceId 可能已经没有对应的工作区。恢复不该因此失败：文件照常回盘，会话落在「未分组」，
  // 与宿主自己处理这类会话的方式一致。
  it('原工作区已被删掉（账本里没有 ws-1）⇒ 照常恢复、不挂账本，归入未分组', async () => {
    const { d, calls } = deps({ workspaceExists: false })
    const host = d.host
    await restoreSession(d)(entry.id)
    expect(calls).toEqual(['rename'])
    expect(host.attach).not.toHaveBeenCalled()
    expect(await d.manifest.list()).toHaveLength(0)
  })

  it('原工作区已不存在 + 原本未归档：取消归档照旧，恢复完成', async () => {
    const { d, calls } = deps({ workspaceExists: false })
    await d.manifest.add({ ...entry, wasArchived: false })
    await restoreSession(d)(entry.id)
    expect(calls).toEqual(['rename', 'unarchive'])
  })

  // 「查过之后、挂之前」账本被删（宿主的删除工作区与这次恢复撞上）与上面是同一件事；
  // 但只认端口自己抛的那句"账本里没这个工作区"——别的失败哪怕撞上同一刻也不许静默改归属。
  it('attach 时工作区刚好被删掉 ⇒ 按未分组收，不回滚', async () => {
    const { d, calls } = deps()
    const host = d.host
    host.workspaceExists = vi.fn(async () => true).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    host.attach = vi.fn(async () => { throw new Error('workspace not found (attach): ws-1') })
    const rename = d.fs.rename
    await restoreSession(d)(entry.id)
    expect(calls).toEqual(['rename'])
    expect(rename.mock.calls).toEqual([[trashDir, sessionDir]])
  })

  // 兜底认的是**那一句**，不是"attach 出错了"：工作区刚好也没了 + 另一个原因的失败，仍是真故障，
  // 照旧把目录退回回收站并报 io（吞掉它就等于把一次存储故障伪装成"归入未分组"）。
  it('attach 抛的不是"账本没这个工作区" ⇒ 工作区刚好也没了也回滚报 io', async () => {
    const { d, calls } = deps()
    const host = d.host
    host.workspaceExists = vi.fn(async () => true).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    host.attach = vi.fn(async () => { throw new Error('storage table write failed') })
    const rename = d.fs.rename
    await expect(restoreSession(d)(entry.id)).rejects.toThrow(/挂回账本失败/)
    expect(rename.mock.calls).toEqual([[trashDir, sessionDir], [sessionDir, trashDir]])
    expect(calls).toEqual(['rename', 'rename'])
  })

  // 行上那句与"到底挂不挂账本"必须是同一条判据（`isWorkspaceMissing` 由 `attachableWorkspaceId` 派生）：
  // 三种输入三个结论，尤其不许拿"删除时就没有账目"冒充"工作区没了"。
  it('挂账本的判据与清单那句同源：还在 / 没了 / 从来就没有', async () => {
    const host = (id: boolean): Pick<HostIdentityPort, 'workspaceExists'> => ({ workspaceExists: async () => id })
    expect(await attachableWorkspaceId(host(true), entry)).toBe('ws-1')
    expect(await isWorkspaceMissing(host(true), entry)).toBe(false)
    expect(await attachableWorkspaceId(host(false), entry)).toBeUndefined()
    expect(await isWorkspaceMissing(host(false), entry)).toBe(true)
    const ungrouped = { ...entry, workspaceId: '' }
    expect(await attachableWorkspaceId(host(true), ungrouped)).toBeUndefined()
    expect(await isWorkspaceMissing(host(true), ungrouped)).toBe(false)
  })

  it('未分组 + 取消归档失败：回滚里没有摘账本那一步', async () => {
    const { d, calls } = deps()
    const manifest = d.manifest
    await manifest.add({ ...entry, wasArchived: false, workspaceId: '' })
    const host = d.host
    host.unarchive = vi.fn(async () => { throw new Error('unarchive boom') })
    const rename = d.fs.rename
    await expect(restoreSession(d)(entry.id)).rejects.toMatchObject({ code: 'sessiondelete/io' })
    expect(calls).toEqual(['rename', 'archive', 'rename'])
    expect(host.detach).not.toHaveBeenCalled()
    expect(rename.mock.calls).toEqual([[trashDir, sessionDir], [sessionDir, trashDir]])
    expect(await d.manifest.list()).toHaveLength(1)
  })

  it('清单里没有该条目时报 trash-empty', async () => {
    const { d } = deps()
    await expect(restoreSession(d)('nope')).rejects.toMatchObject({ code: 'sessiondelete/trash-empty' })
  })

  it('目标项目目录不存在时报 project-missing，且不静默建目录', async () => {
    const { d } = deps()
    ;d.fs.exists = vi.fn(async (p: string) => !p.endsWith('/sessions'))
    await expect(restoreSession(d)(entry.id)).rejects.toMatchObject({ code: 'sessiondelete/project-missing' })
  })

  it('恢复成功后清单里不再有它，账本挂回原工作区', async () => {
    const { d } = deps()
    await restoreSession(d)(entry.id)
    expect(await d.manifest.list()).toHaveLength(0)
    expect(d.host.attach)
      .toHaveBeenCalledWith('session-abc', 'ws-1')
  })

  it('attach 失败即把会话目录放回回收站，并把原始错误带出', async () => {
    const { d } = deps()
    ;d.host.attach =
      vi.fn(async () => { throw new Error('ledger boom') })
    const rename = d.fs.rename
    await expect(restoreSession(d)(entry.id)).rejects.toMatchObject({
      code: 'sessiondelete/io', cause: expect.objectContaining({ message: 'ledger boom' }),
    })
    expect(rename.mock.calls).toEqual([[trashDir, sessionDir], [sessionDir, trashDir]])
    expect(await d.manifest.list()).toHaveLength(1)
  })

  it('取消归档失败即整体回退：重新归档（藏回去）+ 摘账本 + 目录回回收站，清单行仍留着', async () => {
    const { d, calls } = deps()
    await d.manifest.add({ ...entry, wasArchived: false })
    const host = d.host
    host.unarchive = vi.fn(async () => { throw new Error('unarchive boom') })
    const rename = d.fs.rename
    await expect(restoreSession(d)(entry.id)).rejects.toMatchObject({
      code: 'sessiondelete/io', cause: expect.objectContaining({ message: 'unarchive boom' }),
    })
    // 末尾那个 rename 是回滚（目录放回回收站），下一行按 rename 的两对入参逐对核对
    expect(calls).toEqual(['rename', 'attach', 'archive', 'rename'])
    expect(host.detach).toHaveBeenCalledWith('session-abc', 'ws-1')
    expect(rename.mock.calls).toEqual([[trashDir, sessionDir], [sessionDir, trashDir]])
    expect(await d.manifest.list()).toHaveLength(1)
  })

  // 摘清单行同样是最后一件写：它失败也要把前面几步退回去，否则回收站里会留一条
  // 「恢复不了也清不掉的幽灵行」（目录已经回了 `sessions/`，行却还在回收站里挂着）。
  it('摘清单行失败即整体回退：重新归档 + 摘账本 + 目录放回回收站', async () => {
    const { d, calls } = deps()
    const manifest = d.manifest
    await manifest.add({ ...entry, wasArchived: false })
    manifest.remove = vi.fn(async () => { throw new Error('storage boom') })
    const host = d.host
    const rename = d.fs.rename
    await expect(restoreSession(d)(entry.id)).rejects.toMatchObject({
      code: 'sessiondelete/io', cause: expect.objectContaining({ message: 'storage boom' }),
    })
    // 反向：archive 藏回去 → detach 摘账本 → rename 把目录放回回收站（detach 不在 calls 里，见夹具）
    expect(calls).toEqual(['rename', 'attach', 'unarchive', 'archive', 'rename'])
    expect(host.detach).toHaveBeenCalledWith('session-abc', 'ws-1')
    expect(rename.mock.calls).toEqual([[trashDir, sessionDir], [sessionDir, trashDir]])
    expect(await d.manifest.list()).toHaveLength(1)
  })
})

// 级联的另一半：删是按组搬进来的，恢复也必须按组搬回去。清单只列父行（孩子折在里面），
// 若恢复只回父，回收站里就留下一堆点不到的孩子行——既看不见也清不掉。
describe('恢复动词 · 整组（父回则孩子一起回）', () => {
  const NOW = Date.UTC(2026, 8, 30, 13, 5, 0)
  const parent: TrashEntry = {
    id: makeEntryId(NOW, 'session-parent'), sessionId: 'session-parent', projectDir: '--p--',
    workspaceId: 'ws-1', wasArchived: true, deletedAt: NOW, title: '父', sizeBytes: 10,
  }
  const kidA: TrashEntry = { ...parent, id: makeEntryId(NOW, 'session-kidA'), sessionId: 'session-kidA', title: '甲', parentEntryId: parent.id }
  const kidB: TrashEntry = { ...parent, id: makeEntryId(NOW, 'session-kidB'), sessionId: 'session-kidB', title: '乙', parentEntryId: parent.id }

  function world(exists: (p: string) => boolean = () => true, seed: TrashEntry[] = [parent, kidA, kidB]) {
    return createFakeDeps({ seed, fs: { exists, size: 0 } })
  }

  it('恢复父 ⇒ 三个目录都搬回 sessions/、三行都摘掉，且**这个动词自己不发通告**', async () => {
    const { deps: d, fs, host, manifest } = world()
    await restoreSession(d)(parent.id)
    expect(fs.rename).toHaveBeenCalledTimes(3)
    const fromTrash = fs.rename.mock.calls.filter((c) => String(c[0]).includes('session-trash'))
    expect(fromTrash).toHaveLength(3)
    expect(await manifest.list()).toEqual([])
    // 通告归批量层：一次批量只发一次 `api-session/added`、配一次预取的摘要表（ADR-0002）。
    // 「一次调用交回整组的三个 id」那条断言搬去了 `tests/batch.test.ts`（契约还在，只是换了家）。
    expect(host.announceRestoredBatch).not.toHaveBeenCalled()
    expect(host.announceRestored).not.toHaveBeenCalled()
  })

  it('组里任一成员的原项目目录不在 ⇒ 整组拒绝、一个目录都不搬（不许半组在外面）', async () => {
    // kidB 的家被删过（项目目录不在）：预检必须在看任何一次 rename 之前就把整组拦下
    const stranded: TrashEntry = { ...kidB, projectDir: '--gone--' }
    const { deps: d, fs, manifest } = world((p) => !p.includes('--gone--'), [parent, kidA, stranded])
    await expect(restoreSession(d)(parent.id)).rejects.toMatchObject({ code: 'sessiondelete/project-missing' })
    expect(fs.rename).not.toHaveBeenCalled()
    expect(await manifest.list()).toHaveLength(3)
  })

  it('按孩子的 id 单独恢复 ⇒ 只回它自己，父那一行照常留着', async () => {
    const { deps: d, fs, manifest } = world()
    await restoreSession(d)(kidA.id)
    expect(fs.rename).toHaveBeenCalledTimes(1)
    const left = await manifest.list()
    expect(left.map(r => r.sessionId).sort()).toEqual(['session-kidB', 'session-parent'])
  })

  it('组回滚的目录退回失败 ⇒ details 带 rollbackFailures，且不发"已移除"', async () => {
    const { deps: d, fs, host } = world()
    host.attach = vi.fn(async (id: string) => {
      if (id === 'session-kidB') throw new Error('attach boom')
    })
    fs.rename = vi.fn(async (from: string, to: string) => {
      if (from.includes('/sessions/') && to.includes('session-trash')) throw new Error('EACCES')
    })
    const err = await failureOf(d, parent.id)
    expect(err.details).toMatchObject({
      rollbackFailures: expect.arrayContaining([expect.stringContaining('EACCES')]),
    })
    expect(host.announceRemoved).not.toHaveBeenCalled()
  })

  it('组回滚里已经恢复的成员：目录退回回收站后发"已移除"，按相反顺序', async () => {
    const calls: string[] = []
    const made = createFakeDeps({
      seed: [parent, kidA, kidB],
      fs: { exists: () => true, size: 0 },
      log: calls,
      logMethods: ['evictLive', 'announceRemoved'],
      format: (method, args) => `${method}(${String(args[0])})`,
    })
    made.host.attach = vi.fn(async (id: string) => {
      if (id === 'session-kidB') throw new Error('attach boom')
    })
    const err = await failureOf(made.deps, parent.id)
    expect(err.code).toBe('sessiondelete/io')
    expect(calls).toEqual([
      'evictLive(session-kidA)', 'announceRemoved(session-kidA)',
      'evictLive(session-parent)', 'announceRemoved(session-parent)',
    ])
  })
})
