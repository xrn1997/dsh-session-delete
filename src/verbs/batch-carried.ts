/**
 * **同批已带走集**（已被同批前一条带走的 id）的唯一实现（ADR-0002 的内部实现）。两种 id 域各一个 adapter：
 * entry 域接在 `createShrinkingView` 上（判据仍读 `groups.ts`）；session 域只有 fresh / carried，集合由动词结果长出。
 * purge 那一半的实例住清册作用域（`src/verbs/trash-scope.ts`）。
 *
 * 本文件另收 session 域的**预裁决表**（`preAdjudicateSession`，ADR-0070）：输入序回答「这条会被更早的条目
 * 带走吗」。**预判只管调度**（carried 挂不挂、谁进波次 1）；实况为准的裁决与补跑在动词与第二波（口径住 ADR-0070）。
 */
import { bareSessionId, firstByBare } from '../domain/closure.js'
import type { TrashEntry } from '../trash/entry.js'
import { type GroupClaim, type IdGroupClaim } from '../trash/groups.js'
import { createShrinkingView } from '../trash/shrinking-view.js'

export interface EntryBatchCarried {
  claim(id: string): GroupClaim
  /** 输入序预裁决（只裁决不动手）：裁决视图按 claim 序演化——同批后到的同组条目先被裁成 carried；
   *  执行视图只在 `take`（执行成功）后才收缩（`createShrinkingView` 的持有），第二波按实况重裁靠的就是它。 */
  claimAll(ids: readonly string[]): readonly IdGroupClaim[]
  take(id: string): void
  takeRows(rowIds: readonly string[]): void
}

/** session 域没有组可交：claim 只回答 fresh / carried。 */
export type SessionClaim = { readonly verdict: 'fresh' | 'carried' }

export interface SessionBatchCarried {
  claim(id: string): SessionClaim
  take(id: string): void
}

/** 恢复：原始快照认得、当前视图已经空了 ⇒ 同批前一条带走的；持有与收缩都归 `createShrinkingView`。 */
export function createEntryCarried(original: readonly TrashEntry[]): EntryBatchCarried {
  const view = createShrinkingView(original)
  return {
    claim: (id) => view.claim(id),
    // 输入序预裁决的演化循环住 `createShrinkingView` 的 `claimAll`（唯一一份），这里只转发。
    claimAll: (ids) => view.claimAll(ids),
    take: (id) => view.take(id),
    takeRows: (rowIds) => view.takeRows(rowIds),
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

/** 预裁决表的一行（输入序）：`fresh` 进波次 1；`carried` 挂起、第二波按实况裁决。
 *  预测的搬走组只服务内部调度（谁进波次 1、哪些 id 会被更早条目带走），不在表里外露——caller 拿它
 *  当第二份组名单用就会长出第二个判据。 */
export interface SessionPreClaim {
  readonly id: string
  readonly verdict: 'fresh' | 'carried'
}

/**
 * session 域的预裁决表（输入序）：`predicted` 是各 id 的**预测搬走组**（自己 + 盘上在场的孩子，批级一次
 * 实况读筛好交进来）。组先按 `firstByBare` 去重（共享后代归第一个声明者，全局去重只有那一处实现）；id 已被
 * 更早条目的预测组收走 ⇒ `carried`（挂第二波），否则 `fresh`。两条归一：bare（`session-` 前缀两种写法是同一
 * 条会话）；以及**预测组照收进带走预测集**——被预判 carried 的条目自己也可能带走更晚的条目，它的预测组照样
 * 算数。幽灵 id 不是「被带走」：没人预测会带走它 ⇒ `fresh`，照旧进执行路响亮失败——幂等只留给「被同批前
 * 一条带走」。
 */
export function preAdjudicateSession(
  wanted: readonly string[],
  predicted: ReadonlyMap<string, readonly string[]>,
): readonly SessionPreClaim[] {
  // 预测组去重仍走 `firstByBare`：把「输入序 + 声明者」绑进一条记录，交给那唯一一处全局去重。
  // `projectDir` 只满足闭包节点形状（本判据不看目录）。
  const flat: Array<{ readonly sessionId: string; readonly projectDir: string; readonly index: number }> = []
  wanted.forEach((id, index) => {
    for (const member of predicted.get(id) ?? [id]) flat.push({ sessionId: member, projectDir: '', index })
  })
  const groups = wanted.map((): string[] => [])
  for (const entry of firstByBare(flat)) groups[entry.index]?.push(entry.sessionId)
  // 裁决与积累同序走：先按更早条目的预测组判这一条，再把这一条的预测组收进带走预测集（含 carried 条目——
  // 它被预判带走不代表它自己带不走更晚的条目）。
  const taken = new Set<string>()
  return wanted.map((id, index): SessionPreClaim => {
    const group = groups[index] ?? []
    const verdict = taken.has(bareSessionId(id)) ? 'carried' as const : 'fresh' as const
    for (const member of group) taken.add(bareSessionId(member))
    return { id, verdict }
  })
}
