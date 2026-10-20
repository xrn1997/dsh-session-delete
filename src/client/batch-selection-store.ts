/**
 * 宿主列表批量删除的**选中集现场**（2026-10-20）：多选模式 + 选中名单，一份合并快照。
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
 * 「全选」追加的条目按 `host-rows.ts` 读到的 DOM 序接在后面。`/apply` 那条「保持输入顺序」吃到的就是这份名单序。
 */
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

const selectionStore = createStore(INITIAL)

export function getSelection(): SelectionState {
  return selectionStore.get()
}

export function getPicks(): readonly PickItem[] {
  return getSelection().picks
}

export function isSelecting(): boolean {
  return getSelection().selecting
}

/** 供组件订阅：模式与名单是同一次交互的两半，读它们的组件订同一份快照。 */
export function useSelection(): SelectionState {
  return selectionStore.use()
}

/** 「⋯ → 多选」按下时进入；重复进入是幂等的（同一份快照，不发通告）。 */
export function enterSelection(): void {
  selectionStore.update((current) => (current.selecting ? current : { ...current, selecting: true }))
}

/** 退出模式并清空名单：多选态和选中集是同一次交互的两半，退出后不该留下看不见的名单。 */
export function exitSelection(): void {
  selectionStore.update((current) =>
    current.selecting || current.picks.length > 0 ? INITIAL : current,
  )
}

/** 翻转一条：没选过就排队尾，选过就摘掉（列表里永远不会有重复 id）。 */
export function togglePick(item: PickItem): void {
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

/** 清空名单但**留在多选态**（「取消全选」那颗）；已经空了就不发通告。 */
export function clearPicks(): void {
  selectionStore.update((current) =>
    current.picks.length === 0 ? current : { ...current, picks: [] },
  )
}

/** 只追加还没选过的条目；名单序 = 原有选中在前、新条目按传入序接在后面。没有新条目就不发通告。 */
export function addPicks(items: readonly PickItem[]): void {
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
}

/** 执行后收缩：只留失败名单（空数组 = 全清）。成功的随通告从侧栏消失，不该留在名单里。 */
export function shrinkPicksToFailures(failedSessionIds: readonly string[]): void {
  const keep = new Set(failedSessionIds)
  // 保持既有语义：哪怕一条都没被剔掉也发一次通告（收缩发生在一次执行之后，订阅方按"执行完了"重读）。
  selectionStore.update((current) => ({
    ...current,
    picks: current.picks.filter((item) => keep.has(item.sessionId)),
  }))
}

/** 测试专用：模式与名单一起回初值（订阅者随组件卸载自行退订）。 */
export function resetSelection(): void {
  selectionStore.reset()
}
