import { describe, expect, it } from 'vitest'
import {
  failureMessage,
  isFailureVerdict,
  landedEntryIds,
  missingOutcomeMessage,
  readReceipt,
  readSingleReceipt,
  restoredSessionIds,
} from '../../src/client/receipt.js'
import type { ApplyOutcome } from '../../src/shared/wire.js'

const row = (id: string) => ({
  id, sessionId: `session-${id}`, projectDir: '--p--', workspaceId: 'ws',
  wasArchived: false, deletedAt: 1, title: id, sizeBytes: 1,
})
const entry = (id: string): ApplyOutcome => ({ id, action: 'delete', ok: true, value: row(id) })
const gone = (id: string): ApplyOutcome => ({ id, action: 'delete', ok: true, value: null })
const failed = (id: string, message = 'boom'): ApplyOutcome =>
  ({ id, action: 'delete', ok: false, error: { code: 'sessiondelete/io', message } })

describe('readReceipt', () => {
  it('gives one verdict per requested id: ok / already-gone / failed', () => {
    const receipt = readReceipt('delete', ['a', 'b', 'c'], [entry('a'), gone('b'), failed('c')])
    expect(receipt.verdicts.map((v) => v.kind)).toEqual(['ok', 'already-gone', 'failed'])
    expect(receipt.byId.get('a')).toMatchObject({ kind: 'ok', value: { id: 'a' } })
    expect(receipt.byId.get('b')).toMatchObject({ kind: 'already-gone' })
    expect(receipt.byId.get('c')).toMatchObject({ kind: 'failed', error: { message: 'boom' } })
  })

  it('requested but absent = missing, not silent success', () => {
    const receipt = readReceipt('delete', ['a', 'b'], [entry('a')])
    expect(receipt.verdicts[1]).toEqual({
      kind: 'missing', id: 'b',
      message: missingOutcomeMessage('delete', 'b'),
    })
  })

  it('dedupes requested ids and preserves order', () => {
    const receipt = readReceipt('delete', ['a', 'a'], [entry('a')])
    expect(receipt.verdicts).toHaveLength(1)
    expect(receipt.verdicts[0]).toMatchObject({ kind: 'ok', id: 'a' })
  })

  it('duplicate outcomes for one id: the first one wins', () => {
    const receipt = readReceipt('delete', ['a'], [entry('a'), failed('a', 'later')])
    expect(receipt.verdicts).toHaveLength(1)
    expect(receipt.byId.get('a')).toMatchObject({ kind: 'ok', value: { id: 'a' } })
  })

  it('an outcome for an id that was not requested stays out of the receipt', () => {
    const receipt = readReceipt('delete', ['a'], [entry('a'), entry('ghost')])
    expect(receipt.verdicts.map((v) => v.id)).toEqual(['a'])
    expect(receipt.byId.has('ghost')).toBe(false)
  })

  it('an outcome with another action does not count for this id', () => {
    const receipt = readReceipt('delete', ['a'], [{ id: 'a', action: 'restore', ok: true, value: null }])
    expect(receipt.verdicts[0]).toMatchObject({ kind: 'missing' })
  })

  it('orphan-clean not-found is neutral; other failures stay failed', () => {
    const neutral: ApplyOutcome = {
      id: 'a', action: 'orphan-clean', ok: false,
      error: { code: 'sessiondelete/not-found', message: '不在了' },
    }
    const broken: ApplyOutcome = {
      id: 'b', action: 'orphan-clean', ok: false,
      error: { code: 'sessiondelete/io', message: '坏了', details: { removed: 1 } },
    }
    const receipt = readReceipt('orphan-clean', ['a', 'b'], [neutral, broken])
    expect(receipt.verdicts.map((v) => v.kind)).toEqual(['neutral', 'failed'])
    expect(receipt.verdicts[1]).toMatchObject({ kind: 'failed', error: { details: { removed: 1 } } })
  })

  it('single: null 是协议错，不再是 already-gone', () => {
    const receipt = readReceipt('delete', ['a'], [gone('a')], { single: true })
    expect(receipt.verdicts[0]).toEqual({
      kind: 'failed',
      id: 'a',
      error: { code: 'client/unknown', message: '单条动作回了幂等空值：delete a' },
    })
  })

  it('readSingleReceipt：正常成功支仍是 ok，且类型面不含 already-gone', () => {
    const receipt = readSingleReceipt('delete', 'a', [entry('a')])
    expect(receipt.verdicts[0]).toMatchObject({ kind: 'ok', id: 'a', value: { id: 'a' } })
  })

  it('readSingleReceipt：null 折成 failed，single 读法不产生 already-gone', () => {
    const receipt = readSingleReceipt('delete', 'a', [gone('a')])
    expect(receipt.verdicts[0]).toMatchObject({
      kind: 'failed',
      id: 'a',
      error: { code: 'client/unknown', message: '单条动作回了幂等空值：delete a' },
    })
  })

  it('failureMessage: failed/neutral use error.message; missing uses message', () => {
    const neutral: ApplyOutcome = {
      id: 'a', action: 'orphan-clean', ok: false,
      error: { code: 'sessiondelete/not-found', message: '不在了' },
    }
    const broken: ApplyOutcome = {
      id: 'b', action: 'orphan-clean', ok: false,
      error: { code: 'sessiondelete/io', message: '坏了' },
    }
    const failures = readReceipt('orphan-clean', ['a', 'b', 'c'], [neutral, broken])
      .verdicts.filter(isFailureVerdict)
    expect(failures.map((verdict) => failureMessage(verdict))).toEqual([
      '不在了',
      '坏了',
      missingOutcomeMessage('orphan-clean', 'c'),
    ])
  })
})

describe('landedEntryIds', () => {
  it('只收 ok 支的条目 id；already-gone / failed / purge 的聚合值都不算', () => {
    const receipt = readReceipt('delete', ['a', 'b', 'c'], [entry('a'), gone('b'), failed('c')])
    expect(landedEntryIds(receipt)).toEqual(['a'])

    const purge = readReceipt('purge', ['p'], [
      { id: 'p', action: 'purge', ok: true, value: { removed: 1, freedBytes: 1 } },
    ])
    expect(landedEntryIds(purge)).toEqual([])
  })

  it('restore 的 ok 支取条目 id（撤销名单与回盘的 sessionId 是两个域）', () => {
    const receipt = readReceipt('restore', ['e1'], [
      { id: 'e1', action: 'restore', ok: true, value: row('e1') },
    ])
    expect(landedEntryIds(receipt)).toEqual(['e1'])
  })
})

describe('restoredSessionIds', () => {
  const restoreEntry = (id: string): ApplyOutcome =>
    ({ id, action: 'restore', ok: true, value: row(id) })
  const restoreGone = (id: string): ApplyOutcome =>
    ({ id, action: 'restore', ok: true, value: null })
  const purgeOk = (id: string): ApplyOutcome =>
    ({ id, action: 'purge', ok: true, value: { removed: 1, freedBytes: 1 } })

  it('ok 支取 sessionId；already-gone 由条目查找兜底；purge 的聚合值跳过', () => {
    const receipt = readReceipt('restore', ['a', 'b'], [restoreEntry('a'), restoreGone('b')])
    expect(restoredSessionIds(receipt, (id) => id === 'b' ? 'session-b' : undefined))
      .toEqual(['session-a', 'session-b'])
    expect(restoredSessionIds(readReceipt('purge', ['c'], [purgeOk('c')]))).toEqual([])
  })

  it('没有兜底时 already-gone 不产生 id（撤销横幅原语义）', () => {
    const receipt = readReceipt('restore', ['a'], [restoreGone('a')])
    expect(restoredSessionIds(receipt)).toEqual([])
  })
})
