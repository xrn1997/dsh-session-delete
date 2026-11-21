/**
 * 收缩视图的持有机制的唯一家：entry 适配（restore 的同批已带走集）与清册作用域（purge）都接这一份。判据不搬：三态读 `groups.ts` 的
 * `claimOf`、按组收缩读 `withoutGroup`——这里只**持有**两份行并把它们递给判据，无 I/O。
 */
import type { TrashEntry } from './entry.js'
import { claimOf, withoutGroup, type GroupClaim } from './groups.js'

/** 收缩视图的持有面：原始快照判三态，当前视图按组收缩。 */
export interface ShrinkingView {
  /** 这条 id 现在的三态。只读、可重复——判据读 `claimOf`，同一视图状态连问两次同一个答案。 */
  claim(id: string): GroupClaim
  /** 收掉一条 id 所属的整组（判据读 `withoutGroup`）。 */
  take(id: string): void
  /** 把当前视图收缩到空。 */
  takeAll(): void
  /** 交当前行（选组与扫描都念它），不是原始快照。 */
  view(): readonly TrashEntry[]
}

/**
 * 开工时把整批的原始快照捕下来（三态判据的「整批开始前的样子」），当前视图从它出发、按组收缩。
 * 调用纪律：`take` / `takeAll` 都在动作**成功之后**才调——清完才收缩，失败时视图不动、下一次重试还能看见这一组。
 * 什么时候收缩、把实例放在哪里仍归调用方：本函数只持有原始与当前两份行，不记账。
 */
export function createShrinkingView(rows: readonly TrashEntry[]): ShrinkingView {
  const original = rows
  let current = [...rows]
  return {
    claim: (id) => claimOf(original, current, id),
    take: (id) => {
      current = withoutGroup(current, id)
    },
    takeAll: () => {
      current = []
    },
    view: () => current,
  }
}
