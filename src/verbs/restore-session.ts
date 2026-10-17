import { parseEntryId, sessionDirOf, trashDirOf, type TrashEntry } from '../trash/entry.js'
import type { DeleteDeps } from './delete-session.js'
import { verbError } from './errors.js'

/** 一次恢复的**反向动作**：把这个成员退回回收站里（连清册行一起）。 */
type Undo = () => Promise<void>

/**
 * 恢复 = 把删除那次**按原路退回**，而且按组走：当年是按组一起搬进来的（父 + 它在盘上的孩子），
 * 只回父就会在回收站里留下一堆点不到的孩子行——清单只列父行，那些行既看不见也清不掉。
 *
 * 三段与删除对称：
 * ① **预检整组**（一个字节都不写）：每个成员的回收站目录与项目目录都得在。缺席的判据与原来一致
 *    （回收站目录不在 = `trash-empty`；原项目目录不在 = `project-missing`，且绝不静默建目录）。
 *    预检在写之前，是为了不让"父已经回到 `sessions/`、孩子因为项目目录没了而回不去"这种半组留在外面。
 *    **工作区账本不在这条硬前提里**：宿主的「删除工作区」只删注册、保留日志，记下的工作区没了就按
 *    「未分组」收（见 `restoreOne`），照旧回盘——恢复是加法，不该因为一个可选的账目而失败。
 * ② **逐个恢复**，顺序与删除相反：文件先回来 → 挂账本 → 还原可见性 → 摘清册行 → 通告回来。
 * ③ 中途失败把这个成员自己退回回收站（就地回滚），并把**已经恢复完的**兄弟按相反顺序一起退回，失败照抛。
 */
export function restoreSession(deps: DeleteDeps) {
  return async function restoreSession(
    entryId: string,
    options: {
      readonly snapshot?: TrashEntry[]
      /** 批量（`verbs/apply.ts`）**自己收尾一次发**时传 `suppressAnnounce`：动词不再逐条通告——
       *  单条一份摘要 = 一条一次宿主全表扫，那是 2026-10-17 "恢复很慢"的头号来源。 */
      readonly suppressAnnounce?: boolean
    } = {},
  ): Promise<TrashEntry> {
    // 一次 `manifest.list()` 按调用算——批量把整批的这一次抬到外面来传进来。
    const all = options.snapshot ?? await deps.manifest.list()
    const target = all.find(e => e.id === entryId)
    if (!target) throw verbError('trash-empty', `回收站里没有这一条：${entryId}`)

    // 父那一行代表整组；按孩子的 id 来恢复（清单不单独列孩子，只有手工/降级路径会走到）就只回它自己。
    const group: TrashEntry[] = target.parentEntryId === undefined
      ? [target, ...all.filter(e => e.parentEntryId === target.id)]
      : [target]

    for (const entry of group) {
      const trashDir = trashDirOf(entry.id, deps.home)
      if (!(await deps.fs.exists(trashDir))) throw verbError('trash-empty', `回收站条目已不在磁盘上：${trashDir}`)
      const projectRoot = sessionDirOf(entry.projectDir, '', deps.home).replace(/\/$/, '')
      if (!(await deps.fs.exists(`${deps.home}/sessions`)) || !(await deps.fs.exists(projectRoot))) {
        throw verbError('project-missing', `原项目目录已不存在：${projectRoot}`)
      }
    }

    const done: Undo[] = []
    const restored: string[] = []
    try {
      for (const entry of group) {
        done.push(await restoreOne(deps, entry))
        restored.push(entry.sessionId)
      }
    } catch (error) {
      for (const undo of done.reverse()) await undo()
      throw error
    }
    // 单条路各发各的（拉一次表换一条通告，量级无所谓）；批量路由 `apply.ts` 在整批末尾一次发。
    if (options.suppressAnnounce !== true) await deps.host.announceRestoredBatch(restored)
    return target
  }
}

/** 放回哪儿：用**删除时记进 entryId 的那段原目录名**，不从 `sessionId` 现推（设计稿 §3）——
 *  因此不依赖宿主当时的目录命名约定（v3 无前缀 / v4 带 `session-` 前缀）。 */
function restoreTargetDir(deps: DeleteDeps, entry: TrashEntry): string {
  return sessionDirOf(entry.projectDir, parseEntryId(entry.id).sessionDirName, deps.home)
}

/** 恢复一个成员，交回它的反向动作。 */
async function restoreOne(deps: DeleteDeps, entry: TrashEntry): Promise<Undo> {
  const trashDir = trashDirOf(entry.id, deps.home)
  const sessionDir = restoreTargetDir(deps, entry)

  // 账本归属是**可选的反向动作**，两种缺席是同一件事：空串 = 删除时它就没有账目（「未分组」的会话）；
  // 非空但工作区已被删掉 = 宿主的「删除工作区」只删注册、保留目录与每一份日志（`HostPort.workspaceExists`），
  // 那些会话之后本来就在「未分组」下。恢复不该为了挂一个不存在的账本而把整条退回回收站。
  const workspaceId = entry.workspaceId !== '' && (await deps.host.workspaceExists(entry.workspaceId))
    ? entry.workspaceId
    : undefined
  /** 真的挂上了账本才为 true——回滚里"摘账本"那一步只对挂过的成员存在。 */
  let attached = false

  // ① 文件先回来
  await deps.fs.rename(trashDir, sessionDir).catch((error) => {
    throw verbError('io', `放回会话目录失败：${String(error)}`, error)
  })
  // ② 再挂账本（`workspaceId` 缺席 = 没有账本可挂）。
  if (workspaceId !== undefined) {
    try {
      await deps.host.attach(entry.sessionId, workspaceId)
      attached = true
    } catch (error) {
      // 查过之后、挂之前账本被删掉（宿主的「删除工作区」与这次恢复撞上）：与上面同一件事，按未分组收；
      // 工作区仍在就是真故障，照旧把目录退回去并抛原文。
      if (await deps.host.workspaceExists(workspaceId)) {
        await deps.fs.rename(sessionDir, trashDir).catch(() => {})
        throw verbError('io', `挂回账本失败：${String(error)}`, error)
      }
    }
  }
  // ③ 可见性按 `wasArchived` 反推：删除时"原本未归档"的会话是我们把它归档才藏起来的 ⇒ 现在放回树里；
  //    "原本已归档"的删前删后都在归档集里 ⇒ 一个字节都不动（§8 边界红检）。
  if (!entry.wasArchived) {
    try {
      await deps.host.unarchive(entry.sessionId)
    } catch (error) {
      // 失败同样要回到"东西还在回收站"：先藏回去（重新归档）、再摘账本、最后把目录放回回收站。
      await deps.host.archive(entry.sessionId, workspaceId ?? undefined).catch(() => {})
      if (attached && workspaceId !== undefined) await deps.host.detach(entry.sessionId, workspaceId).catch(() => {})
      await deps.fs.rename(sessionDir, trashDir).catch(() => {})
      throw verbError('io', `取消归档失败：${String(error)}`, error)
    }
  }

  // 摘清单行是最后一件写。它失败同样把前几步退回去，否则会留下一条**恢复不了也清不掉的幽灵行**。
  try {
    await deps.manifest.remove(entry.id)
  } catch (error) {
    if (!entry.wasArchived) await deps.host.archive(entry.sessionId, workspaceId ?? undefined).catch(() => {})
    if (attached && workspaceId !== undefined) await deps.host.detach(entry.sessionId, workspaceId).catch(() => {})
    await deps.fs.rename(sessionDir, trashDir).catch(() => {})
    throw verbError('io', `摘回收站条目失败：${String(error)}`, error)
  }
  // ④ **通告不在这里发**：整组恢复完由调用方一次性发（见 `restoreSession` 末尾的 `announceRestoredBatch`），
  //    单条一份摘要 = 一条一次全表扫，批量下就是那次"恢复很慢"的主因。
  // 反向动作（组里别的成员失败时才用）：行先回去、再按删除那趟的顺序退回去（归档 → 摘账本 → 目录搬回回收站）。
  return async () => {
    await deps.manifest.add(entry).catch(() => {})
    if (!entry.wasArchived) await deps.host.archive(entry.sessionId, workspaceId ?? undefined).catch(() => {})
    if (attached && workspaceId !== undefined) await deps.host.detach(entry.sessionId, workspaceId).catch(() => {})
    await deps.fs.rename(sessionDir, trashDir).catch(() => {})
    const eviction = await deps.host.evictLive(entry.sessionId).catch(() => 'unknown' as const)
    if (eviction !== 'unknown') await deps.host.announceRemoved(entry.sessionId).catch(() => {})
  }
}
