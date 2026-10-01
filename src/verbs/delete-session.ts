import { makeEntryId, sessionDirOf, trashDirOf, type TrashEntry } from '../trash/entry.js'
import type { FsPort } from '../ports/fs-port.js'
import type { HostPort } from '../ports/host-port.js'
import type { ManifestPort } from '../trash/manifest.js'
import { verbError } from './errors.js'

export interface DeleteDeps {
  fs: FsPort
  host: HostPort
  manifest: ManifestPort
  home: string
  now(): number
}

export function deleteSession(deps: DeleteDeps) {
  return async function deleteSession(sessionId: string): Promise<TrashEntry> {
    if (await deps.host.isLive(sessionId)) throw verbError('live', `会话正在运行：${sessionId}`)

    const projectDir = await deps.host.projectDirOf(sessionId)
    if (!projectDir) throw verbError('not-found', `宿主的持久化里没有这个会话：${sessionId}`)
    // 工作区归属是**可选**的：宿主的"删除工作区"（"其会话将显示在「未分组」下"）留下的就是这种会话——
    // 目录与日志都在、只是没有账目。那种会话照样能删：没有成员资格可摘，恢复时也不挂账本。
    const workspaceId = await deps.host.workspaceOf(sessionId)

    // 宿主给的 id **实测就是目录名**（v3 无前缀、v4 带 `session-` 前缀，两种都在真机上读到过）
    // ⇒ 它同时就是**记进 entryId 的那段原目录名**（`makeEntryId`），恢复端照它放回、不再现推（设计稿 §3）。
    const sessionDir = sessionDirOf(projectDir, sessionId, deps.home)
    if (!(await deps.fs.exists(sessionDir))) throw verbError('not-found', `会话目录不存在：${sessionDir}`)

    const wasArchived = await deps.host.isArchived(sessionId)
    const deletedAt = deps.now()
    const entryId = makeEntryId(deletedAt, sessionId)
    const trashDir = trashDirOf(entryId, deps.home)

    // 两件纯读提前到任何写之前——读不依赖写，失败即"零副作用失败"，
    // 不会留下"归档已加、账本已摘、文件仍在原地、清单无行"的半吊子状态
    let title: string
    let sizeBytes: number
    try {
      title = await deps.host.titleOf(sessionId)
      sizeBytes = await deps.fs.sizeOfDir(sessionDir)
    } catch (error) {
      throw verbError('io', `读取会话现场失败：${String(error)}`, error)
    }

    // ③ 归档（藏起来）：删除后它不能再出现在分组面里——而**只摘账本挡不住它**。
    //   宿主的会话列表读面是并集（`sessionQuery.listSessions()` = 磁盘上的持久化 ∪ 内存里 attach 着的活体），
    //   搬文件只清掉其中一侧；本机运行期打开/用过的会话是活体，`session.list` 照样把它交出来，
    //   而账本一摘它就成了"无主且可见"的一行 ⇒ 客户端派生分组时正好把它收进「未分组」
    //   （真机实测：文件已进回收站、账本已摘，侧栏却留着一行在未分组下）。
    //   归档是宿主自己的隐藏面（官方注释 "Hide one known Session from Workspace grouping surfaces"），
    //   客户端的分组派生按 `archivedFilter` 先把它挡掉；**必须先于 detach**，否则两者之间会有一段可见的无主窗口。
    //   已在归档集里就一个字节都不动（官方语义：已归档的 id 直接返回，不写、不问、不停）。
    if (!wasArchived) {
      try {
        await deps.host.archive(sessionId, workspaceId)
      } catch (error) {
        // 第一件写就失败 ⇒ 零副作用，不需要回滚（文件、账本、归档集都还是原样）
        throw verbError('io', `归档失败：${String(error)}`, error)
      }
    }
    if (workspaceId !== undefined) {
      try {
        // ② 摘账本：若先动文件而这一步失败，账本会留下指向不存在会话的行
        await deps.host.detach(sessionId, workspaceId)
      } catch (error) {
        if (!wasArchived) await deps.host.unarchive(sessionId).catch(() => {})
        throw verbError('io', `摘账本失败：${String(error)}`, error)
      }
    }

    const entry: TrashEntry = {
      id: entryId, sessionId, projectDir, workspaceId: workspaceId ?? '', wasArchived, deletedAt,
      title, sizeBytes,
    }
    try {
      // ① 最后动文件：同卷 rename，原子瞬时；首删时回收站根还不存在，先建
      await deps.fs.ensureDir(`${deps.home}/session-trash`)
      await deps.fs.rename(sessionDir, trashDir)
    } catch (error) {
      if (workspaceId !== undefined) await deps.host.attach(sessionId, workspaceId).catch(() => {})
      if (!wasArchived) await deps.host.unarchive(sessionId).catch(() => {})
      throw verbError('io', `移动会话目录失败：${String(error)}`, error)
    }

    // 登记清单是最后一件写。它失败也要把前面三步退回去——**文件已进回收站而清单无行**是个
    // 面板看不见、用户也恢复不了的孤儿（正是本节要避免的那种"删一半"）。滚回顺序与执行相反：
    // 先把目录挪回原处，再挂账本，最后按 `wasArchived` 还原可见性。
    try {
      await deps.manifest.add(entry)
    } catch (error) {
      await deps.fs.rename(trashDir, sessionDir).catch(() => {})
      if (workspaceId !== undefined) await deps.host.attach(sessionId, workspaceId).catch(() => {})
      if (!wasArchived) await deps.host.unarchive(sessionId).catch(() => {})
      throw verbError('io', `登记回收站条目失败：${String(error)}`, error)
    }
    // ⑤ 最后两件：把会话从宿主内存里摘掉，再**如实通告**客户端把那一行删掉。
    // 通告的门槛是"知道宿主列表已经不含它"（evicted / not-live）；unknown 时沉默——那时发"已移除"是假话，
    // 客户端重连后那一行会自己长回来。两件都不抛、也不影响已经完成的删除。
    const eviction = await deps.host.evictLive(sessionId)
    if (eviction !== 'unknown') await deps.host.announceRemoved(sessionId)
    return entry
  }
}
