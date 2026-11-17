/**
 * 回收站清单的**失效通告台**：动过回收站的动作戳一下，清单面板据此重新取数。
 *
 * 为什么需要它（真机反馈）：回收站面板是「挂载时取一次数」（`useEffect(reload)`），而删除发生在
 * **侧栏菜单**那边（`delete-confirm.tsx` 的常驻宿主），两者没有共同的父组件——删完之后中央那个
 * 面板（如果正开着）不会自己重读，用户得切走再切回来（= 重新挂载）才看得见新条目。撤销（`undo-notices.ts`）
 * 同理。
 *
 * 形状：**可实例化的现场**（`createTrashRevisionScene`）——语义只有"变过"这一件事：一个递增的修订号。
 * 订阅/通告那套骨架仍只住 `store.ts` 的 `createStore` 里。跨槽位无共同父级 ⇒ 实例由注册面创建
 * （`scene.ts` 的 `ClientScene`）并同时装成默认实例，自由函数委托它；测试可 `createClientScene()`
 * 各造一份互不串味（见 `tests/client/scene.test.ts`）。
 */
import { getDefaultClientScene, useClientScene } from './scene.js'
import { createStore } from './store.js'

/** 一台回收站修订台：戳一下 / 订阅 / 收场。 */
export interface TrashRevisionScene {
  /** 通告一次"回收站变过了"（删除成功、撤销成功；面板自己的恢复/彻底删除则就地重读）。 */
  invalidate(): void
  /** 供面板与归档档订阅：修订号进 `useGatedRefresh` 的修订集合。 */
  use(): number
  /** 场景收场：修订号归零（订阅者随组件卸载自行退订）。 */
  reset(): void
}

export function createTrashRevisionScene(): TrashRevisionScene {
  const revisionStore = createStore(0)
  return {
    invalidate(): void {
      revisionStore.update((revision) => revision + 1)
    },
    use(): number {
      return revisionStore.use()
    },
    reset(): void {
      revisionStore.reset()
    },
  }
}

/** 兼容自由函数（旧调用点与测试）：委托默认场景的实例。 */
export function invalidateTrash(): void {
  getDefaultClientScene().trashRevisions.invalidate()
}

/** 供面板订阅（生产走 Provider 的那一份；测试无 Provider 回退默认场景）。 */
export function useTrashRevision(): number {
  return useClientScene().trashRevisions.use()
}
