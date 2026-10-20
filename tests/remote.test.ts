// **错误映射**（`src/remote/map-error.ts`）
//
// 这张表是插件唯一的错误词汇（src/shared/wire.ts 的五个码），产出的是**线上信封那三件**
// （`{code, message, details?}`）——消费者是 `src/api/dispatch.ts`（路由层把结果原样塞进失败信封）。
import { describe, expect, it } from 'vitest'
import { toRemoteFailure } from '../src/remote/map-error.js'
import { verbError } from '../src/verbs/errors.js'

/** 宿主两条类型化错误的**结构替身**：跨插件类不可 import（值 import 是生态红线），
 *  我们按官方构造器写死的 `this.name` 认——asar `dsh-workspace/lib/index.js` 原文：
 *  `this.name = "WorkspaceUnknownSessionError"` / `this.name = "WorkspaceActiveSessionError"`。 */
const hostError = (name: string, message: string): Error =>
  Object.assign(new Error(message), { name })

describe('错误映射', () => {
  it('动词错误码原样过桥', () => {
    expect(toRemoteFailure(verbError('live', 'x')).code).toBe('sessiondelete/live')
  })

  it('未预期的异常落到 io，并带上原文', () => {
    const e = toRemoteFailure(new Error('ENOENT: boom'))
    expect(e.code).toBe('sessiondelete/io')
    expect(e.message).toContain('ENOENT')
  })

  // 带标记位的失败（宿主网关递出来的那种）**原样带出它的 code**，
  // 不再包一层：别域的码（`gateway/*`…）到这里不许被改写成我们的域。
  it('已经是带标记位的失败 ⇒ 原样带出它的 code 与 message', () => {
    const marked = Object.assign(new Error('网关原话'), { code: 'gateway/internal', isDSHRemoteError: true })
    expect(toRemoteFailure(marked)).toEqual({ code: 'gateway/internal', message: '网关原话' })
  })

  // 本表的产物**不带标记位**，再过一遍走的是「`sessiondelete/` 前缀 + 五个码」那条桥，
  // 结果同样不二次包装、原文不丢。
  it('本表的产物再过一遍是幂等的（不二次包装、原文不丢）', () => {
    const once = toRemoteFailure(verbError('trash-empty', 'y'))
    expect(toRemoteFailure(once)).toEqual(once)
  })

  // src/remote/map-error.ts 的两行映射：宿主类型化错误 → 我们的码。动词把宿主错误包成 `io` 并把原始错误挂在 cause 上
  // （`src/verbs/delete-session.ts` / `restore-session.ts` 的 `verbError('io', …, error)`），
  // 所以映射必须看得进 cause 链，否则这两行永远到不了客户端。
  it('动词包成 io 的宿主类型化错误，按 cause 映射回 live / not-found', () => {
    const active = verbError('io', '复原归档态失败：boom',
      hostError('WorkspaceActiveSessionError', 'cannot archive session x: the session is active (turn)'))
    expect(toRemoteFailure(active).code).toBe('sessiondelete/live')
    const unknown = verbError('io', '撤销归档失败：boom',
      hostError('WorkspaceUnknownSessionError', 'cannot unarchive session x: live sessions and session persistence hold no such session'))
    expect(toRemoteFailure(unknown).code).toBe('sessiondelete/not-found')
  })

  it('宿主类型化错误直接抛出（不经动词那层 io）时同样映射', () => {
    expect(toRemoteFailure(hostError('WorkspaceUnknownSessionError', 'nope')).code)
      .toBe('sessiondelete/not-found')
    expect(toRemoteFailure(hostError('WorkspaceActiveSessionError', 'busy')).code)
      .toBe('sessiondelete/live')
  })

  // `hostCodeOf` 沿 `cause` 链按 `this.name` 认宿主错误，查表必须用 `hasOwn`：
  // `'constructor' in {...}` 是 true（原型链），抛出的东西只要叫这个名字就会拿回一个**函数**当码。
  it('`name` 撞 Object.prototype 的键（constructor / toString…）不许冒充宿主码', () => {
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(toRemoteFailure(Object.assign(new Error('boom'), { name })))
        .toEqual({ code: 'sessiondelete/io', message: 'boom' })
    }
  })

  it('五个码之外的怪 code 一律落 io；官方域的 code 不再被改写（2026-10-17 错误面对齐）', () => {
    expect(toRemoteFailure(Object.assign(new Error('z'), { code: 'sessiondelete/nope' })).code)
      .toBe('sessiondelete/io')
    expect(toRemoteFailure(undefined).code).toBe('sessiondelete/io')
    // 旧断言把 `gateway/internal` 折成 `io`——那等于把宿主的判断抹成我们的，如今原样过桥
    expect(toRemoteFailure(Object.assign(new Error('z'), { code: 'gateway/internal' })).code)
      .toBe('gateway/internal')
  })

  // 上屏原文这条许诺对**非 Error 抛出物**同样成立（丢掉它就会让用户看到 `[object Object]`）。
  it('带 message 字符串的非 Error 抛出物，原文照样上屏', () => {
    expect(toRemoteFailure({ message: '宿主抛了个裸对象' }))
      .toEqual({ code: 'sessiondelete/io', message: '宿主抛了个裸对象' })
  })

  // 映射结果带着线上信封要的 code 与 message：`code` 是浏览器半的判别依据，
  // `message` 是上屏的原文——两样都必须从返回值上拿得到。
  it('映射结果带着线上信封要的 code 与 message', () => {
    const mapped = toRemoteFailure(verbError('project-missing', '原项目目录已不存在：/x'))
    expect(mapped.code).toBe('sessiondelete/project-missing')
    expect(mapped.message).toBe('原项目目录已不存在：/x')
  })

  // ── 2026-10-17 错误面对齐──────────────────────────────
  // 官方 `rpcErrorSchema` 是 `{code, message, details}` 三件；动词的结构化附带物不该在桥上被丢掉。
  it('动词错误带 details ⇒ 原样过桥（宿主把 activity/sessionId 塞在错误自己身上的那种）', () => {
    const e = Object.assign(verbError('live', '会话正在运行：session-a'), { sessionId: 'session-a', activity: [{ kind: 'turn' }] })
    const mapped = toRemoteFailure(e)
    expect(mapped.code).toBe('sessiondelete/live')
    // 官方 schema 是 `Record<string, unknown>`：activity 保留结构，不降级成 JSON 字符串。
    expect(mapped.details).toEqual({ sessionId: 'session-a', activity: [{ kind: 'turn' }] })
  })

  it('verbError 自己就能带 details（字符串表），第三件跟着上线', () => {
    const mapped = toRemoteFailure(verbError('project-missing', '原项目目录已不存在：/x', undefined, { path: '/x' }))
    expect(mapped).toEqual({ code: 'sessiondelete/project-missing', message: '原项目目录已不存在：/x', details: { path: '/x' } })
  })

  // 「就近优先」：动词在抛出处挂的 details 比 cause 链上宿主错误自己带的字段更近。
  it('details 就近优先：外层 verbError 挂的 details 覆盖 cause 上的宿主字段', () => {
    const inner = Object.assign(hostError('WorkspaceActiveSessionError', 'busy'), {
      sessionId: 'inner', activity: [{ kind: 'turn' }],
    })
    const mapped = toRemoteFailure(verbError('io', '包了一层', inner, { sessionId: 'outer' }))
    expect(mapped.code).toBe('sessiondelete/live')
    expect(mapped.details).toEqual({ sessionId: 'outer' })
  })

  // 带**官方形状 code**（`<域>/<名>`）的抛出物不再折成我们的 `io`：改写法就是把宿主的判断抹成我们的。
  // 没有 code 的仍按 cause 链/五个码走；**不合规式的 code**（没斜杠、非本域）照旧兜 io（上面那条已钉）。
  it('宿主自己域的失败（workspace/*、session/*）原样过桥，不被改写成 sessiondelete/io', () => {
    const active = Object.assign(new Error('cannot archive session x'), { code: 'workspace/session-active', sessionId: 'x' })
    expect(toRemoteFailure(active)).toMatchObject({ code: 'workspace/session-active', message: 'cannot archive session x' })
  })

  it('带标记位的失败若挂着 details，第三件也一起带出', () => {
    const marked = Object.assign(new Error('原话'), {
      code: 'workspace/session-active', isDSHRemoteError: true, details: { sessionId: 'x' },
    })
    expect(toRemoteFailure(marked).details).toEqual({ sessionId: 'x' })
  })
})
