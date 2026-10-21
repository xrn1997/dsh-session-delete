import { bareSessionId, type SessionIdentity } from '../ports/host-port.js'
import type { OrphanCleanStatsWire, OrphanReportWire } from '../shared/wire.js'
import type { DeleteDeps } from './delete-session.js'
import { verbError } from './errors.js'
import { executeRemoval, measureMemberDir, planOrphanRemoval } from './permanent-removal.js'

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
 * 彻底删除（组语义见 `src/trash/groups.ts`），把它的根当孤儿删掉就是**替用户做了一个没人点过的决定**。孤儿只
 * 有一种来路：父被彻底删掉了（或被手工从盘上清掉了），清册里再也没有这一行。
 *
 * 根按**传递闭包**收全部后代（与 `HostCorpusPort.subagentMembersOf` 同一口径：孩子与孙代都算，深度不设上限），
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
 *  `listSessions()` 回 `{ available: false }` 时**必须抛**：那是宿主的会话语料服务没挂，不是"这个家没有孤儿"。
 *  拿缺席当空语料 ⇒ 报告说"零条孤儿"、界面上一句"没有要清理的"，而盘上真有几百 MB——那是假话，
 *  所以这里按 `io` 响亮失败（AGENTS.md：`available: false` 意味着服务缺席，扫描方不许冒充读数）。 */
export async function loadOrphanGroups(deps: DeleteDeps): Promise<readonly OrphanGroup[]> {
  const read = await deps.host.listSessions()
  if (!read.available) {
    throw verbError('io', '无主子会话扫描需要宿主的 sessionQuery.listSessions')
  }
  const corpus = read.value
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
 * 清一组：`planOrphanRemoval`（只读计划，整组 live 准入在一切写之前）→ `executeRemoval`（只写）。
 * 量目录、摘归档集与账本、删目录与成员通告的顺序和失败形状都住 `verbs/permanent-removal.ts`；
 * 这里只把这一组接上去，别在这再长出一段手写步骤（purge 走的是同一条路）。
 *
 * 顺序与删除那一半是**对偶**的，但不是照抄：
 * - 删除那一半不再用归档藏会话（ADR-0008）：它摘账本、搬目录，最后才摘活体。这里目录是**删掉**
 *   不是搬走，藏不藏都不影响可见性 ⇒ 归档集反而**在写之前整批摘掉**：失败时目录还在，下一次还能重试，
 *   不会留下"会话没了但还在归档集里挂着"的幽灵 id。
 * - `unarchive` 对未归档的会话是官方幂等 no-op（`registry.unarchiveSession`），所以这里不需要那次
 *   `wasArchived` 读——这里没有"还原到删除前"的义务。
 * - 摘账本只在账本真记着它时做（`workspaceOf` 未命中 = 本来就是「未分组」，不是故障）。
 */
export async function cleanOrphanGroup(
  deps: DeleteDeps,
  group: OrphanGroup,
): Promise<OrphanCleanStatsWire> {
  return await executeRemoval(deps, await planOrphanRemoval(deps, group.members))
}
