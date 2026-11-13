/**
 * **同批已带走集**（「已被同批前一条带走」的 id）的唯一实现（ADR-0002 的内部实现）。
 *
 * 两种 id 域各一个 adapter：
 * - entry 适配：restore 的条目 id，`claim` 是三态（fresh / carried / absent）——薄壳，接在
 *   `src/trash/shrinking-view.ts` 的 `createShrinkingView` 上（持有机制在那边，判据仍读 `src/trash/groups.ts`，
 *   不抄第二遍）；
 * - session 适配：delete 的会话 id，`claim` 只有 fresh / carried，集合由动词结果长出——没有原始
 *   清册视图、也没有组可收缩，与收缩视图机制无关。
 *
 * 收缩中的当前只读视图不外递：purge 那一半的实例住「清册作用域」（`src/verbs/trash-scope.ts`）。
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

/** 恢复：原始快照认得、当前视图已经空了 ⇒ 同批前一条带走的。这里只接 entry 域的面，
 *  持有与收缩都是 `src/trash/shrinking-view.ts` 的 `createShrinkingView` 那一份（多出的
 *  `takeAll` / `view` 不外递，返回值只按 `EntryBatchCarried` 看）。 */
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
