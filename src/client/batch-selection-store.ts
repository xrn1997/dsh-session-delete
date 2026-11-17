/**
 * 宿主列表批量删除的**选中集现场**：多选模式 + 选中名单，一份合并快照。
 *
 * 从 `batch-select.tsx` 拆出来的理由：多选态与选中集是**同一次交互的两半**（进入模式才出现勾选框，
 * 退出模式连名单一起清），读写它们的却有四个座位——菜单里的入口（`batch-menu-item.tsx`）、行首
 * 勾选框、行尾兜底、overlay 上的浮条与确认框。状态住这一处，`batch-select.tsx` 只剩控件，
 * `host-rows.ts` 只回答"页面上现在有哪些行、点行算不算选中"。订阅/通告那套仍只住在 `store.ts`
 * 的 `createStore` 里，本文件不另写一份。
 *
 * **合并快照**而不是两个 store：两半的变化总是成对出现（`exitSelection` 清两半），订阅者
 * （勾选框、浮条）两半都要读；分两份只会让"进模式的那一帧"出现两次通告、两个快照不同步的缝。
 *
 * 名单只收槽位投影原样给的 `sessionId` / `displayTitle`（浏览器半不自己拼 id）：**逐条勾选序 = 名单序**；
 * 「全选」追加的条目按 `host-rows.ts` 的槽位登记序接在后面。`/apply` 那条「保持输入顺序」吃到的就是这份名单序。
 *
 * 形状：**可实例化的现场**（`createBatchSelectionScene`）——快照住实例，由 `scene.ts` 的
 * `ClientScene` 聚合；自由函数委托默认场景（兼容旧调用点与测试），读数 hook 走 `useClientScene()`。
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
  /** 多选模式：入口在每一行的「⋯」菜单里；只有模式内才渲染勾选框、才吃整行点击。 */
  readonly selecting: boolean
  readonly picks: readonly PickItem[]
}

const INITIAL: SelectionState = { selecting: false, picks: [] }

/** 一台批量选中现场：读快照 / 模式与名单的翻转 / 收缩 / 收场。 */
export interface BatchSelectionScene {
  get(): SelectionState
  /** 当前选中的条目（名单序）。 */
  picks(): readonly PickItem[]
  /** 是否多选态。 */
  isSelecting(): boolean
  /** 供组件订阅：模式与名单是同一次交互的两半，读它们的组件订同一份快照。 */
  useSelection(): SelectionState
  /** 「⋯ → 多选」按下时进入；重复进入是幂等的（同一份快照，不发通告）。 */
  enter(): void
  /** 退出模式并清空名单：多选态和选中集是同一次交互的两半，退出后不该留下看不见的名单。 */
  exit(): void
  /** 翻转一条：没选过就排队尾，选过就摘掉（列表里永远不会有重复 id）。 */
  toggle(item: PickItem): void
  /** 清空名单但**留在多选态**（「取消全选」那颗）；已经空了就不发通告。 */
  clear(): void
  /** 只追加还没选过的条目；名单序 = 原有选中在前、新条目按传入序接在后面。 */
  add(items: readonly PickItem[]): void
  /** 执行后收缩：只留失败名单（空数组 = 全清）。 */
  shrinkToFailures(failedSessionIds: readonly string[]): void
  /** 场景收场：模式与名单一起回初值。 */
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

/* ── 兼容自由函数（旧调用点与测试）：委托默认场景的实例 ────────────────────────── */

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

/** 「⋯ → 多选」按下时进入（默认场景）。 */
export function enterSelection(): void {
  getDefaultClientScene().batchSelection.enter()
}

/** 退出模式并清空名单（默认场景）。 */
export function exitSelection(): void {
  getDefaultClientScene().batchSelection.exit()
}

/** 翻转一条（默认场景）。 */
export function togglePick(item: PickItem): void {
  getDefaultClientScene().batchSelection.toggle(item)
}

/** 清空名单但留在多选态（默认场景）。 */
export function clearPicks(): void {
  getDefaultClientScene().batchSelection.clear()
}

/** 只追加还没选过的条目（默认场景）。 */
export function addPicks(items: readonly PickItem[]): void {
  getDefaultClientScene().batchSelection.add(items)
}

/** 执行后收缩（默认场景）。 */
export function shrinkPicksToFailures(failedSessionIds: readonly string[]): void {
  getDefaultClientScene().batchSelection.shrinkToFailures(failedSessionIds)
}

/** 测试专用：默认场景的模式与名单一起回初值。 */
export function resetSelection(): void {
  getDefaultClientScene().batchSelection.reset()
}
