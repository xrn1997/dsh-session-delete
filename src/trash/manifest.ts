import type { TrashEntry } from './entry.js'

/** 回收站清单的**唯一**读法（动词只依赖这个端口，不认 storage domain 的形状）。 */
export interface ManifestPort {
  list(): Promise<TrashEntry[]>
  add(e: TrashEntry): Promise<void>
  remove(id: string): Promise<void>
}

export function createMemoryManifest(seed: TrashEntry[] = []): ManifestPort {
  const rows = new Map<string, TrashEntry>(seed.map(e => [e.id, e]))
  return {
    async list() { return [...rows.values()].sort((a, b) => b.deletedAt - a.deletedAt) },
    async add(e) { rows.set(e.id, e) },
    async remove(id) { rows.delete(id) },
  }
}

/** 宿主 storage domain 的最小面。这是**接缝**，不是对宿主 API 的断言：
 *  探针只枚举到 `ctx.storageDomain` 有 `open` / `get` / `domains` / `reserved` 等成员，
 *  **没有**枚举 `open()` 返回的 domain 句柄面 ⇒ 真实绑定由 `createStorageManifest` 写一层薄适配
 *  （官方读面若只有迭代器/快照，就把迭代器折成 `readAll()`，不在动词层引入第二种读法）。 */
export interface StorageDomainLike {
  readAll(): Promise<TrashEntry[]>
  put(record: TrashEntry): Promise<void>
  delete(key: string): Promise<void>
}

export function createStorageManifest(domain: StorageDomainLike): ManifestPort {
  return {
    async list() { return (await domain.readAll()).sort((a, b) => b.deletedAt - a.deletedAt) },
    async add(e) { await domain.put(e) },
    async remove(id) { await domain.delete(id) },
  }
}
