import { describe, expect, it } from 'vitest'
import { failureMessage, isFailureVerdict, missingOutcomeMessage, readReceipt } from '../../src/client/receipt.js'
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
