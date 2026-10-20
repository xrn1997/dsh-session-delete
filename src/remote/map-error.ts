import {
  isDSHRemoteError,
  SESSION_DELETE_ERROR_DOMAIN,
  VERB_CODES,
  type RemoteFailure,
  type VerbCode,
} from '../shared/wire.js'

/** 插件专属远程域名（src/shared/wire.ts）：与宿主官方域（`workspace/*`、`session/*`、`gateway/*`…）不重名。
 *  字面量的家在 `shared/wire.ts`（ADR-0003）——浏览器半也按同一个域认码。 */
const DOMAIN = SESSION_DELETE_ERROR_DOMAIN

/** 五个码的家同样在 `shared/wire.ts`（`io` 是唯一兜底）——这里只是取来用，不再抄第二份。 */
type Code = VerbCode

/** 宿主两条类型化错误 → 我们的码（本文件的两行映射）。
 *  类不可 import（跨插件值 import 是红线；且宿主包与运行中的宿主不同代）⇒ 按官方构造器写死的 `this.name` 认。
 *  证据：asar `dsh/node_modules/@deepseek-ai/dsh-workspace/lib/index.js` 原文
 *  `var WorkspaceUnknownSessionError = class extends Error { …; this.name = "WorkspaceUnknownSessionError"; }`
 *  `var WorkspaceActiveSessionError  = class extends Error { …; this.name = "WorkspaceActiveSessionError"; }`。 */
const HOST_ERROR_CODE: Record<string, Code> = {
  WorkspaceUnknownSessionError: 'not-found',
  WorkspaceActiveSessionError: 'live',
}

/** cause 链上第一个**宿主类型化错误**本身（不只它的名字）——它自己身上的字段还要当 `details` 用。
 *  深度有界（链坏掉不递归下去）；查表必须 `hasOwn`：`in` 会命中 `Object.prototype` 的键。 */
function hostErrorOf(error: unknown): (Error & { name: string }) | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 8; depth++) {
    if (current === null || typeof current !== 'object') return undefined
    const name = (current as { name?: unknown }).name
    // 必须 `hasOwn`：`'constructor' in {...}` 是 true（原型链），抛出的东西只要 `name` 叫 `constructor`
    // 或 `toString` 就会拿回一个**函数**当码（`sessiondelete/function Object(){…}`）。
    if (typeof name === 'string' && Object.hasOwn(HOST_ERROR_CODE, name)) return current as Error & { name: string }
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** 上屏原文：`Error` 取 `.message`；**带 `message` 字符串的非 Error 抛出物也照取**（否则会退化成
 *  `[object Object]`，把 src/shared/wire.ts「`message` 是上屏的原文」这条许诺落空）；其余一律 `String()`。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

/** 官方 `<域>/<名>` 形状的 code。动词码也是这个形状，所以调用方另要**排除本域**才作数。 */
const OFFICIAL_CODE = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/

/** 抛出物**自己身上**挂的结构化字段（rc.2：`WorkspaceActiveSessionError` 带 `sessionId` / `activity`，
 *  `WorkspaceUnknownSessionError` 带 `sessionId`；控制器把它们折进 `RemoteError.details` 才上客户端）。
 *  `activity` 过一遍 JSON 往返再交回：既保住它的结构（官方 schema 是 `Record<string, unknown>`），
 *  也保证信封那一侧 `JSON.stringify` 不会撞上循环引用。
 *  一件都没有 ⇒ `undefined`（不硬造一个空表冒充"带过 details"）。 */
function ownDetailsOf(error: unknown): Record<string, unknown> | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const out: Record<string, unknown> = {}
  const source = error as Record<string, unknown>
  for (const key of ['sessionId', 'workspaceId', 'path']) {
    if (typeof source[key] === 'string') out[key] = source[key] as string
  }
  if (source.activity !== undefined) {
    try { out.activity = JSON.parse(JSON.stringify(source.activity)) } catch { /* 循环引用的 activity 不归我修 */ }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 一个可以过线的 details 对象（数组与 null 不算；官方是 `z.record`）。 */
function isDetailsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `details` 的来历，就近优先：自己挂着的 `details`（官方 `RemoteError` 那件）→ 自己身上的字段 → 无。 */
function detailsOf(error: unknown): Record<string, unknown> | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const carried = (error as { details?: unknown }).details
  if (isDetailsRecord(carried)) return carried
  return ownDetailsOf(error)
}

/**
 * 把任意抛出物折成失败信封里的**那三件**（本文件唯一那张映射表）。
 *
 * - 已经是远程失败（`isDSHRemoteError` 认得的结构标记）⇒ 原样带出它自己的 `code` / `message`，
 *   挂着的 `details` 一起过桥，不再包一层。
 * - **带官方形状 code 的抛出物**（`workspace/session-active`、`session/not-found`…）⇒ **原样过桥**。
 *   把它们折成 `sessiondelete/io` 就是把宿主的判断抹成我们的，客户端拿到的 code 从此不能说真话。
 * - 宿主类型化错误（自身或 `cause` 链上，见 {@link hostErrorOf}）⇒ 映射成 `live` / `not-found`，
 *   并把它自己身上的结构化字段带成 `details`。这一条排在动词码之前：动词会把宿主错误包成笼统的 `io`
 *   并把原错误挂在 cause 上（`verbError('io', …, cause)`），不看进 cause 链，本文件那两行映射永远到不了客户端。
 * - 动词的 `sessiondelete/<五个码>` ⇒ 原样过桥（`details` 同样带着）。
 * - 其余（别域的怪 code、前缀外的因、非 Error 抛出物）⇒ `io`，message 保留原文。
 *
 * **返回的是线上形状、不是 `Error`**：这份东西唯一的去处是 `src/api/dispatch.ts` 的失败信封
 * （以及 `verbs/batch.ts` 的逐条 `error`），而本仓的跨插件 import 红线也不许为此去引宿主的
 * `RemoteError` 类（实例也上不了线：信封只走这三件）。
 */
export function toRemoteFailure(error: unknown): RemoteFailure {
  if (isDSHRemoteError(error)) {
    const carried = (error as { details?: unknown }).details
    return {
      code: error.code,
      message: String(error.message),
      ...(isDetailsRecord(carried) ? { details: carried } : {}),
    }
  }

  const raw = (error as { code?: unknown } | undefined)?.code
  if (typeof raw === 'string' && OFFICIAL_CODE.test(raw) && !raw.startsWith(`${DOMAIN}/`)) {
    const details = detailsOf(error)
    return { code: raw, message: messageOf(error), ...(details === undefined ? {} : { details }) }
  }
  const reason = typeof raw === 'string' && raw.startsWith(`${DOMAIN}/`)
    ? raw.slice(DOMAIN.length + 1)
    : undefined
  const fromVerb = reason !== undefined && (VERB_CODES as readonly string[]).includes(reason)
    ? (reason as Code)
    : undefined

  const host = hostErrorOf(error)
  // 「就近优先」：动词在抛出处挂的 details 比 cause 上的宿主字段更近，前者有就用前者。
  const own = detailsOf(error) ?? (host === undefined ? undefined : detailsOf(host))
  if (host === undefined && fromVerb === undefined && typeof raw === 'string' && raw.includes('/')) {
    // 形状像 code 但不是官方域、也不是我们的动词码（`sessiondelete/nope` 那类）⇒ 兜 io，但原文照带
    return { code: `${DOMAIN}/io`, message: messageOf(error) }
  }
  const code = host !== undefined ? HOST_ERROR_CODE[host.name] : fromVerb ?? 'io'
  return { code: `${DOMAIN}/${code}`, message: messageOf(error), ...(own === undefined ? {} : { details: own }) }
}
