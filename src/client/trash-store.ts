/**
 * 回收站清单的**失效通告台**：动过回收站的动作戳一下，清单面板据此重新取数。
 *
 * 为什么需要它（真机反馈）：回收站面板是「挂载时取一次数」（`useEffect(reload)`），而删除发生在
 * **侧栏菜单**那边（`delete-confirm.tsx` 的常驻宿主），两者没有共同的父组件——删完之后中央那个
 * 面板（如果正开着）不会自己重读，用户得切走再切回来（= 重新挂载）才看得见新条目。撤销（`undo-toast.tsx`）
 * 同理。
 *
 * 形状与两个邻居同款（`undo-toast.tsx` 的通知台、`delete-confirm.tsx` 的现场）：**模块级现场 +
 * `useSyncExternalStore`**，不为此引状态库、也不引入上下文——三样东西都挂在 `shell.overlay`／`main`
 * 这些各不相邻的座位上，模块级是它们唯一的共同点。
 *
 * 语义只有"变过"这一件事：一个单调递增的修订号。面板把它写进 effect 的依赖里，戳一次重读一次；
 * 不需要知道是谁动的、动了什么（清单本体永远是问宿主要）。
 */
import { useSyncExternalStore } from 'react'

let revision = 0
const listeners = new Set<() => void>()

/** 通告一次"回收站变过了"（删除成功、撤销成功；面板自己的恢复/彻底删除则就地重读）。 */
export function invalidateTrash(): void {
  revision += 1
  for (const listener of listeners) listener()
}

function getTrashRevision(): number {
  return revision
}

function subscribeTrash(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 供面板订阅。 */
export function useTrashRevision(): number {
  return useSyncExternalStore(subscribeTrash, getTrashRevision, getTrashRevision)
}
