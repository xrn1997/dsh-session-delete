/** 失败的**结构与措辞**。码本身、码的前缀读法与动词词表都住在 `shared/wire.ts`（ADR-0003）：
 *  浏览器半也要认它们，它们属于两半共同的契约，不属于 Node 半。这里只做动词抛错与回滚措辞。 */
import {
  SESSION_DELETE_CODES,
  verbCodeOf,
  type RouteCode,
  type VerbCode,
} from '../shared/wire.js'

/** 一次失败的**结构**：码、上屏原文、可选 cause（`map-error` 沿 cause 链认宿主类型化错误）、
 *  可选的结构化附带物（对齐官方 `rpcErrorSchema` 的第三件 `details`）。 */
export interface VerbError extends Error {
  code: string
  details?: Record<string, unknown>
  cause?: unknown
}

export function verbError(code: VerbCode, message: string, cause?: unknown, details?: Record<string, unknown>): VerbError {
  const e = new Error(message) as VerbError
  e.code = SESSION_DELETE_CODES[code]
  if (cause !== undefined) e.cause = cause
  if (details !== undefined) e.details = details
  return e
}

/** 路由自检用的失败：带 HTTP 状态语义，**不**冒充五个动词码。 */
export function routeError(code: RouteCode, httpStatus: number, message: string): VerbError & { httpStatus: number } {
  const e = verbError('io', message) as VerbError & { httpStatus: number }
  e.code = SESSION_DELETE_CODES[code]
  e.httpStatus = httpStatus
  return e
}

/** 一条回滚步骤失败的**标签句**：label 说的是"这一步在退什么"，原文带出**那一步抛的东西**
 *  （`Error` 取 message，其余一律 `String()`；对象带 `message` 的差异归 `map-error.messageOf` 管）。
 *  调用方不许另抄这份格式——那样 details 里的句子会随各处 catch 变形，界面上就变成"同一个失败三个说法"。 */
export function rollbackReason(label: string, error: unknown): string {
  return `${label}：${error instanceof Error ? error.message : String(error)}`
}

/** 内层错误已经挂着的回滚失败（成员自己的就地回滚失败时会有）。组级 catch 再包一次时不能丢。 */
function carriedRollbackFailures(error: unknown): string[] {
  const raw = (error as { details?: { rollbackFailures?: unknown } } | undefined)?.details?.rollbackFailures
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
}

/** 原错误保留，回滚失败作为 `details.rollbackFailures` 上线；码仍按原错误的动词码，
 *  没有可继承的就落 io。**内层的回滚失败要并进来**：一个成员自己退失败、兄弟也退失败时，
 *  两份失败都得在 details 里，消息也不能出现第二个「回滚未完成」。 */
export function withRollbackFailures(error: unknown, failures: readonly string[]): VerbError {
  const code = verbCodeOf(error) ?? 'io'
  const carried = carriedRollbackFailures(error)
  const merged = [...new Set([...carried, ...failures])]
  const base = error instanceof Error ? error.message : String(error)
  // 内层消息已经带过标签时不再重复标签，但外层新出现的失败仍要进原文（不能只进 details）。
  const extra = failures.filter((failure) => !carried.includes(failure))
  const message = base.includes('；回滚未完成：')
    ? (extra.length > 0 ? `${base}；${extra.join('；')}` : base)
    : `${base}；回滚未完成：${merged.join('；')}`
  return verbError(
    code,
    message,
    error,
    { rollbackFailures: merged },
  )
}
