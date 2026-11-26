/**
 * 逐条 `/apply` 的写入链一个家：座位只拥有「这次是谁在写、交哪些材质、闸在哪」，六个座位共用同一条
 * 生命周期与**按 action 的收尾顺序**（收尾一个家是 ADR-0013，闸面是 ADR-0056）。面板重读与清空回收站
 * 的收尾住 `use-trash-query.ts`。闸包住整趟：给了 `gate` 就把 apply → settle → refresh 一起包进去——
 * refresh 落在闸外时旧清单还在屏上，同一个动作能被再点一次；被挡回的那趟什么都不落地，交回 blocked。
 */
import type { Translate } from './copy.js'
import type { BusyGate, GateRun } from './busy-gate.js'
import type { OneShotDeps, TrashEntryLike } from './remote.js'
import { readReceipt, summarizeReceipt, type ReceiptSummary } from './receipt.js'
import { afterDelete, afterRestore, forgetMainView } from './main-view.js'
import { invalidateTrash } from './trash-store.js'
import { writeSucceeded } from './trash-snapshot.js'
import {
  clearUndoNotice,
  dismissUndoNotice,
  failNotice,
  ownsNotice,
  publishUndoBatchNotice,
  publishUndoNotice,
  type UndoNotice,
} from './undo-notices.js'
import type { ApplyAction, RemoteFailure } from '../shared/wire.js'

/** 有座位的动作：写入链只服务这四支；新增动作默认落进这里，穷尽闸会编译错直到补上它的收尾。 */
export type SeatedAction = Exclude<ApplyAction, 'count' | 'orphan-clean'>

/** 一次写入结局的成功支：渲染无关的事实（`SettledFacts`）加逐条失败表。 */
export type WriteSuccess<A extends SeatedAction> = SettledFacts<A> & {
  readonly ok: true
  /** 逐条失败原文（failed / neutral / missing），按 id；失败表的唯一落点，摘要只带聚合与落地 id。 */
  readonly failures: ReadonlyMap<string, string>
}

/** 一次写入结局的顶层失败支：信封就没成，逐条无从判读。 */
export interface WriteFailure<A extends SeatedAction> {
  readonly ok: false
  readonly action: A
  readonly ids: readonly string[]
  readonly failure: RemoteFailure
  /** 顶层失败时同一句原文铺到每个请求 id。 */
  readonly failures: ReadonlyMap<string, string>
}

export type WriteOutcome<A extends SeatedAction = SeatedAction> = WriteSuccess<A> | WriteFailure<A>

/** 一次写入的逐条失败落点：座位负责「apply 前清旧原文、跑完按 id 铺回这一趟失败」；被挡回的那趟
 *  也清过旧原文，**blocked 的界面分支仍留调用方**（收不收框、动不动勾选是各面的呈现）。 */
export interface FailureSink {
  /** 进入动作时清掉这些 id 的旧失败原文（同一 id 去重保序后调用；被闸挡回也调用）。 */
  clear(ids: readonly string[]): void
  /** 这一趟的逐条失败表（信封成功或顶层失败都交；没有失败时是空 Map）。被挡回时不调用。 */
  set(failures: ReadonlyMap<string, string>): void
}

/** 一条待移入回收站的会话：宿主投影的会话 id + 移入回收站那一刻的显示名。请求现场、单条座位、批量选中集
 *  （`batch-selection-store.ts` 的 `PickItem`）与撤销横幅共用这组同行字段；`title` 只用于已选清单与
 *  撤销/失败原文，不参与请求。 */
export interface TrashMoveTarget {
  /** 宿主槽位投影的会话 id，原样透给 `/apply`（浏览器半不自己拼 id）。 */
  readonly sessionId: string
  /** 移入回收站那一刻的显示名（投影的 `displayTitle`）。 */
  readonly title: string
}

/** 会话行菜单的单条移入座位：一条会话、`single` 读法、成功发单条撤销横幅。`value` 是这条的失败原文，
 *  `null` = 跑了且无失败；调用方据此发布裸失败提示。 */
export async function deleteSessionFromMenu(
  deps: OneShotDeps,
  input: TrashMoveTarget & { failureSink?: FailureSink; refresh?: () => void | Promise<void> },
  gate: Pick<BusyGate, 'around'>,
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
    refresh: input.refresh,
    failureSink: input.failureSink,
  })
  // 挡回来的一趟不伪造「这条没有失败」：原样交回 blocked，界面后果归在飞那一趟。
  if (run.kind === 'blocked') return run
  return { kind: 'ran', value: run.value.failures.get(input.sessionId) ?? null }
}

/** 批量移入座位（多选浮条与归档档页脚共用）：撤销名单只收 ok 支的条目 id；被挡回时调用方
 *  不许照着它收缩名单——那会吞掉在飞那一趟的结果。 */
export async function deleteSessionsFromBatch(
  deps: OneShotDeps,
  ids: readonly string[],
  gate: Pick<BusyGate, 'around'>,
  failureSink?: FailureSink,
  refresh?: () => void | Promise<void>,
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
    refresh,
    failureSink,
  })
  return outcome.kind === 'blocked' ? outcome : { kind: 'ran', value: outcome.value.failures }
}

/** 外部恢复座位：闸在调用方，座位不传（双套会让外层 busy 提前落）；多条失败横幅要说清条数与去重
 *  原因（只显第一条会把其余折没）。座位**不传 `dismissUndo`**——部分失败的回滚会先熄灭横幅，随后
 *  `failNotice` 因 `ownsNotice` 落空而吞掉失败原文。 */
export async function restoreFromUndo(deps: OneShotDeps, notice: UndoNotice, t: Translate): Promise<void> {
  // 没有落点的撤销是假按钮：单条形拿不到条目 id 时早退（批量空名单由组件挡住）。
  const ids = notice.kind === 'one' ? [notice.entryId] : notice.entryIds
  if (notice.kind === 'one' && notice.entryId === '') return
  const outcome = await runWrite({
    deps,
    action: 'restore',
    ids,
    single: notice.kind === 'one',
    // 主视图重开归 settlement（外部恢复不带 panelSeat）；清单失效并按成功名单丢详情账本
    // （ADR-0048 决定 4：写成功即丢，不等清单重读——面板未挂载时也要丢）。
    presentation: { invalidate: invalidateTrash, writeSucceeded },
  })
  if (!outcome.ok) {
    failNotice(notice, outcome.failure.message)
    return
  }
  const failure = outcome.failures.values().next().value
  if (failure !== undefined) {
    // 信封成功 ≠ 每条都撤销成功：逐条失败时横幅要换失败原文，不能假装成功。
    failNotice(notice, outcome.failures.size > 1
      ? t('undo.failedBatch', {
        n: outcome.failures.size,
        reasons: [...new Set(outcome.failures.values())].join(' · '),
      })
      : failure)
    return
  }
  // 成功只收掉自己那条：期间发布的新移入回收站横幅不能被顺手清掉。
  if (ownsNotice(notice)) clearUndoNotice()
}

/** 面板两个 `/apply` 座位共用的那一半：依赖、条目 id、闸、重读与账本失效。 */
interface PanelWriteInput<A extends 'restore' | 'purge'> {
  deps: OneShotDeps
  ids: readonly string[]
  gate: BusyGate
  /** 属性声明：这两枚回调被摘下来交给 `runWrite`，实现不读 `this`。 */
  refreshAfterWrite: (outcome: WriteOutcome<A>) => Promise<void>
  writeSucceeded: (ids: readonly string[]) => void
  /** 逐条失败的落点（面板自己的行失败表）：清旧原文 / 铺这一趟的失败由座位执行。 */
  failureSink?: FailureSink
}

/** 面板恢复另要两样：单条读法，以及 already-gone 回执缺行时反查 sessionId 的当前清单。 */
interface PanelRestoreInput extends PanelWriteInput<'restore'> {
  single?: boolean
  entries: readonly TrashEntryLike[] | null
}

/** 面板恢复座位：面板已替这条完成「回来」的结算 ⇒ `panelSeat`；被闸占着时交回 blocked，
 *  面板照它什么都不改（连点不发第二条）。 */
export function restoreFromPanel(input: PanelRestoreInput): Promise<GateRun<WriteOutcome<'restore'>>> {
  return runWrite({
    deps: input.deps,
    action: 'restore',
    ids: input.ids,
    single: input.single,
    // already-gone 回执不带行，sessionId 只能从面板当前清单反查，取不到就跳过。
    sessionIdOfEntry: (entryId) => input.entries?.find((entry) => entry.id === entryId)?.sessionId,
    presentation: {
      panelSeat: true,
      dismissUndo: dismissUndoNotice,
      writeSucceeded: input.writeSucceeded,
    },
    gate: input.gate,
    refresh: input.refreshAfterWrite,
    failureSink: input.failureSink,
  })
}

/** 面板彻底删除座位：永久删除也让指向这些条目的撤销横幅熄灭（settlement 的 purge 支负责）。 */
export function purgeFromPanel(input: PanelWriteInput<'purge'>): Promise<GateRun<WriteOutcome<'purge'>>> {
  return runWrite({
    deps: input.deps,
    action: 'purge',
    ids: input.ids,
    presentation: {
      dismissUndo: dismissUndoNotice,
      writeSucceeded: input.writeSucceeded,
    },
    gate: input.gate,
    refresh: input.refreshAfterWrite,
    failureSink: input.failureSink,
  })
}

/** 解除归档座位（幂等、无撤销座位）：被闸占着时交回 blocked，这一趟不改任何界面后果。
 *  没有跨槽位收尾——归档清单重读归调用方的 `refresh`（只戳失效台，失效链住 `archive-store`）。 */
export function unarchiveFromArchiveTab(input: {
  deps: OneShotDeps
  ids: readonly string[]
  gate: BusyGate
  refresh: (outcome: WriteOutcome<'unarchive'>) => void | Promise<void>
  /** 逐条失败的落点（归档档自己的行失败表）：清旧原文 / 铺这一趟的失败由座位执行。 */
  failureSink?: FailureSink
}): Promise<GateRun<WriteOutcome<'unarchive'>>> {
  return runWrite({
    deps: input.deps,
    action: 'unarchive',
    ids: input.ids,
    presentation: noPresentation('unarchive'),
    gate: input.gate,
    refresh: input.refresh,
    failureSink: input.failureSink,
  })
}

/* ── 模块私有：一次写入的生命周期与按 action 的收尾顺序（判据在文件头） ────────────── */

/** 一次写入里与渲染无关的那部分：动作、请求 id、以及唯一的那份回执摘要。 */
interface SettledFacts<A extends SeatedAction> {
  readonly action: A
  readonly ids: readonly string[]
  readonly summary: ReceiptSummary
}

/** 按 action 切开的呈现材质：形状对不上的钩子在类型面就不存在；钩子都是同步的，settlement 在
 *  `refresh` 前一次跑完，不 await。 */
type WritePresentationByAction = {
  delete: {
    /** 外部写入座位：让回收站面板重读；面板写不传（自己的重读不走这条通告）。 */
    invalidate?(): void
    /** 撤销发布：名单**非空**（全被同批前一条带走时没有可撤销的横幅），座位只决定发布哪一形；
     *  `archived` = 落地条目里有已归档会话（撤销回「归档」）。 */
    publishUndo?(landed: { readonly entryIds: readonly [string, ...string[]]; readonly n: number; readonly archived: boolean }): void
  }
  restore: {
    invalidate?(): void
    /** 面板恢复座位：true = 面板已替这条完成「回来」的结算，只遗忘、不重开、不抢焦点。 */
    panelSeat?: true
    dismissUndo?(entryIds: readonly string[]): void
    writeSucceeded?(entryIds: readonly string[]): void
  }
  purge: {
    dismissUndo?(entryIds: readonly string[]): void
    writeSucceeded?(entryIds: readonly string[]): void
  }
  /** 解除归档：没有跨槽位收尾，归档档的清单重读归调用方的 `refresh`（失效链住 `archive-store`）。 */
  unarchive: Record<string, never>
}

type WritePresentation<A extends SeatedAction> = WritePresentationByAction[A]

const NO_PRESENTATION: WritePresentationByAction = {
  delete: {}, restore: {}, purge: {}, unarchive: {},
}

/** 没有呈现材质的座位用它：抛掉按 action 的联合，调用点不用各自造一个空对象字面量。 */
function noPresentation<A extends SeatedAction>(action: A): WritePresentation<A> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- 联合收窄：按 `A` 索引 `NO_PRESENTATION` 得到的是大联合，断言把它收敛到 `WritePresentation<A>`；删了调用点的材质钩子就不可赋值。
  return NO_PRESENTATION[action] as WritePresentation<A>
}

function settleWrite<A extends SeatedAction>(
  success: SettledFacts<A>,
  presentation: WritePresentation<A>,
): void {
  switch (success.action) {
    case 'delete': {
      // 判别式不收窄 type 参数：三支各做一次具名窄化。
      const seat = presentation as WritePresentationByAction['delete']
      afterDelete(success.summary.successIds)
      seat.invalidate?.()
      if (success.summary.anySuccess) {
        const [first, ...rest] = success.summary.landedIds
        // 全部被同批前一条带走时没有落点：不发布一条没有可撤销动作的横幅。
        if (first !== undefined) {
          const entryIds: [string, ...string[]] = [first, ...rest]
          seat.publishUndo?.({
            entryIds,
            n: success.summary.successIds.length,
            archived: success.summary.landedArchivedIds.length > 0,
          })
        }
      }
      return
    }
    case 'restore': {
      const seat = presentation as WritePresentationByAction['restore']
      // restore 的落地名单域是会话 id（回盘名单），与 delete 的条目 id 不混用。
      const restored = success.summary.landedIds
      if (seat.panelSeat !== true) afterRestore(restored)
      seat.invalidate?.()
      if (!success.summary.anySuccess) return
      seat.dismissUndo?.(success.summary.successIds)
      if (seat.panelSeat === true) forgetMainView(restored)
      seat.writeSucceeded?.(success.summary.successIds)
      return
    }
    case 'purge': {
      const seat = presentation as WritePresentationByAction['purge']
      if (success.summary.anySuccess) {
        // 留着就是一条注定失败的「撤销」。
        seat.dismissUndo?.(success.summary.successIds)
        seat.writeSucceeded?.(success.summary.successIds)
      }
      return
    }
    case 'unarchive':
      return
    default: {
      // 穷尽闸：`SeatedAction` 多出一个动作时，这里编译不过——新动作不许悄悄跳过 settlement。
      const _never: never = success.action
      return _never
    }
  }
}

/** 一次逐条 `/apply` 写入的输入面（模块私有）：座位交上来的就是这张表的自己那几格。 */
interface WriteInput<A extends SeatedAction> {
  readonly deps: OneShotDeps
  readonly action: A
  readonly ids: readonly string[]
  /** 单条写入面：把 N=1 模式交给 receipt 读法（null 折成协议错）。 */
  readonly single?: boolean | undefined
  /** restore 的 already-gone 回执不带行，它的 sessionId 只能由调用方从当前清单里查。 */
  readonly sessionIdOfEntry?: (entryId: string) => string | undefined
  /** 信封成功时交给 settlement 的呈现材质；按 action 的收尾顺序住本模块的 `settleWrite`。 */
  readonly presentation?: WritePresentation<A>
  /** 这一趟的闸：给了就把 apply → settle → refresh 整趟包进 busy。refresh 不许落在闸外。
   *  整趟只用得到 `around` 这一格，调用方不必为了过闸伪造整枚 `BusyGate`。 */
  readonly gate?: Pick<BusyGate, 'around'>
  /** 写完全程（无论成败）后的重读策略；是否真的重读由调用方决定。 */
  readonly refresh?: ((outcome: WriteOutcome<A>) => void | Promise<void>) | undefined
  /** 逐条失败的落点；不给 = 这一面没有行级失败要铺（外部撤销座位把失败写回横幅）。见 {@link FailureSink}。 */
  readonly failureSink?: FailureSink | undefined
}

/** 签名上的分岔就是判据：没传闸 ⇒ 这一趟一定跑；传了闸 ⇒ 可能被同一枚闸的在飞那一趟挡回，回
 *  blocked、什么都没做。第二支把 `gate` 钉成 `undefined`，否则类型会把挡回漏成 `WriteOutcome`。 */
function runWrite<A extends SeatedAction>(input: WriteInput<A> & { readonly gate: Pick<BusyGate, 'around'> }): Promise<GateRun<WriteOutcome<A>>>
function runWrite<A extends SeatedAction>(input: WriteInput<A> & { readonly gate?: undefined }): Promise<WriteOutcome<A>>
async function runWrite<A extends SeatedAction>(input: WriteInput<A>): Promise<GateRun<WriteOutcome<A>> | WriteOutcome<A>> {
  // 请求 id 去重保序在闸外一次算好：失败落点的 `clear` 也按这一份（被挡回也要清）。
  const ids = [...new Set(input.ids)]
  // `clear` 落在闸外——挡回来的一趟一次 /apply 都不发，旧原文照样作废；没跑就没有结论可铺，不 set。
  input.failureSink?.clear(ids)

  const lifecycle = async (): Promise<WriteOutcome<A>> => {
    const outcome = await input.deps.applyOutcomes(input.action, ids)

    if (!outcome.ok) {
      const failures = new Map(ids.map((id) => [id, outcome.failure.message] as const))
      const failed: WriteOutcome<A> = {
        ok: false, action: input.action, ids, failure: outcome.failure, failures,
      }
      await input.refresh?.(failed)
      // 顶层失败也是这一趟的结论：同一句原文按 id 铺回，时序与成功支一致（refresh 之后）。
      input.failureSink?.set(failures)
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
    input.failureSink?.set(failures)
    return success
  }

  // 闸包住整趟：refresh 也是这一趟的一部分——落在闸外，旧清单还在屏上时同一个动作能被再点一次。
  return input.gate === undefined ? lifecycle() : input.gate.around(lifecycle)
}
