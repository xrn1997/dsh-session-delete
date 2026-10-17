import { trashDirOf, type TrashEntry } from '../trash/entry.js'
import type { DeleteDeps } from './delete-session.js'
import { verbError } from './errors.js'

export function purgeTrash(deps: DeleteDeps) {
  return async function purgeTrash(
    entryId?: string,
    // 批量（`verbs/apply.ts`）把整批共用的那一份清册快照传进来，并**就地收缩**它（父行带走孩子后，
    // 后到的孩子 id 在同批里必须认得出"已经不在了"，那是一次幂等 no-op，不是一次失败）。
    snapshot?: TrashEntry[],
  ): Promise<{ removed: number; freedBytes: number }> {
    const all = snapshot ?? await deps.manifest.list()
    // 点的是父那一行 ⇒ **整组**一起清（孩子是跟着父进来的，不该在父被彻底删除后单独留在回收站里）；
    // 点的是孩子那一行（清单不单独列它，只有手工/降级路径会走到）⇒ 只清它自己。
    // **副本**：下面要按"已清"就地收缩 `all`（让同批的下一条认得出幽灵 id），不能边删边动 `targets` 指向的同一数组。
    const targets: TrashEntry[] = entryId
      ? all.filter(e => e.id === entryId || e.parentEntryId === entryId)
      : [...all]
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
      const at = all.indexOf(entry)
      if (at >= 0) all.splice(at, 1)
      // 彻底删除也要把宿主内存里那一份请掉、并如实通告客户端（清单里可能是修复前删的，或它又活了过来）。
      // 同样不抛、不影响"已彻底删除"这个结果；只有知道宿主列表已经干净时才通告。
      const eviction = await deps.host.evictLive(entry.sessionId)
      if (eviction !== 'unknown') await deps.host.announceRemoved(entry.sessionId)
    }
    return { removed: targets.length, freedBytes }
  }
}
