/**
 * 清册的两个读面：**真相读走 `list()`（先对账，再交行）；pure 读面走 `raw()`（只回索引，不写行）**。外部事实源是 `session-trash/` 里的目录；
 * `manifest.list()` 只是 raw 索引。写动作与真相读用 `list()`；`/orphans`、`/detail` 声明为 pure，只许 `raw()`——一次 pure 读顺手对账就等于
 * 把写动作带到到达序链之外。`/projection-clean` 虽是 chained 写动作也用 `raw()`：要保住目录不在的幽灵行，先对账会把行摘掉（ADR-0062）。
 * **它不是 `ManifestPort`**：同名 `list()` 的语义已换成真相读，拿它当 raw 端口用会漏对账或递归对账。
 */
import type { FsPort } from '../ports/fs-port.js'
import type { TrashEntry } from './entry.js'
import type { ManifestPort } from './manifest.js'
import { reconcileTrash } from './reconcile.js'

export interface TrashLedger extends Pick<ManifestPort, 'add' | 'remove'> {
  /** 真相读：先对账、再交行。`/list`、`/empty` 与写动词都认这一条。 */
  list(): Promise<TrashEntry[]>
  /** raw 索引快照：**不对账、不写行**。只给声明为 pure 的读面；要知道"此刻真有的一切"用 `list()`。 */
  raw(): Promise<TrashEntry[]>
}

export function createTrashLedger(raw: ManifestPort, fs: FsPort, home: string): TrashLedger {
  return {
    list: () => reconcileTrash({ fs, manifest: raw, home }),
    raw: () => raw.list(),
    add: (entry) => raw.add(entry),
    remove: (id) => raw.remove(id),
  }
}
