/** 失败的**结构与措辞**：码与前缀读法住 `shared/wire.ts`（ADR-0003），这里只做动词抛错与回滚措辞。 */
import {
  SESSION_DELETE_CODES,
  verbCodeOf,
  type RouteCode,
  type VerbCode,
} from './shared/wire.js'

/** 一次失败的结构：码、上屏原文、可选 cause 与结构化附带物（对齐官方 `rpcErrorSchema` 第三件）。 */
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

/** `trash-empty` 的原文：有具体条目就点名那个 id，拿不到时只报通用那句。 */
export function trashEmpty(entryId?: string): VerbError {
  return verbError('trash-empty', entryId === undefined ? '回收站里没有这一条' : `回收站里没有这一条：${entryId}`)
}

/** 路由自检用的失败：带 HTTP 状态语义，**不**冒充五个动词码。 */
export function routeError(code: RouteCode, httpStatus: number, message: string): VerbError & { httpStatus: number } {
  const e = verbError('io', message) as VerbError & { httpStatus: number }
  e.code = SESSION_DELETE_CODES[code]
  e.httpStatus = httpStatus
  return e
}

/** 一条回滚步骤失败的标签句：label 说「这一步在退什么」，原文带出那一步抛的东西。
 *  调用方不许另抄格式，否则同一个失败会上屏三个说法。 */
export function rollbackReason(label: string, error: unknown): string {
  return `${label}：${error instanceof Error ? error.message : String(error)}`
}

/** 内层错误已经挂着的回滚失败（成员自己的就地回滚失败时会有）。组级 catch 再包一次时不能丢。 */
function carriedRollbackFailures(error: unknown): string[] {
  const raw = (error as { details?: { rollbackFailures?: unknown } } | undefined)?.details?.rollbackFailures
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
}

/** 原错误保留，回滚失败作为 `details.rollbackFailures` 上线；内层的回滚失败要并进来。
 *  **原错误 details 的其余键原样保留**：孤儿清理的部分回执挂在它上面，整份替换会把已删除报成 0。 */
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
  const priorDetails = (error as { details?: Record<string, unknown> } | null | undefined)?.details
  return verbError(
    code,
    message,
    error,
    { ...priorDetails, rollbackFailures: merged },
  )
}
