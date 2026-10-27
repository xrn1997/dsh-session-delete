import { parseEntryId, sessionDirOf, trashDirOf, type TrashEntry } from '../trash/entry.js'
import { isWorkspaceMissingError, type HostIdentityPort } from '../ports/host-port.js'
import type { CoreDeps } from '../deps.js'
import { trashEmpty, verbError } from './errors.js'
import { createJournal, stepUndo, type Journal, type JournalStep } from './member-journal.js'
import { withPresenceTail } from './member-presence.js'
import type { PresenceCapability } from '../ports/presence-port.js'
import { moveGroup } from './move-group.js'

/**
 * 恢复：把删除那次按原路退回，并按组走。
 *
 * 三段：
 * 1. 预检整组（不写盘）：每个成员的回收站目录与原项目目录都必须在；工作区账本缺席不算硬失败，
 *    恢复后归入「未分组」。预检在任何写之前，避免留下半组。
 * 2. 逐个恢复：文件先回来 → 挂账本 →（旧条目）取消归档 → 摘清册行。
 * 3. 中途失败由 journal 回滚当前成员；已恢复的兄弟由整组按相反顺序退回。
 *
 * 通告不在本文件：批量层在批尾一次 `announceRestored(ids)`（ADR-0002）。
 */
export function restoreSession(deps: CoreDeps) {
  const presence = deps.presence
  return async function restoreSession(
    entryId: string,
    /** 这一组（只读）：批量层由 `batch-carried.ts` 的 `claimOf` 给出，直调者按 `trash/groups.ts`
     *  的 `groupOf` 自己算。ghost 父（父行已摘、只剩孩子）的组只有孩子、不含 `entryId`，这里照旧
     *  报 `trash-empty`；其余调用按这一组整体恢复。动词**不收缩**它——收缩与同批已带走集都归
     *  `verbs/batch-carried.ts`，组语义归 `trash/groups.ts`。 */
    group: readonly TrashEntry[],
  ): Promise<TrashEntry> {
    const [root, ...followers] = group
    const target = group.find(e => e.id === entryId)
    if (root === undefined || target === undefined) {
      throw trashEmpty(entryId)
    }

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
    // `root` 只是**操作顺序上的根**（组的第一成员）：ghost / 降级组里它可能仍记着 `parentEntryId`
    // （真正的组根已经不在），`moveGroup` 只负责先跑它；组语义仍归 `trash/groups.ts`。
    await moveGroup<TrashEntry, undefined>({
      root,
      followers,
      move: async (entry) => {
        const move = await memberRestore(deps, presence, entry)
        // 恢复不产出结果：根与跟随者都交回 `undefined`，没有按位置约定的占位结果。
        return { journal: move.journal, result: undefined }
      },
    })
    return target
  }
}

/** 放回哪儿：用删除时记进 entryId 的原目录名，不从 sessionId 现推；因此不依赖宿主的目录命名约定。 */
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
 * 一个成员的恢复步骤：放回目录 → 挂账本 →（旧条目）取消归档 → 摘清册行。
 * 挂账本时若工作区刚被删除，按未分组收、不回滚；其他失败照抛，不能伪装成未分组。
 */
async function memberRestore(
  deps: CoreDeps,
  presence: PresenceCapability,
  entry: TrashEntry,
): Promise<{ journal: Journal }> {
  const trashDir = trashDirOf(entry.id, deps.home)
  const sessionDir = restoreTargetDir(deps, entry)

  // 账本归属是**可选的一步**，判据见 {@link attachableWorkspaceId}。
  const workspaceId = await attachableWorkspaceId(deps.host, entry)
  /** 旧条目迁移：早期删除用归档藏会话，盘上仍是归档态。
   *  `wasArchived:false` 且当前仍归档 ⇒ 只可能是旧条目，恢复时取消归档；
   *  `wasArchived:true` 是用户删除前自己归档的，保持归档态。 */
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
    // ③ 旧条目迁移：只有 legacyArchived 为真才动归档集；用户删前自己归档的保持归档态。
    //    undoOnFailure：取消归档可能半做完，失败时也要把会话藏回去。
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
      run: async () => { await deps.ledger.remove(entry.id) },
      undo: () => stepUndo('清册行写回失败', () => deps.ledger.add(entry)),
    },
  ]

  const journal = createJournal(steps)
  return {
    journal: withPresenceTail(presence, journal, {
      sessionId: entry.sessionId,
      // run 不动在场：恢复的「回到可见面」由批量层一次 `announceRestored(ids)` 发起（ADR-0002）。
      // 组级回滚时目录真的退回回收站了才发 removed；没退回去就什么都别发。
      onUndone: (undo) => ({ kind: 'leave', backInTrash: undo.restored('dir') }),
    }),
  }
}
