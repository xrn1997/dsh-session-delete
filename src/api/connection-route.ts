/** 现代宿主的 exact Fetch 路由适配器：段名注册到 `connection.fetch.register`，Host/Origin/认证由宿主 `/api` bridge 做（ADR-0033）。
 *  路径必须带 `/api` 前缀（宿主 `assertFetchRoute` 校验）；`request.url` 已被 bridge 重写，只取 pathname / searchParams。
 *  本适配器不重复宿主鉴权；声明了 `fetchGate` 的段（`/attachment`）再判一次同源取数。4xx 与 200 信封在这里落地。 */
import { toRemoteFailure } from '../remote/map-error.js'
import { OFFICIAL_SESSION_DELETE_API_PREFIX } from '../shared/wire.js'
import { routeError } from '../errors.js'
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

/** `filename*` 的 RFC 5987 ext-value：`encodeURIComponent` 保留 `'()*`，这四枚不是 attr-char，必须补转。 */
function encodeFilenameStar(filename: string): string {
  return encodeURIComponent(filename).replace(
    /['()*]/gu,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** 二进制响应的四道头：类型与长度同源、禁止缓存、禁改猜、下载名走 `filename*`。 */
function binaryHeaders(body: BinaryResponse): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': body.contentType,
    'content-length': String(body.body.length),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  }
  if (body.filename !== undefined) {
    headers['content-disposition'] = `${body.disposition}; filename*=UTF-8''${encodeFilenameStar(body.filename)}`
  } else if (body.disposition === 'attachment') {
    headers['content-disposition'] = 'attachment'
  }
  return headers
}

/** 失败的落地：码与原文来自 `toRemoteFailure`。请求本身不对回 4xx；操作失败回 200 + 信封。
 *  宿主 401/403 是纯文本响应，由客户端映射，不在插件这一层。 */
function failureResult(error: unknown, status?: number): ApiResult {
  const carried = (error as { httpStatus?: unknown } | null | undefined)?.httpStatus
  return {
    kind: 'json',
    status: status ?? (typeof carried === 'number' ? carried : 200),
    body: { ok: false, error: toRemoteFailure(error) },
  }
}

/**
 * 同源取数闸（ADR-0033 边界收口）：附件字节能被任意页面当 `<img>` 渲染，而宿主 cookie 的 `SameSite=Strict`
 * 按 **site** 判——同 IP 不同端口仍会带上；宿主 `/api` 只拦 cross-site 与 authority 不符的 `Origin`，
 * 这一格补在插件侧：`Sec-Fetch-Site` 为 same-site / cross-site ⇒ 拒；
 * http(s) 的 `Origin` / `Referer` 与 `Host` 不同 authority ⇒ 拒（覆盖不发送 Fetch Metadata 的代次）；
 * 桌面壳的 `dsh-app:` 来源与三头全缺的非浏览器客户端放行。
 * `Host` 依赖宿主 bridge 保留原始请求头（它只改写 `request.url`）。
 */
function isSameOriginFetch(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  // Fetch Metadata 是浏览器写的可信标签：same-origin 直接放行，不押在 Host 是否被中间层保留上。
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

/** 边读边数：宿主按 `buffered` 已预读整段，这里仍守插件侧 1 MiB 逻辑闸，超限即停。 */
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
    // Buffer 不是 `BodyInit`，显式拷进 `Uint8Array`；附件已被 20 MiB 上限约束。
    return new Response(new Uint8Array(result.body.body), {
      status: 200,
      headers: binaryHeaders(result.body),
    })
  }
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    // 与附件段同一道缓存闸：清单/详情是当下读数，不能被中间层留下。
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
    },
  })
}

/** 注册全部段名 exact Fetch 路由，返回组合 disposer；`connection` 是硬依赖，`fetch.register` 缺席直接抛。
 *  静默返回空 disposer 会让插件「在但没有入口」。 */
export function registerConnectionRoutes(
  service: ConnectionFetchServiceLike,
  dispatch: Dispatch,
): () => Promise<void> {
  const fetchService = service.fetch
  if (fetchService === undefined || typeof fetchService.register !== 'function') {
    throw new Error('session-delete: connection.fetch.register 不可用')
  }
  const disposers: Array<() => Promise<void>> = []
  // 逆序摘除（后挂的先摘）；卸载路径不留拒绝：失败没有补救动作，冒出去只会变成卸载错误。
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
            // 请求本身不被接受 ⇒ 403 + 失败信封；不与「操作失败 200 + 信封」混用。
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
