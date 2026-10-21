/**
 * `GET /list` 那一行的装配：清册行（`TrashEntry`）→ 线上那一行（`TrashRowWire`），外加组视图的几个只读数。
 *
 * 它从 `api/dispatch.ts` 里搬出来，因为路由层的事是**传输**（栅栏、方法、纯度、信封），而"一行里放什么"
 * 是这一层的事。「折进谁、谁露面」那条判据读 `trash/groups.ts`（ADR-0001）；一组会释放多少、盘上还剩谁
 * 归 `verbs/permanent-removal.ts` 的只读计划 —— 这里只做装配，不再自己枚举盘上后代。
 */
import type { CoreDeps } from '../deps.js'
import { isWorkspaceMissing } from '../verbs/restore-session.js'
import { planVisibleTrash } from '../verbs/permanent-removal.js'
import type { TrashEntry } from '../trash/entry.js'
import { visibleGroups } from '../trash/groups.js'
import type { TrashRowWire } from '../shared/wire.js'

/** 组视图那几个只读数的容器（行投影的第二个入参）。`releaseBytes` 必填（计划里实测好的那一格）；
 *  其余缺席 = 这次没算，不是 0。 */
type TrashRowReadouts = { readonly releaseBytes: number } & Partial<
  Pick<TrashRowWire, 'subagentCount' | 'subagentBytes' | 'strandedSubagents' | 'strandedBytes' | 'workspaceMissing'>
>
/**
 * 清册那一行 → 线上那一行。**显式字面量、不用 `...row`**：线上形状多一个必填字段时，这里编译不过，
 * 于是"线上多了一格却没人填"不可能悄悄发生（`...row` 会把它带过去，看上去一切正常）。
 */
export function toWire(row: TrashEntry, readouts: TrashRowReadouts): TrashRowWire {
  return {
    id: row.id,
    sessionId: row.sessionId,
    projectDir: row.projectDir,
    workspaceId: row.workspaceId,
    wasArchived: row.wasArchived,
    deletedAt: row.deletedAt,
    title: row.title,
    sizeBytes: row.sizeBytes,
    // 「这一次会释放多少」由只读计划量好递进来（与 purge 的 `freedBytes` 同一口径）；
    // 投影只搬运，不在这里另算一遍。界面上头部合计与单条确认框都念这一个数。
    releaseBytes: readouts.releaseBytes,
    ...(row.parentEntryId === undefined ? {} : { parentEntryId: row.parentEntryId }),
    // 只读数逐格显式列出（不 `...readouts`）：缺席 = 这次没算，不是 0，也不许被一个宽 spread 带进来。
    ...(readouts.subagentCount === undefined ? {} : { subagentCount: readouts.subagentCount }),
    ...(readouts.subagentBytes === undefined ? {} : { subagentBytes: readouts.subagentBytes }),
    ...(readouts.strandedSubagents === undefined ? {} : { strandedSubagents: readouts.strandedSubagents }),
    ...(readouts.strandedBytes === undefined ? {} : { strandedBytes: readouts.strandedBytes }),
    ...(readouts.workspaceMissing === undefined ? {} : { workspaceMissing: readouts.workspaceMissing }),
  }
}

/**
 * 把清册的全部行装配成「一行 = 一组」：孩子折进父那一行、不单独列（宿主的客户端本来就藏孩子，
 * 我们若单列就会冒出一堆点不到的行）；父行不在时孩子自己站出来占一行，否则它既看不见也清不掉。
 * 这些派生值只加在这次回信上，**不落清册**——清册该记的是文件里真有的事实，而"还剩几个孩子"
 * "工作区还在不在"是随盘上随时变的读数。取数失败照抛（响亮失败，不端一份少了这栏的清单当没事发生）。
 *
 * 一组要释放多少、盘上还剩谁**只读计划一处算**（`planVisibleTrash`，与 purge 同一条口径）；
 * 这里不再自己枚举盘上后代，也不碰 `isLive`（活体准入只属于写动词）。
 */
export async function assembleTrashRows(deps: CoreDeps, rows: readonly TrashEntry[]): Promise<TrashRowWire[]> {
  // 「折进谁」与「谁露面」由 `trash/groups.ts` 算出（ADR-0001）：**接得住孩子的只有根行**。
  const groups = visibleGroups(rows)
  // 两个取数面各管各的、可以并行：`planVisibleTrash` 量盘（与 purge 同一条口径）；`isWorkspaceMissing`
  // 是账本的逐行只读判别（空串是「未分组」，没有工作区可问）。按 `entry.id` 键控，不靠下标对齐。
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
