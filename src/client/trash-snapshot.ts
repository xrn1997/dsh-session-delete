/**
 * 回收站面板的**首帧快照**与**详情账本**：上一次成功读到的清单、选中与详情，跨面板挂载留一份。
 * 面板是宿主 `main` 的 keyed 占用者，卸载再挂载；状态只活组件里就会在 loading → 两栏 → 骨架之间轮换。
 * 收成可实例化场景（`createTrashSnapshotScene`），由 `scene.ts` 的 `ClientScene` 聚合；读一次、不订阅。
 * 详情账本独立于清单快照存在；它不是清单状态第四态，也不是持久化。**失败时整份丢掉**——读不到就不许
 * 拿旧行冒充此刻的回收站。也不记折叠集、列宽、孩子视图（视图状态，跨挂载记住与 ADR-0050 冲突）。
 * **何时丢什么**收进意图名（ADR-0048 的可观察规则）：`reloadSucceeded` 只管成功；`reloadFailed` /
 * `emptiedTrash` 见各自方法注；`writeSucceeded` 按落地名单丢详情，不等清单重读。
 */
import { writeDetail } from './detail-ledger.js'
import type { TrashDetailLike, TrashEntryLike } from './remote.js'
import { getDefaultClientScene } from './scene.js'

/** 快照的形状：只搬清册/详情线上已有的只读事实，不带时间戳或"读了几次"这类读数。 */
export interface TrashSnapshot {
  readonly rows: readonly TrashEntryLike[]
  readonly selectedId: string | null
  readonly details: ReadonlyMap<string, TrashDetailLike>
}

/** 一台首帧快照 + 详情账本：意图名与可观察规则住类型，实例互不串味。 */
export interface TrashSnapshotScene {
  /** 读当前快照；没有（或已 clear）⇒ null。只在挂载首帧读一次，不做订阅。 */
  read(): TrashSnapshot | null
  /** 读一条已成功读到的详情：详情账本的唯一读口，清单快照是否存在不影响它。 */
  readDetail(entryId: string): TrashDetailLike | undefined
  /** 写入一份**成功**的清单读数：复制数组、按上一份清单修剪详情账本，选中行不在了就置空。 */
  reloadSucceeded(rows: readonly TrashEntryLike[]): void
  /** 记下选中行；没有清单快照时无处可挂，直接忽略。 */
  noteSelection(entryId: string | null): void
  /** 记下一条成功读到的详情（写时复制）；失败不写。 */
  writeDetail(entryId: string, detail: TrashDetailLike): void
  /** 丢掉一条详情（恢复 / 彻底删除成功、或那一条的读数失败）。 */
  rowGone(entryId: string): void
  /** 按写动作的成功名单丢一组详情。 */
  writeSucceeded(entryIds: readonly string[]): void
  /** 丢掉整份快照与详情账本：清单读失败、清空失败，以及测试/HMR 复位。 */
  reloadFailed(): void
  /** 只丢详情账本，清单快照原样留着：清空回收站**成功**后走这一条。 */
  emptiedTrash(): void
  /** 场景收场：与 `reloadFailed` 同一条（快照/账本没有额外的在飞票要作废）。 */
  reset(): void
}

export function createTrashSnapshotScene(): TrashSnapshotScene {
  let snapshot: TrashSnapshot | null = null
  let details: Map<string, TrashDetailLike> = new Map()

  const scene: TrashSnapshotScene = {
    read: (): TrashSnapshot | null => snapshot,
    readDetail: (entryId: string): TrashDetailLike | undefined => details.get(entryId),
    reloadSucceeded(rows: readonly TrashEntryLike[]): void {
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
    },
    noteSelection(entryId: string | null): void {
      if (snapshot === null) return
      snapshot = { ...snapshot, selectedId: entryId }
    },
    writeDetail(entryId: string, detail: TrashDetailLike): void {
      const next = new Map(details)
      writeDetail(next, entryId, detail)
      details = next
      if (snapshot !== null) snapshot = { ...snapshot, details }
    },
    rowGone(entryId: string): void {
      if (!details.has(entryId)) return
      const next = new Map(details)
      next.delete(entryId)
      details = next
      if (snapshot !== null) snapshot = { ...snapshot, details }
    },
    writeSucceeded(entryIds: readonly string[]): void {
      for (const id of entryIds) scene.rowGone(id)
    },
    reloadFailed(): void {
      snapshot = null
      details = new Map()
    },
    emptiedTrash(): void {
      details = new Map()
      if (snapshot !== null) snapshot = { ...snapshot, details }
    },
    reset(): void {
      scene.reloadFailed()
    },
  }
  return scene
}

/* ── 兼容自由函数（旧调用点与测试）：委托默认场景的实例 ────────────────────────── */

export function readTrashSnapshot(): TrashSnapshot | null {
  return getDefaultClientScene().snapshot.read()
}

/** 读一条已成功读到的详情（默认场景）。名字带 `Cached`：Node 半的 `trash/detail.ts` 也有一个
 *  `readTrashDetail`（读会话日志），两个「唯一实现」不是同一个东西，grep 不该把它们混在一起。 */
export function readCachedTrashDetail(entryId: string): TrashDetailLike | undefined {
  return getDefaultClientScene().snapshot.readDetail(entryId)
}

/** 写回成功读数：失败支不许调（默认场景）。 */
export function reloadSucceeded(rows: readonly TrashEntryLike[]): void {
  getDefaultClientScene().snapshot.reloadSucceeded(rows)
}

export function noteSelection(entryId: string | null): void {
  getDefaultClientScene().snapshot.noteSelection(entryId)
}

export function writeTrashDetail(entryId: string, detail: TrashDetailLike): void {
  getDefaultClientScene().snapshot.writeDetail(entryId, detail)
}

export function rowGone(entryId: string): void {
  getDefaultClientScene().snapshot.rowGone(entryId)
}

export function writeSucceeded(entryIds: readonly string[]): void {
  getDefaultClientScene().snapshot.writeSucceeded(entryIds)
}

export function reloadFailed(): void {
  getDefaultClientScene().snapshot.reloadFailed()
}

export function emptiedTrash(): void {
  getDefaultClientScene().snapshot.emptiedTrash()
}
