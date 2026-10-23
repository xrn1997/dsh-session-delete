/**
 * 清册的两个读面：**真相读走 `list()`（先对账，再交行）；pure 读面走 `raw()`（只回索引，不写行）**。
 *
 * 外部事实源是 `session-trash/` 里的目录；`manifest.list()` 只是 raw 索引。
 * 消费方只认这个 seam：写动作与真相读用 `list()`，不再各自记得"读前先 reconcile"；`/orphans` 与 `/detail`
 * 声明为 pure，只许 `raw()`——一次 pure 读若顺手对账，就等于把一个写动作带到了到达序链之外。
 * **它不是 `ManifestPort`**：同名 `list()` 的语义已经换成真相读，拿它当 raw 端口用会漏对账或递归对账。
 * 两条写口从 raw 端口取；raw 端口本身只留给本 module 与 `src/trash/reconcile.ts` 的 implementation。
 */
import type { FsPort } from '../ports/fs-port.js'
import type { TrashEntry } from './entry.js'
import type { ManifestPort } from './manifest.js'
import { reconcileTrash } from './reconcile.js'

export interface TrashLedger extends Pick<ManifestPort, 'add' | 'remove'> {
  /** 真相读：先对账、再交行。`/list`、`/empty` 与写动词都认这一条。 */
  list(): Promise<TrashEntry[]>
  /** raw 索引快照：**不对账、不写行**。只给声明为 pure 的读面（`/orphans` 扫描、`/detail` 详情）；
   *  要知道"此刻真有的一切"用 `list()`。 */
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
