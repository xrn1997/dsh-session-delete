import { parseEntryId, sessionDirOf, trashDirOf, type TrashEntry } from '../trash/entry.js'
import { isWorkspaceMissingError, type HostIdentityPort } from '../ports/host-port.js'
import type { CoreDeps } from '../deps.js'
import { verbError } from './errors.js'
import { createJournal, stepUndo, type Journal, type JournalStep } from './member-journal.js'
import { createMemberPresence, type MemberPresence } from './member-presence.js'
import { moveGroup } from './move-group.js'

/**
 * 恢复 = 把删除那次**按原路退回**，而且按组走：当年是按组一起搬进来的（父 + 它在盘上的孩子），
 * 只回父就会在回收站里留下一堆点不到的孩子行——清单只列父行，那些行既看不见也清不掉。
 *
 * 三段与删除对称（成员循环与整组回滚的实现住 `verbs/move-group.ts`）：
 * ① **预检整组**（一个字节都不写）：每个成员的回收站目录与项目目录都得在。缺席的判据与原来一致
 *    （回收站目录不在 = `trash-empty`；原项目目录不在 = `project-missing`，且绝不静默建目录）。
 *    预检在写之前，是为了不让"父已经回到 `sessions/`、孩子因为项目目录没了而回不去"这种半组留在外面。
 *    **工作区账本不在这条硬前提里**：宿主的「删除工作区」只删注册、保留日志，记下的工作区没了就按
 *    「未分组」收（判据在 {@link attachableWorkspaceId}），照旧回盘——恢复是加法，不该因为一个可选的账目而失败。
 * ② **逐个恢复**，顺序与删除相反：文件先回来 → 挂账本 →（旧清单迁移）取消归档 → 摘清册行。
 * ③ 中途失败时 journal 把这个成员自己退回回收站；**已经恢复完的**兄弟由整组 catch 按相反顺序一起退回。
 *
 * **通告不在这里**：一次批量只该拉一遍宿主会话表、只发一次 `api-session/added`（2026-10-17 那次
 * "恢复很慢"就是逐条发）。通告归 `verbs/batch.ts`（ADR-0002），所以这个动词的 interface 是
 * "一个条目 id + 这一组进、回收站那一行出"，没有批量专用的开关。
 */
export function restoreSession(deps: CoreDeps) {
  const presence = createMemberPresence(deps.host)
  return async function restoreSession(
    entryId: string,
    /** 这一组（只读）：批量层由 `batch-carried.ts` 的 `claimOf` 给出，直调者按 `trash/groups.ts`
     *  的 `groupOf` 自己算。ghost 父（父行已摘、只剩孩子）的组只有孩子、不含 `entryId`，这里照旧
     *  报 `trash-empty`；其余调用按这一组整体恢复。动词**不收缩**它——收缩与同批已带走集都归
     *  `verbs/batch-carried.ts`，组语义归 `trash/groups.ts`。 */
    group: readonly TrashEntry[],
  ): Promise<TrashEntry> {
    const target = group.find(e => e.id === entryId)
    if (!target) throw verbError('trash-empty', `回收站里没有这一条：${entryId}`)

    for (const entry of group) {
      const trashDir = trashDirOf(entry.id, deps.home)
      if (!(await deps.fs.exists(trashDir))) throw verbError('trash-empty', `回收站条目已不在磁盘上：${trashDir}`)
      const projectRoot = sessionDirOf(entry.projectDir, '', deps.home).replace(/\/$/, '')
      if (!(await deps.fs.exists(`${deps.home}/sessions`)) || !(await deps.fs.exists(projectRoot))) {
        throw verbError('project-missing', `原项目目录已不存在：${projectRoot}`)
      }
    }

    // 相反顺序退回去；某一步退不干净时**不能**让原错误独走——客户端只看 code 会以为已经回到回收站，
    // 实际那个成员半在 `sessions/` 半在回收站里，通告还会骗它把那一行删掉。
    await moveGroup(group, async (entry) => {
      const move = await memberRestore(deps, presence, entry)
      return { journal: move.journal, result: undefined }
    })
    return target
  }
}

/** 放回哪儿：用**删除时记进 entryId 的那段原目录名**，不从 `sessionId` 现推（CONTEXT.md 的「条目」条）——
 *  因此不依赖宿主当时的目录命名约定（v3 无前缀 / v4 带 `session-` 前缀）。 */
function restoreTargetDir(deps: CoreDeps, entry: TrashEntry): string {
  return sessionDirOf(entry.projectDir, parseEntryId(entry.id).sessionDirName, deps.home)
}

/**
 * 这一次恢复**到底挂不挂账本**：交出能挂的那个 `workspaceId`，挂不了就 `undefined`。
 *
 * 两种缺席是同一件事：空串 = 删除时它就没有账目（「未分组」的会话）；非空但账本里已经没它 =
 * 宿主的「删除工作区」只删注册、保留目录与每一份日志，那些会话之后本来就在「未分组」下。
 * 恢复不该为了挂一个不存在的账本把整条退回回收站。
 *
 * 判据**只有这一处**：`memberRestore` 拿它决定挂不挂，`GET /list` 拿它决定行上那句「原工作区已不存在，
 * 恢复后归入未分组」说不说。两边各问一遍就会有一天一个说、一个不挂。
 */
export async function attachableWorkspaceId(host: Pick<HostIdentityPort, 'workspaceExists'>, entry: TrashEntry): Promise<string | undefined> {
  if (entry.workspaceId === '') return undefined
  return await host.workspaceExists(entry.workspaceId) ? entry.workspaceId : undefined
}

/** 这一条记着的工作区**是不是已经没了**（区别于"删除时它就没有账目"的空串）——清单行据此决定
 *  要不要在点之前说那句「原工作区已不存在，恢复后归入未分组」。由 {@link attachableWorkspaceId}
 *  派生，不另起一份判据：那样会有一天一个说、一个不挂。 */
export async function isWorkspaceMissing(host: Pick<HostIdentityPort, 'workspaceExists'>, entry: TrashEntry): Promise<boolean> {
  return entry.workspaceId !== '' && (await attachableWorkspaceId(host, entry)) === undefined
}

/**
 * 一个成员的恢复步骤（顺序与删除相反）：放回目录 → 挂账本 →（旧清单迁移）取消归档 → 摘清册行。
 *
 * 账本那一步有个**只认端口那句**的兜底：查过之后、挂之前账本被删掉（宿主的「删除工作区」与这次恢复
 * 撞上）⇒ 按未分组收、不回滚；**别的**失败是真故障，照旧抛（吞掉它就等于把一次存储故障伪装成"未分组"）。
 */
async function memberRestore(
  deps: CoreDeps,
  presence: MemberPresence,
  entry: TrashEntry,
): Promise<{ journal: Journal }> {
  const trashDir = trashDirOf(entry.id, deps.home)
  const sessionDir = restoreTargetDir(deps, entry)

  // 账本归属是**可选的一步**，判据见 {@link attachableWorkspaceId}。
  const workspaceId = await attachableWorkspaceId(deps.host, entry)
  /**
   * **旧清单迁移**：2026-10-21 之前的删除用归档来藏会话，所以那些条目在盘上仍是归档态。
   * 新删除不再碰归档（回收站与归档解耦）⇒ `wasArchived:false` 且当前**仍**归档的，只可能是旧条目；
   * 恢复时取消归档。`wasArchived:true` 是用户删除前自己归档的，保持归档态不动。
   */
  const legacyArchived = !entry.wasArchived && await deps.host.isArchived(entry.sessionId)
  /** 真挂上了账本才记下那个 id——回滚里"摘账本"那一步只对挂过的成员存在。 */
  let attached = false

  const steps: JournalStep[] = [
    // ① 文件先回来
    {
      key: 'dir',
      label: '放回会话目录失败',
      run: async () => { await deps.fs.rename(trashDir, sessionDir) },
      undo: () => stepUndo('目录退回回收站失败', () => deps.fs.rename(sessionDir, trashDir)),
    },
    // ② 再挂账本（`workspaceId` 缺席 = 没有账本可挂）
    ...(workspaceId === undefined ? [] : [{
      key: 'workspace' as const,
      label: '挂回账本失败',
      run: async () => {
        try {
          await deps.host.attach(entry.sessionId, workspaceId)
          attached = true
        } catch (error) {
          if (!isWorkspaceMissingError(error) || await deps.host.workspaceExists(workspaceId)) throw error
          // 账本在这次恢复的同时被删掉了：按未分组收，不回滚
        }
      },
      undo: async () => {
        if (!attached) return { restored: true, failures: [] }
        return stepUndo('摘账本失败', () => deps.host.detach(entry.sessionId, workspaceId))
      },
    }]),
    // ③ **只为旧清单迁移**取消归档：新删除不归档，`legacyArchived` 为假时一个字节都不碰归档集。
    //    用户删除前原本已归档（`wasArchived:true`）的也保持归档态（`legacyArchived` 为假）。
    //    `undoOnFailure`：取消归档可能已经半做完，所以它自己失败时也要先把会话藏回去。
    ...(!legacyArchived ? [] : [{
      key: 'archive' as const,
      label: '取消归档失败',
      undoOnFailure: true,
      run: async () => { await deps.host.unarchive(entry.sessionId) },
      undo: () => stepUndo('重新归档失败', () => deps.host.archive(entry.sessionId, workspaceId)),
    }]),
    // ④ 摘清单行是最后一件写。它失败时 journal 把前几步退回去，否则会留下一条
    //    **恢复不了也清不掉的幽灵行**（目录已经回了 `sessions/`，行却还在回收站里挂着）。
    {
      key: 'manifest',
      label: '摘回收站条目失败',
      run: async () => { await deps.manifest.remove(entry.id) },
      undo: () => stepUndo('清册行写回失败', () => deps.manifest.add(entry)),
    },
  ]

  const journal = createJournal(steps)
  return {
    journal: {
      run: () => journal.run(),
      // 组级回滚：先把步骤按相反顺序退回，再交给成员在场 module 判「目录真的回到回收站了吗」。
      async undo() {
        const undo = await journal.undo()
        await presence.memberGone(entry.sessionId, { backInTrash: undo.restored('dir') })
        return undo
      },
    },
  }
}
