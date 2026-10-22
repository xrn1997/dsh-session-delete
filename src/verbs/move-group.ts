/**
 * 组级成员移动：按成员顺序跑，任一失败就把**已经做成**的按相反顺序退回。
 *
 * 顺序与整组回滚此前在 `delete-session` 与 `restore-session` 各写一遍（`done` 列表 +
 * for 循环 + catch `rollbackJournals`）；两个动词只有预检谓词与每成员步骤不同。
 * 这里拥有顺序、整组回滚与**按成员顺序交回的结果**：下一位还能看到已交回的结果
 * （删除的父子条目 id 依赖父那一步的结果），调用方不再用闭包变量走私它。
 * 单成员的步骤与反向动作仍归 `member-journal.ts`。
 */
import { rollbackJournals, type Journal } from './member-journal.js'

export async function moveGroup<T, R>(
  members: readonly T[],
  move: (member: T, priorResults: readonly R[]) => Promise<{ journal: Journal; result: R }>,
): Promise<R[]> {
  const journals: Journal[] = []
  const results: R[] = []
  try {
    for (const member of members) {
      const prepared = await move(member, results)
      await prepared.journal.run()
      journals.push(prepared.journal)
      results.push(prepared.result)
    }
  } catch (error) {
    await rollbackJournals(journals, error)
  }
  return results
}
