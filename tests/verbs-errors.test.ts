import { describe, expect, it } from 'vitest'
import { isVerbCodeError, routeError, verbError, withRollbackFailures } from '../src/verbs/errors.js'

describe('回滚失败的结构化上报', () => {
  it('内层 details 合并进来，消息不重复「回滚未完成」', () => {
    const inner = verbError('io', '外层失败；回滚未完成：成员自己没退回去', undefined, {
      rollbackFailures: ['成员自己没退回去'],
    })
    const wrapped = withRollbackFailures(inner, ['兄弟没退回去'])
    expect(wrapped.code).toBe('sessiondelete/io')
    expect(wrapped.details).toEqual({ rollbackFailures: ['成员自己没退回去', '兄弟没退回去'] })
    expect(wrapped.message.match(/回滚未完成/g)).toHaveLength(1)
    expect(wrapped.message).toContain('兄弟没退回去')
  })

  it('失败列表去重，原错误的动词码保留', () => {
    const inner = verbError('live', '会话正在运行', undefined, { rollbackFailures: ['x'] })
    const wrapped = withRollbackFailures(inner, ['x', 'y'])
    expect(wrapped.code).toBe('sessiondelete/live')
    expect(wrapped.details).toEqual({ rollbackFailures: ['x', 'y'] })
  })

  it('没有可继承的动词码就落 io', () => {
    const wrapped = withRollbackFailures(new Error('boom'), ['x'])
    expect(wrapped.code).toBe('sessiondelete/io')
    expect(wrapped.details).toEqual({ rollbackFailures: ['x'] })
  })
})

describe('isVerbCodeError：本仓动词码的唯一判据', () => {
  it('verbError 与 routeError 的输出都算', () => {
    expect(isVerbCodeError(verbError('io', 'boom'))).toBe(true)
    expect(isVerbCodeError(verbError('not-found', '这一组已经不在了'))).toBe(true)
    expect(isVerbCodeError(routeError('bad-request', 400, '请求体不对'))).toBe(true)
  })

  it('别的错误、缺 code、非字符串 code 都不算', () => {
    expect(isVerbCodeError(new Error('boom'))).toBe(false)
    expect(isVerbCodeError({ code: 'ENOENT' })).toBe(false)
    expect(isVerbCodeError({ code: 42 })).toBe(false)
    expect(isVerbCodeError({ code: 'sessiondelete/' })).toBe(true) // 只认前缀，不认后缀是否在册
    expect(isVerbCodeError('sessiondelete/io')).toBe(false)
    expect(isVerbCodeError(undefined)).toBe(false)
    expect(isVerbCodeError(null)).toBe(false)
  })
})
