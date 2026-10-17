/** 五个码（设计稿 §6 的表）。**唯一定义处**：`remote/map-error.ts` 从这份数组反推它的 `Code`，
 *  免得"加了一个码只在一边加"让两张表各自漂移（漂移的后果是那个码静默降级成 `io`）。 */
export const VERB_CODES = ['live', 'not-found', 'trash-empty', 'project-missing', 'io'] as const

export type VerbCode = (typeof VERB_CODES)[number]

/** 路由层的自检（不是五个动词码之一）：**请求本身不对**——方法、路径、body 形状。
 *  它上的是 HTTP 状态那条口（404/405），信封里也带着它，好让只看信封的调用方拿到同一句原文。 */
export const ROUTE_CODES = ['bad-method', 'not-found-route', 'bad-request'] as const

export type RouteCode = (typeof ROUTE_CODES)[number]

/** 一次失败的**结构**：码、上屏原文、可选 cause（`map-error` 沿 cause 链认宿主类型化错误）、
 *  可选的结构化附带物（对齐官方 `rpcErrorSchema` 的第三件 `details`）。 */
export interface VerbError extends Error {
  code: string
  details?: Record<string, unknown>
  cause?: unknown
}

export function verbError(code: VerbCode, message: string, cause?: unknown, details?: Record<string, unknown>): VerbError {
  const e = new Error(message) as VerbError
  e.code = `sessiondelete/${code}`
  if (cause !== undefined) e.cause = cause
  if (details !== undefined) e.details = details
  return e
}

/** 路由自检用的失败：带 HTTP 状态语义，**不**冒充五个动词码。 */
export function routeError(code: RouteCode, httpStatus: number, message: string): VerbError & { httpStatus: number } {
  const e = verbError('io', message) as VerbError & { httpStatus: number }
  e.code = `sessiondelete/${code}`
  e.httpStatus = httpStatus
  return e
}
