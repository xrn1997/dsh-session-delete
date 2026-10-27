/**
 * **同批已带走集**（「已被同批前一条带走」的 id）的唯一实现（ADR-0002 的内部实现）。
 *
 * 两种 id 域各一个 adapter：
 * - entry 适配：restore / purge 的条目 id，`claim` 是三态（fresh / carried / absent），组语义仍读
 *   `trash/groups.ts`；
 * - session 适配：delete 的会话 id，`claim` 只有 fresh / carried，集合由动词结果长出。
 *
 * entry 适配的三态判据读 `groups.claimOf`；session 适配没有原始清册视图，只记 `take` 过的会话 id。
 * 当前只读视图（`rows`）只挂在 entry 域上：只有 purge 要它——盘上后代要按清册里还在的 id 排除。
 */
import { bareSessionId } from '../ports/host-port.js'
import type { TrashEntry } from '../trash/entry.js'
import { claimOf, groupOf, type GroupClaim } from '../trash/groups.js'

export interface EntryBatchCarried {
  claim(id: string): GroupClaim
  take(id: string): void
  /** 收缩中的当前视图（`take` 过的那一组已经不在里面）。 */
  rows(): readonly TrashEntry[]
}

/** session 域没有组可交：claim 只回答 fresh / carried。 */
export type SessionClaim = { readonly verdict: 'fresh' | 'carried' }

export interface SessionBatchCarried {
  claim(id: string): SessionClaim
  take(id: string): void
}

/** 恢复 / 彻底删除：原始快照认得、当前视图已经空了 ⇒ 同批前一条带走的。 */
export function createEntryCarried(original: readonly TrashEntry[]): EntryBatchCarried {
  let current = [...original]
  return {
    claim(id) {
      return claimOf(original, current, id)
    },
    take(id) {
      const gone = new Set(groupOf(current, id).map((row) => row.id))
      if (gone.size === 0) return
      current = current.filter((row) => !gone.has(row.id))
    },
    rows: () => current,
  }
}

/** 删除：会话 id 域；`take` 只收这次真的搬走的成员（父 + 盘上的孩子）。 */
export function createSessionCarried(): SessionBatchCarried {
  const carried = new Set<string>()
  return {
    claim(id): SessionClaim {
      return carried.has(bareSessionId(id))
        ? { verdict: 'carried' }
        : { verdict: 'fresh' }
    },
    take(id) {
      carried.add(bareSessionId(id))
    },
  }
}
