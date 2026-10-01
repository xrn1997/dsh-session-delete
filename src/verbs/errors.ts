/** 五个码（设计稿 §6 的表）。**唯一定义处**：`remote/map-error.ts` 从这份数组反推它的 `Code`，
 *  免得"加了一个码只在一边加"让两张表各自漂移（漂移的后果是那个码静默降级成 `io`）。 */
export const VERB_CODES = ['live', 'not-found', 'trash-empty', 'project-missing', 'io'] as const

export type VerbCode = (typeof VERB_CODES)[number]

export function verbError(code: VerbCode, message: string, cause?: unknown) {
  const e = new Error(message) as Error & { code: string; cause?: unknown }
  e.code = `sessiondelete/${code}`
  e.cause = cause
  return e
}
