import {
  SESSION_DELETE_CODES,
  type ApplyAction,
  type ApplyOutcome,
  type ApplyValueByAction,
  type RemoteFailure,
} from '../shared/wire.js'

/**
 * 一条 `/apply` 结果对一个请求 id 的含义。各写入面不许再各自推导：
 * 缺 id 是通道错误，`null` 是幂等成功，orphan-clean 的 `not-found` 是中性提示而非失败，
 * **N=1 的 `null` 是协议错**——最后这条也在这里判，`applyOne` 与 `runWrite` 只消费同一份 verdict。
 *
 * 各 action 可能出现的 kind（类型面故意保持同一个联合，消费方按 action 自己收窄）：
 * - delete / restore：`ok` / `already-gone` / `failed` / `missing`
 * - count / purge：`ok` / `failed` / `missing`
 * - orphan-clean：`ok` / `neutral` / `failed` / `missing`
 * - 单条读法（`readSingleReceipt`）：不含 `already-gone`；null 折成 `failed`
 */
export type ReceiptVerdict<A extends ApplyAction> =
  | { readonly kind: 'ok'; readonly id: string; readonly value: Exclude<ApplyValueByAction[A], null> }
  | { readonly kind: 'already-gone'; readonly id: string }
  | { readonly kind: 'failed'; readonly id: string; readonly error: RemoteFailure }
  | { readonly kind: 'neutral'; readonly id: string; readonly error: RemoteFailure }
  | { readonly kind: 'missing'; readonly id: string; readonly message: string }

export interface Receipt<A extends ApplyAction> {
  readonly verdicts: readonly ReceiptVerdict<A>[]
  readonly byId: ReadonlyMap<string, ReceiptVerdict<A>>
}

/** 浏览器半自己的未分类诊断码（通道打不通 / 非信封 / 单条协议错）。它不过线，线上失败码仍归 `shared/wire.ts`。 */
export const CLIENT_UNKNOWN_CODE = 'client/unknown'

export interface ReceiptOptions {
  /** N=1：null 只能是通道答错了，不冒充幂等成功。 */
  readonly single?: boolean
}

export type SingleReceiptVerdict<A extends ApplyAction> = Exclude<ReceiptVerdict<A>, { kind: 'already-gone' }>

export interface SingleReceipt<A extends ApplyAction> {
  readonly verdicts: readonly SingleReceiptVerdict<A>[]
  readonly byId: ReadonlyMap<string, SingleReceiptVerdict<A>>
}

export function missingOutcomeMessage(action: ApplyAction, id: string): string {
  return `批量通道没回这一条的结果：${action} ${id}`
}

function singleNullMessage(action: ApplyAction, id: string): string {
  return `单条动作回了幂等空值：${action} ${id}`
}

/** 三种“这一条没成”的 verdict；`failureMessage` 是它们原文取值的唯一入口。 */
export type FailureVerdict<A extends ApplyAction> = Extract<
  ReceiptVerdict<A>,
  { kind: 'failed' | 'neutral' | 'missing' }
>

export function isFailureVerdict<A extends ApplyAction>(verdict: ReceiptVerdict<A>): verdict is FailureVerdict<A> {
  return verdict.kind === 'failed' || verdict.kind === 'neutral' || verdict.kind === 'missing'
}

/** failed / neutral 取服务端原文 `error.message`；missing 取通道自己写的那句。 */
export function failureMessage<A extends ApplyAction>(verdict: FailureVerdict<A>): string {
  return verdict.kind === 'failed' || verdict.kind === 'neutral' ? verdict.error.message : verdict.message
}

function decode<A extends ApplyAction>(
  action: A,
  outcome: ApplyOutcome,
  options: ReceiptOptions,
): ReceiptVerdict<A> | undefined {
  if (outcome.action !== action) return undefined
  const typed = outcome as Extract<ApplyOutcome, { action: A }>
  if (!typed.ok) {
    return action === 'orphan-clean' && typed.error.code === SESSION_DELETE_CODES['not-found']
      ? { kind: 'neutral', id: typed.id, error: typed.error }
      : { kind: 'failed', id: typed.id, error: typed.error }
  }
  const value = typed.value as ApplyValueByAction[A]
  if (value === null) {
    return options.single === true
      ? {
        kind: 'failed',
        id: typed.id,
        error: { code: CLIENT_UNKNOWN_CODE, message: singleNullMessage(action, typed.id) },
      }
      : { kind: 'already-gone', id: typed.id }
  }
  return { kind: 'ok', id: typed.id, value: value as Exclude<ApplyValueByAction[A], null> }
}

export function readReceipt<A extends ApplyAction>(
  action: A,
  requestedIds: readonly string[],
  outcomes: readonly ApplyOutcome[],
  options: ReceiptOptions = {},
): Receipt<A> {
  const wanted = [...new Set(requestedIds)]
  const wantedSet = new Set(wanted)
  const byId = new Map<string, ReceiptVerdict<A>>()
  for (const outcome of outcomes) {
    if (!wantedSet.has(outcome.id) || byId.has(outcome.id)) continue
    const verdict = decode(action, outcome, options)
    if (verdict !== undefined) byId.set(outcome.id, verdict)
  }
  const verdicts = wanted.map((id): ReceiptVerdict<A> =>
    byId.get(id) ?? { kind: 'missing', id, message: missingOutcomeMessage(action, id) })
  return { verdicts, byId: new Map(verdicts.map((verdict) => [verdict.id, verdict])) }
}

/**
 * N=1 的读法：null 折成协议错，类型面因此不含 `already-gone`（下面那次过滤只服务类型收窄，
 * single 读法运行期不会产出它）。`applyOne` 用它之后只剩「按 id 取一条 + 抛失败」。
 */
export function readSingleReceipt<A extends ApplyAction>(
  action: A,
  id: string,
  outcomes: readonly ApplyOutcome[],
): SingleReceipt<A> {
  const verdicts = readReceipt(action, [id], outcomes, { single: true }).verdicts
    .filter((verdict): verdict is SingleReceiptVerdict<A> => verdict.kind !== 'already-gone')
  return { verdicts, byId: new Map(verdicts.map((verdict) => [verdict.id, verdict])) }
}

function isRestoreEntry(value: unknown): value is { readonly sessionId: string } {
  return typeof value === 'object' && value !== null && 'sessionId' in value
}

/**
 * restore 回执里真正回盘的会话 id：`ok` 支取条目上的 `sessionId`；`already-gone` 没有行，
 * 由调用方给条目查找兜底。purge / count 的 `ok` 值没有 `sessionId`，会被跳过。
 */
export function restoredSessionIds<A extends ApplyAction>(
  receipt: Receipt<A>,
  sessionIdOfEntry?: (entryId: string) => string | undefined,
): string[] {
  const ids: string[] = []
  for (const verdict of receipt.verdicts) {
    if (verdict.kind === 'ok') {
      if (isRestoreEntry(verdict.value)) ids.push(verdict.value.sessionId)
      continue
    }
    if (verdict.kind === 'already-gone' && sessionIdOfEntry !== undefined) {
      const sessionId = sessionIdOfEntry(verdict.id)
      if (sessionId !== undefined) ids.push(sessionId)
    }
  }
  return ids
}
