/** 客户端用例共用的**批量口替身**：把一个"单条动作"的函数包成 `applyOutcomes(action, ids)` 的形状。
 *
 * 为什么需要它：注入面收成一个 `apply` 之后，组件里所有单条动作都走
 * `applyOne(deps, action, id)`——用例因此再也不能用 `{ delete: fn }` 这种"每个动作一个方法"的假 deps，
 * 而要把自己的单条假实现包成那一批的形状。包一次比在 20 个调用点各写一遍 outcomes 数组清楚。
 *
 * 折法照着信封：`run` 抛的异常按 `error` 交回（码缺省 `sessiondelete/io`），`count` 的结果必须是个数
 * （缺省 0——"读不到就不说那半句"由调用方判，不在这里冒充）。
 */
import { vi } from 'vitest'
import type { ApplyAction, ApplyOutcome, ApplyValueByAction } from '../../../src/shared/wire.js'
import { failed, NEUTRAL_VALUE, ok } from './outcomes.js'

export type SingleAction = (id: string) => Promise<unknown>

/** 一层 `applyOutcomes`：`over[action]` 缺省 = 该动作的中性成功值（口径住 `outcomes.ts`）。 */
export function fakeApply(over: Partial<Record<ApplyAction, SingleAction>> = {}) {
  return vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]> => {
    const run: SingleAction = over[action] ?? (async () => NEUTRAL_VALUE[action])
    const receipts: ApplyOutcome[] = []
    for (const id of ids) {
      try {
        // 值由假实现自己保证与动作对得上（`over` 的签名就要求它交回那个动作的成功值）。
        const value = await run(id) as ApplyValueByAction[ApplyAction]
        receipts.push(ok(action, id, value))
      } catch (error) {
        const code = (error as { code?: unknown }).code
        receipts.push(failed(
          action,
          id,
          error instanceof Error ? error.message : String(error),
          typeof code === 'string' ? code : undefined,
        ))
      }
    }
    return receipts
  })
}
