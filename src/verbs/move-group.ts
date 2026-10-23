/**
 * 组级成员移动：组根先跑（拿到 `undefined`），跟随者按序跑并拿到根结果；任一失败就把**已经做成**的
 * 按相反顺序退回。
 *
 * 这里拥有顺序、整组回滚与**组根结果的交回**：根先跑，跟随者按序拿到根结果；调用方直接拿
 * 返回的根结果，不按位置索引结果数组。跟随者自己的结果不向上交回——当前调用方不需要。
 * 单成员的步骤与反向动作仍归 `member-journal.ts`；这条归属的裁决见 ADR-0002。
 */
import { rollbackJournals, type Journal } from './member-journal.js'

export interface GroupMove<M, R> {
  /** 组根：先跑，`move` 收到的 `rootResult` 是 `undefined`。 */
  readonly root: M
  /** 跟随者：按序跑，每个都拿到根结果（彼此看不到对方的结果）。 */
  readonly followers: readonly M[]
  move(member: M, rootResult: R | undefined): Promise<{ journal: Journal; result: R }>
}

export async function moveGroup<M, R>({
  root,
  followers,
  move,
}: GroupMove<M, R>): Promise<R> {
  const journals: Journal[] = []
  const run = async (member: M, rootResult: R | undefined): Promise<R> => {
    const prepared = await move(member, rootResult)
    await prepared.journal.run()
    journals.push(prepared.journal)
    return prepared.result
  }
  try {
    const rootResult = await run(root, undefined)
    for (const follower of followers) await run(follower, rootResult)
    return rootResult
  } catch (error) {
    // `rollbackJournals` 永远抛出（原错误或带 `rollbackFailures` 的它）；`return` 只是让控制流收口。
    return await rollbackJournals(journals, error)
  }
}
