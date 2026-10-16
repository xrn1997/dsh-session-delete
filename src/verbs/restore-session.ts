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
 * ② **逐个恢复**，顺序与删除相反：文件先回来 → 挂账本 → 还原可见性 → 摘清册行 → 通告回来。
 * ③ 中途失败把这个成员自己退回回收站（就地回滚），并把**已经恢复完的**兄弟按相反顺序一起退回，失败照抛。
 */
export function restoreSession(deps: DeleteDeps) {
  return async function restoreSession(entryId: string): Promise<TrashEntry> {
    const all = await deps.manifest.list()
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
    for (const entry of group) {
      try {
        done.push(await restoreOne(deps, entry))
      } catch (error) {
        for (const undo of done.reverse()) await undo()
        throw error
      }
    }
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

  // ① 文件先回来
  await deps.fs.rename(trashDir, sessionDir).catch((error) => {
    throw verbError('io', `放回会话目录失败：${String(error)}`, error)
  })
  // ② 再挂账本。**工作区为空串 = 删除时它就没有账目**（未分组的会话）⇒ 没有账本可挂，回滚里也没有可摘的。
  if (entry.workspaceId !== '') {
    try {
      await deps.host.attach(entry.sessionId, entry.workspaceId)
    } catch (error) {
      await deps.fs.rename(sessionDir, trashDir).catch(() => {})
      throw verbError('io', `挂回账本失败：${String(error)}`, error)
    }
  }
  // ③ 可见性按 `wasArchived` 反推：删除时"原本未归档"的会话是我们把它归档才藏起来的 ⇒ 现在放回树里；
  //    "原本已归档"的删前删后都在归档集里 ⇒ 一个字节都不动（§8 边界红检）。
  if (!entry.wasArchived) {
    try {
      await deps.host.unarchive(entry.sessionId)
    } catch (error) {
      // 失败同样要回到"东西还在回收站"：先藏回去（重新归档）、再摘账本、最后把目录放回回收站。
      await deps.host.archive(entry.sessionId, entry.workspaceId || undefined).catch(() => {})
      if (entry.workspaceId !== '') await deps.host.detach(entry.sessionId, entry.workspaceId).catch(() => {})
      await deps.fs.rename(sessionDir, trashDir).catch(() => {})
      throw verbError('io', `取消归档失败：${String(error)}`, error)
    }
  }

  // 摘清单行是最后一件写。它失败同样把前几步退回去，否则会留下一条**恢复不了也清不掉的幽灵行**。
  try {
    await deps.manifest.remove(entry.id)
  } catch (error) {
    if (!entry.wasArchived) await deps.host.archive(entry.sessionId, entry.workspaceId || undefined).catch(() => {})
    if (entry.workspaceId !== '') await deps.host.detach(entry.sessionId, entry.workspaceId).catch(() => {})
    await deps.fs.rename(sessionDir, trashDir).catch(() => {})
    throw verbError('io', `摘回收站条目失败：${String(error)}`, error)
  }
  // ④ 通告客户端"它回来了"。不发也不影响结果，只是要等下次重连才上屏。
  await deps.host.announceRestored(entry.sessionId)

  // 反向动作（组里别的成员失败时才用）：行先回去、再按删除那趟的顺序退回去（归档 → 摘账本 → 目录搬回回收站）。
  return async () => {
    await deps.manifest.add(entry).catch(() => {})
    if (!entry.wasArchived) await deps.host.archive(entry.sessionId, entry.workspaceId || undefined).catch(() => {})
    if (entry.workspaceId !== '') await deps.host.detach(entry.sessionId, entry.workspaceId).catch(() => {})
    await deps.fs.rename(sessionDir, trashDir).catch(() => {})
    const eviction = await deps.host.evictLive(entry.sessionId).catch(() => 'unknown' as const)
    if (eviction !== 'unknown') await deps.host.announceRemoved(entry.sessionId).catch(() => {})
  }
}
