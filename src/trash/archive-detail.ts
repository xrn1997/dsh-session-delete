/**
 * 归档**单条详情**（`POST /archive-detail`）：正文走 `sessionQuery.readSession` 的整本事件流
 * + 合成 `session` 头，喂 `DetailFold`（块/分页/计数与回收站详情同一份折叠，`src/trash/detail.ts`）。
 *
 * 三条硬口径（ADR-0060 决定第 2–3 条、ADR-0061）：
 * ① **寻址只认 id**：客户端只传 `sessionId`（与可选的 `rootSessionId`），路径字段不过线。
 *    目标自己已归档 ⇒ 可读；否则要求 `rootSessionId` 已归档且目标在该根的 subagent 闭包里
 *    ⇒ 也可读（归档父会话的子会话只读查看）。其余 id ⇒ `not-found`——否则这就是一条
 *    可读任意会话的通用正文通道。路径形字符串只是一个「不满足闭包条件的 id」。
 * ② **header 合成**：`readSession` 的 `events` **不含** raw JSONL 里那条 `{"type":"session", …}`
 *    头记录——把 `snapshot.session` 的 `cwd` / `createdAt` / `parentSession` 拼成同形的那一条先喂
 *    折叠，项目名、创建时间与 fork 子会话的 label 兜底才不丢。
 * ③ **失败折码**：`SESSION_QUERY_SESSION_NOT_FOUND` ⇒ `sessiondelete/not-found`（不折就分不出
 *    「这条没了」与「读失败」）；方法缺席 / 读失败 ⇒ `io`（不静默空正文）。
 *
 * 子会话段是**只读投影**：宿主 `subagentMembersOf` 给出闭包，行读数（标题 / 最后活动 / 大小 /
 * label）走 `src/trash/session-rows.ts` 那一份——与归档清单同一套缺席口径，只把大小读失败折成
 * 逐行缺（这一段不许拖垮正文）。归档仍是**单会话粒度**（`archiveSession` 不级联），这里只展示
 * 孩子，不做随父归档/恢复。孩子的正文也只走 `archive-detail` 的这条只读栅栏；v1 每次翻页重走
 * 整本 `readSession`（与 `/detail` 每次重读整条日志同量级），慢的话另立缓存裁决。
 * **仅凭根放行的读不装配这一段**：孩子视图单级、客户端对这种主体也不画它（无 `onOpenChild`），
 * 不为此付第二次闭包 BFS 与逐孩子行读数——这一趟只付寻址校验本身那一次（ADR-0061 边界）。
 */
import type { CoreDeps } from '../deps.js'
import type { ArchiveDetailWire, ArchiveSubagentWire } from '../shared/wire.js'
import type { SessionRecord } from '../log/session-log.js'
import type { CorpusEvent, CorpusLogRead } from '../ports/host-port.js'
import { bareSessionId } from '../domain/closure.js'
import { createDetailFold, SUBAGENT_SUMMARY_LIMIT, type DetailLimits } from './detail.js'
import { projectSessionRows, sizeTotals } from './session-rows.js'
import { verbError, type VerbError } from '../errors.js'

/** `readSession` 抛的宿主失败码（`SessionQueryError.code`）：未知 id / 已无盘上记录。 */
const SESSION_QUERY_SESSION_NOT_FOUND = 'SESSION_QUERY_SESSION_NOT_FOUND'

/** 「不在寻址边界内」的原文只此一份：三处 not-found 同句，cause 有就挂。 */
const notInArchive = (sessionId: string, cause?: unknown): VerbError =>
  verbError('not-found', `归档里没有这一条：${sessionId}`, cause)

export function readArchiveDetail(deps: CoreDeps, limits?: DetailLimits) {
  return async function readArchiveDetail(
    sessionId: string,
    before?: number,
    rootSessionId?: string,
  ): Promise<ArchiveDetailWire> {
    // 寻址边界：目标自己已归档，或是已归档根的 subagent 闭包成员；其余一律 not-found（先判权，
    // 不先读正文）。返回值同时决定子会话段装配：仅凭根放行（false）的主体不装配那一段。
    const selfArchived = await assertArchiveReadable(deps, sessionId, rootSessionId)

    let session: CorpusLogRead['session']
    let events: readonly CorpusEvent[]
    try {
      const read = await deps.host.readSession(sessionId)
      session = read.session
      events = read.events
    } catch (error) {
      if ((error as { readonly code?: unknown }).code === SESSION_QUERY_SESSION_NOT_FOUND) {
        throw notInArchive(sessionId, error)
      }
      throw verbError('io', error instanceof Error ? `读归档日志失败：${error.message}` : `读归档日志失败：${String(error)}`, error)
    }

    const fold = createDetailFold(limits, before)
    // 合成头：与 raw JSONL 的 `{"type":"session", …}` 同形（字段缺席就不带），先喂。
    const header: SessionRecord = {
      type: 'session',
      ...(typeof session.createdAt === 'number' ? { createdAt: session.createdAt } : {}),
      ...(typeof session.cwd === 'string' ? { cwd: session.cwd } : {}),
      ...(typeof session.parentSession === 'string' ? { parentSession: session.parentSession } : {}),
    }
    fold.add(header)
    for (const event of events) fold.add({ type: event.type, time: event.time, data: event.data })

    const detail: ArchiveDetailWire = { sessionId, archived: selfArchived, ...fold.finish() }
    // 子会话段是**只读投影**：它读不出只让它自己不画，正文照旧（孩子的元信息不许能坏正文）。
    // 仅凭根放行的读（主体自己未归档、只进得来孩子视图）不装配这一段：客户端对这种主体
    // 整段不画，不为此重跑一次闭包 BFS + 逐孩子行读数（ADR-0061 边界）。
    if (selfArchived) {
      let subagents: ArchiveSubagents | undefined
      try {
        subagents = await readArchiveSubagents(deps, sessionId, limits)
      } catch {
        subagents = undefined
      }
      if (subagents !== undefined) {
        detail.subagents = subagents.rows
        if (subagents.total !== undefined) detail.subagentsTotal = subagents.total
        if (subagents.sizeBytes !== undefined) detail.subagentsSizeBytes = subagents.sizeBytes
      }
    }
    return detail
  }
}

/** 归档详情读的寻址边界：目标自己已归档回 `true`（主体，子会话段照常装配）；仅凭
 *  `rootSessionId` 那条已归档根的闭包成员放行回 `false`（只读视图，不装配那一段）。
 *  其余一律 not-found。闭包读不出时失败关闭（`io`），不把「证明不了」当成「可以读」。 */
async function assertArchiveReadable(
  deps: CoreDeps,
  sessionId: string,
  rootSessionId: string | undefined,
): Promise<boolean> {
  if (await deps.host.isArchived(sessionId)) return true
  if (rootSessionId === undefined || !(await deps.host.isArchived(rootSessionId))) {
    throw notInArchive(sessionId)
  }
  let members
  try {
    members = await deps.host.subagentMembersOf([rootSessionId])
  } catch (error) {
    throw verbError(
      'io',
      error instanceof Error ? `读归档子会话闭包失败：${error.message}` : `读归档子会话闭包失败：${String(error)}`,
      error,
    )
  }
  if (!members.available) {
    throw verbError('io', `归档子会话闭包读不出，无法校验：${sessionId}`)
  }
  const target = bareSessionId(sessionId)
  const found = (members.value[rootSessionId] ?? []).some((kid) => bareSessionId(kid.sessionId) === target)
  if (!found) throw notInArchive(sessionId)
  return false
}

/** 归档详情的子会话只读投影：宿主闭包 + `session-rows.ts` 那一份行读数。 */
async function readArchiveSubagents(
  deps: CoreDeps,
  sessionId: string,
  limits: DetailLimits | undefined,
): Promise<ArchiveSubagents | undefined> {
  const members = await deps.host.subagentMembersOf([sessionId])
  if (!members.available) return undefined
  const kids = members.value[sessionId] ?? []
  if (kids.length === 0) return undefined

  // 与归档清单同一份读面，只换两条策略：大小读失败**不许**坏正文（`absent` ⇒ 逐行缺大小），
  // 子会话没有「创建时间」这一格可回落 ⇒ 读不到提问时间就整格缺席。
  const facts = await projectSessionRows(deps, kids.map((kid) => ({
    sessionId: kid.sessionId,
    wantsLabel: true,
  })), { sizeFailure: 'absent' })
  // 孩子自己的归档态：**不**拿「在不在归档清单里」推（清单是交集投影、会缺席）——认宿主
  // 归档集这条权威判据（`isArchived`，id 原样）。这一格读不出就整段不画（与闭包同一条
  // 「读不出不画」策略），不拿 false 冒充「未归档」。
  const archived = await Promise.all(kids.map((kid) => deps.host.isArchived(kid.sessionId)))
  const limit = limits?.subagents ?? SUBAGENT_SUMMARY_LIMIT
  // 摘要条报的是**全部**孩子的合计，不是已列前 N 条的和（ADR-0055）；超闸只报总数，不静默截断。
  const { totalBytes, missingSizeCount } = sizeTotals(facts)
  const rows = facts.slice(0, limit).flatMap((fact, index): ArchiveSubagentWire[] => {
    const kid = kids[index]
    const isArchived = archived[index]
    if (kid === undefined || isArchived === undefined) return []
    return [{
      sessionId: kid.sessionId,
      archived: isArchived,
      projectDir: kid.projectDir,
      title: fact.title,
      ...(fact.label === undefined ? {} : { label: fact.label }),
      ...(fact.updatedAt === undefined ? {} : { updatedAt: fact.updatedAt }),
      ...(fact.updatedAtSource === undefined ? {} : { updatedAtSource: fact.updatedAtSource }),
      ...(fact.sizeBytes === undefined ? {} : { sizeBytes: fact.sizeBytes }),
    }]
  })
  return {
    rows,
    ...(kids.length > limit ? { total: kids.length } : {}),
    ...(missingSizeCount === facts.length ? {} : { sizeBytes: totalBytes }),
  }
}

/** 子会话段的三样读数：已列的行、被条数闸截断时的总数、全部孩子已知大小的合计。 */
interface ArchiveSubagents {
  rows: ArchiveSubagentWire[]
  total?: number
  sizeBytes?: number
}
