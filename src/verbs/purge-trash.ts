import { trashDirOf, type TrashEntry } from '../trash/entry.js'
import type { DeleteDeps } from './delete-session.js'
import { verbError } from './errors.js'

export function purgeTrash(deps: DeleteDeps) {
  return async function purgeTrash(entryId?: string): Promise<{ removed: number; freedBytes: number }> {
    const all = await deps.manifest.list()
    const targets: TrashEntry[] = entryId ? all.filter(e => e.id === entryId) : all
    if (entryId && targets.length === 0) throw verbError('trash-empty', `回收站里没有这一条：${entryId}`)

    let freedBytes = 0
    for (const entry of targets) {
      const dir = trashDirOf(entry.id, deps.home)
      // 目录可能已被手工删掉：那就不再有字节可释放，但仍要摘清单行（否则回收站永远多一条点不开的）
      if (await deps.fs.exists(dir)) {
        freedBytes += await deps.fs.sizeOfDir(dir)
        await deps.fs.removeDir(dir).catch((error) => {
          throw verbError('io', `删除回收站目录失败：${String(error)}`, error)
        })
      }
      await deps.manifest.remove(entry.id)
      // 彻底删除也要把宿主内存里那一份请掉、并如实通告客户端（清单里可能是修复前删的，或它又活了过来）。
      // 同样不抛、不影响"已彻底删除"这个结果；只有知道宿主列表已经干净时才通告。
      const eviction = await deps.host.evictLive(entry.sessionId)
      if (eviction !== 'unknown') await deps.host.announceRemoved(entry.sessionId)
    }
    return { removed: targets.length, freedBytes }
  }
}
