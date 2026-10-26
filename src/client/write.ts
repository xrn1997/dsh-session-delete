/**
 * 一次逐条 `/apply` 写入的**唯一生命周期**：apply → 解信封 → `readReceipt` → 回执摘要 → settlement → refresh。
 *
 * 收尾顺序与 `anySuccess` 门住 `src/client/write-settlement.ts`（为什么按 action 收见 ADR-0013）；
 * 这里只管时机、信封判读、整趟的闸与 `refresh` 的交法。清空回收站是聚合回执（`/empty`），收尾仍住
 * `use-trash-query.ts` 的 `emptyTrash`。
 *
 * 五条判据：
 * - `ok` 只说**信封**成不成；逐条成败在 `failures` 里，调用方自己决定怎么上屏。
 * - 顶层失败把同一句原文铺到每个 id，不结算；`refresh` 照样交（成败都在 outcome 里）。
 * - **信封成功就结算**（逐条全失败也跑：批量写入的失效通告不能漏）；`anySuccess` 与落地名单由
 *   `receipt.ts` 的回执摘要算好，settlement 按它上闸。调用方只交呈现材质，再按 `outcome` 决定是否真的重读。
 *   结算在 `refresh` 之前：列表重读看得到收尾后的现场。
 * - `single: true` 时把 N=1 模式交给 `receipt.ts` 的读法；单条 null 在那一处折成 failed，
 *   这里不再重复守卫。
 * - **闸包住整趟**：给了 `gate` 就把 apply → settle → refresh 一起包进去——refresh 落在闸外时，
 *   旧清单还在屏上，同一个动作能被再点一次；调用方不再自己 `around`。
 */
import type { BusyGate } from './busy-gate.js'
import { readReceipt, summarizeReceipt } from './receipt.js'
import { callRemote, type OneShotDeps } from './remote.js'
import {
  noPresentation,
  settleWrite,
  type SettledFacts,
  type WritePresentation,
} from './write-settlement.js'
import type { ApplyAction, RemoteFailure } from '../shared/wire.js'

export type WriteSuccess<A extends ApplyAction> = SettledFacts<A> & {
  readonly ok: true
  /** 逐条失败原文（failed / neutral / missing），按 id。这是失败表的**唯一落点**：
   *  摘要只带聚合与落地 id，不再复制一份逐条原文。 */
  readonly failures: ReadonlyMap<string, string>
}

export interface WriteFailure<A extends ApplyAction> {
  readonly ok: false
  readonly action: A
  readonly ids: readonly string[]
  readonly failure: RemoteFailure
  /** 顶层失败时同一句原文铺到每个请求 id。 */
  readonly failures: ReadonlyMap<string, string>
}

export type WriteOutcome<A extends ApplyAction> = WriteSuccess<A> | WriteFailure<A>

export interface WriteInput<A extends ApplyAction> {
  readonly deps: OneShotDeps
  readonly action: A
  readonly ids: readonly string[]
  /** 单条写入面：把 N=1 模式交给 receipt 读法（null 折成协议错）。 */
  readonly single?: boolean
  /** restore 的 already-gone 回执不带行，它的 sessionId 只能由调用方从当前清单里查。 */
  readonly sessionIdOfEntry?: (entryId: string) => string | undefined
  /** 信封成功时交给 settlement 的呈现材质（摘要里的成功名单可能为空）；按 action 的收尾顺序住 `write-settlement.ts`。 */
  readonly presentation?: WritePresentation<A>
  /** 这一趟的闸：给了就把 apply → settle → refresh 整趟包进 busy。refresh 不许落在闸外。 */
  readonly gate?: BusyGate
  /** 写完（顶层失败或信封成功，无论逐条成败）后的重读策略；成败与 `anySuccess` 都在 outcome 里，
   *  是否真的重读由调用方决定。 */
  readonly refresh?: (outcome: WriteOutcome<A>) => void | Promise<void>
}

export async function runWrite<A extends ApplyAction>(input: WriteInput<A>): Promise<WriteOutcome<A>> {
  const lifecycle = async (): Promise<WriteOutcome<A>> => {
    const ids = [...new Set(input.ids)]
    const outcome = await callRemote(() => input.deps.applyOutcomes(input.action, ids))

    if (!outcome.ok) {
      const failures = new Map(ids.map((id) => [id, outcome.failure.message] as const))
      const failed: WriteOutcome<A> = {
        ok: false, action: input.action, ids, failure: outcome.failure, failures,
      }
      await input.refresh?.(failed)
      return failed
    }

    const single = input.single === true && ids.length === 1
    const receipt = readReceipt(input.action, ids, outcome.value, { single })
    const { summary, failures } = summarizeReceipt(receipt, input.sessionIdOfEntry)
    const success: WriteSuccess<A> = {
      ok: true, action: input.action, ids, summary, failures,
    }
    settleWrite(success, input.presentation ?? noPresentation(input.action))
    await input.refresh?.(success)
    return success
  }

  // 闸包住整趟：refresh 也是这一趟的一部分——落在闸外，旧清单还在屏上时同一个动作能被再点一次。
  return input.gate === undefined ? lifecycle() : input.gate.around(lifecycle)
}
