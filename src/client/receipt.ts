import {
  SESSION_DELETE_CODES,
  type ApplyAction,
  type ApplyOutcome,
  type ApplyValueByAction,
  type RemoteFailure,
} from '../shared/wire.js'

/**
 * 一条 `/apply` 结果对一个请求 id 的含义。各写入面不许再各自推导：
 * 缺 id 是通道错误，`null` 是幂等成功，orphan-clean 的 `not-found` 是中性提示而非失败。
 *
 * 各 action 可能出现的 kind（类型面故意保持同一个联合，消费方按 action 自己收窄）：
 * - delete / restore：`ok` / `already-gone` / `failed` / `missing`
 * - count / purge：`ok` / `failed` / `missing`
 * - orphan-clean：`ok` / `neutral` / `failed` / `missing`
 */
export type ReceiptVerdict<A extends ApplyAction> =
  | { readonly kind: 'ok'; readonly id: string; readonly value: ApplyValueByAction[A] }
  | { readonly kind: 'already-gone'; readonly id: string }
  | { readonly kind: 'failed'; readonly id: string; readonly error: RemoteFailure }
  | { readonly kind: 'neutral'; readonly id: string; readonly error: RemoteFailure }
  | { readonly kind: 'missing'; readonly id: string; readonly message: string }

export interface Receipt<A extends ApplyAction> {
  readonly verdicts: readonly ReceiptVerdict<A>[]
  readonly byId: ReadonlyMap<string, ReceiptVerdict<A>>
}

export function missingOutcomeMessage(action: ApplyAction, id: string): string {
  return `批量通道没回这一条的结果：${action} ${id}`
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

function decode<A extends ApplyAction>(action: A, outcome: ApplyOutcome): ReceiptVerdict<A> | undefined {
  if (outcome.action !== action) return undefined
  const typed = outcome as Extract<ApplyOutcome, { action: A }>
  if (!typed.ok) {
    return action === 'orphan-clean' && typed.error.code === SESSION_DELETE_CODES['not-found']
      ? { kind: 'neutral', id: typed.id, error: typed.error }
      : { kind: 'failed', id: typed.id, error: typed.error }
  }
  const value = typed.value as ApplyValueByAction[A]
  return value === null
    ? { kind: 'already-gone', id: typed.id }
    : { kind: 'ok', id: typed.id, value }
}

export function readReceipt<A extends ApplyAction>(
  action: A,
  requestedIds: readonly string[],
  outcomes: readonly ApplyOutcome[],
): Receipt<A> {
  const wanted = [...new Set(requestedIds)]
  const wantedSet = new Set(wanted)
  const byId = new Map<string, ReceiptVerdict<A>>()
  for (const outcome of outcomes) {
    if (!wantedSet.has(outcome.id) || byId.has(outcome.id)) continue
    const verdict = decode(action, outcome)
    if (verdict !== undefined) byId.set(outcome.id, verdict)
  }
  const verdicts = wanted.map((id): ReceiptVerdict<A> =>
    byId.get(id) ?? { kind: 'missing', id, message: missingOutcomeMessage(action, id) })
  return { verdicts, byId: new Map(verdicts.map((verdict) => [verdict.id, verdict])) }
}
