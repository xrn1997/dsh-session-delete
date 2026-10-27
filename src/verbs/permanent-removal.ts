/**
 * 永久删除的测量、计划与执行：先记录目录/字节/账本归属，再按计划动盘。
 * 计划函数只读；活体准入在计划阶段、任何写之前完成。
 */
import { sessionDirOf, trashDirOf, type TrashEntry } from '../trash/entry.js'
import type { TrashGroupView } from '../trash/groups.js'
import { bareSessionId, type HostCorpusPort, type SubagentMember } from '../ports/host-port.js'
import type { CoreDeps, RemovalDeps } from '../deps.js'
import { isSessionDeleteCodeError } from '../shared/wire.js'
import { verbError } from './errors.js'
import { assertNoLive } from './live-admission.js'

export interface MeasuredMemberDir {
  readonly dir: string
  readonly bytes: number
}

/** 一条成员被删之前要记下的三件：目录、字节、账本归属（缺席 = 未分组）。`/list` 的只读计划与
 *  purge / orphan-clean 的删除计划共用这一份形状。 */
export interface PlannedMemberRemoval {
  readonly sessionId: string
  readonly dir: string
  readonly bytes: number
  readonly workspaceId?: string
}

/** `exists` 与 `sizeOfDir` 之间目录消失（ENOENT）是唯一一种当"不在"的失败：盘没挂、权限、I/O 错误
 *  都不许伪装成"目录没了"，那会让 `/list` 静默少算释放量、让删除计划少一条该删的目录。 */
function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 'ENOENT'
}

/** 一条目录的盘上读数：在不在 + 实测字节（不在 = 0 字节）。 */
interface DirProbe {
  readonly present: boolean
  readonly bytes: number
}

/** `exists → sizeOfDir` 的唯一一条度量口径（成员目录与回收站目录共用）：先问在不在，再量字节；
 *  ENOENT 是唯一一种当"不在"的失败，别的错误照旧响亮。别再在调用点各写一遍这段 try/catch。
 *
 *  **已知粒度**：`sizeOfDir` 递归里撞到的 ENOENT 与"目录本身没了"是同一个码，所以目录里某个文件
 *  恰好在这一拍消失时，整条目录会被记成「不在」（`/list` 少算这条、删除计划里没有可删的字节，
 *  而清册行照旧摘——盘上留下目录等下一次 `reconcile` 重建成行，自愈、不丢数据）。复核一次
 *  `exists(dir)` 能把两者分开，却会让「宿主正在写、文件刚被挪走」这类正常竞态把 `/list` 整个打红——
 *  这里选自愈不选响亮。 */
async function probeDir(deps: CoreDeps, dir: string): Promise<DirProbe> {
  if (!(await deps.fs.exists(dir))) return { present: false, bytes: 0 }
  try {
    return { present: true, bytes: await deps.fs.sizeOfDir(dir) }
  } catch (error) {
    if (isMissing(error)) return { present: false, bytes: 0 }
    throw error
  }
}

/** 成员的盘上目录与字节（扫描、清单装配与 purge 共用这一条路径/存在性/度量口径；
 *  目录缺席回 `undefined`，不拿一份"记录还在、盘上已经没了"的旧读数冒充盘上残留）。 */
export async function measureMemberDir(
  deps: CoreDeps,
  member: { readonly sessionId: string; readonly projectDir: string },
): Promise<MeasuredMemberDir | undefined> {
  const dir = sessionDirOf(member.projectDir, member.sessionId, deps.home)
  const probe = await probeDir(deps, dir)
  return probe.present ? { dir, bytes: probe.bytes } : undefined
}

/** 把一组成员折成"删之前要记下的计划"；目录不在的成员跳过（记录与盘不一致是那条成员自己的事）。
 *  `purge` 的盘上后代、`orphan-clean` 的整组与 `/list` 的盘上残留都走这一处，别再各写一遍
 *  measure + workspaceOf。 */
async function planMemberRemovals(
  deps: CoreDeps,
  members: readonly { readonly sessionId: string; readonly projectDir: string }[],
): Promise<PlannedMemberRemoval[]> {
  const plans: PlannedMemberRemoval[] = []
  for (const member of members) {
    const measured = await measureMemberDir(deps, member)
    if (measured === undefined) continue
    const workspaceId = await deps.host.workspaceOf(member.sessionId)
    plans.push({
      sessionId: member.sessionId,
      ...measured,
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

/**
 * 盘上后代的选择判据（`/list` 与 purge 的删除计划共用这一份）：`subagentMembersOf` 一次问全部父，
 * 再按 `bareSessionId` **排除全部清册 id**（跟着父进来的孩子不按盘上残留再算一遍），同一个 bare id 只认
 * **遍历顺序里第一次**出现的那条（同一个会话在两代宿主里的写法不同）。
 *
 * 语料看不见（`available: false`）⇒ 每个根都按空成员收：`/list` 与 purge 只许静默降级，
 * 盘上残留留给 `GET /orphans` 兜底。
 *
 * 结果按传入父 id 的原序分组、组内保持宿主交回的顺序：全局去重需要顺序，实测那一步可以并行。
 *
 * **单行读数和单行回执可能差一条**：同一个 bare id 若同时挂在两个组根下，全局去重只把它算给遍历
 * 顺序里第一个根；而对某个根单独 purge 时它仍会算进那一组 ⇒ 那条的 `releaseBytes` 与对它 purge 的
 * `freedBytes` 在共享后代上可以不等（全部可见行之和与 `/empty` 的回执仍相等）。数据里有环或两代
 * 写法混杂才会撞上，不为它多开一条口径。
 */
async function selectStrandedMembers(
  host: Pick<HostCorpusPort, 'subagentMembersOf'>,
  manifest: readonly TrashEntry[],
  parentIds: readonly string[],
): Promise<SubagentMember[][]> {
  const manifestIds = new Set(manifest.map((row) => bareSessionId(row.sessionId)))
  const read = await host.subagentMembersOf(parentIds)
  const seen = new Set<string>()
  return parentIds.map((parentId) => {
    const wanted: SubagentMember[] = []
    if (!read.available) return wanted
    for (const member of read.value[parentId] ?? []) {
      const bare = bareSessionId(member.sessionId)
      if (manifestIds.has(bare) || seen.has(bare)) continue
      seen.add(bare)
      wanted.push(member)
    }
    return wanted
  })
}

/** `/list` 的一行（一组）所需的只读数：`releaseBytes` 是这一组**实测**会释放的字节。 */
export interface VisibleTrashGroup extends TrashGroupView {
  readonly trash: readonly PlannedTrashRow[]
  readonly members: readonly PlannedMemberRemoval[]
  readonly releaseBytes: number
  readonly subagentBytes: number
  readonly strandedBytes: number
  readonly strandedCount: number
}

/**
 * `/list` 的只读计划：一行 = 一组。释放量与 purge 用同一条口径——回收站目录与成员目录**现测**，
 * 不用清册里记的 `sizeBytes`（那是删除那一刻的事实，盘上早就变了）。
 *
 * 盘上后代经 `selectStrandedMembers` 选出（排除全部清册 id、bare id 全局只算一次）；目录不在的成员
 * 不进 `members`（与 `planMemberRemovals` 同口径）。
 */
export async function planVisibleTrash(
  deps: CoreDeps,
  rows: readonly TrashEntry[],
  groups: readonly TrashGroupView[],
): Promise<VisibleTrashGroup[]> {
  // 候选按组先选好（只读，但要问一次宿主的 subagentMembersOf）：逐组实测那一步可以并行。
  const candidates = await selectStrandedMembers(deps.host, rows, groups.map((group) => group.root.sessionId))
  return await Promise.all(groups.map(async ({ root, kids }, index) => {
    const rootRow = await measureTrashRow(deps, root)
    const kidRows = await Promise.all(kids.map((kid) => measureTrashRow(deps, kid)))
    const members = await planMemberRemovals(deps, candidates[index] ?? [])
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
  }))
}

/** 一次永久删除的只读计划：哪些目录要删、各自实测多少字节、哪些会话要先摘归档集。
 *  `kind` 同时决定执行器在**删目录阶段**失败时交不交部分回执：`trash`（purge）不带、`orphan`
 *  （orphan-clean）带 `{removed, freedBytes, failedSessionId}`——回执与 `kind` 在生产里 1:1，
 *  所以由 `kind` 派生，不另存一份会跟它漂移的字段；更早的 `unarchive` / `detach` 一步不套回执。 */
export interface RemovalPlan {
  readonly kind: 'trash' | 'orphan'
  readonly trash: readonly PlannedTrashRow[]
  readonly members: readonly PlannedMemberRemoval[]
  readonly unarchive: readonly string[]
  /** 计划量到的合计；成功回执的 freedBytes 只念它。 */
  readonly bytes: number
}

function totalBytes(items: readonly { readonly bytes: number }[]): number {
  return items.reduce((total, item) => total + item.bytes, 0)
}

/**
 * purge 的删除计划：`targets` 由调用方按组语义（`trash/groups.ts`）选好，这里只量、只筛、只查活体。
 * **计划函数就是执行前的闸**——调用方拿到计划才允许写，所以准入必须发生在任何写之前。
 *
 * - `trash` 按 targets 原序逐个实测（目录缺席的行 `present:false` / 0 字节，但清册行仍要摘）。
 * - 盘上后代经 `selectStrandedMembers` 选出（一次问全部 targets、排除全部清册 id、bare id 全局只计划一次）。
 * - `members` 只收盘上还有目录的成员（目录缺席没有可删的字节）；`unarchive` = targets + 这些成员：
 *   只摘这一次真要碰的 id。
 * - 活体准入在量目录与任何写之前逐个查 targets 与**全部枚举到的**盘上后代；任一在跑就整条拒绝、
 *   零副作用。没有跳过它的开关——计划就是执行前的闸（ADR-0006）。
 * - `sessionQuery` 缺席时端口回 `{ available: false }` ⇒ members 为空、不抛（盘上残留留给 `GET /orphans` 兜底）。
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
  const trash = await Promise.all(targets.map((entry) => measureTrashRow(deps, entry)))
  const members = await planMemberRemovals(deps, candidates)
  return {
    kind: 'trash',
    trash,
    members,
    unarchive: [...targets.map((entry) => entry.sessionId), ...members.map((member) => member.sessionId)],
    bytes: totalBytes(trash) + totalBytes(members),
  }
}

/**
 * orphan-clean 的删除计划：成员是调用方扫出来的传递闭包（`orphanGroupsOf`）。
 *
 * - `members` 只收盘上还有目录的成员（目录缺席没有可删的字节），`bytes` 只算这些实测值。
 * - `unarchive` 覆盖**全部传入成员**（含目录缺席）：orphan-clean 在删目录之前整批摘归档集，
 *   目录缺席的 id 也可能还挂在归档集里；重试时不会再长出一条幽灵 id。
 * - live 准入覆盖**全部传入成员**（含目录缺席）：它们都在这一组的可见面里，任一在跑就整组拒绝。
 * - 回执由 `kind:'orphan'` 派生：删目录阶段失败时执行器要交回 `{removed, freedBytes, failedSessionId}`。
 */
export async function planOrphanRemoval(
  deps: CoreDeps,
  members: readonly { readonly sessionId: string; readonly projectDir: string }[],
): Promise<RemovalPlan> {
  await assertNoLive(deps.host, members.map((member) => member.sessionId))
  const present = await planMemberRemovals(deps, members)
  return {
    kind: 'orphan',
    trash: [],
    members: present,
    unarchive: members.map((member) => member.sessionId),
    bytes: totalBytes(present),
  }
}

/**
 * 按计划执行一次永久删除：只写、不再量、不再判活体（计划就是执行前的闸）。回执的字节念计划
 * （`plan.bytes`），执行期不再累加一遍。
 *
 * 顺序：整批摘归档集 → 摘有账本的成员的账本 → 逐条回收站行
 * （在才删目录 → 摘清册行 → 通告成员离场）→ 逐条盘上成员（删目录 → 通告成员离场）。目录删掉就没有
 * "退回去"这回事，中途失败**不回滚**；已经删掉的由下面的计数器如实交回。
 *
 * 失败形状：
 * - `kind:'orphan'`（orphan-clean）⇒ `io` + `{removed, freedBytes, failedSessionId}`，不伪装成整组没动；
 * - `kind:'trash'`（purge）⇒ 同一个标签、不带 details；
 * - orphan-clean 的 unarchive / detach 原样抛出。
 *
 * 通告只经 `member-presence`（摘活体三态 + `api-session/removed`），不在这里另写一份。
 */
export async function executeRemoval(
  deps: RemovalDeps,
  plan: RemovalPlan,
): Promise<{ removed: number; freedBytes: number }> {
  const presence = deps.presence
  let removed = 0
  /** 删到这一刻已经腾出的**进度**：只喂 `orphan` 的部分回执；成功回执念计划的合计（`plan.bytes`）。 */
  let freedSoFar = 0

  /** 删除途中失败的唯一出口：标签沿用旧措辞；部分回执只属于 `orphan`（由计划的 `kind` 派生）。
   *  已经是本仓动词码的错误原样抛（与 `member-journal.ts` 的 `journalFailure` 同一条判据）——
   *  `not-found` / `live` 之类不许在这里被折成 `io`。 */
  const fail = (label: string, error: unknown, failedSessionId: string): never => {
    if (isSessionDeleteCodeError(error)) throw error
    const details = plan.kind === 'orphan' ? { removed, freedBytes: freedSoFar, failedSessionId } : undefined
    throw verbError('io', `${label}：${String(error)}`, error, details)
  }

  /** 退归档集 / 摘账本这一步的失败形状：purge 折成带标签的 `io`；orphan-clean 原样抛。 */
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

  // 归档集与账本在**任何删除之前**退掉：失败时目录还在，重试还能清；也不会留下"会话没了、归档集还挂着"的幽灵 id。
  for (const sessionId of plan.unarchive) {
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
      freedSoFar += row.bytes
    }
    try {
      await deps.ledger.remove(row.entry.id)
    } catch (error) {
      fail('删除回收站目录失败', error, row.entry.sessionId)
    }
    removed += 1
    await presence.memberGone(row.entry.sessionId)
  }

  // 盘上成员：标签按调用方区分（purge 说的是"盘上后代"，orphan-clean 说的是"会话目录"）。
  const memberLabel = plan.kind === 'trash' ? '删除盘上后代目录失败' : '删除会话目录失败'
  for (const member of plan.members) {
    try {
      await deps.fs.removeDir(member.dir)
    } catch (error) {
      fail(memberLabel, error, member.sessionId)
    }
    removed += 1
    freedSoFar += member.bytes
    await presence.memberGone(member.sessionId)
  }

  return { removed, freedBytes: plan.bytes }
}
