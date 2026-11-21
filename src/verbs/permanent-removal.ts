/**
 * 永久删除的测量、计划与执行：先记录目录/字节/账本归属，再按计划动盘。计划函数只读；活体准入在计划阶段、任何写之前完成，
 * 执行器动第一笔写前再查一次（ADR-0027）。
 * 测量与补账本归属**分家**：`/list` 的只读计划只吃 `measureMembers`（零账本读）；`workspaceOf` 只有 purge / orphan-clean 的删除计划才付。
 */
import { sessionDirForId, trashDirOf, type TrashEntry } from '../trash/entry.js'
import type { TrashGroupView } from '../trash/groups.js'
import {
  executeImageAttachmentRemoval,
  isMissing,
  planImageAttachmentRemoval,
  recheckImageRemovalExclusivity,
  type ImageRemovalPlan,
} from '../trash/attachments.js'
import type { HostCorpusPort, SubagentMember } from '../ports/host-port.js'
import { mapLimit } from '../trash/session-rows.js'
import { bareSessionId, firstByBare } from '../domain/closure.js'
import type { CoreDeps, RemovalDeps } from '../deps.js'
import { isSessionDeleteCodeError, type AttachmentCleanupWire } from '../shared/wire.js'
import { dropDeletedSessionCache } from '../trash/projection-cache.js'
import { verbError, rollbackReason, withRollbackFailures } from '../errors.js'
import { assertNoLive } from './live-admission.js'

export interface MeasuredMemberDir {
  readonly dir: string
  readonly bytes: number
}

/** 一条成员被删之前要记下的三件：目录、字节、账本归属（缺席 = 未分组）。`/list` 的只读计划不吃它（零账本读）。 */
export interface PlannedMemberRemoval {
  readonly sessionId: string
  readonly dir: string
  readonly bytes: number
  readonly workspaceId?: string
}

/** 一条目录的盘上读数：在不在 + 实测字节（不在 = 0 字节）。 */
interface DirProbe {
  readonly present: boolean
  readonly bytes: number
}

/** `exists → sizeOfDir` 的唯一一条度量口径（成员目录与回收站目录共用）：先问在不在，再量字节；缺席（ENOENT / ENOTDIR）才是不在，
 *  别的错误照旧响亮（ADR-0039）。**已知粒度**：`sizeOfDir` 递归里撞到的缺席与"目录本身没了"是同一个码，所以文件恰在这一拍消失时
 *  整条目录会被记成「不在」（清册行照旧摘——盘上留下的目录由下一次 `reconcile` 重建成行，自愈、不丢数据）；复核一次 `exists`
 *  会把正常竞态打红，这里选自愈不选响亮。 */
async function probeDir(deps: CoreDeps, dir: string): Promise<DirProbe> {
  if (!(await deps.fs.exists(dir))) return { present: false, bytes: 0 }
  try {
    return { present: true, bytes: await deps.fs.sizeOfDir(dir) }
  } catch (error) {
    if (isMissing(error)) return { present: false, bytes: 0 }
    throw error
  }
}

/** 成员的盘上目录与字节（扫描、清单与 purge 共用一条口径）；目录缺席回 `undefined`，不拿旧读数冒充盘上残留。 */
export async function measureMemberDir(
  deps: CoreDeps,
  member: { readonly sessionId: string; readonly projectDir: string },
): Promise<MeasuredMemberDir | undefined> {
  // 目录按宿主目录段拼（`sessionDirForId`）：`sessionId` 是原始 id，宿主编码后才是目录名。
  const dir = sessionDirForId(member.projectDir, member.sessionId, deps.home)
  const probe = await probeDir(deps, dir)
  return probe.present ? { dir, bytes: probe.bytes } : undefined
}

/** 一条成员的**测量**读数：身份两格 + 目录 + 实测字节；没有账本归属格（归属只有删除动词才读）。 */
export interface MeasuredMember {
  readonly sessionId: string
  readonly projectDir: string
  readonly dir: string
  readonly bytes: number
}

/** 只测量（目录 + 实测字节）：`/list` 的只读计划只吃这一支，零账本读；目录不在的成员跳过。为什么不顺手问归属：
 *  `/list` 只用字节与条数，那一格立刻被丢弃——每开一次回收站为它付 N 次宿主调用，还把账本归属读拉进失败面。 */
export async function measureMembers(
  deps: CoreDeps,
  members: readonly { readonly sessionId: string; readonly projectDir: string }[],
): Promise<MeasuredMember[]> {
  const out: MeasuredMember[] = []
  for (const member of members) {
    const measured = await measureMemberDir(deps, member)
    if (measured === undefined) continue
    out.push({ sessionId: member.sessionId, projectDir: member.projectDir, ...measured })
  }
  return out
}

/** 把一组成员折成删除计划：`measureMembers` 之外**逐成员补账本归属**（`workspaceOf`）——executor 摘账本要用。 */
async function planMemberRemovals(
  deps: CoreDeps,
  members: readonly { readonly sessionId: string; readonly projectDir: string }[],
): Promise<PlannedMemberRemoval[]> {
  const plans: PlannedMemberRemoval[] = []
  for (const measured of await measureMembers(deps, members)) {
    const workspaceId = await deps.host.workspaceOf(measured.sessionId)
    plans.push({
      sessionId: measured.sessionId,
      dir: measured.dir,
      bytes: measured.bytes,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    })
  }
  return plans
}

/** 回收站里的一条要删的行：目录、在不在、实测字节（缺席 = 0）。purge 与 `/list` 都由它量。 */
export interface PlannedTrashRow {
  readonly entry: TrashEntry
  readonly dir: string
  readonly present: boolean
  readonly bytes: number
}

/** 量一条回收站行；目录不在回 `present: false` / 0 字节（目录不在不等于清册行不用摘）。 */
async function measureTrashRow(deps: CoreDeps, entry: TrashEntry): Promise<PlannedTrashRow> {
  const dir = trashDirOf(entry.id, deps.home)
  const probe = await probeDir(deps, dir)
  return { entry, dir, present: probe.present, bytes: probe.bytes }
}

/** 扁平化候选与组号绑成一条记录：全局去重仍只走 `firstByBare`，不再维护两条等长数组与一张按对象身份反查的表。 */
interface GroupedMember {
  readonly sessionId: string
  readonly projectDir: string
  readonly member: SubagentMember
  readonly groupIndex: number
}

/**
 * 盘上后代的选择判据（`/list` 与 purge 共用）：`subagentMembersOf` 一次问全部父，再按 `bareSessionId` **排除全部清册 id**，
 * 同一个 bare id 只认**遍历顺序里第一次**出现的那条（去重口径住 `firstByBare`）。语料看不见 ⇒ 每个根按空成员收（盘上残留留给 `GET /orphans`）。
 * 结果按传入父 id 的原序分组、组内保持宿主交回的顺序。
 *
 * **单行读数与单行回执可能差一条**：同一个 bare id 挂在两个组根下时，全局去重只把它算给第一个根；单独 purge 那一组时它仍算进那一组
 * ⇒ 那条的 `releaseBytes` 与 `freedBytes` 在共享后代上可以不等（全部可见行之和与 `/empty` 的回执仍相等）。数据有环或两代写法混杂才撞上。
 */
async function selectStrandedMembers(
  host: Pick<HostCorpusPort, 'subagentMembersOf'>,
  manifest: readonly TrashEntry[],
  parentIds: readonly string[],
): Promise<SubagentMember[][]> {
  const manifestIds = new Set(manifest.map((row) => bareSessionId(row.sessionId)))
  const read = await host.subagentMembersOf(parentIds)
  if (!read.available) return parentIds.map(() => [])
  // 每条候选与它第一次出现的组号绑成一条记录；全局去重仍走 `firstByBare`——跨根共享的后代只算给先出现的组根。
  const flat: GroupedMember[] = []
  parentIds.forEach((parentId, groupIndex) => {
    for (const member of read.value[parentId] ?? []) {
      if (manifestIds.has(bareSessionId(member.sessionId))) continue
      flat.push({ sessionId: member.sessionId, projectDir: member.projectDir, member, groupIndex })
    }
  })
  const out: SubagentMember[][] = parentIds.map(() => [])
  for (const entry of firstByBare(flat)) {
    const bucket = out[entry.groupIndex]
    // 组号来自 `parentIds.forEach` 的下标，必在界内；这一句只满足 `noUncheckedIndexedAccess`。
    if (bucket === undefined) throw verbError('io', `子会话分组越界：${entry.member.sessionId}`)
    bucket.push(entry.member)
  }
  return out
}

/** `/list` 的一行（一组）：`releaseBytes` 是这一组**实测**会释放的字节；`members` 是测量读数（无账本归属格）。 */
export interface VisibleTrashGroup extends TrashGroupView {
  readonly trash: readonly PlannedTrashRow[]
  readonly members: readonly MeasuredMember[]
  readonly releaseBytes: number
  readonly subagentBytes: number
  readonly strandedBytes: number
  readonly strandedCount: number
}

/** `/list` 只读计划的盘上测量预算（组与组内 kids 两级共用）：`/list` 一次可能几百组、每组几百孩子，无界 `Promise.all`
 *  会把上千个 `exists` / `sizeOfDir` 挂起抢同一个盘；它与逐行读数的旋钮分家（那边是宿主投影读，同一个数没有同一条理由）。 */
const VISIBLE_MEASURE_CONCURRENCY = 8

/**
 * `/list` 的只读计划：一行 = 一组。释放量与 purge 同口径——回收站目录与成员目录**现测**，不用清册记的 `sizeBytes`（盘上早变了）。
 * 盘上后代经 `selectStrandedMembers` 选出；目录不在的成员不进 `members`。成员只吃 `measureMembers`：**零账本读**。
 * 两级都有界（`VISIBLE_MEASURE_CONCURRENCY`）；输出按 `groups` 原序（`mapLimit` 按 index 落位），首个失败原样抛。
 */
export async function planVisibleTrash(
  deps: CoreDeps,
  rows: readonly TrashEntry[],
  groups: readonly TrashGroupView[],
): Promise<VisibleTrashGroup[]> {
  // 候选按组先选好（只读，但要问一次宿主的 subagentMembersOf）：逐组实测那一步可以并行。
  const candidates = await selectStrandedMembers(deps.host, rows, groups.map((group) => group.root.sessionId))
  return await mapLimit(groups, VISIBLE_MEASURE_CONCURRENCY, async ({ root, kids }, index) => {
    const rootRow = await measureTrashRow(deps, root)
    const kidRows = await mapLimit(kids, VISIBLE_MEASURE_CONCURRENCY, (kid) => measureTrashRow(deps, kid))
    const members = await measureMembers(deps, candidates[index] ?? [])
    const subagentBytes = kidRows.reduce((total, row) => total + row.bytes, 0)
    const strandedBytes = members.reduce((total, member) => total + member.bytes, 0)
    return {
      root,
      kids,
      trash: [rootRow, ...kidRows],
      members,
      releaseBytes: rootRow.bytes + subagentBytes + strandedBytes,
      subagentBytes,
      strandedBytes,
      strandedCount: members.length,
    }
  })
}

/** 一次永久删除的只读计划：哪些目录要删、各自实测多少字节、哪些会话要先摘归档集。`kind` 同时决定执行器在**删目录阶段**
 *  失败时交不交部分回执：`trash` 不带、`orphan` 带 `{removed, freedBytes, failedSessionId}`——回执与 `kind` 在生产里 1:1，
 *  所以由它派生，不另存一份会跟它漂移的字段。 */
export interface RemovalPlan {
  readonly kind: 'trash' | 'orphan'
  readonly trash: readonly PlannedTrashRow[]
  readonly members: readonly PlannedMemberRemoval[]
  readonly unarchive: readonly string[]
  /** 计划量到的合计；成功回执的 freedBytes 只念它。 */
  readonly bytes: number
  /** 这一次要连带清掉的独占图片对象（空计划 = 没有可删的、或剩余引用源读不出而整体跳过——原因在 `skipped`）。
   *  附件字节**不进** `bytes`（那是会话目录的释放量）；附件读数单独走回执的 `attachments`。 */
  readonly attachments: ImageRemovalPlan
}

function totalBytes(items: readonly { readonly bytes: number }[]): number {
  return items.reduce((total, item) => total + item.bytes, 0)
}

/**
 * purge 的删除计划：`targets` 由调用方按组语义选好，这里只量、只筛、只查活体。**计划函数是执行前的第一道闸**——
 * 计划与第一笔写之间的窗口由 `executeRemoval` 在首笔写前复查。
 *
 * - `trash` 按 targets 原序逐个实测（目录缺席的行 `present:false` / 0 字节，但清册行仍要摘）；盘上后代经 `selectStrandedMembers` 选出。
 * - `members` 只收盘上还有目录的成员；`unarchive` = targets + 这些成员（只摘真要碰的 id）。
 * - `attachments` 由被删目录里的图片引用与全部剩余引用源算独占；共享的保留、剩余引用源读不出就整体跳过（判据住 `attachments.ts`）。
 * - 活体准入在量目录与任何写之前逐个查 targets 与**全部枚举到的**盘上后代；没有跳过它的开关（执行器首笔写前还会复查）。
 * - `sessionQuery` 缺席 ⇒ members 为空、不抛（盘上残留留给 `GET /orphans` 兜底）。
 */
export async function planTrashRemoval(
  deps: CoreDeps,
  rows: readonly TrashEntry[],
  targets: readonly TrashEntry[],
): Promise<RemovalPlan> {
  const candidates = (await selectStrandedMembers(deps.host, rows, targets.map((entry) => entry.sessionId))).flat()
  // 准入住在计划里、量目录与任何写之前（判据与那句原文住 `verbs/live-admission.ts`）。
  await assertNoLive(deps.host, [
    ...targets.map((entry) => entry.sessionId),
    ...candidates.map((member) => member.sessionId),
  ])
  // 批量 purge 的 targets 可能一次上百条：盘上测量同样走那份有界预算，不拿宿主并发换自己的省事。
  const trash = await mapLimit(targets, VISIBLE_MEASURE_CONCURRENCY, (entry) => measureTrashRow(deps, entry))
  const members = await planMemberRemovals(deps, candidates)
  // 剩余引用源由附件域自己扫（活动会话 + 除本次被删目录外的全部 session-trash + storages/cache）。
  const attachments = await planImageAttachmentRemoval(
    deps,
    [...trash.map((row) => row.dir), ...members.map((member) => member.dir)],
  )
  return {
    kind: 'trash',
    trash,
    members,
    unarchive: [...targets.map((entry) => entry.sessionId), ...members.map((member) => member.sessionId)],
    bytes: totalBytes(trash) + totalBytes(members),
    attachments,
  }
}

/**
 * orphan-clean 的删除计划：成员是调用方扫出来的传递闭包（`orphanGroupsOf`）。
 * - `members` 只收盘上还有目录的成员，`bytes` 只算这些实测值；`unarchive` 覆盖**全部传入成员**（含目录缺席）——
 *   它们可能还挂在归档集里，重试时不会再长出一条幽灵 id。
 * - live 准入覆盖**全部传入成员**（含目录缺席）：任一在跑就整组拒绝。`attachments` 的剩余引用源由附件域自己扫，共享图片保留。
 * - 回执由 `kind:'orphan'` 派生：删目录阶段失败时执行器交回 `{removed, freedBytes, failedSessionId}`。
 */
export async function planOrphanRemoval(
  deps: CoreDeps,
  members: readonly { readonly sessionId: string; readonly projectDir: string }[],
): Promise<RemovalPlan> {
  await assertNoLive(deps.host, members.map((member) => member.sessionId))
  const present = await planMemberRemovals(deps, members)
  const attachments = await planImageAttachmentRemoval(
    deps,
    present.map((member) => member.dir),
  )
  return {
    kind: 'orphan',
    trash: [],
    members: present,
    unarchive: members.map((member) => member.sessionId),
    bytes: totalBytes(present),
    attachments,
  }
}

/** 一次永久删除的成功回执：条数、计划合计字节与附件读数（purge 与 orphan-clean 共用这一形状）。 */
export interface RemovalStats {
  readonly removed: number
  readonly freedBytes: number
  readonly attachments: AttachmentCleanupWire
}

/**
 * 执行器的窄面：把一份计划动成盘、把 `RemovalStats` 交回来。删的能力（`RemovalDeps`）留在持有它的调用方手里、
 * 按调用点注入，作用域自己够不着。
 */
export type RemovalExecutor = (plan: RemovalPlan) => Promise<RemovalStats>

/**
 * 按计划执行一次永久删除：不再量，回执的字节念计划（`plan.bytes`）。**准入查两遍**（ADR-0027）：计划期证明成立时没人在跑；
 * 执行器首笔写前用计划里的同一份名单（`plan.unarchive`）复查，补上附件扫描撑开的窗口——失败仍零写入。
 *
 * 顺序：整批摘归档集 → 摘有账本的成员的账本 → 逐条回收站行（在才删目录 → 摘清册行 → 通告离场）→ 逐条盘上成员（删目录 → 通告离场）
 * → 逐条附件对象。目录删掉就没有"退回去"这回事，中途失败**不回滚目录**；已删的由计数器如实交回。
 *
 * **归档态回滚**：`unarchive` 排在所有删除之前，所以失败时目录还在、归档位却已摘。失败出口把**目录还在**的那些按删除前的读数
 * 重新归档（预读 `isArchived`，不按 `wasArchived` 猜），目录不在的跳过——否则会造幽灵 id。回滚失败走 `details.rollbackFailures`（ADR-0040）。
 * **附件计划在执行期复核**：删对象前用同一套剩余引用扫描重判，只删这一刻仍无引用的对象（ADR-0041）。
 *
 * 失败形状：`kind:'orphan'` ⇒ `io` + `{removed, freedBytes, failedSessionId}`，不伪装成整组没动；`kind:'trash'` ⇒ 同一个标签、不带 details；
 * orphan-clean 的归档实况预读 / unarchive / detach 原样抛出；归档回滚不干净时原错误带 `details.rollbackFailures`。
 * 通告只经 `member-presence`，不在这里另写一份。
 */
export async function executeRemoval(
  deps: RemovalDeps,
  plan: RemovalPlan,
): Promise<RemovalStats> {
  // 计划→执行的窗口由附件引用扫描撑开；动第一笔写前重查同一份名单（理由见函数头注）。
  await assertNoLive(deps.host, plan.unarchive)
  const presence = deps.presence
  let removed = 0
  /** 删到这一刻已经腾出的**进度**：只喂 `orphan` 的部分回执；成功回执念计划的合计。 */
  let freedSoFar = 0

  /** 删除途中失败的唯一出口：标签沿用旧措辞；部分回执只属于 `orphan`（由 `kind` 派生）。
   *  已是本仓动词码的错误原样抛（同 `journalFailure` 的判据）——`not-found` / `live` 不许在这里折成 `io`。 */
  const fail = (label: string, error: unknown, failedSessionId: string): never => {
    if (isSessionDeleteCodeError(error)) throw error
    const details = plan.kind === 'orphan' ? { removed, freedBytes: freedSoFar, failedSessionId } : undefined
    throw verbError('io', `${label}：${String(error)}`, error, details)
  }

  /** 归档实况预读 / 退归档集 / 摘账本这一步的失败形状：purge 折成带标签的 `io`；orphan-clean 原样抛。 */
  const step = async (label: string, sessionId: string, run: () => Promise<void>): Promise<void> => {
    if (plan.kind === 'orphan') {
      await run()
      return
    }
    try {
      await run()
    } catch (error) {
      fail(label, error, sessionId)
    }
  }

  // 归档态回滚名单：只放回删除前确实归档着的那些（`unarchive` 对未归档是 no-op，回滚时更不能凭空把没归档过的
  // 会话归档了——不按 `wasArchived` 猜：旧条目、盘上成员的归档事实都可能与清册那一格不同）。
  // 预读失败与 unarchive 同走一条 `step` 形状，且此刻零写入。
  const archivedBefore = new Set<string>()
  for (const sessionId of plan.unarchive) {
    await step('读取归档状态失败', sessionId, async () => {
      if (await deps.host.isArchived(sessionId)) archivedBefore.add(sessionId)
    })
  }
  /** 走到过 `unarchive` 这一步的 id（含失败那一条）：失败时按它回滚。 */
  const unarchived: string[] = []
  /** 计划时目录还在的 id：只有这些会话还有本体可挂归档；名字在 `unarchive` 里但目录缺席的没有可回滚的。 */
  const onDisk = new Set<string>([
    ...plan.trash.filter((row) => row.present).map((row) => row.entry.sessionId),
    ...plan.members.map((member) => member.sessionId),
  ])
  /** 目录已经真删掉的 id：没有归档态可放回去，跳过——否则会在 registry 里留下幽灵 id。 */
  const deleted = new Set<string>()

  try {
    // 归档集与账本在**任何删除之前**退掉：失败时目录还在，重试还能清；也不会留下"会话没了、归档集还挂着"的幽灵 id。
    for (const sessionId of plan.unarchive) {
      unarchived.push(sessionId)
      await step('取消归档失败', sessionId, () => deps.host.unarchive(sessionId))
    }
    for (const member of plan.members) {
      const workspaceId = member.workspaceId
      if (workspaceId === undefined) continue
      await step('摘账本失败', member.sessionId, () => deps.host.detach(member.sessionId, workspaceId))
    }

    // 回收站行：计划里 `present:false` 的行没有目录可删（执行期也不再问盘），但清册行仍要摘。
    for (const row of plan.trash) {
      if (row.present) {
        try {
          await deps.fs.removeDir(row.dir)
        } catch (error) {
          fail('删除回收站目录失败', error, row.entry.sessionId)
        }
        deleted.add(row.entry.sessionId)
        freedSoFar += row.bytes
      }
      try {
        await deps.ledger.remove(row.entry.id)
      } catch (error) {
        fail('摘除回收站条目失败', error, row.entry.sessionId)
      }
      removed += 1
      await presence.memberGone(row.entry.sessionId)
      // 只有这一行的目录/清册行确实处理完，才删**这一条会话**的投影缓存：删到一半失败时已删的照清、
      // 没删成的不动；缓存删除失败只留 warning，不翻删除。
      await dropDeletedSessionCache(deps, row.entry.sessionId)
    }

    // 盘上成员：标签按调用方区分（purge 说的是"盘上后代"，orphan-clean 说的是"会话目录"）。
    const memberLabel = plan.kind === 'trash' ? '删除盘上后代目录失败' : '删除会话目录失败'
    for (const member of plan.members) {
      try {
        await deps.fs.removeDir(member.dir)
      } catch (error) {
        fail(memberLabel, error, member.sessionId)
      }
      deleted.add(member.sessionId)
      removed += 1
      freedSoFar += member.bytes
      await presence.memberGone(member.sessionId)
      // 同回收站行：这一条成员目录真的删掉了，才删这一条会话的缓存。
      await dropDeletedSessionCache(deps, member.sessionId)
    }

    // 附件对象最后动：会话目录已经真的没了，失败只计数、不回滚，也不改会话删除的字节。
    // 删之前再复核一次独占：计划到这一刻窗口里新增的引用（同图再贴一次 / 派生存储新写一条）必须保住对象（ADR-0041）。
    const attachmentPlan = await recheckImageRemovalExclusivity(deps, plan.attachments)
    const attachments = await executeImageAttachmentRemoval(deps, attachmentPlan)
    return {
      removed,
      freedBytes: plan.bytes,
      attachments: {
        ...attachments,
        ...(attachmentPlan.skipped === undefined ? {} : { skipped: attachmentPlan.skipped }),
      },
    }
  } catch (error) {
    // 目录不回滚（删了就是删了）；归档态不是——条目还在回收站、目录也还在的那些，用户随后恢复时
    // 恢复路径不会替他补归档（它只按 `wasArchived` 迁移旧条目），所以这里必须放回去（ADR-0040）。
    const rollbackFailures: string[] = []
    for (const sessionId of [...unarchived].reverse()) {
      if (!archivedBefore.has(sessionId) || deleted.has(sessionId) || !onDisk.has(sessionId)) continue
      try {
        await deps.host.archive(sessionId)
      } catch (rollbackError) {
        rollbackFailures.push(rollbackReason('恢复归档失败', rollbackError))
      }
    }
    throw rollbackFailures.length === 0 ? error : withRollbackFailures(error, rollbackFailures)
  }
}
