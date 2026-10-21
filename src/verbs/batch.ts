/**
 * **「这一批」的唯一拥有者**（ADR-0002）：`POST /apply` 的落点——一组 id 上的同一个动作。
 *
 * 五个动作：`delete` / `restore` / `purge` / `count` / `orphan-clean`。
 *
 * 为什么批量要有自己的 module：批量是**请求**的性质，不是某一条动词的性质。此前它长在三个动词的
 * interface 上（`onMembers` / `snapshot` / `suppressAnnounce`），于是每个动词都得知道"我是第几个、
 * 前面的兄弟带走了谁"，同一个事实还有三种机制（回调、调用方 `taken` 集合、动词就地收缩数组）。
 *
 * 这一层独占四件（每条批量语义都在这里）：
 * ① **去重保序**：输入顺序就是界面"清单从上往下"的读感；
 * ② **清册快照**：整批只读一次"最初的样子"，用来判断"已被同批前一条带走"；
 * ③ **逐条信封**：一条失败不传染下一条，失败按 `map-error` 那张表折成 `{code,message,details?}`；
 * ④ **一批一次通告**：恢复的 `api-session/added` 攒到批尾、配一次预取的摘要表发（逐条发 = 每条一次
 *   宿主全表扫，那正是 2026-10-17 "恢复很慢"的头号来源）。
 *
 * 「已被同批前一条带走」是**幂等成功**，不是失败：用户要的结果本来就已经达成了（`delete`/`restore`
 * 回 `null`；`purge` 回 `{removed:0,freedBytes:0}`）。判据读 `trash/groups.ts`（ADR-0001），
 * 与 `/list` 的装配、与三个动词同一条。
 */
import { toRemoteFailure } from '../remote/map-error.js'
import { bareSessionId } from '../ports/host-port.js'
import type { ApplyAction, ApplyOutcome, ApplyValueByAction } from '../shared/wire.js'
import type { TrashEntry } from '../trash/entry.js'
import { groupOf, takenByEarlierInBatch } from '../trash/groups.js'
import { reconcileTrash } from '../trash/reconcile.js'
import type { CoreDeps, DeleteDeps } from '../deps.js'
import { deleteSession } from './delete-session.js'
import { verbError } from './errors.js'
import { cleanOrphanGroup, loadOrphanGroups } from './orphan-subagents.js'
import { purgeTrash } from './purge-trash.js'
import { restoreSession } from './restore-session.js'

function failure(id: string, action: ApplyAction, error: unknown): ApplyOutcome {
  return { id, action, ok: false, error: toRemoteFailure(error) }
}

/** 按动作收窄的成功支（判别联合要的是**字面量**，所以动作参数按 `A` 收，不收成宽化的 `ApplyAction`）。 */
function success<A extends ApplyAction>(id: string, action: A, value: ApplyValueByAction[A]): Extract<ApplyOutcome, { action: A }> {
  return { id, action, ok: true, value } as Extract<ApplyOutcome, { action: A }>
}

/** 去重且保持输入顺序（重复 id 跑第二遍是"幂等成功"的伪装，不该发生）。 */
function unique(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * 一条 id 一条结果：**这是批量唯一的形式**（单条就是长度为 1 的批量，仓里不留第二条执行路径）。
 * 动词只收一个 id、只吐一条结果；`try/catch` 在这一处，失败不传染下一条。
 */
async function forEachId<A extends ApplyAction>(
  action: A,
  ids: readonly string[],
  run: (id: string) => Promise<ApplyValueByAction[A]>,
): Promise<ApplyOutcome[]> {
  const outcomes: ApplyOutcome[] = []
  for (const id of unique(ids)) {
    try {
      outcomes.push(success(id, action, await run(id)))
    } catch (error) {
      outcomes.push(failure(id, action, error))
    }
  }
  return outcomes
}

/** 这一组的行从"当前快照"里摘掉（父行带走孩子后，后到的孩子 id 要认得出"已经不在了"）。 */
function shrink(current: TrashEntry[], rows: readonly TrashEntry[]): void {
  for (const row of rows) {
    const at = current.indexOf(row)
    if (at >= 0) current.splice(at, 1)
  }
}

async function applyDelete(deps: DeleteDeps, ids: readonly string[]): Promise<ApplyOutcome[]> {
  const run = deleteSession(deps)
  // 同批父先被删时，孩子是跟着父一起搬走的；后到的孩子 id 是一次幂等 no-op。
  // 这份名单**由动词的结果长出**（`movedSessionIds` = 这次真的搬走的整组），删除写完之后不再读一次清册。
  const carried = new Set<string>()
  return forEachId('delete', ids, async (sessionId) => {
    const root = bareSessionId(sessionId)
    if (carried.has(root)) return null
    const { entry, movedSessionIds } = await run(sessionId)
    for (const movedId of movedSessionIds) carried.add(bareSessionId(movedId))
    return entry
  })
}

/** 「这条是不是被同批前一条带走了」：原始快照里认得出、当前快照里已经空了。
 *  **收缩归这一层**（动词只拿只读快照）——`apply` 整批只读一次清册，`takenByEarlierInBatch` 不比它多读。 */
async function applyRestore(deps: CoreDeps, ids: readonly string[]): Promise<ApplyOutcome[]> {
  // 整批一次清册读（"最初的样子"）+ 一份会收缩的**本层私有**视图；通告攒到批尾，配一次预取的摘要表发。
  const original = await deps.manifest.list()
  const current: TrashEntry[] = [...original]
  const run = restoreSession(deps)
  const restored: string[] = []
  const outcomes = await forEachId('restore', ids, async (entryId) => {
    if (takenByEarlierInBatch(original, current, entryId)) return null // 已被同批前一条带走：幂等 no-op
    // **当前视图**是这一批的私有副本：前一条已经恢复的行不在里面了。动词只读它、绝不改它；
    // 收缩归这一层（`shrink`），于是整批仍然只读一次清册，而"先点孩子再点父"也不会拿旧组去重放。
    const group = groupOf(current, entryId)
    const entry = await run(entryId, current)
    // 通告的是**这一组的会话 id**（父 + 跟着它回来的孩子）
    restored.push(...group.map((row) => row.sessionId))
    shrink(current, group)
    return entry
  })
  if (restored.length > 0) {
    await deps.host.announceRestoredBatch(restored, await deps.host.restoredSummariesOf())
  }
  return outcomes
}

async function applyPurge(deps: CoreDeps, ids: readonly string[]): Promise<ApplyOutcome[]> {
  const original = await deps.manifest.list()
  const current: TrashEntry[] = [...original]
  const run = purgeTrash(deps)
  return forEachId('purge', ids, async (entryId) => {
    if (takenByEarlierInBatch(original, current, entryId)) return { removed: 0, freedBytes: 0 } // 已被同批前一条带走
    // 与 restore 同理：动词读**当前视图**，前一条已经清掉的行不再出现在这一组的预检/删除目标里。
    const group = groupOf(current, entryId)
    const stats = await run(entryId, current)
    shrink(current, group)
    return stats
  })
}

/** 删除确认框那句「含 N 个子会话」：一次问完整批（`subagentMembersOf` 本来就是批量口）。
 *  宿主口缺席（`available:false`）时按 0（这里不再有"空表"这一步）；真读失败则整次调用失败，
 *  浏览器半按"读不到"把整句不说。 */
async function applyCount(deps: CoreDeps, ids: readonly string[]): Promise<ApplyOutcome[]> {
  const wanted = unique(ids)
  const read = await deps.host.subagentMembersOf(wanted)
  return wanted.map(id => success(id, 'count', read.available ? (read.value[id]?.length ?? 0) : 0))
}

/**
 * 清一组无主子会话（父已被彻底删掉、孩子还留在 `sessions/` 里的那些）。id 是**根会话 id**——
 * 界面先 `GET /orphans` 拿 `roots` 再原样带回来，所以这里的 `not-found` 说的是"这句话已经过期了"
 * （父又被人放回回收站、组已被上一个请求带走，或另一处已经把目录清掉），不是"用户打错了一个 id"。
 * 根 id 两边都去 `session-` 前缀再比：报告原样回传是正常路径，外部调用带另一种写法也认。
 *
 * **这是写动作，排在到达序链上**，而且**先对账再扫**（2026-10-19）：判"父没了"用的是清册，而刚被人
 * 手工搬进 `session-trash/` 的那一格目录此刻可能还没有对应行——不对账就会把"父还在回收站里等着"的
 * 一组当成孤儿**直接删盘**，替用户做了一个没人点过的决定（那种组该跟着父恢复或彻底删除）。
 * 对账写在动词这一侧而不是只写在路由里，为的是 `apply` 的批量入口只有一个：链上的排队与这份快照
 * 谁也别想只占一半。
 */
async function applyOrphanClean(deps: CoreDeps, ids: readonly string[]): Promise<ApplyOutcome[]> {
  await reconcileTrash(deps)
  // 语料面（宿主 `sessionQuery`）缺席时这一句抛 `io` ⇒ 整次调用失败，不回一份"零条"的假回执。
  const groups = await loadOrphanGroups(deps)
  const byRoot = new Map(groups.map(group => [bareSessionId(group.root.sessionId), group]))
  const outcomes: ApplyOutcome[] = []
  for (const id of unique(ids)) {
    const group = byRoot.get(bareSessionId(id))
    if (group === undefined) {
      outcomes.push(failure(id, 'orphan-clean', verbError('not-found', `不再是可清理的无主子会话：${id}`)))
      continue
    }
    try {
      // 组内没有回收站这一层可退：`cleanOrphanGroup` 的 live 准入在任何写之前（整组拒绝、零副作用）；
      // 删到一半失败时已删目录不回滚，失败错误的 `details` 带 `{ removed, freedBytes }` 作为部分回执，
      // 不会伪装成"整组清完了"。
      outcomes.push(success(id, 'orphan-clean', await cleanOrphanGroup(deps, group)))
    } catch (error) {
      outcomes.push(failure(id, 'orphan-clean', error))
    }
  }
  return outcomes
}

export function applyActions(deps: DeleteDeps, action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]> {
  switch (action) {
    case 'delete':
      return applyDelete(deps, ids)
    case 'restore':
      return applyRestore(deps, ids)
    case 'purge':
      return applyPurge(deps, ids)
    case 'count':
      return applyCount(deps, ids)
    case 'orphan-clean':
      return applyOrphanClean(deps, ids)
  }
}
