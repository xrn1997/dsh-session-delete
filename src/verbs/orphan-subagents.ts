import { bareSessionId, orphanRootsOf } from '../domain/closure.js'
import type { SessionIdentity } from '../ports/host-port.js'
import type { TrashEntry } from '../trash/entry.js'
import type { OrphanCleanStatsWire, OrphanReportWire } from '../shared/wire.js'
import type { CoreDeps, RemovalDeps } from '../deps.js'
import { verbError } from '../errors.js'
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
 * 清册里的父不算孤儿（那是 **stranded**：孩子本该跟父一起恢复或一起永久删除，组语义见 `src/trash/groups.ts`）——
 * 把它的根当孤儿删掉就是替用户做了没人点过的决定；父被彻底删掉才是孤儿唯一的来路。
 *
 * 根按**传递闭包**收全部 subagent 后代（核心住 `orphanRootsOf`：孩子与孙代都算，普通 fork 不算也不穿过），
 * 同一条记录只归一组（`claimed`）——数据里真出现环时结果是"少数一条"，不是把一个会话删两遍。
 * 归堆与去重**两边都去 `session-` 前缀**：同一个父在两代宿主里写法不同。
 */
export function orphanGroupsOf(
  corpus: readonly SessionIdentity[],
  trashSessionIds: readonly string[],
): RawGroup[] {
  // 薄包装：known 的口径（语料里的父 + 清册里的父）留在这里，闭包、防环与成组次序都在纯核心里。
  const known = [...corpus.map((session) => session.sessionId), ...trashSessionIds]
  return orphanRootsOf(corpus, known)
}

/** **纯扫描，不对账、不写清册行**（`/orphans` 声明为 pure）：清册行由调用方选好交进来（`/orphans` 交 raw 索引、
 *  `orphan-clean` 交对账后的行），否则刚被手工搬进 `session-trash/` 的父目录还没行，会被当成"父没了"直接删盘。
 *  `listSessions()` 回 `{ available: false }` 时**必须抛**：那是宿主的会话语料服务没挂，拿缺席当空语料会报"零条孤儿"的假话；
 *  `roots` 只收请求点名的组、**在量字节之前过滤**，否则点一组会把整个家所有孤儿的树都递归量一遍。 */
export async function loadOrphanGroups(
  deps: CoreDeps,
  /** 调用方选好并交来的清册行：`/orphans` 交 `read.rows()`，`orphan-clean` 交 `ledger.list()`。 */
  trash: readonly TrashEntry[],
  /** 只要这些根（两边都去 `session-` 前缀再比）；缺席 = 全量扫描。 */
  roots?: readonly string[],
): Promise<readonly OrphanGroup[]> {
  const read = await deps.host.listSessions()
  if (!read.available) {
    throw verbError('io', '无主子会话扫描需要宿主的 sessionQuery.listSessions')
  }
  const corpus = read.value
  const all = orphanGroupsOf(corpus, trash.map((entry) => entry.sessionId))
  const wanted = roots === undefined ? undefined : new Set(roots.map((root) => bareSessionId(root)))
  const groups = wanted === undefined
    ? all
    : all.filter((group) => wanted.has(bareSessionId(group.root.sessionId)))
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
    const root = members[0]
    // 组定义写明 `members` 含根自己 ⇒ 必非空；缺了是上游构造坏了，走失败通道（宁炸不猜），不拿第一成员硬当根。
    if (root === undefined) {
      throw verbError('io', `无主子会话组没有成员（父 ${group.parentSessionId}）`)
    }
    out.push({ root, parentSessionId: group.parentSessionId, members })
  }
  return out
}

/** 收成报告：根清单 + 闭包总数/总字节 + 失踪父的**去重计数** + 按项目目录分摊（按字节从多到少排）。 */
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
 * 清一组：`planOrphanRemoval`（只读计划，整组 live 准入在一切写之前）→ `executeRemoval`（只写）。量目录、摘归档集与账本、
 * 删目录与成员通告的顺序和失败形状都住 `permanent-removal.ts`；这里只把这一组接上去。顺序与删除那一半**对偶**
 * 但不照抄：
 * - 删除那一半不碰归档（ADR-0008）；这里目录是**删掉**不是搬走 ⇒ 归档集**在写之前整批摘掉**：失败时目录还在可重试，
 *   不留"会话没了却还在归档集里挂着"的幽灵 id（`unarchive` 对未归档会话本就是幂等 no-op，无需那次 `wasArchived` 读）。
 * - 摘账本只在账本真记着它时做（`workspaceOf` 未命中 = 未分组，不是故障）；独占图片的剩余引用源由附件域自己扫。
 */
export async function cleanOrphanGroup(
  deps: RemovalDeps,
  group: OrphanGroup,
): Promise<OrphanCleanStatsWire> {
  return await executeRemoval(deps, await planOrphanRemoval(deps, group.members))
}
