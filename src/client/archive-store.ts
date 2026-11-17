/**
 * 归档档的**失效通告台**：动过归档可见性的动作戳一下，归档档据此重新取数。
 *
 * 形状：**可实例化的现场**（`createArchiveRevisionScene`）——与 `trash-store.ts` 同款（语义只有
 * "变过"这一件事：一个递增的修订号），状态住在场景实例里（`scene.ts` 的 `ClientScene`）。
 * 谁戳：归档旁路观察（宿主归档集）与归档档的自救动作（解除归档）。删除/撤销**不戳这里**——
 * 那条链由 `useArchiveQuery` 直接订阅 `useTrashRevision()`（恢复/撤销会让已归档会话重新可见、
 * 删除会让它消失）。消费者只有一个：`useArchiveQuery` 的重读 effect（唯一入口 `reload`）。
 */
import { getDefaultClientScene, useClientScene } from './scene.js'
import { createStore } from './store.js'

/** 一台归档修订台：戳一下 / 订阅 / 收场。 */
export interface ArchiveRevisionScene {
  /** 通告一次"归档可见性变过了"（旁路观察、解除归档自救）。 */
  invalidate(): void
  /** 供归档查询订阅。 */
  use(): number
  /** 测试/场景收场：修订号归零。 */
  reset(): void
}

export function createArchiveRevisionScene(): ArchiveRevisionScene {
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

/** 兼容自由函数：委托默认场景的实例。 */
export function invalidateArchive(): void {
  getDefaultClientScene().archiveRevisions.invalidate()
}

/** 供归档查询订阅（生产走 Provider 的那一份；测试无 Provider 回退默认场景）。 */
export function useArchiveRevision(): number {
  return useClientScene().archiveRevisions.use()
}

/** 测试专用：默认场景的修订号归零。 */
export function resetArchiveStore(): void {
  getDefaultClientScene().archiveRevisions.reset()
}
