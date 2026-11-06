/**
 * 现代宿主的 exact Fetch 路由适配器：把十段注册到 `connection.fetch.register`，
 * 由宿主 `/api` bridge 做 Host/Origin/浏览器认证（ADR-0033）。
 *
 * 为什么路径必须带 `/api`：宿主 `assertFetchRoute` 用 `endpointFromPath('/api', path)` 校验，
 * 不带 `/api/` 前缀会在注册时直接抛错。`request.url` 会被 bridge 重写成 `http://dsh.internal/...`，
 * 这里只取 `pathname` / `searchParams`，不依赖外部 origin。
 *
 * 这条路由**不重复宿主的鉴权**：Host/Origin/浏览器认证在 handler 之前已经由宿主完成；只有路由记录
 * 声明了 `fetchGate` 的段（`/attachment`）再判一次同源取数（`isSameOriginFetch`）——那是字节 oracle
 * 的收口，不是身份。插件的 4xx（请求体 / 方法）与 200 操作失败信封在这里落地——`createDispatcher`
 * 只抛带 `httpStatus` 的请求错误。401/403 是宿主的纯文本响应，客户端负责映射。适配器拥有 wire 机制：
 * body 字节闸、JSON 解析、二进制头与失败信封。
 */
import { toRemoteFailure } from '../remote/map-error.js'
import { OFFICIAL_SESSION_DELETE_API_PREFIX } from '../shared/wire.js'
import { routeError } from '../verbs/errors.js'
import { ROUTE_TABLE, type BinaryResponse, type JsonBody } from './route-table.js'
import type { ApiResult, Dispatch } from './dispatch.js'

/** 请求体字节上限：这条通道只收几个 id，1MiB 是"够用且不给自己开一条内存放大器"的量级。 */
export const JSON_BODY_MAX_BYTES = 1024 * 1024

/** 请求体文本 → JSON 对象；空体 `null`；非对象 / 非法 JSON 抛 400。 */
function parseJsonBody(text: string): JsonBody {
  const trimmed = text.trim()
  if (trimmed === '') return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw routeError('bad-request', 400, '请求体需为 JSON 对象')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw routeError('bad-request', 400, `请求体不是合法 JSON：${error.message}`)
    }
    throw error
  }
}

/**
 * 二进制响应的四道头（`/attachment` 专用）。判据不是口味：类型由处理函数给、长度与字节同源、
 * 不许任何中间层留下已删除会话的附件、字节与声明类型不一致时浏览器不许改猜。
 */
function binaryHeaders(body: BinaryResponse): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': body.contentType,
    'content-length': String(body.body.length),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  }
  if (body.filename !== undefined) {
    headers['content-disposition'] = `${body.disposition}; filename*=UTF-8''${encodeURIComponent(body.filename)}`
  } else if (body.disposition === 'attachment') {
    headers['content-disposition'] = 'attachment'
  }
  return headers
}

/**
 * 失败的落地：码与原文都来自 `toRemoteFailure`（本插件唯一的错误映射表）。
 * 状态语义：**请求本身不对**不伪装成 200——请求体 400、方法 405、未知路由 404；
 * **操作失败**回 200 + 信封。`code` 一律折成 `sessiondelete/io`，路由站点名不冒充动词码。
 */
function failureResult(error: unknown, status?: number): ApiResult {
  const carried = (error as { httpStatus?: unknown } | null | undefined)?.httpStatus
  return {
    kind: 'json',
    status: status ?? (typeof carried === 'number' ? carried : 200),
    body: { ok: false, error: toRemoteFailure(error) },
  }
}

/**
 * 同源取数闸（ADR-0033 边界收口）：附件字节能被任意页面当 `<img>` 渲染，而宿主 cookie 的
 * `SameSite=Strict` 按 **site** 判——同 IP 不同端口仍会带上。宿主 `/api` 只拦 `cross-site` 与
 * authority 不符的 `Origin`，这一格补在插件这一侧：
 * - `Sec-Fetch-Site` 为 `same-site` / `cross-site` ⇒ 拒；
 * - http(s) 的 `Origin` / `Referer` 与 `Host` 不同 authority ⇒ 拒（覆盖不发送 Fetch Metadata 的代次）；
 * - 桌面壳的 `dsh-app:` 来源与三头全缺的非浏览器客户端放行——桌面转发器已摘掉
 *   `host` / `origin` / `sec-fetch-site`，「摘干净」不是不可信。
 *
 * `Host` 依赖的是宿主 bridge 保留原始请求头（它只改写 `request.url`）；真机与
 * `tests/api.test.ts` 的 `node:http` 桥都钉住这一条：同源 `Referer` 能对上 `Host`。
 */
function isSameOriginFetch(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  // 浏览器自己写的 Fetch Metadata 是可信标签（页面 JS 不能伪造）：same-origin 直接放行，
  // 不把这条常见路径押在 Host 是否被中间层保留上；same-site / cross-site 直接拒；
  // 不发送 Fetch Metadata 的代次再按下面的 Origin / Referer authority 判。
  if (site === 'same-origin') return true
  if (site === 'same-site' || site === 'cross-site') return false
  const host = request.headers.get('host')
  for (const name of ['origin', 'referer'] as const) {
    const value = request.headers.get(name)
    // `Headers.get` 缺席回 `null`（不是 `undefined`）：缺席是「没带这个头」，不是不透明来源。
    if (value === null) continue
    let source: URL
    try {
      source = new URL(value)
    } catch {
      // `Origin: null`（沙箱 iframe / file: 页面）是不透明来源，不放行。
      return false
    }
    // 桌面壳的自定义协议；其余非 http(s) 来源不冒充本部署 authority。
    if (source.protocol !== 'http:' && source.protocol !== 'https:' && source.protocol !== 'dsh-app:') return false
    if (source.protocol === 'dsh-app:') continue
    if (host === null || !isSameAuthority(source, host)) return false
  }
  return true
}

/** 按来源的协议解析 `Host`，两侧都过 WHATWG 归一（默认端口、大小写）后比 authority。 */
function isSameAuthority(source: URL, host: string): boolean {
  try {
    return new URL(`${source.protocol}//${host}`).host === source.host
  } catch {
    return false
  }
}

/** 宿主 `connection.fetch.register` 的入参形状（只声明本适配器用到的成员）。 */
export interface ConnectionFetchRouteLike {
  readonly path: string
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  readonly requestBody: 'buffered' | 'streaming'
  readonly fetch: (request: Request) => Promise<Response>
}

/** 宿主 `connection` 服务的窄镜像：只要求 exact Fetch 注册点。 */
export interface ConnectionFetchServiceLike {
  readonly fetch?: {
    register(route: ConnectionFetchRouteLike): () => Promise<void>
  }
}

/** 边读边数：宿主按 `requestBody: 'buffered'` 已预读整段，这里仍守插件侧的 1 MiB 逻辑闸；
 *  超限即停，不再把读到的分片拼成更大的字符串。 */
async function readRequestJson(request: Request): Promise<JsonBody> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > JSON_BODY_MAX_BYTES) {
    throw routeError('bad-request', 400, `请求体超过 ${JSON_BODY_MAX_BYTES} 字节上限`)
  }
  const stream = request.body
  if (stream === null) return null
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > JSON_BODY_MAX_BYTES) {
        await reader.cancel()
        throw routeError('bad-request', 400, `请求体超过 ${JSON_BODY_MAX_BYTES} 字节上限`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return parseJsonBody(Buffer.concat(chunks).toString('utf8'))
}

function toResponse(result: ApiResult): Response {
  if (result.kind === 'binary') {
    // Buffer 在类型上不是 `BodyInit`（`ArrayBufferLike` 泛型），显式拷进 `Uint8Array` 换一份
    // `ArrayBuffer`；附件已被 20 MiB 默认上限约束，这份拷贝是已知且有限的。
    return new Response(new Uint8Array(result.body.body), {
      status: 200,
      headers: binaryHeaders(result.body),
    })
  }
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    // 与附件段同一道缓存闸：回收站清单/详情是**当下读数**，代理或浏览器的启发式缓存会把
    // 「刚删的那条」留在屏上。九段 JSON 都不该被任何中间层留存。
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
    },
  })
}

/**
 * 注册十段 exact Fetch 路由。返回一个组合 disposer；调用方把它挂在自己的 effect 上。
 * `connection` 是插件的硬依赖（web UI / 桌面端都装 `client-connection`）；`fetch.register`
 * 缺席属于宿主形状漂移，直接抛——静默返回空 disposer 会让插件「在但没有入口」。
 * `dispatch` 与分发器同源。
 */
export function registerConnectionRoutes(
  service: ConnectionFetchServiceLike,
  dispatch: Dispatch,
): () => Promise<void> {
  const fetchService = service.fetch
  if (fetchService === undefined || typeof fetchService.register !== 'function') {
    throw new Error('session-delete: connection.fetch.register 不可用')
  }
  const disposers: Array<() => Promise<void>> = []
  // 逆序摘除（后挂的先摘）；取副本，不把共享数组就地反转给两条收尾路各用一次。
  // 卸载路径不留拒绝：宿主 shutdown / 重复摘除的失败没有补救动作，冒出去只会变成卸载错误。
  const disposeAll = async (): Promise<void> => {
    for (const dispose of [...disposers].reverse()) {
      try {
        await dispose()
      } catch {
        // 继续摘剩下的段；单条失败不改变"插件已经卸载"这件事。
      }
    }
  }
  try {
    for (const [routePath, spec] of Object.entries(ROUTE_TABLE)) {
      const path = `${OFFICIAL_SESSION_DELETE_API_PREFIX}${routePath}`
      disposers.push(fetchService.register({
        path,
        methods: [spec.method],
        requestBody: 'buffered',
        fetch: async (request) => {
          if (spec.fetchGate === 'same-origin' && !isSameOriginFetch(request)) {
            // 请求本身不被接受 ⇒ 403 + 失败信封（走插件自己的错误面；不是宿主那种纯文本 401/403，
            // 也不与「操作失败 200 + 信封」混用）。
            return toResponse(failureResult(routeError('bad-request', 403, '附件只允许同源页面读取')))
          }
          try {
            const body = spec.body === 'json' ? await readRequestJson(request) : null
            const result = await dispatch({
              method: request.method,
              rest: routePath,
              search: new URL(request.url).searchParams,
              body,
            })
            return toResponse(result)
          } catch (error) {
            return toResponse(failureResult(error))
          }
        },
      }))
    }
  } catch (error) {
    // 少挂几段也不能留半套：已经注册的先摘掉，再让调用方看到这次失败（重复注册是宿主的响亮错误）。
    for (const dispose of [...disposers].reverse()) void dispose().catch(() => undefined)
    throw error
  }
  return disposeAll
}
