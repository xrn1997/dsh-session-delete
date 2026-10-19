/**
 * `GET /list` 那一行的装配：清册行（`TrashEntry`）→ 线上那一行（`TrashRowWire`），外加组视图的几个只读数。
 *
 * 它从 `api/dispatch.ts` 里搬出来，因为路由层的事是**传输**（栅栏、方法、纯度、信封），而"一行里放什么"
 * 是这一层的事。「折进谁、谁露面」那条判据读 `trash/groups.ts`（ADR-0001），这里只做装配。
 */
import type { DeleteDeps } from '../verbs/delete-session.js'
import { isWorkspaceMissing } from '../verbs/restore-session.js'
import { measureMemberDir } from '../verbs/orphan-subagents.js'
import { bareSessionId } from '../ports/host-port.js'
import type { TrashEntry } from '../trash/entry.js'
import { visibleGroups } from '../trash/groups.js'
import type { TrashRowWire } from '../shared/wire.js'

/** 组视图那几个只读数的容器（行投影的第二个入参）。 */
type TrashRowReadouts = Pick<
  TrashRowWire,
  'subagentCount' | 'subagentBytes' | 'strandedSubagents' | 'strandedBytes' | 'workspaceMissing'
>
/**
 * 清册那一行 → 线上那一行。**显式字面量、不用 `...row`**：线上形状多一个必填字段时，这里编译不过，
 * 于是"线上多了一格却没人填"不可能悄悄发生（`...row` 会把它带过去，看上去一切正常）。
 */
export function toWire(row: TrashEntry, readouts: TrashRowReadouts = {}): TrashRowWire {
  return {
    id: row.id,
    sessionId: row.sessionId,
    projectDir: row.projectDir,
    workspaceId: row.workspaceId,
    wasArchived: row.wasArchived,
    deletedAt: row.deletedAt,
    title: row.title,
    sizeBytes: row.sizeBytes,
    // 「这一次会释放多少」的**唯一算式**：本行 + 跟着进来的孩子 + 盘上后代。
    // 界面上头部合计与单条确认框都念这一个数（此前它在浏览器半另算一遍，还带一条已知的重复计数偏差）。
    releaseBytes: row.sizeBytes + (readouts.subagentBytes ?? 0) + (readouts.strandedBytes ?? 0),
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
 */
export async function assembleTrashRows(deps: DeleteDeps, rows: readonly TrashEntry[]): Promise<TrashRowWire[]> {
  // 「折进谁」与「谁露面」由 `trash/groups.ts` 算出（ADR-0001）：**接得住孩子的只有根行**。
  const groups = visibleGroups(rows)
  const visible = groups.map((group) => group.root)

  // 两个取数面各管各的：`subagentMembersBatch` 是宿主 `sessionQuery` 的批量口（一处调用、一次 BFS），
  // 交出每组后代名单；下面再按 `measureMemberDir` 量目录是否存在/多大（strandedBytes 与 purge 同口径）。
  // `isWorkspaceMissing` 是账本的逐行只读判别（空串是「未分组」，没有工作区可问）。
  // 按 `entry.id` 键控，不靠两个 `Promise.all` 的下标对齐。
  const [membersByParent, missingByRowId] = await Promise.all([
    deps.host.subagentMembersBatch(visible.map(row => row.sessionId)),
    Promise.all(visible.map(async (row) => [row.id, await isWorkspaceMissing(deps.host, row)] as const)),
  ])
  const gone = new Map(missingByRowId)
  return await Promise.all(groups.map(async ({ root, kids }) => {
    // 跟着这条根一起进回收站的孩子已经不在持久化语料里，宿主不会把它当「盘上后代」交回；
    // 但旧夹具 / 手工搬回这类不一致世界里两边可能同时出现。`purge` 会按清册跳过它，这里也跳过——
    // 否则 `releaseBytes` 会多报一份，与 purge 实际释放的 `freedBytes` 各说各的。
    const kidsInGroup = new Set(kids.map(kid => bareSessionId(kid.sessionId)))
    let count = 0
    let bytes = 0
    for (const member of membersByParent[root.sessionId] ?? []) {
      if (kidsInGroup.has(bareSessionId(member.sessionId))) continue
      // 「盘上还剩」只数真在盘上的目录：宿主记录还在、目录已经不在的那条不算残留，
      // 否则 count 与 bytes 会各说各的（一个照记录数、一个只量得到存在的目录）。
      const measured = await measureMemberDir(deps, member)
      if (measured === undefined) continue
      count += 1
      bytes += measured.bytes
    }
    const missing = gone.get(root.id) === true
    return toWire(root, {
      ...(kids.length === 0 ? {} : {
        subagentCount: kids.length,
        subagentBytes: kids.reduce((total, kid) => total + kid.sizeBytes, 0),
      }),
      ...(count === 0 ? {} : { strandedSubagents: count, strandedBytes: bytes }),
      ...(missing ? { workspaceMissing: true } : {}),
    })
  }))
}
