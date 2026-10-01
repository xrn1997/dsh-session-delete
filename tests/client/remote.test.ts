// 浏览器半的远程面（信封判别 + 注入面那一处展开）
//
// 这一层钉住的是**契约形状**：两半之间的 unary 调用 resolve 成 `{ ok: true, value }` /
// `{ ok: false, error }`，失败是返回而不是 reject；展开（`unwrapRemoteResult`）发生一次，
// 之后组件面只认裸值与 throw。用例全部围绕这条契约，不触碰任何组件。
//
// 信封形状（`RemoteResult`）、失败形状（`RemoteFailure`）与标记位判别（`isDSHRemoteError`）的家是
// 两半共用的 `src/shared/wire.js`；这里验的是**浏览器半对它们的使用**：判别、原文兜底、注入面展开。
import { describe, expect, it } from 'vitest'
import { isDSHRemoteError, type RemoteFailure } from '../../src/shared/wire.js'
import { failureOf, unwrapRemoteResult } from '../../src/client/remote.js'

const FAILURE: RemoteFailure = { code: 'sessiondelete/live', message: '会话正在运行' }

describe('失败判别（标记位）与原文兜底', () => {
  it('官方标记位才认失败；普通 {code,message} 对象不算', () => {
    expect(isDSHRemoteError(Object.assign(new Error('x'), { code: 'sessiondelete/io', isDSHRemoteError: true }))).toBe(true)
    // 这正是上一版自造鸭子判别的地方：普通 `{code, message}`（不是官方 RemoteError 实例）不认。
    expect(isDSHRemoteError({ code: 'sessiondelete/io', message: 'x' })).toBe(false)
    expect(isDSHRemoteError({ isDSHRemoteError: true })).toBe(false)
    expect(isDSHRemoteError(new Error('x'))).toBe(false)
    expect(isDSHRemoteError(null)).toBe(false)
    expect(isDSHRemoteError('sessiondelete/io')).toBe(false)
  })

  it('失败原文与码都不丢：带标记位的失败带自己的 code，其余按原文兜底', () => {
    expect(failureOf(Object.assign(new Error('会话正在运行'), { code: 'sessiondelete/live', isDSHRemoteError: true }))).toEqual({
      code: 'sessiondelete/live',
      message: '会话正在运行',
    })
    expect(failureOf(new TypeError('x.map is not a function'))).toEqual({
      code: 'client/unknown',
      message: 'x.map is not a function',
    })
    expect(failureOf('炸了')).toEqual({ code: 'client/unknown', message: '炸了' })
  })
})

describe('注入面的展开', () => {
  it('ok 支原样给值', () => {
    expect(unwrapRemoteResult({ ok: true, value: 42 })).toBe(42)
  })

  it('失败支抛异常：message 是原文，code 保住且被打上官方的结构标记位', () => {
    let thrown: unknown
    try {
      unwrapRemoteResult({ ok: false, error: FAILURE })
    } catch (reason) {
      thrown = reason
    }
    expect(thrown).toBeInstanceOf(Error)
    const error = thrown as Error & { code?: string }
    expect(error.message).toBe('会话正在运行')
    expect(error.code).toBe('sessiondelete/live')
    // 展开后抛出来的东西仍是「远程失败」——下游 `failureOf` 靠标记位而不是鸭子类型认出它。
    expect(isDSHRemoteError(thrown)).toBe(true)
    expect(failureOf(thrown)).toEqual(FAILURE)
  })
})
