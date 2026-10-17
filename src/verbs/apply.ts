/**
 * 批量动作（2026-10-17 重构批）：`POST /apply` 的落点——**一组 id 上的同一个动作**。
 *
 * 为什么要这一层：批量恢复 100+ 条的真实成本不在搬文件，在**每条一次的全表读**——旧形状是
 * 浏览器半循环 N 次 HTTP，每次都走「读全量清册 + 预检 + 逐成员通告时再拉一遍宿主会话表」。
 * 这一层把整批抬成一次：清册只读一次、宿主会话表只预取一次、通告一次批量发；
 * 单条动作就是 N=1 的批量，**仓里不再留第二条执行路径**。
 *
 * 三条批量语义（都是接口的一部分，不是实现细节）：
 * ① 输入去重、保持输入顺序（界面上"清单从上往下"的那一份读感）；
 * ② 一条失败不传染下一条——**逐条 try/catch**，失败按 `map-error` 那张表折成信封里的
 *    `{code,message,details?}`；
 * ③ 「已被同批前一条带走」是**幂等成功**，不是失败：恢复一条已经跟着父回来的孩子，
 *    用户要的结果本来就已经达成了（`delete`/`restore` 回 `null`；`purge` 回
 *    `{removed:0,freedBytes:0}`）。
 */
import { toRemoteFailure } from '../remote/map-error.js'
import type { ApplyAction, ApplyOutcome, ApplyValueByAction } from '../shared/wire.js'
import type { TrashEntry } from '../trash/entry.js'
import type { DeleteDeps } from './delete-session.js'
import { purgeTrash } from './purge-trash.js'
import { restoreSession } from './restore-session.js'
import { deleteSession } from './delete-session.js'

function failure(id: string, action: ApplyAction, error: unknown): ApplyOutcome {
  return { id, action, ok: false, error: toRemoteFailure(error) }
}

/** 按动作收窄的成功支（判别联合要的是**字面量**，所以动作参数按 `A` 收，不收成宽化的 `ApplyAction`）。 */
function success<A extends ApplyAction>(id: string, action: A, value: ApplyValueByAction[A]): Extract<ApplyOutcome, { action: A }> {
  return { id, action, ok: true, value } as Extract<ApplyOutcome, { action: A }>
}

/** 清册快照里"这条 id 还认得出一个组吗"：父行在、或它是某个还在的父亲的孩子，都算在。 */
function groupOf(snapshot: readonly TrashEntry[], id: string): TrashEntry[] {
  const root = snapshot.find(e => e.id === id)
  if (root !== undefined) return root.parentEntryId === undefined
    ? [root, ...snapshot.filter(e => e.parentEntryId === id)]
    : [root]
  // id 不在快照里：若还有孩子指向它（父行已被别的路径摘掉），这一组仍然存在
  const kids = snapshot.filter(e => e.parentEntryId === id)
  return kids.length > 0 ? kids : []
}

/**
 * 「这条是被**同批前一条**带走的，还是整批开始前就没有？」——幂等语义只属于前者。
 * 后来者本来就不在清册里（用户点了条幽灵 id、或对账刚摘掉它），必须照样响亮报 `trash-empty`，
 * 不能被"已被带走"这句话掩盖成一次成功。**所以判据是快照的原始形状，不是当前形状**：
 * 原始快照里认得出（它自己、它的父、或它的孩子任一在），而当前快照里已经空了 ⇒ 同批带走的。
 */
function takenByEarlierInBatch(original: readonly TrashEntry[], current: readonly TrashEntry[], id: string): boolean {
  return groupOf(original, id).length > 0 && groupOf(current, id).length === 0
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
  }
}

async function applyDelete(deps: DeleteDeps, ids: readonly string[]): Promise<ApplyOutcome[]> {
  const run = deleteSession(deps)
  const outcomes: ApplyOutcome[] = []
  // 同批父先被删时，孩子是跟着父一起搬走的；后到的孩子 id 是一次幂等 no-op。
  const taken = new Set<string>()
  for (const sessionId of unique(ids)) {
    if (taken.has(sessionId)) {
      outcomes.push(success(sessionId, 'delete', null))
      continue
    }
    let members: readonly string[] = []
    try {
      const entry = await run(sessionId, { onMembers: (sessionIds) => { members = sessionIds } })
      for (const id of members) taken.add(id)
      outcomes.push(success(sessionId, 'delete', entry))
    } catch (error) {
      outcomes.push(failure(sessionId, 'delete', error))
    }
  }
  return outcomes
}

async function applyRestore(deps: DeleteDeps, ids: readonly string[]): Promise<ApplyOutcome[]> {
  // 整批一次清册读；通告攒到批尾，配**一次**预取的摘要表发（旧形状 = 每条一次全表扫，
  // 那是 2026-10-17 "恢复很慢"的头号来源）。
  const snapshot = await deps.manifest.list()
  const original = [...snapshot]
  const run = restoreSession(deps)
  const outcomes: ApplyOutcome[] = []
  const restored: string[] = []
  for (const entryId of unique(ids)) {
    // 进动词**之前**记下这一组：动词成功后会就地从快照摘行，之后再也数不出成员。
    const group = groupOf(snapshot, entryId)
    if (group.length === 0 && takenByEarlierInBatch(original, snapshot, entryId)) {
      outcomes.push(success(entryId, 'restore', null)) // 已被同批前一条带走：幂等 no-op
      continue
    }
    try {
      const entry = await run(entryId, { snapshot, suppressAnnounce: true })
      restored.push(...(group.length > 0 ? group : [entry]).map(e => e.sessionId))
      // 这一组已经回到 `sessions/`——从快照视图里同步摘掉，后一条（它的孩子）才会认出"已被带走"。
      // （`purgeTrash` 收快照时自己会就地收缩；恢复动词不做这件事，收缩归这一层。）
      for (const member of group.length > 0 ? group : [entry]) {
        const at = snapshot.indexOf(member)
        if (at >= 0) snapshot.splice(at, 1)
      }
      outcomes.push(success(entryId, 'restore', entry))
    } catch (error) {
      // 不在清册里、也没被同批带走 ⇒ 动词的 `trash-empty` 照原样过桥（响亮，不粉饰成 no-op）
      outcomes.push(failure(entryId, 'restore', error))
    }
  }
  if (restored.length > 0) await deps.host.announceRestoredBatch(restored, await deps.host.restoredSummariesOf())
  return outcomes
}

async function applyPurge(deps: DeleteDeps, ids: readonly string[]): Promise<ApplyOutcome[]> {
  const snapshot = await deps.manifest.list()
  const original = [...snapshot]
  const run = purgeTrash(deps)
  const outcomes: ApplyOutcome[] = []
  for (const entryId of unique(ids)) {
    if (groupOf(snapshot, entryId).length === 0 && takenByEarlierInBatch(original, snapshot, entryId)) {
      outcomes.push(success(entryId, 'purge', { removed: 0, freedBytes: 0 })) // 已被同批前一条带走
      continue
    }
    try {
      outcomes.push(success(entryId, 'purge', await run(entryId, snapshot)))
    } catch (error) {
      outcomes.push(failure(entryId, 'purge', error))
    }
  }
  return outcomes
}

/** 删除确认框那句「含 N 个子会话」：一次问完整批（`subagentCounts` 本来就是批量口）。
 *  宿主口缺席时它回 `{}`（这里折成 0）；真读失败则整次调用失败，浏览器半按"读不到"把整句不说。 */
async function applyCount(deps: DeleteDeps, ids: readonly string[]): Promise<ApplyOutcome[]> {
  const wanted = unique(ids)
  const counts = await deps.host.subagentCounts(wanted)
  return wanted.map(id => success(id, 'count', counts[id] ?? 0))
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
