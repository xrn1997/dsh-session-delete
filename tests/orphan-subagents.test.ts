import { describe, expect, it, vi } from 'vitest'
import {
  cleanOrphanGroup,
  loadOrphanGroups,
  orphanGroupsOf,
  reportOrphans,
  type OrphanGroup,
} from '../src/verbs/orphan-subagents.js'
import type { SessionIdentity } from '../src/ports/host-port.js'
import { sessionDirOf, type TrashEntry } from '../src/trash/entry.js'
import { createFakeDeps } from './support/fake-deps.js'

const HOME = '/h'
const s = (sessionId: string, over: Partial<SessionIdentity> = {}): SessionIdentity => ({
  sessionId, projectDir: '--p--', subagent: true, ...over,
})

/** 内存里那第二个 adapter（`tests/support/fake-deps.ts`）：`corpus` 就是"这一家有会话语料"的语法糖。
 *  日志只记清理会做的那四件，且带参数——顺序（unarchive → detach → 删目录 → 通告）是这批用例的主角。 */
function deps(corpus: readonly SessionIdentity[], seed: TrashEntry[] = []) {
  const calls: string[] = []
  const made = createFakeDeps({
    seed,
    corpus,
    fs: { size: 100 },
    workspaceOf: (id) => (id === 'session-kid' ? 'ws-1' : undefined),
    log: calls,
    logMethods: ['detach', 'unarchive', 'evictLive', 'announceRemoved'],
    format: (method, args) => (method === 'detach'
      ? `detach(${String(args[0])},${String(args[1])})`
      : `${method}(${String(args[0])})`),
  })
  return { fs: made.fs, host: made.host, calls, d: made.deps }
}

describe('孤儿分组（纯函数）', () => {
  it('根是父不在语料/清册里的 subagent；后代全收；清册里的父不算孤儿', () => {
    const corpus = [
      s('session-root', { parentSessionId: 'session-gone' }),
      s('session-kid', { parentSessionId: 'session-root', subagent: false }),
      s('session-g1', { parentSessionId: 'session-kid', subagent: false }),
      s('session-stranded', { parentSessionId: 'session-trashed' }),
      s('session-normal', { subagent: false }),
    ]
    const groups = orphanGroupsOf(corpus, ['session-trashed'])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.root.sessionId).toBe('session-root')
    expect(groups[0]!.members.map((m) => m.sessionId)).toEqual(['session-root', 'session-kid', 'session-g1'])
    expect(groups[0]!.parentSessionId).toBe('session-gone')
  })

  it('同样父带前缀/不带前缀算同一件事', () => {
    const corpus = [s('session-root', { parentSessionId: 'gone' })]
    expect(orphanGroupsOf(corpus, ['session-gone'])).toEqual([])
    expect(orphanGroupsOf(corpus, [])).toHaveLength(1)
  })
})

describe('扫描报告与清理', () => {
  it('loadOrphanGroups 量字节；report 汇总根、闭包、缺失父与项目分组', async () => {
    const { d } = deps([
      s('session-root', { parentSessionId: 'session-gone' }),
      s('session-kid', { parentSessionId: 'session-root', subagent: false, projectDir: '--q--' }),
    ])
    const groups = await loadOrphanGroups(d)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.members.reduce((n, m) => n + m.bytes, 0)).toBe(200)
    expect(reportOrphans(groups)).toMatchObject({
      roots: ['session-root'], totalSessions: 2, totalBytes: 200, missingParents: 1,
      groups: [{ projectDir: '--p--', sessions: 1, bytes: 100 }, { projectDir: '--q--', sessions: 1, bytes: 100 }],
    })
  })

  it('sessionQuery 没挂 ⇒ io，不拿空语料冒充没有孤儿', async () => {
    const { d } = deps([])
    d.host.listSessions = vi.fn(async () => undefined)
    await expect(loadOrphanGroups(d)).rejects.toMatchObject({ code: 'sessiondelete/io' })
  })

  it('非单段 session id 不拼路径：扫描响亮失败，绝不把递归删除带出 sessions/', async () => {
    const { d, fs } = deps([s('../escape', { parentSessionId: 'gone' })])
    await expect(loadOrphanGroups(d)).rejects.toThrow(/不是单段路径/)
    expect(fs.removeDir).not.toHaveBeenCalled()
  })

  it('清理：逐条 live 检查 → unarchive → detach → 删目录并通告', async () => {
    const { d, fs, host, calls } = deps([
      s('session-root', { parentSessionId: 'session-gone' }),
      s('session-kid', { parentSessionId: 'session-root', subagent: false }),
    ])
    const [group] = await loadOrphanGroups(d)
    const result = await cleanOrphanGroup(d, group as OrphanGroup)
    expect(result).toEqual({ removed: 2, freedBytes: 200 })
    expect(calls).toEqual([
      'unarchive(session-root)', 'unarchive(session-kid)',
      'detach(session-kid,ws-1)',
      'evictLive(session-root)', 'announceRemoved(session-root)',
      'evictLive(session-kid)', 'announceRemoved(session-kid)',
    ])
    expect(fs.removeDir).toHaveBeenCalledTimes(2)
    expect(fs.removeDir).toHaveBeenNthCalledWith(1, sessionDirOf('--p--', 'session-root', HOME))
    expect(fs.removeDir).toHaveBeenNthCalledWith(2, sessionDirOf('--p--', 'session-kid', HOME))
    expect(host.isLive).toHaveBeenCalledWith('session-root')
    expect(host.isLive).toHaveBeenCalledWith('session-kid')
  })

  it('成员目录缺席 ⇒ 跳过它的删除与计数，但不跳过归档集摘除', async () => {
    const { d, fs, host } = deps([
      s('session-root', { parentSessionId: 'session-gone' }),
      s('session-kid', { parentSessionId: 'session-root', subagent: false }),
    ])
    const [group] = await loadOrphanGroups(d)
    fs.exists.mockImplementation(async (...args: unknown[]) => !String(args[0]).endsWith('session-kid'))
    const result = await cleanOrphanGroup(d, group as OrphanGroup)
    expect(result).toEqual({ removed: 1, freedBytes: 100 })
    expect(fs.removeDir).toHaveBeenCalledTimes(1)
    expect(fs.removeDir).toHaveBeenCalledWith(sessionDirOf('--p--', 'session-root', HOME))
    expect(host.unarchive).toHaveBeenCalledWith('session-kid')
  })

  it('删到一半失败 ⇒ io 的错误 details 带已删计数与字节，不伪装成整组没动', async () => {
    const { d, fs } = deps([
      s('session-root', { parentSessionId: 'session-gone' }),
      s('session-kid', { parentSessionId: 'session-root', subagent: false }),
    ])
    const [group] = await loadOrphanGroups(d)
    fs.removeDir.mockImplementation(async (...args: unknown[]) => {
      if (String(args[0]).endsWith('session-kid')) throw new Error('boom')
    })
    await expect(cleanOrphanGroup(d, group as OrphanGroup)).rejects.toMatchObject({
      code: 'sessiondelete/io',
      details: { removed: 1, freedBytes: 100, failedSessionId: 'session-kid' },
    })
  })

  it('任一成员在跑 ⇒ live，零写：unarchive/removeDir 都不许发生', async () => {
    const { d, fs, host } = deps([
      s('session-root', { parentSessionId: 'session-gone' }),
      s('session-kid', { parentSessionId: 'session-root', subagent: false }),
    ])
    const [group] = await loadOrphanGroups(d)
    host.isLive = vi.fn(async (id: string) => id === 'session-kid')
    await expect(cleanOrphanGroup(d, group as OrphanGroup)).rejects.toMatchObject({ code: 'sessiondelete/live' })
    expect(host.unarchive).not.toHaveBeenCalled()
    expect(fs.removeDir).not.toHaveBeenCalled()
  })
})
