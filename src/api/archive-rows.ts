/**
 * `GET /archive-list` 那一行的装配：registry 归档集 ∩ 会话语料 → `ArchiveListWire`。
 *
 * 与 `api/trash-rows.ts` 同层同责（「一行里放什么」），但两档各写各的口径：归档行念
 * `sessionPersistence.sizeBytes`（宿主持久化日志工件字节）与「最后活动」，回收站行念清册
 * 的目录实测与删除时间——**两个 sizeBytes 不是一个数**（ADR-0060 决定第 3 条）。
 *
 * 四路读面（标题 / 活动 / 大小 / label）的缺席口径住 `src/trash/session-rows.ts`，这一层只管
 * 「哪一批 id、哪些格要过线」：
 * - `sessionQuery` 缺席 ⇒ `{ available: false }`（显式的「语料不可见」，不是空列表）；
 * - 大小读面抛错 ⇒ 整档 `io`（`sizeFailure: 'throw'`，不拿 0 冒充没有大小）；
 * - label 那格只随**子会话行**过线（普通行的 `labelOf` 念的是标题那一路，不是 descriptor label）。
 *
 * 交集按 **id 原样**（与 `isArchived` 的精确判据一致）：ghost id（归档集里有、语料已无记录）
 * 宁可少显示也不显示死行——删除不改 `archivedSessionIds`（ADR-0008），回收站里那条也靠这道
 * 交集自动消失。
 */
import type { CoreDeps } from '../deps.js'
import type { ArchiveListWire, ArchiveRowWire } from '../shared/wire.js'
import { projectSessionRows, sizeTotals } from '../trash/session-rows.js'

export async function assembleArchiveRows(deps: CoreDeps): Promise<ArchiveListWire> {
  const archived = await deps.host.archivedSessionIds()
  const corpus = await deps.host.listSessions()
  if (!corpus.available) return { available: false }
  const archivedSet = new Set(archived)
  const identities = corpus.value.filter((row) => archivedSet.has(row.sessionId))
  // 创建时间是头部读到的可选事实：缺席（或非正数）就不进目标，时间格整格缺席，
  // 不拿 0 冒充「1970 年创建」（正文详情的 `timeText(0)` 同样画「—」）。
  const facts = await projectSessionRows(deps, identities.map((identity) => ({
    sessionId: identity.sessionId,
    ...(identity.createdAt === undefined || identity.createdAt <= 0 ? {} : { createdAt: identity.createdAt }),
    wantsLabel: identity.subagent,
  })), { sizeFailure: 'throw' })
  const { totalBytes, missingSizeCount } = sizeTotals(facts)

  // 输出与 `identities` 同序同长；判空写出来只为让类型面说真话，不是第二种行为分支。
  const rows: ArchiveRowWire[] = facts.flatMap((fact, index): ArchiveRowWire[] => {
    const identity = identities[index]
    if (identity === undefined) return []
    return [{
      sessionId: identity.sessionId,
      projectDir: identity.projectDir,
      title: fact.title,
      // 空串在 `projectSessionRows` 里就不落键了，这里只管「要不要落」。
      ...(fact.label === undefined ? {} : { label: fact.label }),
      ...(fact.updatedAt === undefined ? {} : { updatedAt: fact.updatedAt }),
      ...(fact.updatedAtSource === undefined ? {} : { updatedAtSource: fact.updatedAtSource }),
      ...(fact.sizeBytes === undefined ? {} : { sizeBytes: fact.sizeBytes }),
      subagent: identity.subagent,
    }]
  })
  return { available: true, rows, totalBytes, missingSizeCount }
}
