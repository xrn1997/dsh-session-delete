import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createFakeHost } from './support/fake-deps.js'
import { createMemberPresence } from '../src/verbs/member-presence.js'

function makeHost(opts: { evicted?: 'evicted' | 'not-live' | 'unknown' } = {}) {
  const log: string[] = []
  const host = createFakeHost({
    evicted: opts.evicted ?? 'not-live',
    log,
    logMethods: ['evictLive', 'announceRemoved', 'announceRestored'],
    format: (method, args) => `${method}(${Array.isArray(args[0]) ? (args[0] as readonly string[]).join(',') : String(args[0])})`,
  })
  return { host, log }
}

describe('成员在场', () => {
  it('memberGone：先摘活体，再如实通告', async () => {
    const { host, log } = makeHost({ evicted: 'evicted' })
    await createMemberPresence(host).memberGone('s1')
    expect(log).toEqual(['evictLive(s1)', 'announceRemoved(s1)'])
  })

  it('memberGone：not-live 也通告（冷会话没有活体可摘，但那一行仍要消失）', async () => {
    const { host, log } = makeHost({ evicted: 'not-live' })
    await createMemberPresence(host).memberGone('s1')
    expect(log).toEqual(['evictLive(s1)', 'announceRemoved(s1)'])
  })

  it('memberGone：unknown 时不通告（宿主列表是否干净不可断言）', async () => {
    const { host, log } = makeHost({ evicted: 'unknown' })
    await createMemberPresence(host).memberGone('s1')
    expect(log).toEqual(['evictLive(s1)'])
  })

  it('memberGone：backInTrash=false 时什么都不做（恢复回滚里目录没退回回收站）', async () => {
    const { host, log } = makeHost({ evicted: 'evicted' })
    await createMemberPresence(host).memberGone('s1', { backInTrash: false })
    expect(log).toEqual([])
  })

  it('memberBack：目录与账本都回去才发 added', async () => {
    const { host, log } = makeHost()
    await createMemberPresence(host).memberBack('s1', { diskBack: true, workspaceBack: true })
    expect(log).toEqual(['announceRestored(s1)'])
  })

  it('memberBack：任一件没回去就不发（假话比不发更糟）', async () => {
    for (const facts of [
      { diskBack: false, workspaceBack: true },
      { diskBack: true, workspaceBack: false },
    ]) {
      const { host, log } = makeHost()
      await createMemberPresence(host).memberBack('s1', facts)
      expect(log).toEqual([])
    }
  })

  it('memberBack：不摘活体（归位只补通告）', async () => {
    const { host } = makeHost()
    await createMemberPresence(host).memberBack('s1', { diskBack: true, workspaceBack: true })
    expect(host.evictLive).not.toHaveBeenCalled()
  })
})

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const PRESENCE = 'src/verbs/member-presence.ts'
const BATCH = 'src/verbs/batch.ts'
const HOST_CALL = /\b(?:deps\.)?host\.(evictLive|announceRemoved|announceRestored)\s*\(/g

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'lib' || entry === '.git') continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p)
  }
  return out
}

describe('通告的唯一调用者', () => {
  it('evictLive / announceRemoved 只在 member-presence 里被调用；announceRestored 只另许批量恢复那一处', () => {
    const violations = walk(join(ROOT, 'src'))
      .map((file) => file.slice(ROOT.length + 1).replace(/\\/g, '/'))
      .filter((file) => file !== PRESENCE)
      .flatMap((file) => {
        const text = readFileSync(join(ROOT, file), 'utf8')
        return [...text.matchAll(HOST_CALL)]
          .filter((match) => !(file === BATCH && match[1] === 'announceRestored'))
          .map((match) => `${file}: ${match[0]}`)
      })
    expect(violations).toEqual([])
  })

  it('扫描不是空转：member-presence 里三件都还命中着（删空它不会让上一条变绿）', () => {
    const text = readFileSync(join(ROOT, PRESENCE), 'utf8')
    const hits = new Set([...text.matchAll(HOST_CALL)].map((match) => match[1]))
    expect(hits).toEqual(new Set(['evictLive', 'announceRemoved', 'announceRestored']))
  })
})
