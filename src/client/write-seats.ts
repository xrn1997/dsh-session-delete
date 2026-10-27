/**
 * 逐条 `/apply` 的写入座位：一次写入发生在哪个界面位置，就在哪个函数里绑定呈现材质、闸与重读通道。
 *
 * 收尾顺序住 `write-settlement.ts`（ADR-0013），重读策略住 `use-trash-query.ts`（ADR-0016）；
 * 座位只拥有「这次是谁在写、交哪些材质、闸在哪」。
 *
 * 边界：不判回执、不决定收尾顺序、不拥有各面的本地状态；面板座位的闸由面板传入，不另造第二枚。
 */
import type { BusyGate } from './busy-gate.js'
import type { OneShotDeps, TrashEntryLike } from './remote.js'
import { invalidateTrash } from './trash-store.js'
import { dismissUndoNotice, publishUndoBatchNotice, publishUndoNotice } from './undo-notices.js'
import { runWrite, type WriteOutcome } from './write.js'

/** 会话行菜单的单删座位：一条会话、`single` 读法、成功发单条撤销横幅。交回这条会话的失败原文。 */
export async function deleteSessionFromMenu(
  deps: OneShotDeps,
  input: { sessionId: string; title: string },
  gate: BusyGate,
): Promise<string | null> {
  const outcome = await runWrite({
    deps,
    action: 'delete',
    ids: [input.sessionId],
    single: true,
    presentation: {
      invalidate: invalidateTrash,
      // N=1 只可能有一条 `ok`（单条读法把幂等空值折成协议错）；settlement 只在有落点时发布，名单非空。
      publishUndo: ({ entryIds }) => publishUndoNotice({ entryId: entryIds[0], title: input.title }),
    },
    gate,
  })
  return outcome.failures.get(input.sessionId) ?? null
}

/** 批量删除座位（宿主会话列表的多选 → 批量确认框）：一次 `/apply`，撤销名单只收 ok 支的条目 id（跟着组走的幂等条不单列）。
 *  只收 id：标题是浮条的呈现，不参与这一次写入。 */
export async function deleteSessionsFromBatch(
  deps: OneShotDeps,
  ids: readonly string[],
  gate: BusyGate,
): Promise<ReadonlyMap<string, string>> {
  const outcome = await runWrite({
    deps,
    action: 'delete',
    ids,
    presentation: {
      invalidate: invalidateTrash,
      publishUndo: ({ entryIds, n }) => publishUndoBatchNotice({ entryIds, n }),
    },
    gate,
  })
  return outcome.failures
}

/** 外部恢复座位（撤销横幅）：没有 busy 面，不传闸；主视图重开归 settlement，这里只让清单失效。 */
export function restoreFromUndo(
  deps: OneShotDeps,
  input: { ids: readonly string[]; single: boolean },
): Promise<WriteOutcome<'restore'>> {
  return runWrite({
    deps,
    action: 'restore',
    ids: input.ids,
    single: input.single,
    presentation: { invalidate: invalidateTrash },
  })
}

/** 面板两个 `/apply` 座位共用的那一半：依赖、条目 id、闸、重读与缓存失效。 */
interface PanelWriteInput<A extends 'restore' | 'purge'> {
  deps: OneShotDeps
  ids: readonly string[]
  gate: BusyGate
  refreshAfterWrite(outcome: WriteOutcome<A>): Promise<void>
  clearDetailCache(ids: readonly string[]): void
}

/** 面板恢复另要两样：单条读法，以及 already-gone 回执缺行时反查 sessionId 的当前清单。 */
interface PanelRestoreInput extends PanelWriteInput<'restore'> {
  single?: boolean
  entries: readonly TrashEntryLike[] | null
}

/** 面板恢复座位：面板已替这条完成「回来」的结算 ⇒ `panelSeat`；撤销横幅与详情缓存都按落地条目收。 */
export function restoreFromPanel(input: PanelRestoreInput): Promise<WriteOutcome<'restore'>> {
  return runWrite({
    deps: input.deps,
    action: 'restore',
    ids: input.ids,
    single: input.single,
    // already-gone 的回执不带行；它的 sessionId 只能从面板当前清单里取，取不到就跳过（那条的旧重开
    // pending 由下一次删除/恢复按「最新动作优先」作废）。
    sessionIdOfEntry: (entryId) => input.entries?.find((entry) => entry.id === entryId)?.sessionId,
    presentation: {
      panelSeat: true,
      dismissUndo: dismissUndoNotice,
      clearDetailCache: input.clearDetailCache,
    },
    gate: input.gate,
    refresh: input.refreshAfterWrite,
  })
}

/** 面板彻底删除座位：永久删除也让指向这些条目的撤销横幅熄灭（settlement 的 purge 支负责）。 */
export function purgeFromPanel(input: PanelWriteInput<'purge'>): Promise<WriteOutcome<'purge'>> {
  return runWrite({
    deps: input.deps,
    action: 'purge',
    ids: input.ids,
    presentation: {
      dismissUndo: dismissUndoNotice,
      clearDetailCache: input.clearDetailCache,
    },
    gate: input.gate,
    refresh: input.refreshAfterWrite,
  })
}

interface OrphanCleanSeatInput {
  deps: OneShotDeps
  ids: readonly string[]
  gate: BusyGate
  refreshAfterWrite(outcome: WriteOutcome<'orphan-clean'>): Promise<void>
}

/** 无主子会话清理座位：不碰回收站失效与撤销，回执判读仍归 `use-trash-query.ts`。 */
export function cleanOrphansFromPanel(input: OrphanCleanSeatInput): Promise<WriteOutcome<'orphan-clean'>> {
  return runWrite({
    deps: input.deps,
    action: 'orphan-clean',
    ids: input.ids,
    gate: input.gate,
    refresh: input.refreshAfterWrite,
  })
}
