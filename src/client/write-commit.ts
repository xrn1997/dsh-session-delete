import { afterDelete, afterRestore } from './main-view.js'
import { invalidateTrash } from './trash-store.js'

/**
 * 回收站面板之外发生的写入（菜单删除、批量删除、撤销恢复）的**跨槽位收尾顺序**：
 * 主视图收尾 → 失效回收站 → 撤销通告。面板自己的写入，本地 refresh / 缓存的
 * 生命周期仍住在 controller 与 query 里。
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
