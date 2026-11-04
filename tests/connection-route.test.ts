// 现代宿主 exact Fetch 路由（ADR-0033）：九段注册、Request/Response 适配、body 闸与 4xx/信封语义。
//
// 鉴权不在这层测：`connection.fetch.register` 的路由由宿主 `/api` bridge 在 handler 之前做
// Host/Origin/浏览器认证；这里只钉插件自己的分发与响应形状。
import { describe, expect, it, vi } from 'vitest'
import {
  JSON_BODY_MAX_BYTES,
  registerConnectionRoutes,
  type ConnectionFetchRouteLike,
  type ConnectionFetchServiceLike,
} from '../src/api/connection-route.js'
import { createDispatcher } from '../src/api/dispatch.js'
import { OFFICIAL_SESSION_DELETE_API_PREFIX, PARAMS } from '../src/shared/wire.js'
import { createFakeDeps } from './support/fake-deps.js'

interface Harness {
  readonly service: ConnectionFetchServiceLike
  readonly routes: Map<string, ConnectionFetchRouteLike>
}

function makeService(): Harness {
  const routes = new Map<string, ConnectionFetchRouteLike>()
  const service: ConnectionFetchServiceLike = {
    fetch: {
      register: (route) => {
        routes.set(route.path, route)
        return async () => {
          routes.delete(route.path)
        }
      },
    },
  }
  return { service, routes }
}

function routeAt(harness: Harness, segment: string): ConnectionFetchRouteLike {
  const route = harness.routes.get(`${OFFICIAL_SESSION_DELETE_API_PREFIX}${segment}`)
  if (route === undefined) throw new Error(`没有注册段 ${segment}`)
  return route
}

function urlOf(segment: string): string {
  return `http://dsh.internal${OFFICIAL_SESSION_DELETE_API_PREFIX}${segment}`
}

describe('connection exact Fetch 路由 · 注册', () => {
  it('九段都注册在 /api 下，方法与路由表一致，body 一律 buffered', async () => {
    const { deps } = createFakeDeps()
    const harness = makeService()
    const dispose = registerConnectionRoutes(harness.service, createDispatcher(deps))
    expect(harness.routes.size).toBe(9)
    const expected: Array<[string, 'GET' | 'POST']> = [
      ['/list', 'GET'],
      ['/ping', 'GET'],
      ['/detail', 'POST'],
      ['/apply', 'POST'],
      ['/empty', 'POST'],
      ['/orphans', 'GET'],
      ['/attachment', 'GET'],
      ['/attachment-orphans', 'GET'],
      ['/attachment-clean', 'POST'],
    ]
    for (const [segment, method] of expected) {
      const route = routeAt(harness, segment)
      expect(route.methods).toEqual([method])
      expect(route.requestBody).toBe('buffered')
      expect(route.path.startsWith('/api/')).toBe(true)
    }
    await dispose()
    expect(harness.routes.size).toBe(0)
  })

  it('没有 fetch.register 的 connection 形状 ⇒ 响亮抛错，不静默注册零条路由', () => {
    const { deps } = createFakeDeps()
    expect(() => registerConnectionRoutes({}, createDispatcher(deps))).toThrow(/connection\.fetch\.register/)
  })

  it('中途注册失败 ⇒ 已注册的段先摘掉，错误照抛（不留半套）', async () => {
    const { deps } = createFakeDeps()
    const removed: string[] = []
    let calls = 0
    const service: ConnectionFetchServiceLike = {
      fetch: {
        register: (route) => {
          calls += 1
          if (calls === 3) throw new Error('duplicate route')
          return async () => { removed.push(route.path) }
        },
      },
    }
    expect(() => registerConnectionRoutes(service, createDispatcher(deps))).toThrow('duplicate route')
    await Promise.resolve()
    expect(removed).toHaveLength(2)
  })

  it('卸载时某个 disposer 拒绝 ⇒ 其余照摘，不把拒绝抛给宿主', async () => {
    const { deps } = createFakeDeps()
    const removed: string[] = []
    let calls = 0
    const service: ConnectionFetchServiceLike = {
      fetch: {
        register: (route) => {
          calls += 1
          if (calls === 2) return async () => { throw new Error('already disposed') }
          return async () => { removed.push(route.path) }
        },
      },
    }
    const dispose = registerConnectionRoutes(service, createDispatcher(deps))
    await expect(dispose()).resolves.toBeUndefined()
    expect(removed).toHaveLength(8)
  })

  it('用调用方给的分发器：适配器不自己另建一条到达序链（ADR-0033 决定 5）', async () => {
    const harness = makeService()
    const dispatch = vi.fn(async () => ({ kind: 'json' as const, status: 200, body: { ok: true, value: 'shared' } }))
    const dispose = registerConnectionRoutes(harness.service, dispatch)
    const res = await routeAt(harness, '/ping').fetch(new Request(urlOf('/ping')))
    expect(await res.json()).toEqual({ ok: true, value: 'shared' })
    expect(dispatch).toHaveBeenCalledTimes(1)
    await dispose()
  })
})

describe('connection exact Fetch 路由 · 响应', () => {
  it('GET /ping 回同一个信封', async () => {
    const { deps } = createFakeDeps()
    const harness = makeService()
    const dispose = registerConnectionRoutes(harness.service, createDispatcher(deps))
    const response = await routeAt(harness, '/ping').fetch(new Request(urlOf('/ping')))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, value: 'pong' })
    await dispose()
  })

  it('GET /list 走同一份分发器：空清册回 {ok:true,value:[]}', async () => {
    const { deps } = createFakeDeps()
    const harness = makeService()
    const dispose = registerConnectionRoutes(harness.service, createDispatcher(deps))
    const response = await routeAt(harness, '/list').fetch(new Request(urlOf('/list')))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, value: [] })
    // 回收站清单是当下读数：与附件段同一道 no-store 闸，代理/浏览器的启发式缓存不许留住它。
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    await dispose()
  })

  it('POST /apply 的空 id 组是请求体 400，不是 200 的操作失败', async () => {
    const { deps } = createFakeDeps()
    const harness = makeService()
    const dispose = registerConnectionRoutes(harness.service, createDispatcher(deps))
    const response = await routeAt(harness, '/apply').fetch(new Request(urlOf('/apply'), {
      method: 'POST',
      body: JSON.stringify({ action: 'delete', ids: [] }),
      headers: { 'content-type': 'application/json' },
    }))
    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const body = await response.json() as { ok: boolean; error: { message: string } }
    expect(body.ok).toBe(false)
    expect(body.error.message).toContain('ids')
    await dispose()
  })

  it('body 超过 1MiB 是 400，不是把整段读进内存', async () => {
    const { deps } = createFakeDeps()
    const harness = makeService()
    const dispose = registerConnectionRoutes(harness.service, createDispatcher(deps))
    const response = await routeAt(harness, '/apply').fetch(new Request(urlOf('/apply'), {
      method: 'POST',
      body: 'x'.repeat(JSON_BODY_MAX_BYTES + 1),
    }))
    expect(response.status).toBe(400)
    const body = await response.json() as { ok: boolean; error: { message: string } }
    expect(body.ok).toBe(false)
    expect(body.error.message).toContain('超过')
    await dispose()
  })

  it('GET /attachment 走二进制支：字节与四道安全头原样到 Response', async () => {
    const bytes = Buffer.from('attachment-bytes')
    const made = createFakeDeps()
    made.fs.statFile.mockResolvedValue({ size: bytes.length })
    made.fs.readFile.mockResolvedValue(bytes)
    const harness = makeService()
    const dispose = registerConnectionRoutes(harness.service, createDispatcher(made.deps))
    const id = `sha256:${'a'.repeat(64)}`
    const query = new URLSearchParams({
      [PARAMS.attachmentId]: id,
      [PARAMS.attachmentKind]: 'file',
      [PARAMS.attachmentName]: 'hello.txt',
    })
    const response = await routeAt(harness, '/attachment').fetch(
      new Request(`${urlOf('/attachment')}?${query.toString()}`),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename\*=UTF-8''/)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    await dispose()
  })

  // 宿主正常路径会在 handler 之前按 `route?.methods.has(method)` 回 404；这里直调适配器，
  // 钉的是「即使被直接交给 handler，方法闸也不会静默放行」的防御分支。
  it('适配器直调：方法不对是 405（宿主正常路径会先回 404）', async () => {
    const { deps } = createFakeDeps()
    const harness = makeService()
    const dispose = registerConnectionRoutes(harness.service, createDispatcher(deps))
    const response = await routeAt(harness, '/list').fetch(new Request(urlOf('/list'), { method: 'POST', body: '{}' }))
    expect(response.status).toBe(405)
    const body = await response.json() as { ok: boolean; error: { message: string } }
    expect(body.ok).toBe(false)
    expect(body.error.message).toContain('方法不允许')
    await dispose()
  })
})

// 同源取数闸（ADR-0033 边界收口）：`/attachment` 的字节能被任意页面当 `<img>` 渲染；
// 宿主 `/api` 只拦 `cross-site` 与 authority 不符的 `Origin`，同 IP 不同端口仍带 cookie。
// 判据住适配器（`isSameOriginFetch`），声明住路由记录的 `fetchGate`。
describe('connection exact Fetch 路由 · 附件的同源取数闸', () => {
  const id = `sha256:${'a'.repeat(64)}`
  const bytes = Buffer.from('attachment-bytes')

  function serveAttach(): {
    route: ConnectionFetchRouteLike
    fs: ReturnType<typeof createFakeDeps>['fs']
    dispose: () => Promise<void>
  } {
    const made = createFakeDeps()
    made.fs.statFile.mockResolvedValue({ size: bytes.length })
    made.fs.readFile.mockResolvedValue(bytes)
    const harness = makeService()
    const dispose = registerConnectionRoutes(harness.service, createDispatcher(made.deps))
    return { route: routeAt(harness, '/attachment'), fs: made.fs, dispose }
  }

  function attachmentUrl(): string {
    const query = new URLSearchParams({
      [PARAMS.attachmentId]: id,
      [PARAMS.attachmentKind]: 'file',
      [PARAMS.attachmentName]: 'a.bin',
    })
    return `${urlOf('/attachment')}?${query.toString()}`
  }

  const callWith = (headers: Record<string, string>): Promise<Response> => {
    const { route } = serveAttach()
    return route.fetch(new Request(attachmentUrl(), { headers }))
  }

  it('同源页面放行：same-origin + 与 Host 同 authority 的 Origin/Referer', async () => {
    const response = await callWith({
      host: 'dsh.internal',
      'sec-fetch-site': 'same-origin',
      origin: 'http://dsh.internal',
      referer: 'http://dsh.internal/index.html',
    })
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
  })

  it('same-origin 标签直接放行，不押在 Host 是否被中间层保留上（页面 JS 伪造不了该头）', async () => {
    const response = await callWith({ 'sec-fetch-site': 'same-origin' })
    expect(response.status).toBe(200)
  })

  it('默认端口与大小写按 WHATWG 归一后仍是同 authority', async () => {
    const response = await callWith({
      host: 'dsh.internal',
      origin: 'http://DSH.internal:80',
    })
    expect(response.status).toBe(200)
  })

  it('同站不同端口（Sec-Fetch-Site: same-site）⇒ 403 + 失败信封，且不读盘', async () => {
    const { route, fs, dispose } = serveAttach()
    const response = await route.fetch(new Request(attachmentUrl(), {
      headers: { host: 'dsh.internal:37777', 'sec-fetch-site': 'same-site' },
    }))
    expect(response.status).toBe(403)
    const body = await response.json() as { ok: boolean; error: { message: string } }
    expect(body.ok).toBe(false)
    expect(body.error.message).toContain('同源')
    expect(fs.statFile).not.toHaveBeenCalled()
    expect(fs.readFile).not.toHaveBeenCalled()
    await dispose()
  })

  it('cross-site 同样被插件侧拒（宿主正常路径会先拒；适配器直调时也不静默放行）', async () => {
    const response = await callWith({ 'sec-fetch-site': 'cross-site' })
    expect(response.status).toBe(403)
  })

  it('没有 Fetch Metadata 的代次：http(s) Origin/Referer 与 Host 不同 authority ⇒ 403', async () => {
    expect((await callWith({ host: 'dsh.internal', origin: 'http://192.168.1.5:9999' })).status).toBe(403)
    expect((await callWith({ host: 'dsh.internal', referer: 'http://192.168.1.5:9999/page' })).status).toBe(403)
  })

  it('Origin: null（沙箱 iframe / file:）是不透明来源 ⇒ 403', async () => {
    expect((await callWith({ origin: 'null' })).status).toBe(403)
  })

  it('桌面壳的 dsh-app:// 来源放行（转发器已摘掉 host/origin/sec-fetch-site）', async () => {
    const response = await callWith({ referer: 'dsh-app://app/' })
    expect(response.status).toBe(200)
  })

  it('dsh-app: 之外的其它非 http(s) 来源不冒充本部署（白名单不是“任意非 HTTP”）', async () => {
    expect((await callWith({ referer: 'chrome-extension://abc/page' })).status).toBe(403)
    expect((await callWith({ referer: 'file:///etc/passwd' })).status).toBe(403)
  })

  it('闸只挂二进制附件段：/list 不带它（JSON 跨源读不到，不需要同源约束）', async () => {
    const { deps } = createFakeDeps()
    const harness = makeService()
    const dispose = registerConnectionRoutes(harness.service, createDispatcher(deps))
    const response = await routeAt(harness, '/list').fetch(new Request(urlOf('/list'), {
      headers: { 'sec-fetch-site': 'same-site' },
    }))
    expect(response.status).toBe(200)
    await dispose()
  })
})
