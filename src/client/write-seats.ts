/**
 * 逐条 `/apply` 的写入座位：一次写入发生在哪个界面位置，就在哪个函数里绑定呈现材质、闸与重读通道。
 *
 * 收尾顺序住 `write-settlement.ts`（ADR-0013），面板的重读策略住 `use-trash-query.ts`；
 * 座位只拥有「这次是谁在写、交哪些材质、闸在哪」。
 *
 * 边界：不自己判读回执（verdict 判读住 `receipt.ts`，失败表怎么上屏归各写入面——撤销那一趟的
 * 横幅改写住 `restoreFromUndo`）、不决定收尾顺序、不拥有各面的本地状态；面板座位的闸由面板传入，
 * 不另造第二枚；闸挡回来的那一趟**什么都不落地**——座位交回 blocked，不伪造 outcome，
 * 收尾留给在飞的那一趟。
 * 无主子会话清理**不是**座位：它只在插件设置页的维护卡里手动触发（ADR-0021），
 * 读数、闸与重查都归 `use-maintenance.ts`。
 */
import type { Translate } from './copy.js'
import type { BusyGate, GateRun } from './busy-gate.js'
import type { OneShotDeps, TrashEntryLike } from './remote.js'
import { invalidateTrash } from './trash-store.js'
import { forgetTrashDetails } from './trash-snapshot.js'
import {
  clearUndoNotice,
  dismissUndoNotice,
  failNotice,
  ownsNotice,
  publishUndoBatchNotice,
  publishUndoNotice,
  type UndoNotice,
} from './undo-notices.js'
import { runWrite, type WriteOutcome } from './write.js'

/** 会话行菜单的单删座位：一条会话、`single` 读法、成功发单条撤销横幅。交回这条会话的失败原文。
 *  两支判别：`{ kind:'blocked' }` = 闸把这一趟挡回来了、什么都没跑（框不收，等在飞那一趟的结论——
 *  先收就会把它的失败原文落在已经卸载的确认框上）；`{ kind:'ran', value }` 里 `value` 是这一条的
 *  失败原文，`null` = 跑了、这一条没有失败要说。 */
export async function deleteSessionFromMenu(
  deps: OneShotDeps,
  input: { sessionId: string; title: string },
  gate: BusyGate,
): Promise<GateRun<string | null>> {
  const run = await runWrite({
    deps,
    action: 'delete',
    ids: [input.sessionId],
    single: true,
    presentation: {
      invalidate: invalidateTrash,
      // N=1 只可能有一条 `ok`（单条读法把幂等空值折成协议错）；settlement 只在有落点时发布，名单非空。
      publishUndo: ({ entryIds, archived }) => publishUndoNotice({ entryId: entryIds[0], title: input.title, archived }),
    },
    gate,
  })
  // 挡回来的一趟不伪造「这条没有失败」：原样交回 blocked，让框留在原地。
  if (run.kind === 'blocked') return run
  return { kind: 'ran', value: run.value.failures.get(input.sessionId) ?? null }
}

/** 批量删除座位（宿主会话列表的多选浮条与面板归档档的页脚共用 → 批量确认框）：一次 `/apply`，撤销名单只收 ok 支的条目 id（跟着组走的幂等条不单列）。
 *  只收 id：标题是发请求那一面的呈现，不参与这一次写入。**被闸挡回时交回 `{kind:'blocked'}`**——这一趟没跑，
 *  浮条与确认框都不许照着它收缩名单或关框（那会吞掉在飞那一趟的结果）。 */
export async function deleteSessionsFromBatch(
  deps: OneShotDeps,
  ids: readonly string[],
  gate: BusyGate,
): Promise<GateRun<ReadonlyMap<string, string>>> {
  const outcome = await runWrite({
    deps,
    action: 'delete',
    ids,
    presentation: {
      invalidate: invalidateTrash,
      publishUndo: ({ entryIds, n, archived }) => publishUndoBatchNotice({ entryIds, n, archived }),
    },
    gate,
  })
  return outcome.kind === 'blocked' ? outcome : { kind: 'ran', value: outcome.value.failures }
}

/** 外部恢复座位：拥有整趟——ids 组装、runWrite、三种回执形状各改写一次横幅、成功收自己。
 *  闸在调用方（横幅组件每条通知一枚）；座位不传闸（双套会让外层 busy 提前落）。
 *  单条与批量都走**一次** `applyOutcomes('restore', ids)`（`runWrite` 判读；单条带 `single: true`，
 *  null 是协议错）；失败就把原因换到同一条横幅上，不静默。多条逐条失败时横幅要说清**条数与各条
 *  原因**（原因去重）——只显第一条会把条数与其余原因折没（issue #8 第 5 条）；单条失败仍原文上屏。
 *  settlement 负责重开删除时被关掉的会话（只认 main-view 自己记过的）、让清单重读并丢成功条目的
 *  详情账本；座位**不传 `dismissUndo`**——部分失败的回滚会让 settlement 先熄灭横幅，随后 `failNotice` 因
 *  `ownsNotice` 落空而吞掉失败原文。 */
export async function restoreFromUndo(deps: OneShotDeps, notice: UndoNotice, t: Translate): Promise<void> {
  // 没有落点的撤销是假按钮：单条形拿不到条目 id 时早退（批量形空名单由组件不出动作挡住）。
  const ids = notice.kind === 'one' ? [notice.entryId] : notice.entryIds
  if (notice.kind === 'one' && notice.entryId === '') return
  const outcome = await runWrite({
    deps,
    action: 'restore',
    ids,
    single: notice.kind === 'one',
    // 主视图重开归 settlement（外部恢复座位不带 panelSeat）；这里让清单失效，并按成功名单丢详情
    // 账本（ADR-0048 决定 4：写成功即丢，不等清单重读——面板未挂载时这一趟也要丢）。
    presentation: { invalidate: invalidateTrash, forgetTrashDetails },
  })
  if (!outcome.ok) {
    failNotice(notice, outcome.failure.message)
    return
  }
  const failure = outcome.failures.values().next().value
  if (failure !== undefined) {
    // 信封成功 ≠ 每一条都撤销成功：逐条失败时横幅要换成失败原文，不能假装撤销成功。
    failNotice(notice, outcome.failures.size > 1
      ? t('undo.failedBatch', {
        n: outcome.failures.size,
        reasons: [...new Set(outcome.failures.values())].join(' · '),
      })
      : failure)
    return
  }
  // 成功只收掉自己那条：期间若已发布新删除的横幅，不能被这次收尾顺手清掉。
  if (ownsNotice(notice)) clearUndoNotice()
}

/** 面板两个 `/apply` 座位共用的那一半：依赖、条目 id、闸、重读与账本失效。 */
interface PanelWriteInput<A extends 'restore' | 'purge'> {
  deps: OneShotDeps
  ids: readonly string[]
  gate: BusyGate
  /** 属性声明：这两枚回调被摘下来交给 `runWrite`（转交而不是当方法调），实现不读 `this`。 */
  refreshAfterWrite: (outcome: WriteOutcome<A>) => Promise<void>
  forgetTrashDetails: (ids: readonly string[]) => void
}

/** 面板恢复另要两样：单条读法，以及 already-gone 回执缺行时反查 sessionId 的当前清单。 */
interface PanelRestoreInput extends PanelWriteInput<'restore'> {
  single?: boolean
  entries: readonly TrashEntryLike[] | null
}

/** 面板恢复座位：面板已替这条完成「回来」的结算 ⇒ `panelSeat`；撤销横幅与详情账本都按落地条目收。
 *  闸被面板那一趟占着时交回 `{kind:'blocked'}`（连点不发第二条），面板照它什么都不改。 */
export function restoreFromPanel(input: PanelRestoreInput): Promise<GateRun<WriteOutcome<'restore'>>> {
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
      forgetTrashDetails: input.forgetTrashDetails,
    },
    gate: input.gate,
    refresh: input.refreshAfterWrite,
  })
}

/** 面板彻底删除座位：永久删除也让指向这些条目的撤销横幅熄灭（settlement 的 purge 支负责）。
 *  与恢复座位同一条：闸被占着时交回 `{kind:'blocked'}`，这一趟不改任何界面后果。 */
export function purgeFromPanel(input: PanelWriteInput<'purge'>): Promise<GateRun<WriteOutcome<'purge'>>> {
  return runWrite({
    deps: input.deps,
    action: 'purge',
    ids: input.ids,
    presentation: {
      dismissUndo: dismissUndoNotice,
      forgetTrashDetails: input.forgetTrashDetails,
    },
    gate: input.gate,
    refresh: input.refreshAfterWrite,
  })
}
