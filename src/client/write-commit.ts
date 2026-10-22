import { afterDelete, afterRestore } from './main-view.js'
import { invalidateTrash } from './trash-store.js'

/**
 * 回收站面板之外发生的写入（菜单删除、批量删除、撤销恢复）的**跨槽位收尾顺序**：
 * 主视图收尾 → 失效回收站 → 撤销通告。调用时机（信封成功、receipt、之后才 refresh）
 * 归 `src/client/write.ts` 的 `runWrite`；这里只做 commit 本体。
 */
export function commitExternalDelete(input: {
  sessionIds: readonly string[]
  publishUndo(): void
}): void {
  afterDelete(input.sessionIds)
  invalidateTrash()
  input.publishUndo()
}

export function commitExternalRestore(sessionIds: readonly string[]): void {
  afterRestore(sessionIds)
  invalidateTrash()
}
