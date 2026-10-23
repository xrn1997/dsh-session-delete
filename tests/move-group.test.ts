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
  it('根先跑；跟随者拿到根结果；失败时把已做成的按相反顺序退回', async () => {
    const log: string[] = []
    const seen: Array<string | undefined> = []
    await expect(moveGroup<string, string>({
      root: 'root',
      followers: ['a', 'b'],
      move: async (id, rootResult) => {
        seen.push(rootResult)
        if (id === 'b') throw new Error('B boom')
        return { journal: journal(id, log), result: `result:${id}` }
      },
    })).rejects.toThrow('B boom')
    expect(seen).toEqual([undefined, 'result:root', 'result:root'])
    expect(log).toEqual(['run:root', 'run:a', 'undo:a', 'undo:root'])
  })

  it('回滚失败并进原错误的 details.rollbackFailures', async () => {
    const log: string[] = []
    await expect(moveGroup<string, string>({
      root: 'a',
      followers: ['b'],
      move: async (id) => {
        if (id === 'b') throw new Error('B boom')
        return { journal: journal(id, log, ['undo a failed']), result: id }
      },
    })).rejects.toMatchObject({ details: { rollbackFailures: ['undo a failed'] } })
    expect(log).toEqual(['run:a', 'undo:a'])
  })

  it('根结果直接交回；跟随者拿到根结果，自己的结果不向上交回', async () => {
    const log: string[] = []
    const moved = await moveGroup<string, string>({
      root: 'a',
      followers: ['b', 'c'],
      move: async (id, rootResult) => ({ journal: journal(id, log), result: `${rootResult ?? 'root'}:${id}` }),
    })
    expect(moved).toBe('root:a')
    expect(log).toEqual(['run:a', 'run:b', 'run:c'])
  })
})
