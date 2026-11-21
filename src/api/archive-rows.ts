/** `GET /archive-list` 那一行的装配：registry 归档集 ∩ 会话语料 → `ArchiveListWire`。
 *  与 `trash-rows.ts` 同层同责，但归档行念持久化日志字节与最后活动，回收站行念清册目录实测与删除时间
 *  ——两个 sizeBytes 不是一个数（ADR-0060 决定第 3 条）。
 *  缺席口径住 `src/trash/session-rows.ts`；交集按 id 原样，ghost id 宁可少显示也不显示死行（ADR-0008）。 */
import type { CoreDeps } from '../deps.js'
import type { ArchiveListWire, ArchiveRowWire } from '../shared/wire.js'
import { projectSessionRows, sizeTotals } from '../trash/session-rows.js'

export async function assembleArchiveRows(deps: CoreDeps): Promise<ArchiveListWire> {
  const archived = await deps.host.archivedSessionIds()
  const corpus = await deps.host.listSessions()
  if (!corpus.available) return { available: false }
  const archivedSet = new Set(archived)
  const identities = corpus.value.filter((row) => archivedSet.has(row.sessionId))
  // 创建时间是可选事实：缺席或非正数就不进目标，不拿 0 冒充「1970 年创建」。
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
