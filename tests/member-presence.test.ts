import { describe, expect, it } from 'vitest'
import { createLogWorld } from './support/world.js'
import { createMemberPresence, withPresenceTail } from '../src/verbs/member-presence.js'
import { createJournal } from '../src/verbs/member-journal.js'

function makeHost(opts: { evicted?: 'evicted' | 'not-live' | 'unknown' } = {}) {
  const made = createLogWorld({
    evicted: opts.evicted ?? 'not-live',
    logMethods: ['evictLive', 'announceRemoved', 'announceRestored'],
    format: (method, args) => `${method}(${Array.isArray(args[0]) ? (args[0] as readonly string[]).join(',') : String(args[0])})`,
  })
  return { host: made.host, log: made.calls }
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

  it('announceRestored：一批归位只发一次通告', async () => {
    const { host, log } = makeHost()
    await createMemberPresence(host).announceRestored(['s1', 's2'])
    expect(log).toEqual(['announceRestored(s1,s2)'])
  })
})

/** 一条最便宜的 journal：`restored` 结果就是两步的成败，不带任何业务。 */
function journalOf(dirBack: boolean, workspaceBack: boolean) {
  return createJournal([
    { key: 'dir', label: '目录', run: async () => {}, undo: async () => ({ restored: dirBack, failures: [] }) },
    { key: 'workspace', label: '账本', run: async () => {}, undo: async () => ({ restored: workspaceBack, failures: [] }) },
  ])
}

describe('在场尾巴工厂', () => {
  // 顺序承重：通告必须落在 journal 完全成功之后——搬一半就发 removed 是假话。
  it('run：删除尾巴在 journal 跑完之后才补离场通告', async () => {
    const { host, log } = makeHost({ evicted: 'evicted' })
    const journal = createJournal([
      { key: 'dir', label: '目录', run: async () => { log.push('step:dir') } },
    ])
    await withPresenceTail(createMemberPresence(host), journal, {
      sessionId: 's1',
      onDone: 'leave',
      onUndone: () => ({ kind: 'leave', backInTrash: true }),
    }).run()
    expect(log).toEqual(['step:dir', 'evictLive(s1)', 'announceRemoved(s1)'])
  })

  it('run：恢复那条没有 onDone ⇒ 只跑 journal，不动在场', async () => {
    const { host, log } = makeHost()
    const journal = createJournal([
      { key: 'dir', label: '目录', run: async () => { log.push('step:dir') } },
    ])
    await withPresenceTail(createMemberPresence(host), journal, {
      sessionId: 's1',
      onUndone: () => ({ kind: 'leave', backInTrash: true }),
    }).run()
    expect(log).toEqual(['step:dir'])
  })

  it('run：journal 自己抛 ⇒ 一条通告都不发，原错误照抛', async () => {
    const { host, log } = makeHost({ evicted: 'evicted' })
    const journal = createJournal([
      { key: 'dir', label: '目录', run: async () => { throw new Error('EBUSY') } },
    ])
    await expect(withPresenceTail(createMemberPresence(host), journal, {
      sessionId: 's1',
      onDone: 'leave',
      onUndone: () => ({ kind: 'leave', backInTrash: true }),
    }).run()).rejects.toMatchObject({ code: 'sessiondelete/io' })
    expect(log).toEqual([])
  })

  it('undo · kind:leave：目录退回回收站才发离场；没退回就什么都不发', async () => {
    for (const [dirBack, expected] of [
      [true, ['evictLive(s1)', 'announceRemoved(s1)']],
      [false, []],
    ] as const) {
      const { host, log } = makeHost({ evicted: 'evicted' })
      const journal = journalOf(dirBack, true)
      await journal.run()
      await withPresenceTail(createMemberPresence(host), journal, {
        sessionId: 's1',
        onUndone: (undo) => ({ kind: 'leave', backInTrash: undo.restored('dir') }),
      }).undo()
      expect(log).toEqual(expected)
    }
  })

  it('undo · kind:return：目录与账本都回去才发归位；缺一件就不发', async () => {
    for (const [dirBack, workspaceBack, expected] of [
      [true, true, ['announceRestored(s1)']],
      [true, false, []],
      [false, true, []],
    ] as const) {
      const { host, log } = makeHost()
      const journal = journalOf(dirBack, workspaceBack)
      await journal.run()
      await withPresenceTail(createMemberPresence(host), journal, {
        sessionId: 's1',
        onUndone: (undo) => ({
          kind: 'return',
          diskBack: undo.restored('dir'),
          workspaceBack: undo.restored('workspace'),
        }),
      }).undo()
      expect(log).toEqual(expected)
    }
  })

  it('undo：journal 的逐步结果原样交回，失败串不被工厂吞掉', async () => {
    const { host } = makeHost()
    const journal = createJournal([
      { key: 'dir', label: '目录', run: async () => {}, undo: async () => ({ restored: true, failures: ['清册行摘除失败：boom'] }) },
    ])
    await journal.run()
    const undo = await withPresenceTail(createMemberPresence(host), journal, {
      sessionId: 's1',
      onUndone: () => ({ kind: 'leave', backInTrash: true }),
    }).undo()
    expect(undo.failures).toEqual(['清册行摘除失败：boom'])
    expect(undo.restored('dir')).toBe(true)
  })
})
