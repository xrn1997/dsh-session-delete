/**
 * 归档档的**失效通告台**：动过归档可见性的动作戳一下，归档档据此重新取数。
 * 形状与 `trash-store.ts` 同款（模块级现场；订阅/通告只住 `store.ts` 的 `createStore`）。
 *
 * 语义只有"变过"这一件事：一个递增的修订号。谁戳：A1（宿主归档集旁路观察）与
 * 归档档的自救动作（解除归档）。删除/撤销**不戳这里**——那条链由 `useArchiveQuery`
 * 直接订阅 `useTrashRevision()`（恢复/撤销会让已归档会话重新可见，删除会让它消失）。
 * 消费者只有一个：`useArchiveQuery` 的重读 effect（唯一入口 `reload`，不造第二套）。
 */
import { createStore } from './store.js'

const revisionStore = createStore(0)

/** 通告一次"归档可见性变过了"（A1 观察、解除归档自救）。 */
export function invalidateArchive(): void {
  revisionStore.update((revision) => revision + 1)
}

/** 供归档查询订阅。 */
export function useArchiveRevision(): number {
  return revisionStore.use()
}

/** 测试专用：修订号归零（订阅者随组件卸载自行退订）。 */
export function resetArchiveStore(): void {
  revisionStore.reset()
}
