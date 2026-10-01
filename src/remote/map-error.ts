import { isDSHRemoteError, type RemoteFailure } from '../shared/wire.js'
import { VERB_CODES, type VerbCode } from '../verbs/errors.js'

/** 插件专属远程域名（设计稿 §6）：与宿主官方域（`workspace/*`、`session/*`、`gateway/*`…）不重名。 */
const DOMAIN = 'sessiondelete'

/** 五个码的家在 `verbs/errors.ts`（`io` 是唯一兜底）——这里只是取来用，不再抄第二份。 */
type Code = VerbCode

/** 宿主两条类型化错误 → 我们的码（设计稿 §6 的两行映射）。
 *  类不可 import（跨插件值 import 是红线；且宿主包与运行中的宿主不同代）⇒ 按官方构造器写死的 `this.name` 认。
 *  证据：asar `dsh/node_modules/@deepseek-ai/dsh-workspace/lib/index.js` 原文
 *  `var WorkspaceUnknownSessionError = class extends Error { …; this.name = "WorkspaceUnknownSessionError"; }`
 *  `var WorkspaceActiveSessionError  = class extends Error { …; this.name = "WorkspaceActiveSessionError"; }`。 */
const HOST_ERROR_CODE: Record<string, Code> = {
  WorkspaceUnknownSessionError: 'not-found',
  WorkspaceActiveSessionError: 'live',
}

/** 错误与它的 `cause` 链上最近的一个宿主类型化错误码（深度有界，链坏掉不递归下去）。 */
function hostCodeOf(error: unknown): Code | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 8; depth++) {
    if (current === null || typeof current !== 'object') return undefined
    const name = (current as { name?: unknown }).name
    // 必须 `hasOwn`：`in` 会命中 `Object.prototype` 的键，抛出的东西只要 `name` 叫 `constructor`
    // 或 `toString` 就会拿回一个**函数**当码（`sessiondelete/function Object() {…}`）。
    if (typeof name === 'string' && Object.hasOwn(HOST_ERROR_CODE, name)) return HOST_ERROR_CODE[name]
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** 上屏原文：`Error` 取 `.message`；**带 `message` 字符串的非 Error 抛出物也照取**（否则会退化成
 *  `[object Object]`，把设计稿 §6「`message` 是上屏的原文」这条许诺落空）；其余一律 `String()`。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

/**
 * 把任意抛出物折成失败信封里的**那两件**（设计稿 §6 唯一那张映射表）。
 *
 * - 已经是远程失败（`isDSHRemoteError` 认得的结构标记）⇒ 原样带出它自己的 `code` / `message`，不再包一层。
 * - 宿主类型化错误（自身或 `cause` 链上，见 {@link HOST_ERROR_CODE}）⇒ 映射成 `live` / `not-found`。
 *   放在动词码之前判：动词把宿主错误包成笼统的 `io` 并把原错误挂在 cause 上（`verbError('io', …, cause)`），
 *   不这样看进 cause 链，§6 那两行映射就永远到不了客户端。
 * - 动词的 `sessiondelete/<五个码>` ⇒ 原样过桥。
 * - 其余（含别域码、前缀外的因、非 Error 抛出物）⇒ `io`，message 保留原文。
 *
 * **返回的是线上形状、不是 `Error`**：这份东西唯一的去处是 `src/api/dispatch.ts` 的失败信封，两种判别
 * （`isDSHRemoteError` 与 {@link HOST_ERROR_CODE}）都只用到 `code` / `message`——造一个真 `Error` 没有消费者，
 * 而本仓的跨插件 import 红线也不许为此去引宿主的 `RemoteError` 类（实例也上不了线：信封只走这两件）。
 */
export function toRemoteFailure(error: unknown): RemoteFailure {
  if (isDSHRemoteError(error)) return { code: error.code, message: String(error.message) }

  const raw = (error as { code?: unknown } | undefined)?.code
  const reason = typeof raw === 'string' && raw.startsWith(`${DOMAIN}/`)
    ? raw.slice(DOMAIN.length + 1)
    : undefined
  const fromVerb = reason !== undefined && (VERB_CODES as readonly string[]).includes(reason)
    ? (reason as Code)
    : undefined

  const code = hostCodeOf(error) ?? fromVerb ?? 'io'
  return { code: `${DOMAIN}/${code}`, message: messageOf(error) }
}
