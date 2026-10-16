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

/** 组里的一个成员（父自己也是一个成员）。 */
interface Member {
  sessionId: string
  /** 父的由宿主的项目目录面给出；孩子的由端口随记录一起交回来（同一个 `projectKey` 算法）。 */
  projectDir: string
}

/** 一次搬入的**反向动作**：把这个成员退回删除前的样子。 */
type Undo = () => Promise<void>

/**
 * 删除 = 移入回收站，**按组走**：用户点掉一条父会话时，宿主的客户端把 `origin:"subagent"` 的孩子
 * 整排藏了 ⇒ 那些目录既看不见也继续占着字节（本机实测 41 条父留了 320 个目录 / 74.6 MB）。
 * 所以这里把父在盘上的孩子一起搬进来，各自成目录、各自一行，清册用 `parentEntryId` 记它是谁的孩子。
 *
 * 三段，顺序承重：
 * ① **先点组、先验活体**（一个字节都不写）。任一成员在跑就整组拒绝——不替用户终止正在跑的活，
 *    也绝不允许"父已经搬进回收站、孩子因为在跑而搬不动"这种半套。
 * ② **逐个搬**：每个成员内部沿用原来那套顺序与就地回滚（归档 → 摘账本 → 搬目录 → 写清册），
 *    任何一步失败就把这个成员自己退回原地。
 * ③ **组级回滚**：某一个成员搬不动时，把**已经搬进去的**那些按相反顺序退回原处（清册行跟着摘、
 *    账本跟着挂、可见性跟着还原），失败照抛——不留"半组在回收站、半组在原地"的世界。
 */
export function deleteSession(deps: DeleteDeps) {
  return async function deleteSession(sessionId: string): Promise<TrashEntry> {
    const kids = await deps.host.subagentMembers(sessionId)

    const parentProjectDir = await deps.host.projectDirOf(sessionId)
    if (parentProjectDir === undefined) throw verbError('not-found', `宿主的持久化里没有这个会话：${sessionId}`)

    // ① 准入：父与孩子逐个查活体（父的账本归属可以缺席——未分组的会话本来就是那种）
    const candidates: Member[] = [
      { sessionId, projectDir: parentProjectDir },
      ...kids.map(k => ({ sessionId: k.sessionId, projectDir: k.projectDir })),
    ]
    for (const member of candidates) {
      if (await deps.host.isLive(member.sessionId)) {
        throw verbError('live', `会话正在运行：${member.sessionId}`)
      }
    }

    // 父的目录必须在盘上（不在就是"账本说有、盘上没有"，与原来同一条 not-found）；
    // 孩子的目录缺席**跳过它**：宿主记录与磁盘不一致是孩子的问题，不该让父删不掉。
    const parentDir = sessionDirOf(parentProjectDir, sessionId, deps.home)
    if (!(await deps.fs.exists(parentDir))) throw verbError('not-found', `会话目录不存在：${parentDir}`)
    const members: Member[] = [{ sessionId, projectDir: parentProjectDir }]
    for (const kid of kids) {
      if (await deps.fs.exists(sessionDirOf(kid.projectDir, kid.sessionId, deps.home))) {
        members.push({ sessionId: kid.sessionId, projectDir: kid.projectDir })
      }
    }

    const deletedAt = deps.now()
    const done: Undo[] = []
    let parentEntry: TrashEntry | undefined
    try {
      for (const member of members) {
        const isParent = member.sessionId === sessionId
        const entry = await moveOneIn(deps, member, deletedAt, isParent ? undefined : parentEntry!.id)
        if (isParent) parentEntry = entry
        done.push(() => undoOneIn(deps, entry))
      }
    } catch (error) {
      // 相反顺序退回去（执行的最后一件先退）
      for (const undo of done.reverse()) await undo()
      throw error
    }
    return parentEntry!
  }
}

/**
 * 搬一个成员进回收站。五件写的顺序照设计稿 §4 那五触点，每一步的失败都**就地**把这个成员自己退回原地：
 * 归档必须先于摘账本（否则中间有一段"无主且可见"的窗口，它会掉进「未分组」），文件在两件纯读之后，
 * 清册行是最后一件写（它失败就把目录挪回去、账本挂回去、可见性还原）。
 */
async function moveOneIn(deps: DeleteDeps, member: Member, deletedAt: number, parentEntryId: string | undefined): Promise<TrashEntry> {
  const { sessionId, projectDir } = member
  const workspaceId = await deps.host.workspaceOf(sessionId)
  const sessionDir = sessionDirOf(projectDir, sessionId, deps.home)

  const wasArchived = await deps.host.isArchived(sessionId)
  const entryId = makeEntryId(deletedAt, sessionId)
  const trashDir = trashDirOf(entryId, deps.home)

  // 两件纯读提前到任何写之前——读不依赖写，失败即"零副作用失败"
  let title: string
  let sizeBytes: number
  try {
    title = await deps.host.titleOf(sessionId)
    sizeBytes = await deps.fs.sizeOfDir(sessionDir)
  } catch (error) {
    throw verbError('io', `读取会话现场失败：${String(error)}`, error)
  }

  if (!wasArchived) {
    try {
      await deps.host.archive(sessionId, workspaceId ?? undefined)
    } catch (error) {
      throw verbError('io', `归档失败：${String(error)}`, error)
    }
  }
  if (workspaceId !== undefined) {
    try {
      await deps.host.detach(sessionId, workspaceId)
    } catch (error) {
      if (!wasArchived) await deps.host.unarchive(sessionId).catch(() => {})
      throw verbError('io', `摘账本失败：${String(error)}`, error)
    }
  }

  const entry: TrashEntry = {
    id: entryId, sessionId, projectDir, workspaceId: workspaceId ?? '', wasArchived, deletedAt,
    title, sizeBytes,
    ...(parentEntryId === undefined ? {} : { parentEntryId }),
  }
  try {
    await deps.fs.ensureDir(`${deps.home}/session-trash`)
    await deps.fs.rename(sessionDir, trashDir)
  } catch (error) {
    if (workspaceId !== undefined) await deps.host.attach(sessionId, workspaceId).catch(() => {})
    if (!wasArchived) await deps.host.unarchive(sessionId).catch(() => {})
    throw verbError('io', `移动会话目录失败：${String(error)}`, error)
  }

  try {
    await deps.manifest.add(entry)
  } catch (error) {
    await deps.fs.rename(trashDir, sessionDir).catch(() => {})
    if (workspaceId !== undefined) await deps.host.attach(sessionId, workspaceId).catch(() => {})
    if (!wasArchived) await deps.host.unarchive(sessionId).catch(() => {})
    throw verbError('io', `登记回收站条目失败：${String(error)}`, error)
  }

  // 最后两件：从宿主内存里摘掉，再如实通告客户端把那一行删掉。都不抛。
  const eviction = await deps.host.evictLive(sessionId)
  if (eviction !== 'unknown') await deps.host.announceRemoved(sessionId)
  return entry
}

/** 把一个**已经搬进去**的成员退回删除前：目录 → 账本 → 可见性 → 清册行 → 通告回来。 */
async function undoOneIn(deps: DeleteDeps, entry: TrashEntry): Promise<void> {
  const sessionDir = sessionDirOf(entry.projectDir, entry.sessionId, deps.home)
  await deps.fs.rename(trashDirOf(entry.id, deps.home), sessionDir).catch(() => {})
  if (entry.workspaceId !== '') await deps.host.attach(entry.sessionId, entry.workspaceId).catch(() => {})
  if (!entry.wasArchived) await deps.host.unarchive(entry.sessionId).catch(() => {})
  await deps.manifest.remove(entry.id).catch(() => {})
  await deps.host.announceRestored(entry.sessionId).catch(() => {})
}
