// 请求栅栏的判据矩阵（`src/api/request-trust.ts`）：归属、身份、rebinding 三条线各自钉死。
//
// 这层是**纯判据**，不碰 socket 也不起服务器：伪造 `headers` 与 `socket.remoteAddress` 就是全部台架。
// 集成面（分发器把裁决翻成 403 与原文）在 `tests/api.test.ts` 的「路由层 · 请求栅栏」。
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { judgeRequest, type RequestTrustFacts } from '../src/api/request-trust.js'
import { createConnectionPort } from '../src/ports/connection-port.js'
import {
  ABSENT_CONNECTION,
  ALLOWED_CONNECTION,
  UNAUTHENTICATED_CONNECTION,
  UNTRUSTED_CONNECTION,
} from './support/connection-stub.js'

function request(headers: Record<string, string>, remoteAddress = '127.0.0.1'): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage
}

function facts(over: Partial<RequestTrustFacts> = {}): RequestTrustFacts {
  return { bindHost: undefined, connection: ABSENT_CONNECTION, ...over }
}

describe('请求栅栏 · 本机支：回环 socket ∧ Host 属于本次部署', () => {
  it.each(['127.0.0.1:3080', '127.0.0.2:3080', 'localhost:3080', '[::1]:3080'])(
    'Host %s + 回环源地址 ⇒ 放行（回环名含整个 127/8）', (host) => {
      expect(judgeRequest(request({ host }), facts())).toBe('allowed')
    },
  )

  it('Host 是监听器的 bind 字面量（本机用 LAN IP 自访）⇒ 放行', () => {
    const req = request({ host: '192.168.50.199:3080' })
    expect(judgeRequest(req, facts({ bindHost: '192.168.50.199' }))).toBe('allowed')
    // 端口不参与归属；zone 是接口选择器，不是地址文本
    expect(judgeRequest(request({ host: '192.168.50.199:9' }), facts({ bindHost: '192.168.50.199' }))).toBe('allowed')
    expect(judgeRequest(request({ host: '[fe80::1]:3080' }), facts({ bindHost: 'fe80::1%eth0' }))).toBe('allowed')
  })

  it('同源 Origin / Referer 与默认端口归一都放行', () => {
    expect(judgeRequest(request({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }), facts())).toBe('allowed')
    expect(judgeRequest(request({ host: '127.0.0.1:3080', referer: 'http://127.0.0.1:3080/trash' }), facts())).toBe('allowed')
    expect(judgeRequest(request({ host: '127.0.0.1:80', origin: 'http://127.0.0.1' }), facts())).toBe('allowed')
  })

  it('桌面壳那条路（Origin 被摘掉、Referer 是 dsh-app://app/）放行；Origin 是它也放行', () => {
    expect(judgeRequest(request({ host: '127.0.0.1:3080', referer: 'dsh-app://app/' }), facts())).toBe('allowed')
    expect(judgeRequest(request({ host: '127.0.0.1:3080', origin: 'dsh-app://app' }), facts())).toBe('allowed')
  })

  it('两者都缺席 = 本机工具（curl 形态）放行', () => {
    expect(judgeRequest(request({ host: '127.0.0.1:3080' }), facts())).toBe('allowed')
  })

  it('回环 socket 不是归属的豁免：Host 写成外来域名就拒（DNS rebinding 的形状）', () => {
    const req = request({ host: 'evil.example:3080', origin: 'http://evil.example:3080' })
    expect(judgeRequest(req, facts())).toBe('untrusted')
    expect(judgeRequest(req, facts({ connection: ALLOWED_CONNECTION }))).toBe('allowed')
    expect(judgeRequest(req, facts({ connection: UNTRUSTED_CONNECTION }))).toBe('untrusted')
  })
})

describe('请求栅栏 · 头栅栏（任何客户端都要过）', () => {
  it.each([
    ['跨源 Origin', { host: '127.0.0.1:3080', origin: 'https://evil.example' }],
    ['跨源 Referer', { host: '127.0.0.1:3080', referer: 'https://evil.example/x' }],
    ['dsh-app 前缀但不是桌面壳那个 host', { host: '127.0.0.1:3080', referer: 'dsh-app://app.evil/' }],
    ['sec-fetch-site: cross-site', { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }],
    ['缺 Host', { origin: 'http://127.0.0.1:3080' }],
    ['Host 不成形', { host: 'bad host' }],
    ['Origin 不是 http(s)（opaque / null）', { host: '127.0.0.1:3080', origin: 'null' }],
    ['Origin 是 file:', { host: '127.0.0.1:3080', origin: 'file:///tmp/x' }],
  ])('%s ⇒ 非受信', (_name, headers) => {
    expect(judgeRequest(request(headers), facts())).toBe('untrusted')
  })
})

describe('请求栅栏 · 远程支：身份承宿主 connection', () => {
  const remote = '192.168.50.77'

  it('Host 属于本次部署但源地址非回环 ⇒ 要身份（unauthenticated）', () => {
    expect(judgeRequest(
      request({ host: '192.168.50.199:3080' }, remote),
      facts({ bindHost: '192.168.50.199', connection: UNAUTHENTICATED_CONNECTION }),
    )).toBe('unauthenticated')
    // 远程客户端声称 Host 是 localhost 也一样：归属对、身份缺
    expect(judgeRequest(
      request({ host: 'localhost:3080' }, remote),
      facts({ connection: UNAUTHENTICATED_CONNECTION }),
    )).toBe('unauthenticated')
  })

  it('宿主认可（requestRejection 回 undefined）⇒ 放行', () => {
    const req = request({ host: 'dsh.internal:3080', origin: 'http://dsh.internal:3080' }, remote)
    expect(judgeRequest(req, facts({ connection: ALLOWED_CONNECTION }))).toBe('allowed')
  })

  // issue #6 的形态：局域网里的浏览器打宿主 bind 的那个 IP。Host 属于本次部署，但源地址不是回环
  // ⇒ 归属对、身份缺；带了那枚 cookie 时宿主认可，插件放行。
  it('远程客户端打 bind 字面量：归属对、要身份；宿主认可即放行', () => {
    const req = request({ host: '192.168.50.199:3080' }, remote)
    expect(judgeRequest(req, facts({ bindHost: '192.168.50.199', connection: UNAUTHENTICATED_CONNECTION })))
      .toBe('unauthenticated')
    expect(judgeRequest(req, facts({ bindHost: '192.168.50.199', connection: ALLOWED_CONNECTION })))
      .toBe('allowed')
  })

  it('宿主回 401（栅栏过、身份缺）⇒ unauthenticated；回 403（归属不对）⇒ untrusted', () => {
    const req = request({ host: 'dsh.internal:3080' }, remote)
    expect(judgeRequest(req, facts({ connection: UNAUTHENTICATED_CONNECTION }))).toBe('unauthenticated')
    expect(judgeRequest(req, facts({ connection: UNTRUSTED_CONNECTION }))).toBe('untrusted')
  })

  // 身份层缺席时没有可换的身份：即使 Host 属于本次部署，也只能按归属不对拒——否则原文会把人
  // 指向一个不存在的入口（ADR-0022 决定 5）。
  it('服务缺席（absent）一律按归属不对拒，不提示去换身份', () => {
    expect(judgeRequest(request({ host: 'dsh.internal:3080' }, remote), facts())).toBe('untrusted')
    expect(judgeRequest(request({ host: '192.168.50.199:3080' }, remote), facts({ bindHost: '192.168.50.199' })))
      .toBe('untrusted')
    expect(judgeRequest(request({ host: 'localhost:3080' }, remote), facts())).toBe('untrusted')
  })
})

describe('connection 端口：每次请求惰性解析、缺席 / 抛错都 fail-closed', () => {
  const ctxWith = (service: unknown): Context => ({ get: () => service }) as unknown as Context

  it('服务缺席或成员不是函数 ⇒ absent', () => {
    expect(createConnectionPort(ctxWith(undefined)).verdictFor(request({}))).toEqual({ kind: 'absent' })
    expect(createConnectionPort(ctxWith({})).verdictFor(request({}))).toEqual({ kind: 'absent' })
    expect(createConnectionPort(ctxWith({ requestRejection: 42 })).verdictFor(request({}))).toEqual({ kind: 'absent' })
  })

  it('宿主的状态码翻成裁决：401 = 缺身份，其余 = 归属不对', () => {
    expect(createConnectionPort(ctxWith({ requestRejection: () => 401 })).verdictFor(request({})))
      .toEqual({ kind: 'unauthenticated' })
    expect(createConnectionPort(ctxWith({ requestRejection: () => 403 })).verdictFor(request({})))
      .toEqual({ kind: 'untrusted' })
    expect(createConnectionPort(ctxWith({ requestRejection: () => 418 })).verdictFor(request({})))
      .toEqual({ kind: 'untrusted' })
    expect(createConnectionPort(ctxWith({ requestRejection: () => undefined })).verdictFor(request({})))
      .toEqual({ kind: 'allowed' })
  })

  it('成员抛错按归属不对拒绝', () => {
    const port = createConnectionPort(ctxWith({ requestRejection: () => { throw new Error('boom') } }))
    expect(port.verdictFor(request({}))).toEqual({ kind: 'untrusted' })
  })

  it('服务晚到也认：第一次 absent，注册后同一条端口即放行', () => {
    let service: unknown
    const ctx = { get: () => service } as unknown as Context
    const port = createConnectionPort(ctx)
    expect(port.verdictFor(request({}))).toEqual({ kind: 'absent' })
    service = { requestRejection: () => undefined }
    expect(port.verdictFor(request({}))).toEqual({ kind: 'allowed' })
  })
})
