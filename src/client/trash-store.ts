/**
 * 回收站清单的失效通告台：动过回收站的动作戳一下，挂载时取一次数的面板据此重读（移入回收站住在侧栏菜单，
 * 两者无共同父级）。语义只有"变过"——一个递增修订号；实例由 `scene.ts` 创建并装成默认实例。
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
