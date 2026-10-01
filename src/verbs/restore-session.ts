import { parseEntryId, sessionDirOf, trashDirOf, type TrashEntry } from '../trash/entry.js'
import type { DeleteDeps } from './delete-session.js'
import { verbError } from './errors.js'

export function restoreSession(deps: DeleteDeps) {
  return async function restoreSession(entryId: string): Promise<TrashEntry> {
    const entry = (await deps.manifest.list()).find(e => e.id === entryId)
    if (!entry) throw verbError('trash-empty', `回收站里没有这一条：${entryId}`)

    const trashDir = trashDirOf(entry.id, deps.home)
    // 用**删除时记进 entryId 的那段原目录名**放回，不从 `sessionId` 现推（设计稿 §3）：
    // 恢复因此不依赖宿主当时的目录命名约定（v3 无前缀 / v4 带 `session-` 前缀）。
    const sessionDir = sessionDirOf(entry.projectDir, parseEntryId(entry.id).sessionDirName, deps.home)
    if (!(await deps.fs.exists(trashDir))) throw verbError('trash-empty', `回收站条目已不在磁盘上：${trashDir}`)

    // 项目目录得放回它原来的家。sessions 根不在 ⇒ 项目目录必然不在，两者同一枚码：
    // 设计稿 §6 里"恢复时目标项目目录不存在"只有 project-missing 一个出口，且绝不静默建目录。
    const projectRoot = sessionDirOf(entry.projectDir, '', deps.home).replace(/\/$/, '')
    if (!(await deps.fs.exists(`${deps.home}/sessions`)) || !(await deps.fs.exists(projectRoot))) {
      throw verbError('project-missing', `原项目目录已不存在：${projectRoot}`)
    }

    // ① 文件先回来
    await deps.fs.rename(trashDir, sessionDir).catch((error) => {
      throw verbError('io', `放回会话目录失败：${String(error)}`, error)
    })
    // ② 再挂账本；③ 最后还原可见性。**工作区为空串 = 删除时它就没有账目**（未分组的会话）
    // ⇒ 这一趟没有账本可挂，回滚里也没有可摘的账本。
    if (entry.workspaceId !== '') {
      try {
        await deps.host.attach(entry.sessionId, entry.workspaceId)
      } catch (error) {
        await deps.fs.rename(sessionDir, trashDir).catch(() => {})
        throw verbError('io', `挂回账本失败：${String(error)}`, error)
      }
    }
    // ③ 可见性按 `wasArchived` 反推：删除时"原本未归档"的会话，是我们把它归档才藏起来的 ⇒ 现在放回树里；
    //    "原本已归档"的删前删后都在归档集里 ⇒ 一个字节都不动
    //    （§8 边界红检：归档过的会话删后恢复仍处归档态）。
    if (!entry.wasArchived) {
      try {
        await deps.host.unarchive(entry.sessionId)
      } catch (error) {
        // 失败同样要回到"东西还在回收站"：先藏回去（重新归档）、再摘账本、最后把目录放回回收站。
        // 滚回顺序与执行相反（执行是 放目录 → 挂账本 → 取消归档）；清单行因为还没摘而自然留着。
        await deps.host.archive(entry.sessionId, entry.workspaceId || undefined).catch(() => {})
        if (entry.workspaceId !== '') await deps.host.detach(entry.sessionId, entry.workspaceId).catch(() => {})
        await deps.fs.rename(sessionDir, trashDir).catch(() => {})
        throw verbError('io', `取消归档失败：${String(error)}`, error)
      }
    }

    // 摘清单行是最后一件写。它失败同样把前几步退回去（重新归档藏起来 → 摘账本 → 目录放回回收站），
    // 否则会留下一条**恢复不了也清不掉的幽灵行**（目录已经回了 `sessions/`，回收站里却还挂着它）。
    try {
      await deps.manifest.remove(entry.id)
    } catch (error) {
      if (!entry.wasArchived) await deps.host.archive(entry.sessionId, entry.workspaceId || undefined).catch(() => {})
      if (entry.workspaceId !== '') await deps.host.detach(entry.sessionId, entry.workspaceId).catch(() => {})
      await deps.fs.rename(sessionDir, trashDir).catch(() => {})
      throw verbError('io', `摘回收站条目失败：${String(error)}`, error)
    }
    // ④ 通告客户端"它回来了"：删除时那一行是靠通告掉下去的（宿主不再列出它），恢复就得通告回来
    // ——摘要取自宿主自己的会话列表。不发也不影响恢复的结果，只是要等下次重连才上屏。
    await deps.host.announceRestored(entry.sessionId)
    return entry
  }
}
