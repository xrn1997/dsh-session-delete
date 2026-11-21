/**
 * 一批会话的**行读数装配**（Node 半），三层拆开：**批量面**（{@link readRowSurfaces}：标题 / 最后活动 / 大小三个读面各预读一次）、
 * **逐行面**（{@link projectRowFacts}：旧宿主标题回退与 label 两种逐行读，共用一份有界并发预算）、**合计**（{@link sizeTotalsForIds} /
 * {@link sizeTotals}）。归档清单（`api/archive-rows.ts`）与归档详情的子会话段（`trash/archive-detail.ts`）共用这一份。
 *
 * 为什么逐行读要有界：孩子段一屏两百行、清单一档上千行，无界地把整批同时挂起是拿宿主的并发换自己的省事——`ROW_READ_CONCURRENCY` 是唯一旋钮。
 * 为什么按输出计划读：归档详情只画前 N 条，显示外的孩子一条逐行读都不该付；摘要条的合计另按全量 id 算（报的是全部孩子的和）。
 *
 * 四条口径住这里，且只住这里：**标题**（批量面缺席 ⇒ 逐条回退 `titleOf`；批量在场 ⇒ map 里没有就是空串；这一格永不失败整档）；
 * **最后活动**（只有 `sessionActivity` 一份读数，`RowTarget.createdAt` 给了才回落，不给就整格缺席）；**大小**（服务缺席 ⇒ 逐行缺大小；
 * 抛错怎么办是调用方的 `sizeFailure`：清单整档 `io`，详情只逐行缺）；**label**（一次投影读，只为 `wantsLabel` 的行付钱；空串 = 没有 ⇒ 键不落）。
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

export interface RowReadPolicy {
  /** 大小读面抛错：`throw` ⇒ 原样上抛（整档 `io`）；`absent` ⇒ 折成逐行缺大小。 */
  readonly sizeFailure: 'throw' | 'absent'
}

/** 逐行读的并发预算：label 与旧宿主标题回退共用这一份——「逐行读」是一个概念，不是一种读法一扇窗。 */
export const ROW_READ_CONCURRENCY = 8

/** 批量面的一次预读快照（{@link readRowSurfaces} 的结果）：逐行面只消费它，不再发批量读。 */
export interface RowSurfaces {
  readonly titles: CorpusRead<ReadonlyMap<string, string>>
  readonly activity: CorpusRead<ReadonlyMap<string, number>>
  /** 抛错被策略折掉时为 null（与逐行缺同义）；服务缺席照旧是显式的 `CorpusRead` 缺席。 */
  readonly sizes: CorpusRead<ReadonlyMap<string, number | undefined>> | null
}

/** 批量面：三个读面各读一次、零逐行读；大小读面抛错按策略折成整档缺席（null）或原样上抛。 */
export async function readRowSurfaces(
  deps: CoreDeps,
  ids: readonly string[],
  policy: RowReadPolicy,
): Promise<RowSurfaces> {
  const titles = await deps.host.titleSnapshots(ids)
  const activity = await deps.host.sessionActivity()
  const sizes = await sizesOf(deps, policy)
  return { titles, activity, sizes }
}

/** 逐行面：旧宿主标题回退与 label 共用同一份有界并发，顺序与 `targets` 对齐、输出同序同长，缺席的格不落键。 */
export async function projectRowFacts(
  deps: CoreDeps,
  surfaces: RowSurfaces,
  targets: readonly RowTarget[],
): Promise<SessionRowFact[]> {
  // 标题的批量面缺席 ⇒ 逐条回退 `titleOf`（旧宿主没有 `titleSnapshots`，不是这一条读不出）。
  // 降级口径：旧宿主 `titleOf` 对子会话可能回 label 优先的显示名，与线上 `title` 的「日志标题」语义差一格——显示名本就不看 title，用户无感。
  const cells = await mapLimit(targets, ROW_READ_CONCURRENCY, async (target) => {
    const title = surfaces.titles.available
      ? surfaces.titles.value.get(target.sessionId) ?? ''
      : await deps.host.titleOf(target.sessionId)
    const label = target.wantsLabel === true ? await deps.host.labelOf(target.sessionId) : ''
    return { title, label }
  })
  return targets.map((target, index) => {
    const { sessionId } = target
    const promptAt = surfaces.activity.available ? surfaces.activity.value.get(sessionId) : undefined
    // 提问时间优先；读不到才用调用方给的创建时间，两边都没有 ⇒ 这一格整格缺席。
    const at = promptAt ?? target.createdAt
    const sizeBytes = surfaces.sizes === null || !surfaces.sizes.available ? undefined : surfaces.sizes.value.get(sessionId)
    const cell = cells[index]
    const label = cell?.label ?? ''
    return {
      sessionId,
      title: cell?.title ?? '',
      ...(label === '' ? {} : { label }),
      ...(at === undefined ? {} : { updatedAt: at, updatedAtSource: promptAt === undefined ? ('created' as const) : ('prompt' as const) }),
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    }
  })
}

/** 兼容包装：一次调用走「批量面 + 逐行面」（归档清单继续用它）。 */
export async function projectSessionRows(
  deps: CoreDeps,
  targets: readonly RowTarget[],
  policy: RowReadPolicy,
): Promise<SessionRowFact[]> {
  const surfaces = await readRowSurfaces(deps, targets.map((target) => target.sessionId), policy)
  return projectRowFacts(deps, surfaces, targets)
}

/** 合计按 id 集合算（输出计划外的行也进合计）：缺席按**传入的每个 id** 计数——读面缺席、或某 id 在表里没有值，都算缺。 */
export function sizeTotalsForIds(
  ids: readonly string[],
  sizes: RowSurfaces['sizes'],
): { totalBytes: number; missingSizeCount: number } {
  let totalBytes = 0
  let missingSizeCount = 0
  for (const id of ids) {
    const sizeBytes = sizes === null || !sizes.available ? undefined : sizes.value.get(id)
    if (sizeBytes === undefined) missingSizeCount += 1
    else totalBytes += sizeBytes
  }
  return { totalBytes, missingSizeCount }
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

/** 有界并发的逐条执行器：结果与 `items` **同序同长**、同时挂起的 `fn` 不超过 `limit`、首个失败原样抛出（失败后不再起新活）。
 *  为什么不直接 `Promise.all`：它无界放飞，而各条自己 settle 的失败还会留下没人收的 rejection。**导出面**：逐行读数与 `/list` 的盘上测量共用——
 *  "有界并发"只该有这一份实现；预算由调用方给（两个调用点的窗口大小不是同一个语义）。 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  /** 按发生顺序收失败：第一条就是「首错」；非空也让在跑的 worker 不再领新活（失败关闭）。 */
  const failures: unknown[] = []
  const worker = async (): Promise<void> => {
    while (failures.length === 0) {
      const index = cursor
      if (index >= items.length) return
      cursor += 1
      const item = items[index]
      if (item === undefined) return
      try {
        results[index] = await fn(item, index)
      } catch (error) {
        failures.push(error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  if (failures.length > 0) throw failures[0]
  return results
}
