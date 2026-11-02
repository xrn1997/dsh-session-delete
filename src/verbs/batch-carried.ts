/**
 * **同批已带走集**（「已被同批前一条带走」的 id）的唯一实现（ADR-0002 的内部实现）。
 *
 * 两种 id 域各一个 adapter：
 * - entry 适配：restore 的条目 id，`claim` 是三态（fresh / carried / absent），组语义仍读
 *   `trash/groups.ts`；
 * - session 适配：delete 的会话 id，`claim` 只有 fresh / carried，集合由动词结果长出。
 *
 * entry 适配的三态判据读 `groups.claimOf`；session 适配没有原始清册视图，只记 `take` 过的会话 id。
 * 收缩中的当前只读视图不再外递：purge 那一半连同视图住「清册作用域」（`src/verbs/trash-scope.ts`）。
 * 两个 adapter 只各自**持有**那份视图；按组收缩的判据不抄第二遍，都读 `groups.withoutGroup`。
 */
import { bareSessionId } from '../domain/closure.js'
import type { TrashEntry } from '../trash/entry.js'
import { claimOf, withoutGroup, type GroupClaim } from '../trash/groups.js'

export interface EntryBatchCarried {
  claim(id: string): GroupClaim
  take(id: string): void
}

/** session 域没有组可交：claim 只回答 fresh / carried。 */
export type SessionClaim = { readonly verdict: 'fresh' | 'carried' }

export interface SessionBatchCarried {
  claim(id: string): SessionClaim
  take(id: string): void
}

/** 恢复：原始快照认得、当前视图已经空了 ⇒ 同批前一条带走的。 */
export function createEntryCarried(original: readonly TrashEntry[]): EntryBatchCarried {
  let current = [...original]
  return {
    claim(id) {
      return claimOf(original, current, id)
    },
    take(id) {
      current = withoutGroup(current, id)
    },
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
