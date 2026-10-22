/**
 * journal 的 undo 不只交失败串：每一步还要交回「到底退回去了没有」。
 * 事实只在这里产生一次，动词与 member-presence 都从这份结果读，不再各维护布尔。
 */
import { describe, expect, it } from 'vitest'
import { createJournal, type JournalStep, type JournalStepKey } from '../src/verbs/member-journal.js'

function step(key: JournalStepKey, undo?: JournalStep['undo']): JournalStep {
  return { key, label: key, run: async () => {}, undo }
}

describe('journal 逐步 undo', () => {
  it('按 key 交回每一步是否真的退回去了，同时保留失败串', async () => {
    const journal = createJournal([
      step('dir', async () => ({ restored: true, failures: [] })),
      step('workspace', async () => ({ restored: false, failures: ['账本挂回失败：boom'] })),
    ])
    await journal.run()
    const undo = await journal.undo()
    expect(undo.restored('dir')).toBe(true)
    expect(undo.restored('workspace')).toBe(false)
    // 这一步没跑过的键：同一张键面里取一个不在 journal 里的
    expect(undo.restored('archive')).toBe(false)
    expect(undo.failures).toEqual(['账本挂回失败：boom'])
  })

  it('run 中途失败：已做成的按相反顺序退，原错误带 rollbackFailures', async () => {
    const log: string[] = []
    const journal = createJournal([
      {
        key: 'dir', label: 'A', undoOnFailure: false,
        run: async () => { log.push('run:a') },
        undo: async () => { log.push('undo:a'); return { restored: true, failures: ['undo a failed'] } },
      },
      {
        key: 'workspace', label: 'B',
        run: async () => { log.push('run:b'); throw new Error('B boom') },
      },
    ])
    await expect(journal.run()).rejects.toMatchObject({
      code: 'sessiondelete/io',
      details: { rollbackFailures: ['undo a failed'] },
    })
    expect(log).toEqual(['run:a', 'run:b', 'undo:a'])
  })

  it('undoOnFailure 的步骤也进结果：自己刚失败的那一步先退', async () => {
    const log: string[] = []
    const journal = createJournal([
      {
        key: 'archive', label: '取消归档失败', undoOnFailure: true,
        run: async () => { log.push('run:archive'); throw new Error('half') },
        undo: async () => { log.push('undo:archive'); return { restored: false, failures: ['重新归档失败：half'] } },
      },
    ])
    await expect(journal.run()).rejects.toMatchObject({
      details: { rollbackFailures: ['重新归档失败：half'] },
    })
    expect(log).toEqual(['run:archive', 'undo:archive'])
  })
})
