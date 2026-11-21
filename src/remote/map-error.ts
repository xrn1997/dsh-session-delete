import {
  isDSHRemoteError,
  isSessionDeleteCodeError,
  SESSION_DELETE_CODES,
  verbCodeOf,
  type RemoteFailure,
  type VerbCode,
} from '../shared/wire.js'

/** 五个码的家同样在 `shared/wire.ts`（`io` 是唯一兜底）——这里只是取来用，不再抄第二份。 */
type Code = VerbCode

/** 宿主两条类型化错误 → 我们的码。类不可 import（跨插件值 import 是红线；且宿主包与运行中的宿主不同代）
 *  ⇒ 按官方构造器写死的 `this.name` 认。证据：asar `dsh/node_modules/@deepseek-ai/dsh-workspace/lib/index.js` 里
 *  `WorkspaceUnknownSessionError` / `WorkspaceActiveSessionError` 两个类各自的 `this.name = "<类名>"` 赋值。 */
const HOST_ERROR_CODE: Record<string, Code> = {
  WorkspaceUnknownSessionError: 'not-found',
  WorkspaceActiveSessionError: 'live',
}

/** cause 链上第一个宿主类型化错误本身（字段当 `details` 用）；深度有界，查表必须 `hasOwn`。 */
function hostErrorOf(error: unknown): { host: Error & { name: string }; code: Code } | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 8; depth++) {
    if (current === null || typeof current !== 'object') return undefined
    const name = (current as { name?: unknown }).name
    // 必须 `hasOwn`：`in` 会命中 `Object.prototype`，抛出的东西叫 `constructor` 就会拿回一个函数当码。
    if (typeof name === 'string' && Object.hasOwn(HOST_ERROR_CODE, name)) {
      const code = HOST_ERROR_CODE[name]
      if (code !== undefined) return { host: current as Error & { name: string }, code }
    }
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** 上屏原文：`Error` 与非 Error 的 `message` 字符串都照取，其余 `String()`。 */
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

/** 抛出物自己身上挂的结构化字段（`sessionId` / `workspaceId` / `path` / `activity`）；一件都没有就 `undefined`。
 *  `activity` 过一遍 JSON 往返，既保结构也避开循环引用。 */
function ownDetailsOf(error: unknown): Record<string, unknown> | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const out: Record<string, unknown> = {}
  const source = error as Record<string, unknown>
  for (const key of ['sessionId', 'workspaceId', 'path']) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- 不信任过线值：`typeof` 只把类型面收成 string，断言在这里是给"过线 JSON 的字段真值"留的显式痕迹（类型面与运行时形状分开记账）。
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

/** 把任意抛出物折成失败信封里的三件（本文件唯一那张映射表）。
 *  已经是远程失败 / 带官方形状 code / 我们的动词码 ⇒ 原样过桥，details 一起带；
 *  宿主类型化错误（自身或 cause 链上）⇒ 映射成 `live` / `not-found`；动词把它包成 `io` 时只挂在 cause 上。
 *  其余 ⇒ `io`，message 保留原文。返回线上形状，不是 `Error`。 */
export function toRemoteFailure(error: unknown): RemoteFailure {
  if (isDSHRemoteError(error)) {
    const carried = (error as { details?: unknown }).details
    return {
      code: error.code,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- 镜像是谎：过线 JSON 的 message 未必是 string；String() 是运行时归一。
      message: String(error.message),
      ...(isDetailsRecord(carried) ? { details: carried } : {}),
    }
  }

  const raw = (error as { code?: unknown } | undefined)?.code
  if (typeof raw === 'string' && OFFICIAL_CODE.test(raw) && !isSessionDeleteCodeError(error)) {
    const details = detailsOf(error)
    return { code: raw, message: messageOf(error), ...(details === undefined ? {} : { details }) }
  }
  const fromVerb = verbCodeOf(error)

  const host = hostErrorOf(error)
  // 「就近优先」：动词在抛出处挂的 details 比 cause 上的宿主字段更近，前者有就用前者。
  const own = detailsOf(error) ?? (host === undefined ? undefined : detailsOf(host.host))
  if (host === undefined && fromVerb === undefined && typeof raw === 'string' && raw.includes('/')) {
    // 形状像 code 但不是官方域、也不是我们的动词码（`sessiondelete/nope` 那类）⇒ 兜 io，但原文照带
    return { code: SESSION_DELETE_CODES.io, message: messageOf(error) }
  }
  const code = host !== undefined ? host.code : fromVerb ?? 'io'
  return { code: SESSION_DELETE_CODES[code], message: messageOf(error), ...(own === undefined ? {} : { details: own }) }
}
