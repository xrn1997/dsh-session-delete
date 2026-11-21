/**
 * **同批已带走集**（已被同批前一条带走的 id）的唯一实现（ADR-0002 的内部实现）。两种 id 域各一个 adapter：
 * entry 域接在 `createShrinkingView` 上（判据仍读 `groups.ts`）；session 域只有 fresh / carried，集合由动词结果长出。
 * purge 那一半的实例住清册作用域（`src/verbs/trash-scope.ts`）。
 */
import { bareSessionId } from '../domain/closure.js'
import type { TrashEntry } from '../trash/entry.js'
import type { GroupClaim } from '../trash/groups.js'
import { createShrinkingView } from '../trash/shrinking-view.js'

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

/** 恢复：原始快照认得、当前视图已经空了 ⇒ 同批前一条带走的；持有与收缩都归 `createShrinkingView`。 */
export function createEntryCarried(original: readonly TrashEntry[]): EntryBatchCarried {
  return createShrinkingView(original)
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
