/**
 * 回收站清单的**失效通告台**：动过回收站的动作戳一下，清单面板据此重新取数。
 *
 * 为什么需要它（真机反馈）：回收站面板是「挂载时取一次数」（`useEffect(refreshAll)`），而删除发生在
 * **侧栏菜单**那边（`delete-confirm.tsx` 的常驻宿主），两者没有共同的父组件——删完之后中央那个
 * 面板（如果正开着）不会自己重读，用户得切走再切回来（= 重新挂载）才看得见新条目。撤销（`undo-notices.ts`）
 * 同理。
 *
 * 形状与两个邻居同款（`undo-notices.ts` 的通知台、`delete-confirm.tsx` 的现场）：**模块级现场**，
 * 订阅/通告那套只住在 `store.ts` 的 `createStore` 里——这些现场都挂在 `shell.overlay`／`main`
 * 这些各不相邻的座位上，模块级是它们唯一的共同点。
 *
 * 语义只有"变过"这一件事：一个递增的修订号（测试收场时归零）。面板把它写进 effect 的依赖里，
 * 戳一次重读一次；不需要知道是谁动的、动了什么（清单本体永远是问宿主要）。
 */
import { createStore } from './store.js'

const revisionStore = createStore(0)

/** 通告一次"回收站变过了"（删除成功、撤销成功；面板自己的恢复/彻底删除则就地重读）。 */
export function invalidateTrash(): void {
  revisionStore.update((revision) => revision + 1)
}

/** 供面板订阅。 */
export function useTrashRevision(): number {
  return revisionStore.use()
}

/** 测试专用：修订号归零（订阅者随组件卸载自行退订）。 */
export function resetTrashStore(): void {
  revisionStore.reset()
}
