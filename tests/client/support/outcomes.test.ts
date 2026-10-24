import { describe, expect, it } from 'vitest'
import {
  countOutcomes, deleteOutcomes, failed, ok, outcomes, restoreOutcomes, trashRow, writeFailed, writeOutcome,
} from './outcomes.js'

describe('测试回执构造器', () => {
  it('ok / failed 产出判别联合的两支', () => {
    expect(ok('count', 'a', 3)).toEqual({ id: 'a', action: 'count', ok: true, value: 3 })
    expect(failed('restore', 'e1', '读不到')).toEqual({
      id: 'e1', action: 'restore', ok: false,
      error: { code: 'sessiondelete/io', message: '读不到' },
    })
  })

  // 两条 id 约定是各座位算撤销名单与恢复通告时的承重格：抄反了界面只读自己关心的那半句，测试仍是绿的。
  it('delete / restore 的成功支各带一行，id 域按约定分（条目 id ↔ 会话 id）', () => {
    expect(deleteOutcomes(['s1', 's2'], ['s2'])).toEqual([
      { id: 's1', action: 'delete', ok: true, value: trashRow('entry-s1', 's1') },
      { id: 's2', action: 'delete', ok: false, error: { code: 'sessiondelete/io', message: '会话目录不在盘上' } },
    ])
    expect(restoreOutcomes(['e1'])).toEqual([
      { id: 'e1', action: 'restore', ok: true, value: trashRow('e1', 'session-e1') },
    ])
  })

  it('outcomes 按 id 覆盖成功值或失败；默认值按动作给', () => {
    expect(outcomes('delete', ['a', 'b'], { b: { message: '删不动' } })).toEqual([
      { id: 'a', action: 'delete', ok: true, value: null },
      { id: 'b', action: 'delete', ok: false, error: { code: 'sessiondelete/io', message: '删不动' } },
    ])
    expect(countOutcomes(['a'], { a: 4 })).toEqual([{ id: 'a', action: 'count', ok: true, value: 4 }])
  })

  it('writeOutcome / writeFailed 造出 query 层要的两种形状', () => {
    const success = writeOutcome('purge', ['e1'])
    expect(success.ok).toBe(true)
    expect(success.failures.size).toBe(0)
    expect(success.successIds).toEqual([])
    expect(success.anySuccess).toBe(false)

    const failedWrite = writeFailed('delete', ['a', 'b'], '通道断了')
    expect(failedWrite.ok).toBe(false)
    expect([...failedWrite.failures.entries()]).toEqual([['a', '通道断了'], ['b', '通道断了']])
  })
})
