/**
 * 逐条 `/apply` 的**写入链一个家**：一次写入发生在哪个界面位置，就在哪个座位里绑定呈现材质、闸与
 * 重读通道——座位只拥有「这次是谁在写、交哪些材质、闸在哪」；六个座位共用同一条生命周期
 * （apply → 解信封 → `readReceipt` → 回执摘要 → settlement → refresh）与按 action 的收尾顺序，
 * `runWrite` / `settleWrite` 是模块私有，调用方只见座位与 `GateRun`（收尾一个家是 ADR-0013 的裁决，
 * 闸落地面的形状是 ADR-0056 的裁决）。面板的重读策略住 `use-trash-query.ts`；清空回收站是聚合回执
 * （`/empty`），收尾仍住 `use-trash-query.ts` 的 `emptyTrash`。
 *
 * 生命周期五条判据：
 * - `ok` 只说**信封**成不成；逐条成败在 `failures` 里，调用方自己决定怎么上屏。
 * - 顶层失败把同一句原文铺到每个 id，不结算；`refresh` 照样交（成败都在 outcome 里）。
 * - **信封成功就结算**（逐条全失败也跑：批量写入的失效通告不能漏）；`anySuccess` 与落地名单由
 *   `receipt.ts` 的回执摘要算好，settlement 按它上闸。调用方只交呈现材质，再按 `outcome` 决定是否
 *   真的重读。结算在 `refresh` 之前：列表重读看得到收尾后的现场。
 * - `single: true` 时把 N=1 模式交给 `receipt.ts` 的读法；单条 null 在那一处折成 failed，
 *   这里不再重复守卫。
 * - **闸包住整趟**：给了 `gate` 就把 apply → settle → refresh 一起包进去——refresh 落在闸外时，
 *   旧清单还在屏上，同一个动作能被再点一次；调用方不再自己 `around`。同一枚闸已有任务在飞时
 *   这一趟**不跑**（连点不发第二条），交回 `{ kind: 'blocked' }`：座位照它收「这一趟没跑」，
 *   不伪造 outcome。
 *
 * 收尾四条判据（`settleWrite`，按 action 各一条固定序列；为什么按 action 收成一处见 ADR-0013）：
 * - **跨槽位在信封成功时就跑**：`afterDelete` / `afterRestore` 与 `invalidate` 不管逐条成败都跑
 *   （回滚失败可能留下半套，回收站清单不能继续摆旧行）；呈现钩子（发布 / 熄灭撤销、遗忘主视图、
 *   清详情账本）只在至少一条落地（`anySuccess`）时跑——没有落点的撤销是假动作。delete 的撤销
 *   另要求落地名单非空：全部被同批前一条带走时没有可撤销的条目。
 * - **面板恢复用 `panelSeat: true` 明说**（「缺席」不再承载语义）：外部恢复（撤销横幅）由 settlement
 *   调 `afterRestore` 重开；面板恢复自带「回来」的结算，只 `forgetMainView`、不重开、不抢焦点。
 *   判据住 `src/client/main-view.ts` 的 `forgetMainView`。
 * - **撤销名单由摘要给、座位发布**：delete 支从 `summary.landedIds`（域是条目 id）取名单、用
 *   `summary.successIds.length` 作条数，组成 `{ entryIds, n }` 交给座位，座位只决定发布哪一形
 *   （单条带标题、批量带条数）——那句文案与它的键住 `undo-toast.tsx` 与 `copy.ts`；purge 支在
 *   `anySuccess` 时熄灭指向这些条目的横幅——留着就是一条注定失败的「撤销」。
 * - **`count` / `orphan-clean` 不是座位**：它们不进 `SeatedAction`（写入链的类型只收四个座位动作），
 *   各自走 `applyOne` 与维护卡；`unarchive` 没有跨槽位收尾（归档档的清单重读归调用方的 `refresh`，
 *   失效链住 `archive-store`）。
 *   不直接读 DOM、不问宿主：主视图收尾只经 `main-view.ts` 的 `afterDelete` / `afterRestore`
 *   （服务缺席或抛错都静默退回）；重读仍归各调用方的 `refresh`（面板那侧的最新票在
 *   `use-trash-query.ts`）。
 *
 * 边界：不自己判读回执（verdict 判读住 `receipt.ts`，失败表怎么上屏归各写入面——撤销那一趟的
 * 横幅改写住 `restoreFromUndo`）、不拥有各面的本地状态；面板座位的闸由面板传入，
 * 不另造第二枚；闸挡回来的那一趟**什么都不落地**——座位交回 blocked，不伪造 outcome，
 * 收尾留给在飞的那一趟。
 * 无主子会话清理**不是**座位：它只在插件设置页的维护卡里手动触发（ADR-0021），
 * 读数、闸与重查都归 `use-maintenance.ts`。
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

/** 有座位的动作：写入链只服务这四支。`count` / `orphan-clean` 走各自的读 / 维护路径，不经过座位与
 *  settlement；新增动作默认落进这里（`Exclude` 只列不结算的两支），`WritePresentationByAction` 与
 *  `settleWrite` 的穷尽闸会编译错直到补上它的收尾。 */
export type SeatedAction = Exclude<ApplyAction, 'count' | 'orphan-clean'>

/** 一次写入结局的成功支：渲染无关的事实（`SettledFacts`）加逐条失败表。 */
export type WriteSuccess<A extends SeatedAction> = SettledFacts<A> & {
  readonly ok: true
  /** 逐条失败原文（failed / neutral / missing），按 id。这是失败表的**唯一落点**：
   *  摘要只带聚合与落地 id，不再复制一份逐条原文。 */
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
    presentation: { invalidate: invalidateTrash, writeSucceeded },
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
  writeSucceeded: (ids: readonly string[]) => void
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
      writeSucceeded: input.writeSucceeded,
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
      writeSucceeded: input.writeSucceeded,
    },
    gate: input.gate,
    refresh: input.refreshAfterWrite,
  })
}

/** 解除归档座位（归档档的自救动作，无确认框——幂等、无撤销座位）：与面板座位同一条，
 *  闸被占着时交回 `{kind:'blocked'}`，这一趟不改任何界面后果。
 *  它没有跨槽位收尾：归档清单的重读归调用方的 `refresh`（自救动作只戳失效台、不直呼 reload，
 *  失效链住 `archive-store`）；行失败原文归面板自己的行失败表——座位只交 outcome，不碰面板的本地状态。 */
export function unarchiveFromArchiveTab(input: {
  deps: OneShotDeps
  ids: readonly string[]
  gate: BusyGate
  refresh: (outcome: WriteOutcome<'unarchive'>) => void | Promise<void>
}): Promise<GateRun<WriteOutcome<'unarchive'>>> {
  return runWrite({
    deps: input.deps,
    action: 'unarchive',
    ids: input.ids,
    presentation: noPresentation('unarchive'),
    gate: input.gate,
    refresh: input.refresh,
  })
}

/* ── 模块私有：一次写入的生命周期与按 action 的收尾顺序（判据在文件头） ────────────── */

/** 一次写入里与渲染无关的那部分：动作、请求 id、以及唯一的那份回执摘要。 */
interface SettledFacts<A extends SeatedAction> {
  readonly action: A
  readonly ids: readonly string[]
  readonly summary: ReceiptSummary
}

/**
 * 按 action 切开的一族呈现材质：每个座位只能拿到自己动作那几手，形状对不上的钩子在类型面就不存在。
 * - `delete` 的 `publishUndo` 存在即「这个座位要发撤销横幅」；它拿到的是 settlement 从摘要取出并组好的落地名单。
 * - `restore` 的 `panelSeat: true` 才是「面板已替这条完成『回来』的结算」，不再靠缺席某个钩子暗示。
 * - `unarchive` 没有呈现材质（用 `noPresentation`）；`count` / `orphan-clean` 不在座位动作里。
 * 钩子都是同步的：settlement 在 `refresh` 前一次跑完，不 await。
 */
type WritePresentationByAction = {
  delete: {
    /** 外部写入座位：让回收站面板重读。面板写不传（自己的清单重读 `reload` 不走这条通告）。 */
    invalidate?(): void
    /** 撤销发布：settlement 从回执摘要取出落地条目 id 与请求名单、组好形之后交来；名单**非空**——
     *  全被同批前一条带走时没有落点，settlement 不发布没有可撤销动作的横幅。座位只决定发布哪一形
     *  与那一形带的标题。`archived` = 落地条目里有已归档会话（撤销回「归档」，文案据此改口）。 */
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
      // `success.action` 已是判别式，但 TS 不会顺着它把 type 参数一起收窄；三支各做一次具名窄化。
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
        // 永久删除也让指向这些条目的撤销横幅熄灭：留着就是一条注定失败的「撤销」。
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
  /** 信封成功时交给 settlement 的呈现材质（摘要里的成功名单可能为空）；按 action 的收尾顺序住本模块的 `settleWrite`。 */
  readonly presentation?: WritePresentation<A>
  /** 这一趟的闸：给了就把 apply → settle → refresh 整趟包进 busy。refresh 不许落在闸外。 */
  readonly gate?: BusyGate
  /** 写完（顶层失败或信封成功，无论逐条成败）后的重读策略；成败与 `anySuccess` 都在 outcome 里，
   *  是否真的重读由调用方决定。 */
  readonly refresh?: (outcome: WriteOutcome<A>) => void | Promise<void>
}

/** 签名上的分岔就是判据：**没传闸 ⇒ 这一趟一定跑**，回真结果；**传了闸 ⇒ 可能被同一枚闸的在飞那一趟
 *  挡回**，那时这一趟什么都没做、回 `{ kind: 'blocked' }`。`runWrite` 不替调用方编造成果——挡回来的
 *  那趟怎么收尾归座位与界面（判据住 `busy-gate.ts`）。第二支把 `gate` 钉成 `undefined`：
 *  `BusyGate | undefined` 这类"可能真有闸"的输入不许落到「一定跑完」那一支，否则类型会把挡回漏成
 *  `WriteOutcome`。 */
function runWrite<A extends SeatedAction>(input: WriteInput<A> & { readonly gate: BusyGate }): Promise<GateRun<WriteOutcome<A>>>
function runWrite<A extends SeatedAction>(input: WriteInput<A> & { readonly gate?: undefined }): Promise<WriteOutcome<A>>
async function runWrite<A extends SeatedAction>(input: WriteInput<A>): Promise<GateRun<WriteOutcome<A>> | WriteOutcome<A>> {
  const lifecycle = async (): Promise<WriteOutcome<A>> => {
    const ids = [...new Set(input.ids)]
    const outcome = await input.deps.applyOutcomes(input.action, ids)

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
