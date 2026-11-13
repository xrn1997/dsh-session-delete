import { describe, expect, it } from 'vitest'
import { trashEmpty, verbError, withRollbackFailures } from '../src/errors.js'

describe('`trash-empty` 的原文', () => {
  // 原文要上屏，点名那句是承重的（purge 与详情都靠它告诉用户"你点的这条不在清单里"）。
  it('拿得到条目就点名那个 id，拿不到时只报通用那句', () => {
    expect(trashEmpty('a1').message).toBe('回收站里没有这一条：a1')
    expect(trashEmpty().message).toBe('回收站里没有这一条')
    expect(trashEmpty().code).toBe('sessiondelete/trash-empty')
  })
})

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

  // 孤儿清理的部分回执就挂在原错误的 details 上，且客户端按它显示「已经删掉了多少」；
  // 回滚失败只能追加一项，不能把整份 details 换成只剩 rollbackFailures。
  it('原错误的其他 details 原样保留，只并入 rollbackFailures', () => {
    const inner = verbError('io', '删除会话目录失败：Error: EBUSY', undefined, {
      removed: 1,
      freedBytes: 100,
      failedSessionId: 'session-kid',
    })
    const wrapped = withRollbackFailures(inner, ['恢复归档失败：registry down'])
    expect(wrapped.details).toEqual({
      removed: 1,
      freedBytes: 100,
      failedSessionId: 'session-kid',
      rollbackFailures: ['恢复归档失败：registry down'],
    })
  })
})
