/** `GET /list` 那一行的装配：清册行 → 线上行，外加组视图只读数；折进判据住 `trash/groups.ts`（ADR-0001）。 */
import type { CoreDeps } from '../deps.js'
import { isWorkspaceMissing } from '../verbs/restore-session.js'
import { planVisibleTrash } from '../verbs/permanent-removal.js'
import { entryWire, type TrashEntry } from '../trash/entry.js'
import { visibleGroups } from '../trash/groups.js'
import type { TrashRowWire } from '../shared/wire.js'

/** 行投影的只读数容器：`releaseBytes` 必填；其余缺席 = 这次没算，不是 0。 */
type TrashRowReadouts = { readonly releaseBytes: number } & Partial<
  Pick<TrashRowWire, 'subagentCount' | 'subagentBytes' | 'strandedSubagents' | 'strandedBytes' | 'workspaceMissing'>
>
/** 清册行 → 线上行：清册字段走 `entryWire`（多一个必填字段会编译错），这里只补 `/list` 只读数。 */
export function toWire(row: TrashEntry, readouts: TrashRowReadouts): TrashRowWire {
  return {
    ...entryWire(row),
    // 释放字节由只读计划量好递进来（与 purge 同口径），这里只搬运。
    releaseBytes: readouts.releaseBytes,
    // 只读数逐格显式列出（不 `...readouts`）：缺席 = 这次没算，不是 0，也不许被一个宽 spread 带进来。
    ...(readouts.subagentCount === undefined ? {} : { subagentCount: readouts.subagentCount }),
    ...(readouts.subagentBytes === undefined ? {} : { subagentBytes: readouts.subagentBytes }),
    ...(readouts.strandedSubagents === undefined ? {} : { strandedSubagents: readouts.strandedSubagents }),
    ...(readouts.strandedBytes === undefined ? {} : { strandedBytes: readouts.strandedBytes }),
    ...(readouts.workspaceMissing === undefined ? {} : { workspaceMissing: readouts.workspaceMissing }),
  }
}

/** 装配成「一行 = 一组」：孩子折进父行，父行不在时孩子自己占一行（否则看不见也清不掉）。
 *  派生值只加在这次回信上、不落清册；取数失败照抛。
 *  组释放量与盘上剩余只由 `planVisibleTrash` 一处算，不碰 `isLive`。 */
export async function assembleTrashRows(deps: CoreDeps, rows: readonly TrashEntry[]): Promise<TrashRowWire[]> {
  // 「折进谁」与「谁露面」由 `trash/groups.ts` 算出（ADR-0001）：**接得住孩子的只有根行**。
  const groups = visibleGroups(rows)
  // 两个取数面可并行：`planVisibleTrash` 量盘、`isWorkspaceMissing` 逐行只读；按 id 键控，不靠下标。
  const [planned, missingByRowId] = await Promise.all([
    planVisibleTrash(deps, rows, groups),
    Promise.all(groups.map(async ({ root }) => [root.id, await isWorkspaceMissing(deps.host, root)] as const)),
  ])
  const gone = new Map(missingByRowId)

  return planned.map(({ root, kids, releaseBytes, subagentBytes, strandedCount, strandedBytes }) => toWire(root, {
    releaseBytes,
    ...(kids.length === 0 ? {} : { subagentCount: kids.length, subagentBytes }),
    ...(strandedCount === 0 ? {} : { strandedSubagents: strandedCount, strandedBytes }),
    ...(gone.get(root.id) === true ? { workspaceMissing: true } : {}),
  }))
}
