/**
 * 一批会话的**行读数装配**（Node 半）：标题 / 最后活动 / 大小 / 子会话 label 四路读面在一次
 * 预读里读齐，再逐行落成线上那一格一份。归档清单（`api/archive-rows.ts`）与归档详情的子会话段
 * （`trash/archive-detail.ts`）共用这一份：两处的行形状读同一套缺席口径。
 *
 * 四条口径住这里，且只住这里：
 * - **标题**：批量读面缺席（旧宿主没有 `titleSnapshots`）⇒ 逐条回退 `titleOf` 的投影标题；
 *   批量在场 ⇒ map 里没有就是空串。`titleOf` / `labelOf` 按端口契约**不抛**（取不到给空串），
 *   所以标题这一格永不失败整档。
 * - **最后活动**：只有 `sessionActivity` 那一份读数，回落什么由调用方决定——`RowTarget.createdAt`
 *   给了才回落（归档清单每行都带着身份记录的创建时间），不给就整格缺席（子会话段没有创建时间）。
 * - **大小**：`persistedSizes` 的**服务缺席** ⇒ 逐行缺大小（显示「—」、合计只加已知）；**抛错**怎么办
 *   是调用方的策略（`sizeFailure`）：清单要整档 `io`（不拿 0 冒充没有大小），详情那一段不许拖垮正文，
 *   只能逐行缺。
 * - **label**：一次宿主投影读，只为要画这一格的行付钱（`RowTarget.wantsLabel`）；空串 = 没有 ⇒ 键不落。
 *
 * 输出与 `targets` **同序同长**：调用方按 index 或 `sessionId` 对齐都行，不另建一份身份表。
 */
import type { CoreDeps } from '../deps.js'
import type { CorpusRead } from '../ports/host-port.js'

/** 一行要读哪些格：`createdAt` 是「没有提问时间时回落什么」，`wantsLabel` 决定要不要读 label 那格。 */
export interface RowTarget {
  readonly sessionId: string
  readonly createdAt?: number
  readonly wantsLabel?: boolean
}

/** 一行的读数：缺席的格**不落键**（`exactOptionalPropertyTypes` 下 `undefined` 与缺席是两件事）。 */
export interface SessionRowFact {
  readonly sessionId: string
  readonly title: string
  readonly label?: string
  readonly updatedAt?: number
  readonly updatedAtSource?: 'prompt' | 'created'
  readonly sizeBytes?: number
}

/** `targets` 每行都给了 `createdAt` ⇒ 时间那一格必然落键（提问时间或创建时间，二选一）。
 *  调用方由此可以直接把这一格当**必有**过线，不再自己判空、也不再重算一遍回落。 */
export interface TimedSessionRowFact extends SessionRowFact {
  readonly updatedAt: number
  readonly updatedAtSource: 'prompt' | 'created'
}

export interface RowReadPolicy {
  /** 大小读面抛错：`throw` ⇒ 原样上抛（整档 `io`）；`absent` ⇒ 折成逐行缺大小。 */
  readonly sizeFailure: 'throw' | 'absent'
}

/** 四路读面的**一次**预读：批量面各读一次，`labelOf` 只读要画那一格的行。 */
export async function projectSessionRows(
  deps: CoreDeps,
  targets: readonly (RowTarget & { readonly createdAt: number })[],
  policy: RowReadPolicy,
): Promise<TimedSessionRowFact[]>
export async function projectSessionRows(
  deps: CoreDeps,
  targets: readonly RowTarget[],
  policy: RowReadPolicy,
): Promise<SessionRowFact[]>
export async function projectSessionRows(
  deps: CoreDeps,
  targets: readonly RowTarget[],
  policy: RowReadPolicy,
): Promise<SessionRowFact[]> {
  const ids = targets.map((target) => target.sessionId)
  const titles = await deps.host.titleSnapshots(ids)
  const activity = await deps.host.sessionActivity()
  const sizes = await sizesOf(deps, policy)
  // 标题的批量面缺席 ⇒ 逐条回退 `titleOf`（旧宿主没有 `titleSnapshots`，不是这一条读不出）。
  const titleList = await Promise.all(ids.map(async (sessionId) => (
    titles.available ? titles.value.get(sessionId) ?? '' : await deps.host.titleOf(sessionId)
  )))
  const labels = await Promise.all(targets.map((target) => (
    target.wantsLabel === true ? deps.host.labelOf(target.sessionId) : Promise.resolve('')
  )))

  return targets.map((target, index) => {
    const { sessionId } = target
    const promptAt = activity.available ? activity.value.get(sessionId) : undefined
    // 提问时间优先；读不到才用调用方给的创建时间，两边都没有 ⇒ 这一格整格缺席。
    const at = promptAt ?? target.createdAt
    const sizeBytes = sizes === null || !sizes.available ? undefined : sizes.value.get(sessionId)
    const label = labels[index] ?? ''
    return {
      sessionId,
      title: titleList[index] ?? '',
      ...(label === '' ? {} : { label }),
      ...(at === undefined ? {} : { updatedAt: at, updatedAtSource: promptAt === undefined ? ('created' as const) : ('prompt' as const) }),
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    }
  })
}

/** 大小的合计口径：只加已知的那几行，缺大小的行数单独报（副标题要念「N 条大小缺席」）。 */
export function sizeTotals(facts: readonly SessionRowFact[]): { totalBytes: number; missingSizeCount: number } {
  let totalBytes = 0
  let missingSizeCount = 0
  for (const fact of facts) {
    if (fact.sizeBytes === undefined) missingSizeCount += 1
    else totalBytes += fact.sizeBytes
  }
  return { totalBytes, missingSizeCount }
}

/** 读面抛错按策略折成「逐行都缺」（`absent`）或原样上抛（`throw`）。 */
async function sizesOf(
  deps: CoreDeps,
  policy: RowReadPolicy,
): Promise<CorpusRead<ReadonlyMap<string, number | undefined>> | null> {
  try {
    return await deps.host.persistedSizes()
  } catch (error) {
    if (policy.sizeFailure === 'throw') throw error
    return null
  }
}
