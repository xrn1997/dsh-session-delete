/**
 * 回收站面板的**首帧快照**与**详情账本**：上一次成功读到的清单、选中与详情，跨面板挂载留一份。
 *
 * 为什么需要它：面板是宿主 `main` 的 keyed 占用者，切到会话时整棵卸载、回来整棵挂载；
 * 如果状态只活在组件里，回来第一帧只能从 `loading` 起画，于是「正在读回收站…」→ 两栏 →
 * 详情骨架在百来毫秒里轮换。宿主对同类问题的做法是「面板卸载、状态不丢」（插件管理页把
 * controller / slot store 放在组件之外），这里把它收成本仓最小的形状：模块级、读一次、不订阅。
 *
 * 详情账本独立于清单快照存在：组件挂载先于清单成功读数时，详情读路仍要能落账；下一次成功
 * 清单读数按行修剪它。它不是「清单状态」的第四态（三态仍住 `use-trash-query.ts`），
 * 也不是持久化：进程重启就没了。**失败时整份丢掉**——读不到就不许再拿旧行冒充此刻的回收站
 * （`unknown` 的老判据）。也不记折叠集、列宽、孩子视图：那些是视图状态，跨挂载记住会与
 * ADR-0050/ui-spec 打架。
 */
import type { TrashDetailLike, TrashEntryLike } from './remote.js'

/** 快照的形状：只搬清册/详情线上已有的只读事实，不带时间戳或"读了几次"这类读数。 */
export interface TrashSnapshot {
  readonly rows: readonly TrashEntryLike[]
  readonly selectedId: string | null
  readonly details: ReadonlyMap<string, TrashDetailLike>
}

let snapshot: TrashSnapshot | null = null
let details: Map<string, TrashDetailLike> = new Map()

/**
 * 详情账本的上限。孩子详情从不在清单行里（`reconcileTrashRows` 只按清单 id 修剪），账本又是
 * 模块级、跨所有面板挂载存活：不设上限时，一个长会话里打开几十个子会话就把每份详情（含已翻
 * 出来的分页块与附件读数）永久留在进程里。64 远高于一屏能开出来的条目数，命中率不受影响。
 */
const DETAIL_LEDGER_LIMIT = 64

/** 读当前快照；没有（或已 clear）⇒ null。只在挂载首帧读一次，不做订阅。 */
export function readTrashSnapshot(): TrashSnapshot | null {
  return snapshot
}

/** 读一条已成功读到的详情：详情账本的唯一读口，清单快照是否存在不影响它。
 *  名字带 `Cached`：Node 半的 `trash/detail.ts` 也有一个 `readTrashDetail`（读会话日志），
 *  两个「唯一实现」不是同一个东西，grep 不该把它们混在一起。 */
export function readCachedTrashDetail(entryId: string): TrashDetailLike | undefined {
  return details.get(entryId)
}

/**
 * 写入一份**成功**的清单读数：复制数组、按上一份清单修剪详情账本，选中行不在了就置空。
 * 只修剪「上一份清单里出现过、这一份不见了」的条目：孩子详情从不在清单行里，不能被误删。
 * 调用方是 `use-trash-query` 的 `reload` 成功支；失败支不许调它。
 */
export function reconcileTrashRows(rows: readonly TrashEntryLike[]): void {
  const ids = new Set(rows.map((row) => row.id))
  const previousIds = new Set(snapshot?.rows.map((row) => row.id) ?? [])
  const next = new Map(details)
  for (const id of next.keys()) {
    if (previousIds.has(id) && !ids.has(id)) next.delete(id)
  }
  details = next
  const selectedId = snapshot?.selectedId ?? null
  snapshot = {
    rows: [...rows],
    selectedId: selectedId !== null && ids.has(selectedId) ? selectedId : null,
    details,
  }
}

/** 记下选中行；没有清单快照时无处可挂，直接忽略。 */
export function writeTrashSelection(entryId: string | null): void {
  if (snapshot === null) return
  snapshot = { ...snapshot, selectedId: entryId }
}

/** 记下一条成功读到的详情；失败不写（失败由调用方落 `failed` 状态）。
 *  写时复制：已经交出去的 `snapshot.details` 引用永远不再变，读方可以安全地比引用。 */
export function writeTrashDetail(entryId: string, detail: TrashDetailLike): void {
  const next = new Map(details)
  next.delete(entryId)
  next.set(entryId, detail)
  // 重写挪到队尾 ⇒ 这里等价于按「最近一次写入」淘汰。上限只兜孩子详情那种永不随清单修剪的条目。
  while (next.size > DETAIL_LEDGER_LIMIT) {
    const oldest = next.keys().next().value
    if (oldest === undefined) break
    next.delete(oldest)
  }
  details = next
  if (snapshot !== null) snapshot = { ...snapshot, details }
}

/** 丢掉一条详情（恢复 / 彻底删除成功、或那一条的读数失败）。写时复制，口径同 `writeTrashDetail`。 */
export function forgetTrashDetail(entryId: string): void {
  if (!details.has(entryId)) return
  const next = new Map(details)
  next.delete(entryId)
  details = next
  if (snapshot !== null) snapshot = { ...snapshot, details }
}

/** 按写动作的成功名单丢一组详情（settlement 收尾与撤销座位共用）：逐条走 `forgetTrashDetail`。 */
export function forgetTrashDetails(entryIds: readonly string[]): void {
  for (const id of entryIds) forgetTrashDetail(id)
}

/** 丢掉整份快照与详情账本：清单读失败、清空失败，以及测试/HMR 复位都走这一条。 */
export function clearTrashSnapshot(): void {
  snapshot = null
  details = new Map()
}

/**
 * 只丢详情账本，清单快照原样留着：清空回收站**成功**后走这一条——`emptyTrash` 已经重读并
 * `reconcileTrashRows([])` 写下过一份空清单，整份 clear 会把这份成功读数也丢掉，下一次挂载
 * 又从「正在读回收站…」起画（ADR-0048 要消灭的正是这帧闪）。要丢的只有详情：随条目作废，
 * 而且孩子详情不随清单修剪，不丢就永远留在账本里（ADR-0048 决定 4）。
 */
export function clearTrashDetails(): void {
  details = new Map()
  if (snapshot !== null) snapshot = { ...snapshot, details }
}
