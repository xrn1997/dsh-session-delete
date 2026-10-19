/**
 * **组语义的唯一家**（ADR-0001）：回收站里「这一组有谁」以及「哪些行在清单里露面」。
 *
 * 此前这条关系在四个地方各算一遍，而且已经算出两种答案：
 * `assembleTrashRows` 与 `restoreSession` 都认为「父自己也是孩子时，它接不住孩子」，
 * 而 `purgeTrash` 的 `id === x || parentEntryId === x` 不认这条 ⇒ 嵌套组上它会连带删掉不属于这一组的孙代
 * （不可恢复）。判据原文只在这里写一次：
 *
 * **接得住孩子的只有组根**——自己不记 `parentEntryId` 的那一行。父行不在、或父行自己也是孩子时，
 * 孩子必须自己占一行，否则它的字节会被头部合计数两遍（而它自己既看不见也清不掉）。
 *
 * 三个函数都是**纯函数**、都吃一份快照：`/apply` 那条路会在同一批里多次重问、而快照会被就地收缩，
 * 收缩的时机归调用方——groups module 不持有可变状态，也就没有"这份快照谁负责更新"的第二套契约。
 */
import type { TrashEntry } from './entry.js'

/** 一条露面的组根，连同它接住的孩子（顺序与清册一致）。 */
export interface TrashGroupView {
  readonly root: TrashEntry
  /** 跟着这条根进来的孩子（`parentEntryId` 指向根的 id）。根自己不在里面。 */
  readonly kids: readonly TrashEntry[]
}

/** 这些孩子的父。 */
function kidsOf(rows: readonly TrashEntry[], parentId: string): TrashEntry[] {
  return rows.filter((row) => row.parentEntryId === parentId)
}

/**
 * 清单露面的一行 = 组根，按清册原序。孩子折进根那一行（宿主的客户端本来就把 `origin:"subagent"`
 * 的行整排藏了 ⇒ 我们若单列就会冒出一堆点不到的行）。
 *
 * 折不进去的那两种孩子（父行不在 / 父行自己也是孩子）**自己站出来占一行**——那正是
 * `visibleGroups` 与 `groupOf` 共用同一条判据的地方。
 */
export function visibleGroups(rows: readonly TrashEntry[]): TrashGroupView[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const kidsByRoot = new Map<string, TrashEntry[]>()
  const folded = new Set<string>()
  for (const row of rows) {
    if (row.parentEntryId === undefined) continue
    const parent = byId.get(row.parentEntryId)
    // 父不在、或父自己也是孩子 ⇒ 这一行接不住它：不折、自己露面（否则它的字节会被算两遍）
    if (parent === undefined || parent.parentEntryId !== undefined) continue
    folded.add(row.id)
    const siblings = kidsByRoot.get(parent.id)
    if (siblings === undefined) kidsByRoot.set(parent.id, [row])
    else siblings.push(row)
  }
  return rows
    .filter((row) => !folded.has(row.id))
    .map((root) => ({ root, kids: kidsByRoot.get(root.id) ?? [] }))
}

/**
 * 一条 id 所属的整组。三种形状，三个答案：
 * - **组根** ⇒ 它自己 + 它接住的孩子（UI 点的是父那一行，删除/恢复/彻底删除都按整组走）；
 * - **孩子**（自己记着 `parentEntryId`）⇒ **只回它自己**。清单不单独列它，只有手工/降级路径会点到这里；
 * - **清册里没有这一条 id，但还有孩子指向它**（父行已被别的路径摘掉）⇒ 那一批孩子；仍然没有 ⇒ 空数组，
 *   调用方据此报 `trash-empty` / 判"已被同批前一条带走"。
 */
export function groupOf(rows: readonly TrashEntry[], id: string): TrashEntry[] {
  const root = rows.find((row) => row.id === id)
  if (root !== undefined) {
    return root.parentEntryId === undefined ? [root, ...kidsOf(rows, id)] : [root]
  }
  return kidsOf(rows, id)
}

/**
 * 「这条是被**同批前一条**带走的，还是整批开始前就没有？」
 *
 * 幂等语义只属于前者：后来者本来就不在清册里（用户点了条幽灵 id、或对账刚摘掉它）必须照样响亮报
 * `trash-empty`，不能被"已被带走"这句话掩盖成成功。**所以判据是快照的原始形状，不是当前形状**：
 * 原始快照里认得出（它自己、它的父、或它的孩子任一在），而当前快照里已经空了 ⇒ 同批带走的。
 */
export function takenByEarlierInBatch(
  original: readonly TrashEntry[],
  current: readonly TrashEntry[],
  id: string,
): boolean {
  return groupOf(original, id).length > 0 && groupOf(current, id).length === 0
}
