/**
 * 宿主列表批量删除的**选中集现场**：多选模式 + 选中名单，一份合并快照。
 * 读写它有四个座位（菜单入口、行首勾选、行尾兜底、浮条与确认框），状态住一处；订阅/通告仍只住
 * `store.ts` 的 `createStore`。**合并快照**而非两个 store：两半成对变化，分两份会让「进模式那一帧」
 * 出现两次通告与不同步的缝。名单序 = 逐条勾选序，「全选」追加在登记序之后（`/apply` 吃的就是它）。
 * 形状是可实例化的现场（`createBatchSelectionScene`），聚合住 `scene.ts`；自由函数委托默认场景。
 */
import { getDefaultClientScene, useClientScene } from './scene.js'
import { createStore } from './store.js'

export interface PickItem {
  /** 宿主槽位投影的会话 id，原样透给 `applyOutcomes('delete', …)`。 */
  readonly sessionId: string
  /** 删除那一刻的会话名（投影的 `displayTitle`）：只用于文案与确认框，不参与请求。 */
  readonly title: string
}

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
  /** 清空名单但**留在多选态**（「取消全选」那颗）；已经空了就不发通告。 */
  clear(): void
  /** 只追加还没选过的条目；原有选中在前、新条目按传入序接在后面。 */
  add(items: readonly PickItem[]): void
  shrinkToFailures(failedSessionIds: readonly string[]): void
  reset(): void
}

export function createBatchSelectionScene(): BatchSelectionScene {
  const selectionStore = createStore(INITIAL)
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
      selectionStore.update((current) =>
        current.selecting || current.picks.length > 0 ? INITIAL : current,
      )
    },
    toggle(item: PickItem): void {
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
    },
    clear(): void {
      selectionStore.update((current) =>
        current.picks.length === 0 ? current : { ...current, picks: [] },
      )
    },
    add(items: readonly PickItem[]): void {
      selectionStore.update((current) => {
        const chosen = new Set(current.picks.map((item) => item.sessionId))
        const additions: PickItem[] = []
        for (const item of items) {
          if (chosen.has(item.sessionId)) continue
          chosen.add(item.sessionId)
          additions.push(item)
        }
        return additions.length === 0 ? current : { ...current, picks: [...current.picks, ...additions] }
      })
    },
    shrinkToFailures(failedSessionIds: readonly string[]): void {
      const keep = new Set(failedSessionIds)
      // 保持既有语义：哪怕一条都没被剔掉也发一次通告（收缩发生在一次执行之后，订阅方按"执行完了"重读）。
      selectionStore.update((current) => ({
        ...current,
        picks: current.picks.filter((item) => keep.has(item.sessionId)),
      }))
    },
    reset(): void {
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

export function clearPicks(): void {
  getDefaultClientScene().batchSelection.clear()
}

export function addPicks(items: readonly PickItem[]): void {
  getDefaultClientScene().batchSelection.add(items)
}

export function shrinkPicksToFailures(failedSessionIds: readonly string[]): void {
  getDefaultClientScene().batchSelection.shrinkToFailures(failedSessionIds)
}

export function resetSelection(): void {
  getDefaultClientScene().batchSelection.reset()
}
