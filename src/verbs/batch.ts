/**
 * 「这一批」的唯一实现（ADR-0002）：POST /apply 的落点——一组 id 上的同一个动作。批量是请求的性质，
 * 不是单个动词的性质：这里拥有去重保序、逐条信封（失败不传染，按 map-error 折成错误对象）、恢复通告攒到批尾一次发。
 * 「已被同批前一条带走」是幂等成功（delete/restore 回 null，purge 回 0），判据住 `groups.ts`；
 * 同批已带走集：delete / restore 住 `batch-carried.ts`，purge 那份由清册作用域持有。
 *
 * **批执行形态**（ADR-0070）：预裁决（输入序）→ 波次 1 有界并发（`BATCH_RUN_CONCURRENCY`，组内串行不动）
 * → 第二波串行补跑（实况为准）→ 信封按输入序落位。预判只管调度——载体真带走了回幂等支，没带走就补跑，
 * 预测错了只是调度白排，不改任何一条信封。
 */
import { toRemoteFailure } from '../remote/map-error.js'
import { bareSessionId } from '../domain/closure.js'
import { FAILURE_DETAILS_ATTACHMENTS_KEY, isApplyOutcomeOf, type ApplyAction, type ApplyOutcome, type ApplyValueByAction, type AttachmentCleanupWire } from '../shared/wire.js'
import type { CoreDeps, DeleteDeps, DeleteSessionDeps, RemovalDeps } from '../deps.js'
import { parseEntryId, sessionDirForId, trashDirOf, type TrashEntry } from '../trash/entry.js'
import { groupOf, type GroupClaim } from '../trash/groups.js'
import { mapLimit } from '../trash/session-rows.js'
import { planBatchImageAttachmentRemoval, unreadableCandidatesReason, unreadableObjectsReason, type BatchAttachmentGroup, type BatchAttachmentPlan } from '../trash/attachments.js'
import { createEntryCarried, createSessionCarried, preAdjudicateSession } from './batch-carried.js'
import { deleteSession } from './delete-session.js'
import { trashEmpty, verbError } from '../errors.js'
import { loadOrphanGroups, planOrphanGroup, runOrphanGroup, type OrphanGroup } from './orphan-subagents.js'
import {
  executeAttachmentTail,
  executeRemoval,
  planTrashRemoval,
  plannedAttachmentDirs,
  type AttachmentTailResult,
  type RemovalPlan,
  type RemovalStats,
} from './permanent-removal.js'
import { restoreSession } from './restore-session.js'
import { createTrashScope, type TrashScope } from './trash-scope.js'
import { writeProgress } from './write-progress.js'

/** 信封装配即验的唯一出口：按动作收窄走 `isApplyOutcomeOf`（`Extract` 那格是条件类型，泛型装配的
 *  字面量 TS 证不过它），装配处不留窄化断言；验不过是装配 bug，响亮抛。 */
function assembleOutcome<A extends ApplyAction>(outcome: unknown, action: A, id: string): Extract<ApplyOutcome, { action: A }> {
  if (!isApplyOutcomeOf(outcome, action)) throw verbError('io', `信封装配不合形：${id}`)
  return outcome
}

function failure<A extends ApplyAction>(
  id: string,
  action: A,
  error: unknown,
  attachments?: AttachmentCleanupWire,
): Extract<ApplyOutcome, { action: A }> {
  const remote = toRemoteFailure(error)
  return assembleOutcome({
    id,
    action,
    ok: false,
    // 失败条自己的附件读数挂 `details.attachments`（与成功回执同格、同 schema，键名住 wire 的常量）：
    // 原有 details 键保留（孤儿清理的部分回执住那几格），只加不替。
    error: attachments === undefined ? remote : { ...remote, details: { ...remote.details, [FAILURE_DETAILS_ATTACHMENTS_KEY]: attachments } },
  }, action, id)
}

/** 按动作收窄的成功支（判别联合要的是**字面量**）。 */
function success<A extends ApplyAction>(id: string, action: A, value: ApplyValueByAction[A]): Extract<ApplyOutcome, { action: A }> {
  return assembleOutcome({ id, action, ok: true, value }, action, id)
}

/** 去重且保持输入顺序（重复 id 跑第二遍是"幂等成功"的伪装，不该发生）。 */
function unique(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * 一条 id 一条结果的单条循环（`unarchive` 用）：动词只收一个 id、只吐一条结果；`try/catch` 在这一处，
 * 失败不传染下一条。波次驱动的收口槽是同一条单条语义的并发形（claim → 跑或 carried、失败不传染、每条 tick 一次）。
 */
async function forEachId<A extends ApplyAction>(
  action: A,
  ids: readonly string[],
  run: (id: string) => Promise<ApplyValueByAction[A]>,
): Promise<ApplyOutcome[]> {
  const outcomes: ApplyOutcome[] = []
  for (const id of unique(ids)) {
    try {
      outcomes.push(success(id, action, await run(id)))
    } catch (error) {
      outcomes.push(failure(id, action, error))
    } finally {
      // 每条（含失败条）结尾 tick 一次：done 与「已处理条数」同义，不是「成功条数」。
      writeProgress.advance()
    }
  }
  return outcomes
}

/** 波次 1 的批内有界并发（`batch.ts` 自己的旋钮，仿 `VISIBLE_MEASURE_CONCURRENCY` 的注释口径）：同一批里
 *  同时在跑的条目上限。**组内串行不动**：实况会碰同一处的一组条目串成一条组按输入序串行跑（双搬红线不许赌
 *  预测对），互不相交的组之间才放开并发。 */
const BATCH_RUN_CONCURRENCY = 4

/**
 * 波次 1 的调度单元：`keysOf` 交出这条实况会碰的点（delete 是语料闭包的裸会话 id，purge / orphan-clean 是
 * 计划会删的目录）。碰同一点的条目并成一条「组」（连通分量），**组内保持输入序**——组内与单条串行执行同语义、
 * 一格不动；组与组之间由 {@link runWave} 有界并发。
 */
function chainsOf<T>(items: readonly T[], keysOf: (item: T) => readonly string[]): T[][] {
  // 并查集归连通分量；归堆按输入序，链内顺序即输入序。
  const parent = items.map((_, index) => index)
  const find = (index: number): number => {
    const up = parent[index] ?? index
    if (up === index) return index
    const root = find(up)
    parent[index] = root
    return root
  }
  const byKey = new Map<string, number>()
  items.forEach((item, index) => {
    for (const key of keysOf(item)) {
      const seen = byKey.get(key)
      if (seen === undefined) {
        byKey.set(key, index)
        continue
      }
      const a = find(index)
      const b = find(seen)
      if (a !== b) parent[a] = b
    }
  })
  const chains: T[][] = []
  const slot = new Map<number, number>()
  items.forEach((item, index) => {
    const root = find(index)
    let at = slot.get(root)
    if (at === undefined) {
      at = chains.length
      slot.set(root, at)
      chains.push([])
    }
    chains[at]?.push(item)
  })
  return chains
}

/** 波次 1：组与组之间有界并发（`BATCH_RUN_CONCURRENCY`）、组内按输入序串行；`settle` 自己收口（含失败条 tick）。 */
async function runWave<T>(chains: readonly (readonly T[])[], settle: (item: T) => Promise<void>): Promise<void> {
  await mapLimit(chains, BATCH_RUN_CONCURRENCY, async (chain) => {
    for (const item of chain) await settle(item)
  })
}

/** delete / restore 的 per-id 收口槽（回执合成前的中间形）：carried 幂等 null、failed 带原始错误、done 带
 *  这一条自己的清册行（restore 另带这一组的会话 id 供批尾通告；delete 不用那一格）。 */
type EntrySlot =
  | { readonly kind: 'carried' }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'done'; readonly entry: TrashEntry; readonly sessionIds: readonly string[] }

/** delete / restore 的逐条信封合成（输入序）：carried 回幂等 null、失败折错误对象、成功带清册行。 */
function entryReceipts(
  action: 'delete' | 'restore',
  ids: readonly string[],
  slots: ReadonlyMap<number, EntrySlot>,
): ApplyOutcome[] {
  return ids.map((id, index): ApplyOutcome => {
    const slot = slots.get(index)
    if (slot === undefined) return failure(id, action, verbError('io', `批执行没有落定：${id}`))
    if (slot.kind === 'failed') return failure(id, action, slot.error)
    return success(id, action, slot.kind === 'carried' ? null : slot.entry)
  })
}

/** 批级一次实况读的产物：预测搬走组（预裁决表吃）+ 语料闭包（波次 1 的组判据吃）。 */
interface SessionGroupScan {
  readonly moved: ReadonlyMap<string, readonly string[]>
  readonly raw: ReadonlyMap<string, readonly string[]>
}

/** 批级实况读缺席（语料看不见 / 真读失败）时的组判据：人人同一个键 ⇒ 整批退成一条组（串行）。 */
const SERIAL_CHAIN_KEY = '批级实况读缺席'

/** 盘上在场探测的有界并发（仿 `VISIBLE_MEASURE_CONCURRENCY` 的口径：批量口一次可能上千个 kid，
 *  同样走有界预算），预读不无界放飞。 */
const PRESENCE_PROBE_CONCURRENCY = 8

/**
 * 批开始**一次** `subagentMembersOf`（它本来就是批量口）+ 盘上在场预测组：预测「这条跑起来会一起搬走谁」。
 * `moved` = 自己 + 盘上在场的孩子（会被一起搬走的成员）；`raw` = 去重前的语料闭包（**含盘上缺席的孩子**）
 * ——执行期才出现的子目录也在同一组里，同组必须串行，双搬红线不许赌预测对。
 * **预判只管调度**：真搬走谁以动词自己的实况读为准（动词 interface 不动、仍自己读实况），第二波按
 * `movedSessionIds` 裁决。语料缺席 / 真读失败不整批炸（逐条失败不传染），也不拿不成立的预测排并发：
 * 退回**人人同组的串行批**——预测没了，串行兜住不双搬，语义与单条依次执行一格不动；读失败照旧由各自动词
 * 在自己那条里再问一遍、折进自己的信封。
 */
async function scanSessionGroups(deps: CoreDeps, wanted: readonly string[]): Promise<SessionGroupScan> {
  const serial = (): SessionGroupScan => ({
    moved: new Map(wanted.map((id) => [id, [id] as readonly string[]])),
    raw: new Map(wanted.map((id) => [id, [SERIAL_CHAIN_KEY] as readonly string[]])),
  })
  let read: Awaited<ReturnType<CoreDeps['host']['subagentMembersOf']>>
  try {
    read = await deps.host.subagentMembersOf(wanted)
  } catch {
    return serial()
  }
  // 语料看不见：动词也只会删父（写侧只许降级），预测同样只认自己；实况可能与预测不符 ⇒ 串行兜底。
  if (!read.available) return serial()
  const moved = new Map<string, string[]>()
  const raw = new Map<string, readonly string[]>()
  for (const id of wanted) {
    const kids = read.value[id] ?? []
    raw.set(id, [id, ...kids.map((kid) => kid.sessionId)])
    moved.set(id, [id])
  }
  // 盘上在场探测只为预测服务：探测本身出错按「在场」收（宁可多算进预测组，第二波按实况裁决兜底）。
  // 探测全批一趟有界并发（`PRESENCE_PROBE_CONCURRENCY`），不逐 kid 串行放大预读；结果按 index 落位（`mapLimit`）。
  const probes = await mapLimit(
    wanted.flatMap((id) => (read.value[id] ?? []).map((kid) => ({ id, kid }))),
    PRESENCE_PROBE_CONCURRENCY,
    async ({ id, kid }) => {
      try {
        return {
          id,
          sessionId: kid.sessionId,
          present: await deps.fs.exists(sessionDirForId(kid.projectDir, kid.sessionId, deps.home)),
        }
      } catch {
        return { id, sessionId: kid.sessionId, present: true }
      }
    },
  )
  for (const probe of probes) {
    if (probe.present) moved.get(probe.id)?.push(probe.sessionId)
  }
  return { moved, raw }
}

async function applyDelete(deps: DeleteSessionDeps, ids: readonly string[]): Promise<ApplyOutcome[]> {
  const wanted = unique(ids)
  // 预裁决（输入序）：carried 挂不挂先落表（预判只管调度），实况为准在动词与第二波。
  const scan = await scanSessionGroups(deps, wanted)
  const table = preAdjudicateSession(wanted, scan.moved)
  // 同批父先被删时孩子跟着父一起搬走，后到的孩子 id 是一次幂等 no-op；名单由动词结果长出（这次真的搬走的整组），删完不再读清册。
  const carried = createSessionCarried()
  const run = deleteSession(deps)
  const slots = new Map<number, EntrySlot>()
  const settle = async (index: number, id: string) => {
    try {
      // 单条语义照旧：先过同批已带走集——被更早的载体带走 ⇒ 幂等 null，不许变报错。
      if (carried.claim(id).verdict === 'carried') {
        slots.set(index, { kind: 'carried' })
        return
      }
      const { entry, movedSessionIds } = await run(id)
      for (const movedId of movedSessionIds) carried.take(movedId)
      slots.set(index, { kind: 'done', entry, sessionIds: [] })
    } catch (error) {
      slots.set(index, { kind: 'failed', error })
    } finally {
      // 每完成一条（含失败条）tick 一次：done 与「已处理条数」同义。
      writeProgress.advance()
    }
  }
  // 波次 1：预测 fresh 的条目有界并发跑；语料闭包撞车的条目同组串行（组内串行不动）。
  const wave1 = wanted.flatMap((id, index) => (table[index]?.verdict === 'fresh' ? [{ id, index }] : []))
  await runWave(
    chainsOf(wave1, ({ id }) => (scan.raw.get(id) ?? [id]).map(bareSessionId)),
    (item) => settle(item.index, item.id),
  )
  // 第二波（实况为准）：预判 carried 的 id 输入序串行补跑——settle 里的 claim 判「载体真的带走了吗」。
  for (const [index, id] of wanted.entries()) {
    if (table[index]?.verdict === 'carried') await settle(index, id)
  }
  return entryReceipts('delete', wanted, slots)
}

/** restore 的同批判据与视图收缩归 `batch-carried.ts`（purge 那一半归 `trash-scope.ts`）；`apply` 整批只读一次清册。 */
async function applyRestore(deps: CoreDeps, ids: readonly string[]): Promise<ApplyOutcome[]> {
  const wanted = unique(ids)
  // 整批一次清册读（"最初的样子"）+ 一份会收缩的同批已带走集；通告攒到批尾，一次发整组 id。
  const carried = createEntryCarried(await deps.ledger.list())
  const table = carried.claimAll(wanted)
  const run = restoreSession(deps)
  const slots = new Map<number, EntrySlot>()
  const settle = async (index: number, id: string, claim: GroupClaim) => {
    try {
      // 一条的裁决形：carried ⇒ 幂等 null；fresh ⇒ 拿这一组补跑；`absent`（幽灵 id）没有组：递空组，
      // 动词照样抛 trash-empty（原文只在动词一处）。
      if (claim.verdict === 'carried') {
        slots.set(index, { kind: 'carried' })
        return
      }
      const group = claim.verdict === 'fresh' ? claim.group : []
      const entry = await run(id, group)
      carried.takeRows(group.map((row) => row.id))
      // 通告的是**这一组的会话 id**（父 + 跟着它回来的孩子）
      slots.set(index, { kind: 'done', entry, sessionIds: group.map((row) => row.sessionId) })
    } catch (error) {
      slots.set(index, { kind: 'failed', error })
    } finally {
      writeProgress.advance()
    }
  }
  // absent 的判形不依赖实况（原始快照里就认不出）：裁决即落定，照旧当场响亮报 trash-empty——挂起只属于要等实况的 carried。
  for (const [index, id] of wanted.entries()) {
    const claim = table[index]
    if (claim?.verdict === 'absent') await settle(index, id, claim)
  }
  // 波次 1：fresh 条目按批的**预裁决组**跑（组在裁决时定死，与依次逐条 claim 的演化同一份判据）；组判据是
  // 恢复目标目录——同一条会话被删两次又同批恢复时，同组串行。
  const wave1 = wanted.flatMap((id, index) => {
    const claim = table[index]
    return claim?.verdict === 'fresh' ? [{ id, index, claim }] : []
  })
  await runWave(
    chainsOf(wave1, ({ claim }) => {
      try {
        return claim.group.map((row) => parseEntryId(row.id).sessionDirName)
      } catch {
        // 坏 id 的组仍进逐条收口，由动词在自己的信封里报错；调度器不能替整批提前抛。
        return [SERIAL_CHAIN_KEY]
      }
    }),
    (item) => settle(item.index, item.id, item.claim),
  )
  // 第二波（实况为准）：预判 carried 的 id 输入序串行——按**当前视图**重裁：载体真的 take 了 ⇒ 幂等 null；
  // 没带走（载体失败/没搬它）⇒ 拿组补跑。
  for (const [index, id] of wanted.entries()) {
    const claim = table[index]
    if (claim?.verdict === 'carried') await settle(index, id, carried.claim(id))
  }
  // 通告名单按输入序合成（乱序完成不许让通告跟着乱）；恢复动作的收尾步（步骤级 tick）在批尾通告前报 finishing。
  const restored: string[] = []
  for (const [index] of wanted.entries()) {
    const slot = slots.get(index)
    if (slot?.kind === 'done') restored.push(...slot.sessionIds)
  }
  if (restored.length > 0) {
    writeProgress.step('finishing')
    await deps.presence.announceRestored(restored)
  }
  return entryReceipts('restore', wanted, slots)
}

/** per-id 收口槽（回执合成前的中间形）：carried 是幂等零回执，failed 带原始错误，done 带这一组自己的计划读数。 */
type IdSlot =
  | { readonly kind: 'carried' }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'done'; readonly stats: RemovalStats }

/** 收口槽 → 合成层的裁决面；没落定按 failed 算（`receiptsOf` 的兜底同口径）。 */
function verdictOf(slot: IdSlot | undefined): 'ok' | 'failed' | 'carried' {
  if (slot === undefined) return 'failed'
  if (slot.kind === 'done') return 'ok'
  return slot.kind === 'carried' ? 'carried' : 'failed'
}

/**
 * per-id 附件读数合成（批级尾 → 逐条信封的 `attachments` 格）：`byGroup` 按**组归属**（计划期先到先得）
 * 拆回各条——ok 支挂进自己的成功回执，失败支挂进自己 `error.details` 的同一格。对象读数不冒领别的条的
 * 回执；执行级「谁删了哪组目录」的第二本账本层不加，组归属就是这本账。carried 幂等支不带 `attachments`
 * （那一趟没有读数，缺席与 0 是两件事）。skipped 逐组归因——候选日志 / 对象 stat 的读不出只落**自己组**
 * 的载体（不串台），全批共享的两段（证明失败、执行期复核失败）落进过计划的组，没人进过计划时全挂
 * （skipped 原文是 fail-closed 的用户可见落点，丢了就是红线回归）。
 * ok 支没有读数也带零读数（与 carried 的缺席区分）；失败支没有信号不带（缺席与 0 是两件事）。
 * 组归属不变 ⇒ 批内各 id 的读数（成功回执 + 失败 details）相加 = 尾 `run` 的合计，客户端「按批相加」的归并不动。
 */
export function synthesizeAttachmentReadings(
  batch: BatchAttachmentPlan,
  tail: AttachmentTailResult,
  runs: readonly { readonly id: string; readonly verdict: 'ok' | 'failed' | 'carried' }[],
): Map<string, AttachmentCleanupWire> {
  type Slot = { removed: number; freedBytes: number; failed: number; skipped?: string }
  const out = new Map<string, Slot>()
  const slotOf = (id: string): Slot => {
    const found = out.get(id)
    if (found !== undefined) return found
    const own = tail.byGroupRun.get(id)
    const slot: Slot = { removed: own?.removed ?? 0, freedBytes: own?.freedBytes ?? 0, failed: own?.failed ?? 0 }
    out.set(id, slot)
    return slot
  }
  // ok 支一律带读数（零读数也带，与 carried 的缺席区分）；失败支只有真有信号才落 details。
  for (const run of runs) {
    if (run.verdict === 'ok' || (run.verdict === 'failed' && tail.byGroupRun.has(run.id))) slotOf(run.id)
  }
  const withObjects = runs.filter((run) => run.verdict !== 'carried' && (batch.byGroup.get(run.id)?.size ?? 0) > 0)
  const sharedTarget = new Set((withObjects.length > 0
    ? withObjects
    : runs.filter((run) => run.verdict !== 'carried')).map((run) => run.id))
  for (const run of runs) {
    if (run.verdict === 'carried') continue
    const parts: string[] = []
    const ownCandidates = batch.unreadableCandidatesByGroup.get(run.id) ?? 0
    if (ownCandidates > 0) parts.push(unreadableCandidatesReason(ownCandidates))
    const ownObjects = batch.unreadableObjectsByGroup.get(run.id) ?? 0
    if (ownObjects > 0) parts.push(unreadableObjectsReason(ownObjects))
    if (sharedTarget.has(run.id)) {
      if (batch.sharedSkipped !== undefined) parts.push(batch.sharedSkipped)
      if (tail.recheckSkipped !== undefined) parts.push(tail.recheckSkipped)
    }
    if (parts.length > 0) slotOf(run.id).skipped = parts.join('；')
  }
  return out
}

/** purge / orphan-clean 的逐条信封：成功支的值都是聚合回执（`PurgeStatsWire`），失败支带线上失败。 */
export type StatsOutcome = Extract<ApplyOutcome, { action: 'purge' | 'orphan-clean' }>

/** 逐条收口 → 信封（输入序）：失败折错误对象并挂自己那组的附件读数，carried 回幂等零，成功支挂合成读数。 */
function receiptsOf(
  action: 'purge' | 'orphan-clean',
  ids: readonly string[],
  slots: ReadonlyMap<number, IdSlot>,
  readings: ReadonlyMap<string, AttachmentCleanupWire>,
): StatsOutcome[] {
  return ids.map((id, index): StatsOutcome => {
    const slot = slots.get(index)
    const attachments = readings.get(id)
    if (slot === undefined) return failure(id, action, verbError('io', `批执行没有落定：${id}`), attachments)
    if (slot.kind === 'failed') return failure(id, action, slot.error, attachments)
    if (slot.kind === 'carried') return success(id, action, { removed: 0, freedBytes: 0 })
    return success(id, action, {
      removed: slot.stats.removed,
      freedBytes: slot.stats.freedBytes,
      ...(attachments === undefined ? {} : { attachments }),
    })
  })
}

/** purge 的批驱动（一次批一扫）：`claimAll` 预裁决 → 逐组计划（`'measuring'` tick 的唯一落点在 `planTrashRemoval`
 *  进门）→ `planBatchImageAttachmentRemoval` 一次扫描（吃各组的 `attachmentDirs`）→ 逐组 `runGroup`（成功才收缩）
 *  → 批尾 `executeAttachmentTail`（一次复核 + 删除，只带走真删掉的目录的独占副本）→ 合成 per-id 回执。
 *  逐条隔离照旧：计划失败与执行失败都只折进那一条的信封，不传染下一条；absent 照样响亮报 trash-empty
 *  （幂等只留给 carried）。条目级 tick 归这一层的 per-id 收口：每完成一条（含失败条）`advance()` 一次。 */
async function applyPurge(deps: RemovalDeps, ids: readonly string[]): Promise<ApplyOutcome[]> {
  const wanted = unique(ids)
  const rows = await deps.ledger.list()
  // 删的能力不在作用域手里（类型面也够不着 `removeDir`），按调用点注入执行器。
  const scope = createTrashScope(rows, (plan) => executeRemoval(deps, plan))
  return await runPurgeBatch(deps, scope, rows, wanted)
}

/** `applyPurge` 的批驱动核：`rows` 是整批只读一次的清册快照，`scope` 持同批收缩视图（多条共用一个作用域的
 *  用例也走它——作用域的 carried/收缩语义就是在这份视图上长出来的）。执行形态四步（ADR-0070）：
 *  预裁决（`claimAll`，absent 裁决即落定、carried 挂起）→ 逐组计划 → 一次批一扫 → 波次 1 有界并发
 *  （组内串行不动）→ 第二波串行补跑（实况为准）→ 批尾附件尾 → 合成 per-id 回执。 */
export async function runPurgeBatch(
  deps: RemovalDeps,
  scope: TrashScope,
  rows: readonly TrashEntry[],
  wanted: readonly string[],
): Promise<StatsOutcome[]> {
  const claims = scope.claimAll(wanted)
  const slots = new Map<number, IdSlot>()
  /** 槽位落定与条目 tick 的唯一闸：done 与「已处理条数」同义（含失败条），每处收口都走它。 */
  const closeSlot = (index: number, slot: IdSlot): void => {
    slots.set(index, slot)
    writeProgress.advance()
  }
  const prepared: Array<{ readonly index: number; readonly id: string; readonly plan: RemovalPlan }> = []
  for (const [index, claim] of claims.entries()) {
    if (claim.verdict === 'absent') {
      // absent 的判形不依赖实况（原始快照里就认不出）：裁决即落定，照旧当场响亮报 trash-empty。
      closeSlot(index, { kind: 'failed', error: trashEmpty(claim.id) })
      continue
    }
    if (claim.verdict === 'carried') continue // 挂起：第二波按实况裁决
    try {
      prepared.push({ index, id: claim.id, plan: await planTrashRemoval(deps, rows, claim.group) })
    } catch (error) {
      // 计划是执行前的第一道闸：闸拒了也只折进这一条（活体准入 `live` 就从这里出来），下一条照常。
      closeSlot(index, { kind: 'failed', error })
    }
  }
  // 一次批一扫的喂食：计划里各组的被删目录 + **挂起条目的原始组行目录与盘上残离子会话目录**——载体失败时
  // 挂起条目第二波会补跑并删这些目录，独占图片的候选必须在扫描面里（尾的复核以盘上为准：没删掉的目录，图片
  // 自动保留）。载体计划成功时它的 `attachmentDirs` 已经覆盖整组行目录，不必重读；只有覆盖不到（计划期被闸
  // 拒掉）才补一份只读扫面。行目录全覆盖即成员目录同覆盖：`groupOf` 的组是快照上的规范集，覆盖整组行目录的
  // 计划必是这一组自己的计划，进门时已把盘上残离子会话目录一并喂过（`plannedAttachmentDirs`）。同一目录被
  // 多组命中时对象单归属先到先得 ⇒ 共享后代归第一个声明者，批内相加不双计。
  const plannedDirs = new Set(prepared.flatMap((item) => item.plan.attachmentDirs))
  const carriedScan: BatchAttachmentGroup[] = []
  const seenGroups = new Set<string>()
  const incompleteGroups = new Set<string>()
  const groupKeyOf = (id: string): string => groupOf(rows, id).map((row) => row.id).sort().join('\u0000')
  for (const claim of claims) {
    if (claim.verdict !== 'carried') continue
    const group = groupOf(rows, claim.id)
    const groupKey = groupKeyOf(claim.id)
    if (seenGroups.has(groupKey)) continue
    if (group.every((row) => plannedDirs.has(trashDirOf(row.id, deps.home)))) continue
    seenGroups.add(groupKey)
    const planned = await plannedAttachmentDirs(deps, rows, group)
    carriedScan.push({ id: claim.id, dirs: planned.dirs })
    // 盘上后代读不出 ⇒ 这一组的第二波补跑不能删：它可能删掉没进过扫描面的目录，留下孤儿附件。
    if (!planned.complete) incompleteGroups.add(groupKey)
  }
  const scan: readonly BatchAttachmentGroup[] = [
    ...prepared.map((item) => ({ id: item.id, dirs: item.plan.attachmentDirs })),
    ...carriedScan,
  ]
  const batch = await planBatchImageAttachmentRemoval(deps, scan)
  const settle = async (index: number, plan: RemovalPlan) => {
    try {
      closeSlot(index, { kind: 'done', stats: await scope.runGroup(plan) })
    } catch (error) {
      closeSlot(index, { kind: 'failed', error })
    }
  }
  // 波次 1：fresh 条目有界并发跑；组判据是**计划会碰的目录与归档解锁的会话**——两条计划撞同一目录（共享后代）
  // 或同一 `sessionId`（目录均缺席但都要 unarchive）时同组串行，不拿并发去碰同一棵树或同一份归档状态。
  await runWave(
    chainsOf(prepared, (item) => [
      ...item.plan.attachmentDirs,
      ...item.plan.unarchive.map((sessionId) => `unarchive:${bareSessionId(sessionId)}`),
    ]),
    (item) => settle(item.index, item.plan),
  )
  // 第二波（实况为准）：预判 carried 的 id 输入序串行——执行视图已 take（载体成功）⇒ 幂等 `{0,0}`；
  // 没带走（载体失败/没搬它）⇒ 重新认领补跑（动态 carried 语义：claim → 跑或 carried）。
  for (const [index, claim] of claims.entries()) {
    if (claim.verdict !== 'carried') continue
    const again = scope.claimAll([claim.id])[0]
    if (again === undefined || again.verdict === 'carried') {
      closeSlot(index, { kind: 'carried' })
      continue
    }
    if (again.verdict === 'absent') {
      closeSlot(index, { kind: 'failed', error: trashEmpty(claim.id) })
      continue
    }
    // 扫描期读不出这一组的盘上后代 ⇒ 补跑会删掉没进过候选面的目录：宁可留着重试，也不留孤儿附件。
    if (incompleteGroups.has(groupKeyOf(claim.id))) {
      closeSlot(index, { kind: 'failed', error: verbError('io', `批级附件扫描读不出这一组的盘上后代：${claim.id}`) })
      continue
    }
    try {
      // 第二波的组从**当前视图**认领（载体没收缩它）；计划照 `planTrashRemoval` 的口径重做——`'measuring'`
      // tick 的唯一落点在它进门，不另写一份。扫描后新出现的目录没进过候选面，补跑必须 fail closed。
      const plan = await planTrashRemoval(deps, rows, again.group)
      const removalDirs = [
        ...plan.trash.filter((row) => row.present).map((row) => row.dir),
        ...plan.members.map((member) => member.dir),
      ]
      const unscanned = removalDirs.filter((dir) => !batch.presentDirs.has(dir))
      if (unscanned.length > 0) {
        throw verbError('io', `第二波删除目录未进入批级附件扫描面：${unscanned[0]}`)
      }
      await settle(index, plan)
    } catch (error) {
      closeSlot(index, { kind: 'failed', error })
    }
  }
  const tail = await executeAttachmentTail(deps, batch)
  const readings = synthesizeAttachmentReadings(
    batch,
    tail,
    wanted.map((id, index) => ({ id, verdict: verdictOf(slots.get(index)) })),
  )
  return receiptsOf('purge', wanted, slots, readings)
}

/** 批量已选清单的子会话计数：一次问完整批（`subagentMembersOf` 本来就是批量口）。
 *  宿主口缺席按 0；真读失败则整次调用失败，浏览器半按"读不到"把整句不说。**父+子同批时逐条相加会
 *  重复计子根**（预裁决放开了「请求根可被父根发现」，ADR-0070 边界）——这是显示级读数、不是信封，
 *  且界面选择只发可见根行，不为此加去重层。 */
async function applyCount(deps: CoreDeps, ids: readonly string[]): Promise<ApplyOutcome[]> {
  const wanted = unique(ids)
  const read = await deps.host.subagentMembersOf(wanted)
  return wanted.map(id => success(id, 'count', read.available ? (read.value[id]?.length ?? 0) : 0))
}

/**
 * 解除归档（归档档的显式动作，不是移入回收站/恢复的副作用，ADR-0008 不翻案）：逐 id 调宿主 `unarchiveSession`
 * （未归档是幂等 no-op）；成功值固定 `1`——「这条 id 被处理成功」，不是实际状态变化数（宿主不为此多读一次 `isArchived`）。
 */
async function applyUnarchive(deps: CoreDeps, ids: readonly string[]): Promise<ApplyOutcome[]> {
  return forEachId('unarchive', ids, async (sessionId) => {
    await deps.host.unarchive(sessionId)
    return 1
  })
}

/**
 * 清一批无主子会话（父已被彻底删掉、孩子还留在 `sessions/` 里的那些）。id 是**根会话 id**；`not-found` 说的是
 * "这句话已经过期了"（父又回了回收站、组已被上一个请求带走），不是用户打错 id；根 id 两边都去 `session-` 前缀再比。
 *
 * **写动作，排在到达序链上**，而且**先对账再扫**：交给 `loadOrphanGroups` 的必须是 `ledger.list()` 对账后的行——
 * 刚被手工搬进 `session-trash/` 的目录此刻可能还没有行，拿 raw 索引扫就会把"父还在回收站里等着"的一组当成孤儿**直接删盘**。
 *
 * 批驱动与 purge 同构（一次批一扫）：逐组计划 → 一次扫描 → 逐组执行 → 批尾 → 合成 per-id 回执；无主子会话与清册
 * 收缩无关，不经过清册作用域。组内没有回收站这一层可退：live 准入在任何写之前（整组拒绝、零副作用）；删到一半
 * 失败不回滚，`details` 带 `{ removed, freedBytes }` 作部分回执，不伪装成"整组清完了"。
 */
async function applyOrphanClean(deps: RemovalDeps, ids: readonly string[]): Promise<ApplyOutcome[]> {
  const wanted = unique(ids)
  // 对账交回的行直接给扫描，不再读第二遍 raw 索引；语料面缺席时这一句抛 `io` ⇒ 整次调用失败，不回"零条"的假回执。
  const groups = await loadOrphanGroups(deps, await deps.ledger.list(), wanted)
  return await runOrphanBatch(deps, groups, wanted)
}

/** `applyOrphanClean` 的批驱动核：`groups` 是扫描交回的组（按根 id 归堆），与 purge 的批驱动同构——
 *  按 `bareSessionId` 对同批异形同根（`abc` 与 `session-abc`）做输入序预裁决：首个进波次 1 有界并发（组判据是
 *  计划会碰的目录与归档解锁会话），同根后来者挂第二波（载体成功回幂等 `{0,0}`，载体失败则重新计划补跑）。 */
export async function runOrphanBatch(
  deps: RemovalDeps,
  groups: readonly OrphanGroup[],
  wanted: readonly string[],
): Promise<StatsOutcome[]> {
  const byRoot = new Map(groups.map((group) => [bareSessionId(group.root.sessionId), group]))
  const slots = new Map<number, IdSlot>()
  /** 槽位落定与条目 tick 的唯一闸（与 `runPurgeBatch` 同口径）：每处收口都走它。 */
  const closeSlot = (index: number, slot: IdSlot): void => {
    slots.set(index, slot)
    writeProgress.advance()
  }
  const prepared: Array<{ readonly index: number; readonly id: string; readonly bare: string; readonly plan: RemovalPlan }> = []
  const deferred: Array<{ readonly index: number; readonly id: string; readonly bare: string; readonly group: OrphanGroup }> = []
  const seenRoots = new Set<string>()
  for (const [index, id] of wanted.entries()) {
    const bare = bareSessionId(id)
    const group = byRoot.get(bare)
    if (group === undefined) {
      closeSlot(index, { kind: 'failed', error: verbError('not-found', `不再是可清理的无主子会话：${id}`) })
      continue
    }
    if (seenRoots.has(bare)) {
      deferred.push({ index, id, bare, group })
      continue
    }
    seenRoots.add(bare)
    try {
      prepared.push({ index, id, bare, plan: await planOrphanGroup(deps, group) })
    } catch (error) {
      // 计划闸拒了也只折进这一条（活体准入 `live` 就从这里出来），下一条照常。
      closeSlot(index, { kind: 'failed', error })
    }
  }
  // 一次批一扫的喂食：计划里各组的被删目录 + **同根挂起条目**的成员目录——首条的计划被闸拒掉时它的计划不存在，
  // 挂起条目的补跑仍会删这些目录，独占图片的候选必须进扫描面（ADR-0070 决定 5；尾的复核以盘上为准：没删掉的
  // 目录，图片自动保留，多喂不会多删）。成员目录由组名单纯推导（`sessionDirForId`），没有读失败这一档 ⇒
  // 不必学 purge 的 incomplete 守卫；同根多条挂起只喂一份，对象单归属仍按组序先到先得。
  const scannedRoots = new Set(prepared.map((item) => item.bare))
  const scan: BatchAttachmentGroup[] = prepared.map((item) => ({ id: item.id, dirs: item.plan.attachmentDirs }))
  for (const item of deferred) {
    if (scannedRoots.has(item.bare)) continue
    scannedRoots.add(item.bare)
    scan.push({
      id: item.id,
      dirs: item.group.members.map((member) => sessionDirForId(member.projectDir, member.sessionId, deps.home)),
    })
  }
  const batch = await planBatchImageAttachmentRemoval(deps, scan)
  const succeededRoots = new Set<string>()
  await runWave(
    chainsOf(prepared, (item) => [
      ...item.plan.attachmentDirs,
      ...item.plan.unarchive.map((sessionId) => `unarchive:${bareSessionId(sessionId)}`),
    ]),
    async (item) => {
      try {
        closeSlot(item.index, { kind: 'done', stats: await runOrphanGroup(deps, item.plan) })
        succeededRoots.add(item.bare)
      } catch (error) {
        closeSlot(item.index, { kind: 'failed', error })
      }
    },
  )
  for (const item of deferred) {
    if (succeededRoots.has(item.bare)) {
      closeSlot(item.index, { kind: 'carried' })
      continue
    }
    try {
      const plan = await planOrphanGroup(deps, item.group)
      const unscanned = plan.attachmentDirs.filter((dir) => !batch.presentDirs.has(dir))
      if (unscanned.length > 0) {
        closeSlot(item.index, { kind: 'failed', error: verbError('io', `第二波删除目录未进入批级附件扫描面：${unscanned[0]}`) })
        continue
      }
      closeSlot(item.index, { kind: 'done', stats: await runOrphanGroup(deps, plan) })
      succeededRoots.add(item.bare)
    } catch (error) {
      closeSlot(item.index, { kind: 'failed', error })
    }
  }
  const tail = await executeAttachmentTail(deps, batch)
  const readings = synthesizeAttachmentReadings(
    batch,
    tail,
    wanted.map((id, index) => ({ id, verdict: verdictOf(slots.get(index)) })),
  )
  return receiptsOf('orphan-clean', wanted, slots, readings)
}

/**
 * `POST /apply` 的落点：进度记录的 begin/finish 包在**最外层**——一趟写一个 running 记录，成败都收尾
 * （失败面另有信封，进度不是第二本账）。`count` 是纯读、不出进度，直通不 begin；其余五个写动作
 * `total` = 去重后的请求 ids 数（各写动词也按去重后的名单执行，重复 id 不会让 k/N 追不上总数），条目级 tick
 * 归各自的 per-id 收口（delete / restore / purge / orphan-clean 走波次驱动的收口槽，unarchive 走
 * {@link forEachId}——每完成一条、含失败条 `advance()` 一次）。
 */
export async function applyActions(deps: DeleteDeps, action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]> {
  // 去重后才算身份与总数：各写动词都按 `unique(ids)` 执行，拿原始 ids 当 total 会让 k/N 永远追不上总数。
  const wanted = unique(ids)
  if (action === 'count') return await applyCount(deps, wanted)
  writeProgress.begin(action, wanted, wanted.length)
  try {
    switch (action) {
      case 'delete':
        return await applyDelete(deps, wanted)
      case 'restore':
        return await applyRestore(deps, wanted)
      case 'purge':
        return await applyPurge(deps, wanted)
      case 'orphan-clean':
        return await applyOrphanClean(deps, wanted)
      case 'unarchive':
        return await applyUnarchive(deps, wanted)
    }
  } finally {
    writeProgress.finish()
  }
}
