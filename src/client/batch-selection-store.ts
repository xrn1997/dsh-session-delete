/**
 * 宿主列表批量移入回收站的**选中集现场**：多选模式 + 选中名单，一份合并快照。
 * 读写它有四个座位（菜单入口、行首勾选、行尾兜底、浮条），状态住一处；订阅/通告仍只住
 * `store.ts` 的 `createStore`。**合并快照**而非两个 store：两半成对变化，分两份会让「进模式那一帧」
 * 出现两次通告与不同步的缝。名单序 = 逐条勾选序，「全选」追加在登记序之后（`/apply` 吃的就是它）。
 * 形状是可实例化的现场（`createBatchSelectionScene`），聚合住 `scene.ts`；自由函数委托默认场景。
 */
import { getDefaultClientScene, useClientScene } from './scene.js'
import { createStore } from './store.js'
import type { TrashMoveTarget } from './write-seats.js'

/** 选中集一条 = 一条待移入回收站的会话：与 `write-seats.ts` 的 `TrashMoveTarget` 同一形状、同一义，
 *  `title` 是移入回收站那一刻的显示名（投影的 `displayTitle`），只用于已选清单与撤销/失败原文，不参与请求。 */
export type PickItem = TrashMoveTarget

export interface SelectionState {
  readonly selecting: boolean
  readonly picks: readonly PickItem[]
}

const INITIAL: SelectionState = { selecting: false, picks: [] }

/** 一台批量选中现场：读快照 / 模式与名单的翻转 / 收缩 / 收场。 */
export interface BatchSelectionScene {
  get(): SelectionState
  picks(): readonly PickItem[]
  isSelecting(): boolean
  /** 供组件订阅：模式与名单是同一次交互的两半，读它们订同一份快照。 */
  useSelection(): SelectionState
  /** 「⋯ → 多选」按下时进入；重复进入幂等（同一份快照，不发通告）。 */
  enter(): void
  exit(): void
  /** 翻转一条：没选过就排队尾，选过就摘掉（列表里永远不会有重复 id）。 */
  toggle(item: PickItem): void
  /** Shift+点：按 `rows` 序勾上「锚点→item」整段（等价 add，去重保序）；锚点缺失或段内任一端不在
   *  `rows` 里 ⇒ 退化为 `toggle` 并立锚（范围无从谈起）。锚点 = 最近一次 `toggle` 的那条；范围不移锚。 */
  toggleRange(item: PickItem, rows: readonly PickItem[]): void
  /** 清空名单但**留在多选态**（「取消全选」那颗）；已经空了就不发通告。 */
  clear(): void
  /** 只追加还没选过的条目；原有选中在前、新条目按传入序接在后面。 */
  add(items: readonly PickItem[]): void
  /** 按本批失败名单收缩选中集；传入 `submittedSessionIds` 时只剔除本批成功项，保留失败项及在飞期间新勾选的会话。 */
  shrinkToFailures(failedSessionIds: readonly string[], submittedSessionIds?: readonly string[]): void
  reset(): void
}

export function createBatchSelectionScene(): BatchSelectionScene {
  const selectionStore = createStore(INITIAL)
  /** 范围勾选的锚点（Shift+点的起点）；只活在场景内部，不进 SelectionState 快照。exit/clear/reset 或被收缩剔除时清掉。 */
  let anchor: string | null = null
  /** `add` 的去重追加逻辑（`toggleRange` 与 `add` 共用一份判据）。 */
  const appendNew = (current: SelectionState, items: readonly PickItem[]): SelectionState => {
    const chosen = new Set(current.picks.map((item) => item.sessionId))
    const additions: PickItem[] = []
    for (const item of items) {
      if (chosen.has(item.sessionId)) continue
      chosen.add(item.sessionId)
      additions.push(item)
    }
    return additions.length === 0 ? current : { ...current, picks: [...current.picks, ...additions] }
  }
  /** 单条翻转（`toggle` 与 `toggleRange` 的退化支共用）：翻哪条，锚点就落在哪条。 */
  const flip = (item: PickItem): void => {
    anchor = item.sessionId
    selectionStore.update((current) => {
      const at = current.picks.findIndex((candidate) => candidate.sessionId === item.sessionId)
      return {
        ...current,
        picks:
          at === -1
            ? [...current.picks, item]
            : current.picks.filter((candidate) => candidate.sessionId !== item.sessionId),
      }
    })
  }
  return {
    get: (): SelectionState => selectionStore.get(),
    picks: (): readonly PickItem[] => selectionStore.get().picks,
    isSelecting: (): boolean => selectionStore.get().selecting,
    useSelection(): SelectionState {
      return selectionStore.use()
    },
    enter(): void {
      selectionStore.update((current) => (current.selecting ? current : { ...current, selecting: true }))
    },
    exit(): void {
      anchor = null
      selectionStore.update((current) =>
        current.selecting || current.picks.length > 0 ? INITIAL : current,
      )
    },
    toggle(item: PickItem): void {
      flip(item)
    },
    toggleRange(item: PickItem, rows: readonly PickItem[]): void {
      const from = anchor === null ? -1 : rows.findIndex((candidate) => candidate.sessionId === anchor)
      const to = rows.findIndex((candidate) => candidate.sessionId === item.sessionId)
      if (from === -1 || to === -1) {
        flip(item)
        return
      }
      const [lo, hi] = from <= to ? [from, to] : [to, from]
      selectionStore.update((current) => appendNew(current, rows.slice(lo, hi + 1)))
    },
    clear(): void {
      anchor = null
      selectionStore.update((current) =>
        current.picks.length === 0 ? current : { ...current, picks: [] },
      )
    },
    add(items: readonly PickItem[]): void {
      selectionStore.update((current) => appendNew(current, items))
    },
    shrinkToFailures(failedSessionIds: readonly string[], submittedSessionIds?: readonly string[]): void {
      const failed = new Set(failedSessionIds)
      if (submittedSessionIds === undefined) {
        if (anchor !== null && !failed.has(anchor)) anchor = null
        // 保持既有语义：哪怕一条都没被剔掉也发一次通告（收缩发生在一次执行之后，订阅方按"执行完了"重读）。
        selectionStore.update((current) => ({
          ...current,
          picks: current.picks.filter((item) => failed.has(item.sessionId)),
        }))
        return
      }
      const succeeded = new Set(submittedSessionIds.filter((id) => !failed.has(id)))
      if (anchor !== null && succeeded.has(anchor)) anchor = null
      selectionStore.update((current) => ({
        ...current,
        picks: current.picks.filter((item) => !succeeded.has(item.sessionId)),
      }))
    },
    reset(): void {
      anchor = null
      selectionStore.reset()
    },
  }
}

export function getSelection(): SelectionState {
  return getDefaultClientScene().batchSelection.get()
}

export function getPicks(): readonly PickItem[] {
  return getDefaultClientScene().batchSelection.picks()
}

export function isSelecting(): boolean {
  return getDefaultClientScene().batchSelection.isSelecting()
}

/** 供组件订阅（生产走 Provider 的那一份；测试无 Provider 回退默认场景）。 */
export function useSelection(): SelectionState {
  return useClientScene().batchSelection.useSelection()
}

export function enterSelection(): void {
  getDefaultClientScene().batchSelection.enter()
}

export function exitSelection(): void {
  getDefaultClientScene().batchSelection.exit()
}

export function togglePick(item: PickItem): void {
  getDefaultClientScene().batchSelection.toggle(item)
}

export function toggleRangePick(item: PickItem, rows: readonly PickItem[]): void {
  getDefaultClientScene().batchSelection.toggleRange(item, rows)
}

export function clearPicks(): void {
  getDefaultClientScene().batchSelection.clear()
}

export function addPicks(items: readonly PickItem[]): void {
  getDefaultClientScene().batchSelection.add(items)
}

export function shrinkPicksToFailures(
  failedSessionIds: readonly string[],
  submittedSessionIds?: readonly string[],
): void {
  getDefaultClientScene().batchSelection.shrinkToFailures(failedSessionIds, submittedSessionIds)
}

export function resetSelection(): void {
  getDefaultClientScene().batchSelection.reset()
}
