import type { ManifestPort } from '../../src/trash/manifest.js'
import type { TrashEntry } from '../../src/trash/entry.js'

/** 测试用的 raw 清册端口：内存实现，让 ledger、对账与详情读面都不必挂宿主 storage 域。
 *  产品侧的绑定只有 `src/trash/storage-manifest.ts` 那一条。 */
export function createMemoryManifest(seed: TrashEntry[] = []): ManifestPort {
  const rows = new Map<string, TrashEntry>(seed.map(e => [e.id, e]))
  return {
    async list() { return [...rows.values()].sort((a, b) => b.deletedAt - a.deletedAt) },
    async add(e) { rows.set(e.id, e) },
    async remove(id) { rows.delete(id) },
  }
}
