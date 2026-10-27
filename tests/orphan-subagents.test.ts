import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  cleanOrphanGroup,
  loadOrphanGroups,
  orphanGroupsOf,
  reportOrphans,
  type OrphanGroup,
} from '../src/verbs/orphan-subagents.js'
import type { SessionIdentity } from '../src/ports/host-port.js'
import { attachmentPathOf } from '../src/trash/attachments.js'
import { sessionDirOf, type TrashEntry } from '../src/trash/entry.js'
import { createLogWorld, trashEntry } from './support/world.js'

const HOME = '/h'
const IMAGE = `sha256:${'a'.repeat(64)}`
const imagePath = attachmentPathOf(HOME, 'image', IMAGE)
/** 一条带独占图片引用的会话日志（压缩格式与 `pickSessionLog` 认的那一代一致）。 */
const imageLog = () => zlib.zstdCompressSync(Buffer.from(
  `${JSON.stringify({ type: 'session', version: 4, id: 'session-root', createdAt: 1, cwd: 'C:/p' })}\n` +
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
/** 一个附件都没碰的回执（现有的普通组不涉及图片）。 */
const NOTHING_CLEANED = { removed: 0, freedBytes: 0, failed: 0 } as const
const s = (sessionId: string, over: Partial<SessionIdentity> = {}): SessionIdentity => ({
  sessionId, projectDir: '--p--', subagent: true, ...over,
})

/** 内存里那第二个 adapter（`tests/support/fake-deps.ts`）：`corpus` 就是"这一家有会话语料"的语法糖。
 *  日志只记清理会做的那四件，且带参数——顺序（unarchive → detach → 删目录 → 通告）是这批用例的主角。 */
function deps(corpus: readonly SessionIdentity[], seed: TrashEntry[] = []) {
  const made = createLogWorld({
    seed,
    corpus,
    fs: { size: 100 },
    workspaceOf: (id) => (id === 'session-kid' ? 'ws-1' : undefined),
    logMethods: ['detach', 'unarchive', 'evictLive', 'announceRemoved'],
    format: (method, args) => (method === 'detach'
      ? `detach(${String(args[0])},${String(args[1])})`
      : `${method}(${String(args[0])})`),
  })
  return { fs: made.fs, host: made.host, calls: made.calls, d: made.deps, seed }
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
    const groups = await loadOrphanGroups(d, [])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.members.reduce((n, m) => n + m.bytes, 0)).toBe(200)
    expect(reportOrphans(groups)).toMatchObject({
      roots: ['session-root'], totalSessions: 2, totalBytes: 200, missingParents: 1,
      groups: [{ projectDir: '--p--', sessions: 1, bytes: 100 }, { projectDir: '--q--', sessions: 1, bytes: 100 }],
    })
  })

  it('清册行由调用方交：传进来的行决定谁是孤儿，动词不再自己挑 raw', async () => {
    const { d } = deps([s('session-root', { parentSessionId: 'session-trashed' })])
    expect(await loadOrphanGroups(d, [])).toHaveLength(1)
    expect(await loadOrphanGroups(d, [trashEntry('session-trashed')])).toEqual([])
  })

  it('清册行是必填：不交行在类型面就过不去（读面由调用方选好）', () => {
    const { d } = deps([])
    if (false) {
      // @ts-expect-error `trash` 不是可选的：扫描不许自己回落到 `ledger.raw()`
      void loadOrphanGroups(d)
    }
  })

  it('sessionQuery 没挂 ⇒ { available:false } ⇒ io，不拿空语料冒充没有孤儿', async () => {
    const { d } = deps([])
    d.host.listSessions = vi.fn(async () => ({ available: false as const }))
    await expect(loadOrphanGroups(d, [])).rejects.toMatchObject({ code: 'sessiondelete/io' })
  })

  it('非单段 session id 不拼路径：扫描响亮失败，绝不把递归删除带出 sessions/', async () => {
    const { d, fs } = deps([s('../escape', { parentSessionId: 'gone' })])
    await expect(loadOrphanGroups(d, [])).rejects.toThrow(/不是单段路径/)
    expect(fs.removeDir).not.toHaveBeenCalled()
  })

  it('清理：逐条 live 检查 → unarchive → detach → 删目录并通告', async () => {
    const { d, fs, host, calls } = deps([
      s('session-root', { parentSessionId: 'session-gone' }),
      s('session-kid', { parentSessionId: 'session-root', subagent: false }),
    ])
    const [group] = await loadOrphanGroups(d, [])
    const result = await cleanOrphanGroup(d, group as OrphanGroup)
    expect(result).toEqual({ removed: 2, freedBytes: 200, attachments: NOTHING_CLEANED })
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

  it('清理连带独占图片：删目录之后才删对象，附件读数单独回执', async () => {
    const { d, fs } = deps([s('session-root', { parentSessionId: 'session-gone' })])
    const dir = sessionDirOf('--p--', 'session-root', HOME)
    const order: string[] = []
    fs.listDirs.mockImplementation(async () => [])
    fs.listFiles.mockImplementation(async (p: string) => p === dir ? ['session.v4.jsonl.zstd'] : [])
    fs.readFile.mockImplementation(async () => imageLog())
    fs.statFile.mockImplementation(async (p: string) => ({ size: p === imagePath ? 7 : 0 }))
    fs.removeDir.mockImplementation(async (p: string) => { order.push(`removeDir:${p}`) })
    fs.removeFile.mockImplementation(async (p: string) => { order.push(`removeFile:${p}`) })

    const [group] = await loadOrphanGroups(d, [])
    const result = await cleanOrphanGroup(d, group as OrphanGroup)

    expect(result).toEqual({ removed: 1, freedBytes: 100, attachments: { removed: 1, freedBytes: 7, failed: 0 } })
    expect(order).toEqual([`removeDir:${dir}`, `removeFile:${imagePath}`])
  })

  it('成员目录缺席 ⇒ 跳过它的删除与计数，但不跳过归档集摘除', async () => {
    const { d, fs, host } = deps([
      s('session-root', { parentSessionId: 'session-gone' }),
      s('session-kid', { parentSessionId: 'session-root', subagent: false }),
    ])
    const [group] = await loadOrphanGroups(d, [])
    fs.exists.mockImplementation(async (...args: unknown[]) => !String(args[0]).endsWith('session-kid'))
    const result = await cleanOrphanGroup(d, group as OrphanGroup)
    expect(result).toEqual({ removed: 1, freedBytes: 100, attachments: NOTHING_CLEANED })
    expect(fs.removeDir).toHaveBeenCalledTimes(1)
    expect(fs.removeDir).toHaveBeenCalledWith(sessionDirOf('--p--', 'session-root', HOME))
    expect(host.unarchive).toHaveBeenCalledWith('session-kid')
  })

  it('删到一半失败 ⇒ io 的错误 details 带已删计数与字节，不伪装成整组没动', async () => {
    const { d, fs } = deps([
      s('session-root', { parentSessionId: 'session-gone' }),
      s('session-kid', { parentSessionId: 'session-root', subagent: false }),
    ])
    const [group] = await loadOrphanGroups(d, [])
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
    const [group] = await loadOrphanGroups(d, [])
    host.isLive = vi.fn(async (id: string) => id === 'session-kid')
    await expect(cleanOrphanGroup(d, group as OrphanGroup)).rejects.toMatchObject({ code: 'sessiondelete/live' })
    expect(host.unarchive).not.toHaveBeenCalled()
    expect(fs.removeDir).not.toHaveBeenCalled()
  })
})

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')

/**
 * 委托结构护栏：删目录与在场通告已由能力面守住；这里只钉 orphan-clean 把删除序列交给执行器，
 * 不再自己调归档集 / 账本 / 删目录（能力面给不了「不要自己调」这条）。
 */
describe('orphan-clean 把删除顺序交给执行器', () => {
  it('扫出一组之后直接接上计划与执行器', () => {
    const text = readFileSync(join(ROOT, 'src/verbs/orphan-subagents.ts'), 'utf8')
    expect(text).not.toContain('deps.fs.removeDir')
    expect(text).not.toContain('deps.host.unarchive')
    expect(text).not.toContain('deps.host.detach')
    expect(text).toContain('planOrphanRemoval(')
    expect(text).toContain('executeRemoval(')
  })
})
