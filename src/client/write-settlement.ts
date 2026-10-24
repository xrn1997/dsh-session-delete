/**
 * 一次逐条 `/apply` 写入成功后的**收尾顺序**，按 action 各一条固定序列。
 *
 * 调用方只交呈现材质（`WritePresentation`），顺序与 `anySuccess` 门只住这里；`runWrite` 在拿到
 * `WriteSuccess` 后、`refresh` 前调一次。为什么按 action 收成一处见 ADR-0013。
 *
 * 四条判据：
 * - **跨槽位在信封成功时就跑**：`afterDelete` / `afterRestore` 与 `invalidate` 不管逐条成败都跑
 *   （回滚失败可能留下半套，回收站清单不能继续摆旧行）；呈现钩子（发布/熄灭撤销、遗忘主视图、
 *   清详情缓存）只在至少一条落地（`anySuccess`）时跑——没有落点的撤销是假动作。delete 的撤销
 *   另要求落地名单非空：全部被同批前一条带走时没有可撤销的条目。
 * - **面板恢复用 `panelSeat: true` 明说**（「缺席」不再承载语义）：外部恢复（撤销横幅）由 settlement
 *   调 `afterRestore` 重开；面板恢复自带「回来」的结算，只 `forgetMainView`、不重开、不抢焦点。
 *   判据住 `src/client/main-view.ts` 的 `forgetMainView`。
 * - **撤销名单由 settlement 算、座位发布**：delete 支把 `landedEntryIds` 与 `successIds.length` 算成
 *   `{ entryIds, n }` 交给座位，座位只决定发布哪一形（单条带标题、批量带条数）——那句文案与它的键
 *   住 `undo-toast.tsx` 与 `copy.ts`；purge 支在
 *   `anySuccess` 时熄灭指向这些条目的横幅——留着就是一条注定失败的「撤销」。
 * - **`count` 不结算**；`orphan-clean` 没有跨槽位收尾（清完由 query 自己的写后刷新收尾）。
 *   不直接读 DOM、不问宿主：主视图收尾只经 `main-view.ts` 的 `afterDelete` / `afterRestore`
 *   （服务缺席或抛错都静默退回）；重读仍归各调用方的 `refresh`（面板那侧的最新票在 `use-trash-query.ts`）。
 */
import type { ApplyAction } from '../shared/wire.js'
import { afterDelete, afterRestore, forgetMainView } from './main-view.js'
import { landedEntryIds, restoredSessionIds, type Receipt } from './receipt.js'

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

/**
 * 按 action 切开的一族呈现材质：每个座位只能拿到自己动作那几手，形状对不上的钩子在类型面就不存在。
 * - `delete` 的 `publishUndo` 存在即「这个座位要发撤销横幅」；它拿到的是 settlement 算好的落地名单。
 * - `restore` 的 `panelSeat: true` 才是「面板已替这条完成『回来』的结算」，不再靠缺席某个钩子暗示。
 * - `count` / `orphan-clean` 没有呈现材质（用 `noPresentation`）。
 * 钩子都是同步的：settlement 在 `refresh` 前一次跑完，不 await。
 */
export type WritePresentationByAction = {
  delete: {
    /** 外部写入座位：让回收站面板重读。面板写不传（自己的 `refreshAfterWrite` 就是重读）。 */
    invalidate?(): void
    /** 撤销发布：settlement 把落地的条目 id 与请求名单算好后交来；名单**非空**——全被同批前一条带走时
     *  没有落点，settlement 不发布没有可撤销动作的横幅。座位只决定发布哪一形与那一形带的标题。 */
    publishUndo?(landed: { readonly entryIds: readonly [string, ...string[]]; readonly n: number }): void
  }
  restore: {
    invalidate?(): void
    /** 面板恢复座位：true = 面板已替这条完成「回来」的结算，只遗忘、不重开、不抢焦点。 */
    panelSeat?: true
    dismissUndo?(entryIds: readonly string[]): void
    clearDetailCache?(entryIds: readonly string[]): void
    /** already-gone 的回执不带行，它的 sessionId 只能由调用方从当前清单里查。 */
    sessionIdOfEntry?(entryId: string): string | undefined
  }
  purge: {
    dismissUndo?(entryIds: readonly string[]): void
    clearDetailCache?(entryIds: readonly string[]): void
  }
  count: Record<string, never>
  'orphan-clean': Record<string, never>
}

export type WritePresentation<A extends ApplyAction> = WritePresentationByAction[A]

const NO_PRESENTATION: WritePresentationByAction = {
  delete: {}, restore: {}, purge: {}, count: {}, 'orphan-clean': {},
}

/** 没有呈现材质的座位用它：抛掉按 action 的联合，调用点不用各自造一个空对象字面量。 */
export function noPresentation<A extends ApplyAction>(action: A): WritePresentation<A> {
  return NO_PRESENTATION[action] as WritePresentation<A>
}

export function settleWrite<A extends ApplyAction>(
  success: SettledFacts<A>,
  presentation: WritePresentation<A>,
): void {
  switch (success.action) {
    case 'delete': {
      // `success.action` 已是判别式，但 TS 不会顺着它把 type 参数一起收窄；三支各做一次具名窄化。
      const seat = presentation as WritePresentationByAction['delete']
      afterDelete(success.successIds)
      seat.invalidate?.()
      if (success.anySuccess) {
        const [first, ...rest] = landedEntryIds(success.receipt)
        // 全部被同批前一条带走时没有落点：不发布一条没有可撤销动作的横幅。
        if (first !== undefined) {
          const entryIds: [string, ...string[]] = [first, ...rest]
          seat.publishUndo?.({ entryIds, n: success.successIds.length })
        }
      }
      return
    }
    case 'restore': {
      const seat = presentation as WritePresentationByAction['restore']
      const restored = restoredSessionIds(success.receipt, seat.sessionIdOfEntry)
      if (seat.panelSeat !== true) afterRestore(restored)
      seat.invalidate?.()
      if (!success.anySuccess) return
      seat.dismissUndo?.(success.successIds)
      if (seat.panelSeat === true) forgetMainView(restored)
      seat.clearDetailCache?.(success.successIds)
      return
    }
    case 'purge': {
      const seat = presentation as WritePresentationByAction['purge']
      if (success.anySuccess) {
        // 永久删除也让指向这些条目的撤销横幅熄灭：留着就是一条注定失败的「撤销」。
        seat.dismissUndo?.(success.successIds)
        seat.clearDetailCache?.(success.successIds)
      }
      return
    }
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
