/**
 * 归档档的**失效通告台**：动过归档可见性的动作戳一下（递增修订号），归档档据此重新取数。
 * 移入回收站/撤销不戳这里——那条链由 `useArchiveQuery` 直接订阅 `useTrashRevision()`；消费者只有它。
 */
import { getDefaultClientScene, useClientScene } from './scene.js'
import { createStore } from './store.js'

export interface ArchiveRevisionScene {
  invalidate(): void
  use(): number
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

export function invalidateArchive(): void {
  getDefaultClientScene().archiveRevisions.invalidate()
}

/** 供归档查询订阅（生产走 Provider 的那一份；测试无 Provider 回退默认场景）。 */
export function useArchiveRevision(): number {
  return useClientScene().archiveRevisions.use()
}

export function resetArchiveStore(): void {
  getDefaultClientScene().archiveRevisions.reset()
}
