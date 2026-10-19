import { bareSessionId, type SessionIdentity } from '../ports/host-port.js'
import type { OrphanCleanStatsWire, OrphanReportWire } from '../shared/wire.js'
import { sessionDirOf } from '../trash/entry.js'
import type { DeleteDeps } from './delete-session.js'
import { verbError } from './errors.js'

/** 组里一个人的盘上身份（字节是**扫描那一刻**量的，清理时按目录重量一次，不拿这份快照冒充准数）。 */
export interface OrphanMember {
  readonly sessionId: string
  readonly projectDir: string
  readonly bytes: number
}

/** 一组无主子会话：根是那"父没了"的 subagent，`members` 是它的**传递闭包**（含根自己）。 */
export interface OrphanGroup {
  readonly root: OrphanMember
  readonly parentSessionId: string
  readonly members: readonly OrphanMember[]
}

export interface MeasuredMemberDir {
  readonly dir: string
  readonly bytes: number
}

/** 一个成员被删之前要记下的三件：目录、字节、账本归属（缺席 = 未分组）。purge 与 orphan-clean 共用。 */
export interface MemberRemovalPlan extends MeasuredMemberDir {
  readonly sessionId: string
  readonly workspaceId?: string
}

/** 成员的盘上目录与字节（扫描、清单装配与 purge 共用这一条路径/存在性/度量口径；
 *  目录缺席回 `undefined`，不拿一份"记录还在、盘上已经没了"的旧读数冒充盘上残留）。 */
export async function measureMemberDir(
  deps: DeleteDeps,
  member: { readonly sessionId: string; readonly projectDir: string },
): Promise<MeasuredMemberDir | undefined> {
  const dir = sessionDirOf(member.projectDir, member.sessionId, deps.home)
  if (!(await deps.fs.exists(dir))) return undefined
  return { dir, bytes: await deps.fs.sizeOfDir(dir) }
}

/** 把一组成员折成"删之前要记下的计划"；目录不在的成员跳过（记录与盘不一致是那条成员自己的事）。
 *  `purge` 的盘上后代与 `orphan-clean` 的整组都走这一处，别再各写一遍 measure + workspaceOf。 */
export async function planMemberRemovals(
  deps: DeleteDeps,
  members: readonly { readonly sessionId: string; readonly projectDir: string }[],
): Promise<MemberRemovalPlan[]> {
  const plans: MemberRemovalPlan[] = []
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

/** {@link orphanGroupsOf} 的中间形状：还没量字节的那一组（纯函数不碰盘）。 */
interface RawGroup {
  readonly root: SessionIdentity
  readonly parentSessionId: string
  readonly members: readonly SessionIdentity[]
}

/**
 * 无主子会话 = `origin:"subagent"`、父**既不在当前语料（live ∪ persisted）也不在回收站清册里**的会话。
 *
 * 为什么清册里的父不算孤儿：那种是 **stranded**——父还在回收站里等着，孩子本该跟着父一起恢复或一起
 * 彻底删除（10-15 稿 §11 的组语义），把它的根当孤儿删掉就是**替用户做了一个没人点过的决定**。孤儿只
 * 有一种来路：父被彻底删掉了（或被手工从盘上清掉了），清册里再也没有这一行。
 *
 * 根按**传递闭包**收全部后代（与 `HostPort.subagentCounts` 同一口径：孩子与孙代都算，深度不设上限），
 * 同一条记录只归一组（`claimed`）——数据里真出现环时结果是"少数一条"，不是把一个会话删两遍。
 * 归堆与去重**两边都去 `session-` 前缀**：同一个父在两代宿主里写法不同（见 `bareSessionId` 的来历）。
 */
export function orphanGroupsOf(
  corpus: readonly SessionIdentity[],
  trashSessionIds: readonly string[],
): RawGroup[] {
  const known = new Set<string>()
  for (const session of corpus) known.add(bareSessionId(session.sessionId))
  for (const id of trashSessionIds) known.add(bareSessionId(id))

  const children = new Map<string, SessionIdentity[]>()
  for (const session of corpus) {
    const parent = session.parentSessionId
    if (parent === undefined) continue
    const key = bareSessionId(parent)
    const list = children.get(key)
    if (list === undefined) children.set(key, [session])
    else list.push(session)
  }

  const claimed = new Set<string>()
  const groups: RawGroup[] = []
  for (const session of corpus) {
    const parent = session.parentSessionId
    if (!session.subagent || parent === undefined) continue
    if (known.has(bareSessionId(parent))) continue
    if (claimed.has(bareSessionId(session.sessionId))) continue
    const members: SessionIdentity[] = []
    const queue: SessionIdentity[] = [session]
    for (let i = 0; i < queue.length; i += 1) {
      const current = queue[i]!
      const id = bareSessionId(current.sessionId)
      if (claimed.has(id)) continue
      claimed.add(id)
      members.push(current)
      for (const child of children.get(id) ?? []) queue.push(child)
    }
    groups.push({ root: session, parentSessionId: parent, members })
  }
  return groups
}

/** 纯读：调用方应先走一次 `/list` 对账（面板的 refresh 就是这样）；本函数不写清单。
 *  写动作 `orphan-clean` 会自己先 reconcile，避免拿一份过期清册判"父没了"。
 *
 *  `listSessions()` 回 `undefined` 时**必须抛**：那是宿主的会话语料服务没挂，不是"这个家没有孤儿"。
 *  拿 undefined 当空语料 ⇒ 报告说"零条孤儿"、界面上一句"没有要清理的"，而盘上真有几百 MB——那是假话，
 *  所以这里按 `io` 响亮失败（AGENTS.md：`undefined` 意味着服务缺席，扫描方不许冒充读数）。 */
export async function loadOrphanGroups(deps: DeleteDeps): Promise<readonly OrphanGroup[]> {
  const corpus = await deps.host.listSessions()
  if (corpus === undefined) {
    throw verbError('io', '无主子会话扫描需要宿主的 sessionQuery.listSessions')
  }
  const trash = await deps.manifest.list()
  const groups = orphanGroupsOf(corpus, trash.map((entry) => entry.sessionId))
  const out: OrphanGroup[] = []
  for (const group of groups) {
    const members: OrphanMember[] = []
    for (const member of group.members) {
      const measured = await measureMemberDir(deps, member)
      members.push({
        sessionId: member.sessionId,
        projectDir: member.projectDir,
        bytes: measured?.bytes ?? 0,
      })
    }
    out.push({ root: members[0]!, parentSessionId: group.parentSessionId, members })
  }
  return out
}

/** 把一组组收成那份报告：根清单 + 闭包总数/总字节 + 失踪父的**去重计数** + 按项目目录的分摊。
 *  `groups` 按字节从多到少排（界面上"哪家还剩得最多"要看第一行）。 */
export function reportOrphans(groups: readonly OrphanGroup[]): OrphanReportWire {
  const projects = new Map<string, { sessions: number; bytes: number }>()
  let totalSessions = 0
  let totalBytes = 0
  for (const group of groups) {
    for (const member of group.members) {
      totalSessions += 1
      totalBytes += member.bytes
      const row = projects.get(member.projectDir) ?? { sessions: 0, bytes: 0 }
      row.sessions += 1
      row.bytes += member.bytes
      projects.set(member.projectDir, row)
    }
  }
  return {
    roots: groups.map((group) => group.root.sessionId),
    totalSessions,
    totalBytes,
    missingParents: new Set(groups.map((group) => bareSessionId(group.parentSessionId))).size,
    groups: [...projects]
      .map(([projectDir, value]) => ({ projectDir, ...value }))
      .sort((a, b) => b.bytes - a.bytes),
  }
}

/**
 * 清一组：先**整组 live 准入（零写）**，再收集目录/字节/账本归属，再 unarchive → detach → 删目录。
 * 任何 preflight 失败都在第一件写之前抛出；删目录到一半失败时**已删目录不回滚**，失败错误的
 * `details` 带 `{ removed, freedBytes, failedSessionId }` 作为部分回执（不伪装成整组没动）。
 * 删目录之后照 purge 的规矩摘活体并如实通告。不碰投影缓存与附件。
 *
 * 顺序与删除那一半是**对偶**的，但不是照抄：
 * - 删除要先把会话藏起来（归档）再摘账本，免得中间那一拍它掉进「未分组」；这里目录是**删掉**不是搬走，
 *   藏不藏都不影响可见性 ⇒ 归档集反而是**在写之前整批摘掉**的：失败时目录还在，下一次还能重试，
 *   不会留下"会话没了但还在归档集里挂着"的幽灵 id。
 * - `unarchive` 对未归档的会话是官方幂等 no-op（`registry.unarchiveSession`），所以不需要删除侧那次
 *   `wasArchived` 读——这里没有"还原到删除前"的义务。
 * - 摘账本只在账本真记着它时做（`workspaceOf` 未命中 = 本来就是「未分组」，不是故障）。
 * - `evictLive` 的三态照 `HostPort.evictLive` 的契约：`unknown` 时**不通告**（发了就是假话），
 *   `evicted` / `not-live` 才发 `api-session/removed`。冷会话没有活体可摘，通告照样必须发。
 */
export async function cleanOrphanGroup(
  deps: DeleteDeps,
  group: OrphanGroup,
): Promise<OrphanCleanStatsWire> {
  for (const member of group.members) {
    if (await deps.host.isLive(member.sessionId)) {
      throw verbError('live', `会话正在运行：${member.sessionId}`)
    }
  }

  const plans = await planMemberRemovals(deps, group.members)

  // 归档集在删目录之前摘：失败时目录还在，下一次还能重试；成功后再删就没有"幽灵 id"了。
  for (const member of group.members) await deps.host.unarchive(member.sessionId)
  for (const plan of plans) {
    if (plan.workspaceId !== undefined) await deps.host.detach(plan.sessionId, plan.workspaceId)
  }

  let removed = 0
  let freedBytes = 0
  for (const plan of plans) {
    try {
      await deps.fs.removeDir(plan.dir)
    } catch (error) {
      // 已经删掉的目录不回滚（它们没有回收站这一层可退）；把这份部分回执挂在失败上，
      // 让上游能说「已删 X 个、剩下的没清掉」而不是只报一个组级失败。
      throw verbError('io', `删除会话目录失败：${String(error)}`, error, {
        removed,
        freedBytes,
        failedSessionId: plan.sessionId,
      })
    }
    removed += 1
    freedBytes += plan.bytes
    const eviction = await deps.host.evictLive(plan.sessionId)
    if (eviction !== 'unknown') await deps.host.announceRemoved(plan.sessionId)
  }
  return { removed, freedBytes }
}
