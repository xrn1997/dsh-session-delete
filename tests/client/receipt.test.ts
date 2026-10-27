import { describe, expect, it } from 'vitest'
import {
  failureMessage,
  landedEntryIds,
  missingOutcomeMessage,
  readReceipt,
  readSingleReceipt,
  restoredSessionIds,
  summarizeReceipt,
} from '../../src/client/receipt.js'
import { SESSION_DELETE_CODES, type ApplyOutcome } from '../../src/shared/wire.js'

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
      .verdicts.filter((verdict) => verdict.kind !== 'ok' && verdict.kind !== 'already-gone')
    expect(failures.map((verdict) => failureMessage(verdict))).toEqual([
      '不在了',
      '坏了',
      missingOutcomeMessage('orphan-clean', 'c'),
    ])
  })
})

describe('summarizeReceipt', () => {
  it('中性、失败与部分计数一次算好，座位不再自己 walk verdict', () => {
    const receipt = readReceipt('orphan-clean', ['a', 'b', 'c'], [
      { id: 'a', action: 'orphan-clean', ok: true, value: { removed: 1, freedBytes: 2 } },
      { id: 'b', action: 'orphan-clean', ok: false, error: { code: SESSION_DELETE_CODES['not-found'], message: 'gone' } },
      { id: 'c', action: 'orphan-clean', ok: false, error: { code: SESSION_DELETE_CODES.io, message: 'boom', details: { removed: 3, freedBytes: 9 } } },
    ])
    const { summary, failures } = summarizeReceipt(receipt)
    expect(summary.successIds).toEqual(['a'])
    expect(summary.neutralIds).toEqual(['b'])
    expect(summary.failed.map((item) => item.id)).toEqual(['c'])
    expect(summary.partial).toEqual({ removed: 3, freedBytes: 9 })
    expect(failures.get('b')).toBe('gone')
    expect(failures.get('c')).toBe('boom')
    expect(summary.anySuccess).toBe(true)
  })

  it('restore 的 already-gone 仍由条目查找补 sessionId', () => {
    const receipt = readReceipt('restore', ['e1', 'e2'], [
      { id: 'e1', action: 'restore', ok: true, value: row('e1') },
      { id: 'e2', action: 'restore', ok: true, value: null },
    ])
    const { summary } = summarizeReceipt(receipt, (id) => (id === 'e2' ? 'session-e2' : undefined))
    expect(summary.landedIds).toEqual(['session-e1', 'session-e2'])
  })

  it('delete 的成功行也带 sessionId，但落地名单只收条目 id：域由 action 定', () => {
    const { summary } = summarizeReceipt(readReceipt('delete', ['a'], [entry('a')]))
    // 成功值里的 sessionId 是 `session-a`：拿它冒充落地条目就会撤销到不存在的条目。
    expect(summary.landedIds).toEqual(['a'])
  })

  it('purge / orphan-clean 没有可撤销的落地 id', () => {
    const purge = summarizeReceipt(readReceipt('purge', ['p'], [
      { id: 'p', action: 'purge', ok: true, value: { removed: 1, freedBytes: 1 } },
    ]))
    expect(purge.summary.landedIds).toEqual([])
  })

  it('purge 回执里的附件统计聚合成摘要；跳过与失败分开保留', () => {
    const outcomes: ApplyOutcome[] = [{
      id: 'e1', action: 'purge', ok: true,
      value: { removed: 1, freedBytes: 10, attachments: { removed: 2, freedBytes: 20, failed: 1, skipped: 'x' } },
    }]
    const read = summarizeReceipt(readReceipt('purge', ['e1'], outcomes))
    expect(read.summary.attachmentCleanup).toEqual({ removed: 2, freedBytes: 20, failed: 1, skipped: 'x' })
  })

  // `skipped` 是原因、不是计数：两条 ok 各带一句时留**第一条**。把 `skipped ??=` 改成 `skipped =`
  // 会被后一条覆盖，所以这条用例必须让两条都真的带值。
  it('purge：两条 ok 都带 skipped ⇒ 第一条赢', () => {
    const receipt = readReceipt('purge', ['p1', 'p2'], [
      { id: 'p1', action: 'purge', ok: true, value: { removed: 0, freedBytes: 0, attachments: { removed: 0, freedBytes: 0, failed: 0, skipped: '第一条' } } },
      { id: 'p2', action: 'purge', ok: true, value: { removed: 0, freedBytes: 0, attachments: { removed: 0, freedBytes: 0, failed: 0, skipped: '第二条' } } },
    ])
    expect(summarizeReceipt(receipt).summary.attachmentCleanup?.skipped).toBe('第一条')
  })

  // seen=false 的那条路：ok 但这一条没有半点附件读数（老服务端 / 这一组根本没附件）⇒ 摘要不许
  // 拿零冒充"清过"，整个字段缺席。`attachments: null` 是畸形线上值，同样按没有读数处理（不炸）。
  it('purge 的 ok 回执没有 attachments（或它是 null）⇒ 摘要没有读数', () => {
    const absent = readReceipt('purge', ['p'], [
      { id: 'p', action: 'purge', ok: true, value: { removed: 1, freedBytes: 1 } },
    ])
    expect(summarizeReceipt(absent).summary.attachmentCleanup).toBeUndefined()

    const nulled = readReceipt('purge', ['p'], [
      { id: 'p', action: 'purge', ok: true, value: { removed: 1, freedBytes: 1, attachments: null } },
    ] as unknown as ApplyOutcome[])
    expect(summarizeReceipt(nulled).summary.attachmentCleanup).toBeUndefined()
  })

  // 一段 `/apply` 可能带多条 ok 回执（批量彻底删除），附件读数要相加；失败条不参与，
  // `skipped` 取**第一条有的**——跳过说的是"这一轮为什么没敢清"，多组各有一句时不叠加。
  it('附件读数跨多条 ok 回执相加；skipped 留第一条；失败条不参与', () => {
    const receipt = readReceipt('orphan-clean', ['a', 'b', 'c'], [
      { id: 'a', action: 'orphan-clean', ok: true, value: { removed: 1, freedBytes: 1 } },
      { id: 'b', action: 'orphan-clean', ok: true, value: { removed: 1, freedBytes: 1, attachments: { removed: 2, freedBytes: 20, failed: 0, skipped: '第一条的原因' } } },
      { id: 'c', action: 'orphan-clean', ok: true, value: { removed: 1, freedBytes: 1, attachments: { removed: 3, freedBytes: 30, failed: 1, skipped: '后面那句不覆盖' } } },
    ])
    expect(summarizeReceipt(receipt).summary.attachmentCleanup).toEqual({
      removed: 5, freedBytes: 50, failed: 1, skipped: '第一条的原因',
    })

    const failedOnly = readReceipt('purge', ['p'], [
      {
        id: 'p', action: 'purge', ok: false,
        error: { code: SESSION_DELETE_CODES.io, message: 'boom', details: { attachments: { removed: 9, freedBytes: 90, failed: 9 } } },
      },
    ])
    expect(summarizeReceipt(failedOnly).summary.attachmentCleanup).toBeUndefined()
  })

  it('别的动作不产生附件摘要：delete / restore 的回执里没有那个读数', () => {
    const del = summarizeReceipt(readReceipt('delete', ['a'], [entry('a')]))
    const restore = summarizeReceipt(readReceipt('restore', ['e1'], [
      { id: 'e1', action: 'restore', ok: true, value: row('e1') },
    ]))
    expect(del.summary.attachmentCleanup).toBeUndefined()
    expect(restore.summary.attachmentCleanup).toBeUndefined()
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
