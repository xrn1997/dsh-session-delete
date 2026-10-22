/**
 * 组级搬移：成员顺序、逐成员的 journal、以及失败时的整组逆序回滚。
 * 这里只测这一层；单成员步骤仍由 delete / restore 的用例钉住。
 */
import { describe, expect, it } from 'vitest'
import { moveGroup } from '../src/verbs/move-group.js'
import type { Journal } from '../src/verbs/member-journal.js'

function journal(id: string, log: string[], undoFailures: readonly string[] = []): Journal {
  return {
    run: async () => { log.push(`run:${id}`) },
    undo: async () => {
      log.push(`undo:${id}`)
      return {
        failures: undoFailures,
        restored: (key: string) => undoFailures.length === 0 && key === 'dir',
      }
    },
  }
}

describe('moveGroup', () => {
  it('按成员顺序跑；失败时把已做成的按相反顺序退回去', async () => {
    const log: string[] = []
    await expect(moveGroup(['a', 'b', 'c'], async (id) => {
      if (id === 'c') throw new Error('C boom')
      return { journal: journal(id, log), result: id }
    })).rejects.toThrow('C boom')
    expect(log).toEqual(['run:a', 'run:b', 'undo:b', 'undo:a'])
  })

  it('回滚失败并进原错误的 details.rollbackFailures', async () => {
    const log: string[] = []
    await expect(moveGroup(['a', 'b'], async (id) => {
      if (id === 'b') throw new Error('B boom')
      return { journal: journal(id, log, ['undo a failed']), result: id }
    })).rejects.toMatchObject({ details: { rollbackFailures: ['undo a failed'] } })
    expect(log).toEqual(['run:a', 'undo:a'])
  })

  it('按成员顺序交回结果；下一位能看到已交回的结果', async () => {
    const log: string[] = []
    const seen: string[][] = []
    const results = await moveGroup<string, string>(['a', 'b'], async (id, priorResults) => {
      seen.push([...priorResults])
      return { journal: journal(id, log), result: `result:${id}` }
    })
    expect(results).toEqual(['result:a', 'result:b'])
    expect(seen).toEqual([[], ['result:a']])
  })

  it('空成员表什么都不做', async () => {
    const log: string[] = []
    await moveGroup([], async (id) => ({ journal: journal(id, log), result: id }))
    expect(log).toEqual([])
  })
})
