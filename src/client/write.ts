/**
 * 一次逐条 `/apply` 写入的**唯一生命周期**：apply → 解信封 → `readReceipt` → commit → refresh。
 *
 * 此前五个逐条 `/apply` 写入面（单删确认框、批量确认框、撤销横幅、回收站面板、残留清理）各写一遍同一段收尾；
 * 面板那一路还只 `refresh` 不 `commit`。这里把顺序收成一处，调用方只交自己的投影与本地状态。
 * 清空回收站是聚合回执（`/empty`），收尾仍住 `use-trash-query.ts` 的 `emptyTrash`。
 *
 * 四条判据：
 * - `ok` 只说**信封**成不成；逐条成败在 `failures` 里，调用方自己决定怎么上屏。
 * - 顶层失败把同一句原文铺到每个 id，不 commit；`refresh` 照样交（成败都在 outcome 里）。
 * - **信封成功就 commit**（逐条全失败也跑：批量写入的失效通告不能漏）；`anySuccess` 由这里算好，
 *   调用方按成功名单投影自己的动作（撤销名单、关视图、清缓存），再按 `outcome.ok` / `anySuccess`
 *   决定是否真的重读。
 * - `single: true` 时把 N=1 模式交给 `receipt.ts` 的读法；单条 null 在那一处折成 failed，
 *   这里不再重复守卫。
 */
import {
  failureMessage,
  isFailureVerdict,
  readReceipt,
  type Receipt,
} from './receipt.js'
import { callRemote, type OneShotDeps } from './remote.js'
import type { ApplyAction, RemoteFailure } from '../shared/wire.js'

export interface WriteSuccess<A extends ApplyAction> {
  readonly ok: true
  readonly receipt: Receipt<A>
  /** 逐条失败原文（failed / neutral / missing），按 id。 */
  readonly failures: ReadonlyMap<string, string>
  /** 成功支（`ok` / `already-gone`）的请求 id，按请求顺序；幂等带走的也算落地。 */
  readonly successIds: readonly string[]
  /** 至少一条真的落地（`ok` / `already-gone`；N=1 的协议空值不算）。 */
  readonly anySuccess: boolean
}

export interface WriteFailure {
  readonly ok: false
  readonly failure: RemoteFailure
  /** 顶层失败时同一句原文铺到每个请求 id。 */
  readonly failures: ReadonlyMap<string, string>
}

export type WriteOutcome<A extends ApplyAction> = WriteSuccess<A> | WriteFailure

export interface WriteInput<A extends ApplyAction> {
  readonly deps: OneShotDeps
  readonly action: A
  readonly ids: readonly string[]
  /** 单条写入面：把 N=1 模式交给 receipt 读法（null 折成协议错）。 */
  readonly single?: boolean
  /** 信封成功时跑（`successIds` 可能为空）；投影成功支、发撤销、清详情缓存都住调用方。 */
  readonly commit?: (outcome: WriteSuccess<A>) => void | Promise<void>
  /** 写完（顶层失败或信封成功，无论逐条成败）后的重读策略；成败与 `anySuccess` 都在 outcome 里，
   *  是否真的重读由调用方决定。 */
  readonly refresh?: (outcome: WriteOutcome<A>) => void | Promise<void>
}

export async function runWrite<A extends ApplyAction>(input: WriteInput<A>): Promise<WriteOutcome<A>> {
  const ids = [...new Set(input.ids)]
  const outcome = await callRemote(() => input.deps.applyOutcomes(input.action, ids))

  if (!outcome.ok) {
    const failures = new Map(ids.map((id) => [id, outcome.failure.message] as const))
    const failed: WriteOutcome<A> = { ok: false, failure: outcome.failure, failures }
    await input.refresh?.(failed)
    return failed
  }

  const single = input.single === true && ids.length === 1
  const receipt = readReceipt(input.action, ids, outcome.value, { single })
  const failures = new Map<string, string>()
  for (const verdict of receipt.verdicts) {
    if (isFailureVerdict(verdict)) failures.set(verdict.id, failureMessage(verdict))
  }

  const successIds = receipt.verdicts
    .filter((verdict) => verdict.kind === 'ok' || verdict.kind === 'already-gone')
    .map((verdict) => verdict.id)
  const success: WriteSuccess<A> = {
    ok: true, receipt, failures, successIds, anySuccess: successIds.length > 0,
  }
  await input.commit?.(success)
  await input.refresh?.(success)
  return success
}
