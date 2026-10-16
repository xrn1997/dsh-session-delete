// 浏览器半的远程面（信封判别 + 注入面那一处展开）
//
// 这一层钉住的是**契约形状**：两半之间的 unary 调用 resolve 成 `{ ok: true, value }` /
// `{ ok: false, error }`，失败是返回而不是 reject；展开（`unwrapRemoteResult`）发生一次，
// 之后组件面只认裸值与 throw。用例全部围绕这条契约，不触碰任何组件。
//
// 信封形状（`RemoteResult`）、失败形状（`RemoteFailure`）与标记位判别（`isDSHRemoteError`）的家是
// 两半共用的 `src/shared/wire.js`；这里验的是**浏览器半对它们的使用**：判别、原文兜底、注入面展开。
import { describe, expect, it, vi } from 'vitest'
import { PARAMS, ROUTES, SESSION_DELETE_API_PREFIX, isDSHRemoteError, type RemoteFailure } from '../../src/shared/wire.js'
import {
  buildDeps,
  createHttpRemote,
  failureOf,
  probeChannel,
  unwrapRemoteResult,
} from '../../src/client/remote.js'

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

describe('createHttpRemote · detail 那一趟（第五个端点）', () => {
  const envelope = (value: unknown) =>
    new Response(JSON.stringify({ ok: true, value }), { headers: { 'content-type': 'application/json' } })

  it('POST 到 /detail，请求体是 { entryId }（字段名与 Node 半同源）', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      calls.push({ path, init })
      return envelope({ entryId: 'e1', messages: [] })
    })
    await expect(createHttpRemote().detail('e1')).resolves.toMatchObject({ ok: true })
    expect(calls[0]!.path).toBe(`${SESSION_DELETE_API_PREFIX}${ROUTES.detail}`)
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ [PARAMS.entryId]: 'e1' })
    vi.unstubAllGlobals()
  })

  it('注入面把失败支展成 throw，码与原文都不丢（详情读失败要能原样上屏）', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ ok: false, error: { code: 'sessiondelete/io', message: '读会话日志失败：第 2 帧解压失败' } }),
        { headers: { 'content-type': 'application/json' } }))
    const deps = buildDeps(createHttpRemote())
    await expect(deps.detail('e1')).rejects.toMatchObject({
      code: 'sessiondelete/io',
      message: '读会话日志失败：第 2 帧解压失败',
    })
    vi.unstubAllGlobals()
  })

  it('探测仍然只探 /list：通道在不在不由 detail 决定', async () => {
    const paths: string[] = []
    vi.stubGlobal('fetch', async (path: string) => {
      paths.push(path)
      return envelope([])
    })
    await expect(probeChannel(createHttpRemote())).resolves.toBe(true)
    expect(paths).toEqual([`${SESSION_DELETE_API_PREFIX}${ROUTES.list}`])
    vi.unstubAllGlobals()
  })
})
