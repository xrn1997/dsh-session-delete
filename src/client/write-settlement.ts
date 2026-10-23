/**
 * 一次逐条 `/apply` 写入成功后的**收尾顺序**，按 action 各一条固定序列。
 *
 * 调用方只交呈现素材（`WritePresentation`），顺序与 `anySuccess` 门只住这里；`runWrite` 在拿到
 * `WriteSuccess` 后、`refresh` 前调一次。为什么按 action 收成一处见 ADR-0013。
 *
 * 四条判据：
 * - **跨槽位在信封成功时就跑**：`afterDelete` / `afterRestore` 与 `invalidate` 不管逐条成败都跑
 *   （回滚失败可能留下半套，回收站清单不能继续摆旧行）；呈现钩子（发布/熄灭撤销、遗忘主视图、
 *   清详情缓存）只在至少一条落地（`anySuccess`）时跑——没有落点的撤销是假动作。
 * - **恢复有两个座位**：外部恢复（撤销横幅）自己不管主视图，由 settlement 调 `afterRestore` 重开；
 *   面板恢复自带 `forgetMainView`（面板已经替这条会话完成“回来”的结算），只遗忘、不重开、不抢焦点。
 *   判据住 `src/client/main-view.ts` 的 `forgetMainView`。
 * - **`count` 不结算**；`orphan-clean` 没有跨槽位收尾（清完由 query 自己的写后刷新收尾）。
 * - 不直接读 DOM、不问宿主：主视图收尾只经 `main-view.ts` 的 `afterDelete` / `afterRestore`（服务缺席或
 *   抛错都静默退回）；重读仍归各调用方的 `refresh`（面板的到达序链在 `use-trash-query.ts`）。
 */
import type { ApplyAction } from '../shared/wire.js'
import { restoredSessionIds, type Receipt } from './receipt.js'
import { afterDelete, afterRestore } from './main-view.js'

/** 一次写入里与渲染无关的那部分：动作、请求 id、回执、成功名单与“至少一条落地”。 */
export interface SettledFacts<A extends ApplyAction> {
  readonly action: A
  readonly ids: readonly string[]
  readonly receipt: Receipt<A>
  /** 成功支（`ok` / `already-gone`）的请求 id，按请求顺序。 */
  readonly successIds: readonly string[]
  /** 至少一条真的落地（`ok` / `already-gone`；N=1 的协议空值不算）。 */
  readonly anySuccess: boolean
}

/** 写入面交给 settlement 的呈现素材；每个钩子都可缺席，缺席即“这个座位不做这一手”
 *  （恢复的 `forgetMainView` 例外：缺席表示外部恢复座位，由 settlement 重开主视图）。
 *  钩子都是同步的：settlement 在 `refresh` 前一次跑完，不 await。 */
export interface WritePresentation<A extends ApplyAction> {
  /** 外部写入座位：让回收站面板重读。面板写不传（自己的 `refreshAfterWrite` 就是重读）。 */
  invalidate?(): void
  /** 只在 delete 座位调用；其余座位给了也不读。 */
  publishUndo?(success: SettledFacts<A>): void
  dismissUndo?(entryIds: readonly string[]): void
  /** 面板恢复座位：只忘掉 main-view 记过的会话，不重开。提供它就跳过 `afterRestore`。 */
  forgetMainView?(sessionIds: readonly string[]): void
  /** already-gone 的回执不带行，它的 sessionId 只能由调用方从当前清单里查。 */
  sessionIdOfEntry?(entryId: string): string | undefined
  clearDetailCache?(entryIds: readonly string[]): void
}

export function settleWrite<A extends ApplyAction>(
  success: SettledFacts<A>,
  presentation: WritePresentation<A> = {},
): void {
  switch (success.action) {
    case 'delete':
      afterDelete(success.successIds)
      presentation.invalidate?.()
      if (success.anySuccess) presentation.publishUndo?.(success)
      return
    case 'restore': {
      const restored = restoredSessionIds(success.receipt, presentation.sessionIdOfEntry)
      if (presentation.forgetMainView === undefined) afterRestore(restored)
      presentation.invalidate?.()
      if (!success.anySuccess) return
      presentation.dismissUndo?.(success.successIds)
      presentation.forgetMainView?.(restored)
      presentation.clearDetailCache?.(success.successIds)
      return
    }
    case 'purge':
      presentation.invalidate?.()
      if (success.anySuccess) presentation.clearDetailCache?.(success.successIds)
      return
    case 'count':
    case 'orphan-clean':
      return
    default: {
      // 穷尽闸：`ApplyAction` 多出一个动作时，这里编译不过——新动作不许悄悄跳过 settlement。
      const _never: never = success.action
      return _never
    }
  }
}
