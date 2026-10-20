import { makeEntryId, sessionDirOf, trashDirOf, type TrashEntry } from '../trash/entry.js'
import type { FsPort } from '../ports/fs-port.js'
import type { HostPort } from '../ports/host-port.js'
import type { ManifestPort } from '../trash/manifest.js'
import { TRASH_DIR_NAME } from '../shared/wire.js'
import { verbError } from './errors.js'
import { attempt, createJournal, rollbackJournals, type Journal, type JournalStep } from './member-journal.js'

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

/**
 * 删除 = 移入回收站，**按组走**：用户点掉一条父会话时，宿主的客户端把 `origin:"subagent"` 的孩子
 * 整排藏了 ⇒ 那些目录既看不见也继续占着字节（本机实测 41 条父留了 320 个目录 / 74.6 MB）。
 * 所以这里把父在盘上的孩子一起搬进来，各自成目录、各自一行，清册用 `parentEntryId` 记它是谁的孩子。
 *
 * 三段，顺序承重：
 * ① **先点组、先验活体**（一个字节都不写）。任一成员在跑就整组拒绝——不替用户终止正在跑的活，
 *    也绝不允许"父已经搬进回收站、孩子因为在跑而搬不动"这种半套。
 * ② **逐个搬**：每个成员是一份 `journal`（`verbs/member-journal.ts`），搬不动时 journal 自己把
 *    这个成员已经做成的步骤退回去。
 * ③ **组级回滚**：某一个成员搬不动时，把**已经搬进去的**那些按相反顺序退回原处（清册行跟着摘、
 *    账本跟着挂、可见性跟着还原），失败照抛——不留"半组在回收站、半组在原地"的世界。
 *
 * interface 只有**一个 id**：批量的性质不在这里（同批"已被前一条带走"的判据归 `verbs/batch.ts`）。
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
    const done: Journal[] = []
    let parentEntry: TrashEntry | undefined
    try {
      for (const member of members) {
        const isParent = member.sessionId === sessionId
        const move = await memberMove(deps, member, deletedAt, isParent ? undefined : parentEntry!.id)
        if (isParent) parentEntry = move.entry
        await move.journal.run()
        done.push(move.journal)
      }
    } catch (error) {
      // 相反顺序退回去（执行的最后一件先退）；某一步退不干净时**不能**让原错误独走——
      // 客户端只看 code 会以为已经回到删除前，实际半组还挂在回收站里。
      await rollbackJournals(done, error)
    }
    return parentEntry!
  }
}

/**
 * 一个成员要做的步骤（顺序承重，那五步就列在下面一行）：
 * 读现场（两件纯读）→ 归档 → 摘账本 → 搬目录 → 写清册行。
 *
 * 每一步的反向动作都是"把这件写退回原样"；**清册行是最后一件写**，它失败时 journal 会把目录搬回去、
 * 账本挂回去、可见性还原。清册行的反向动作带一道闸：**回收站目录还没搬回来就不摘那一行**——
 * 留着行至少元数据还在（与旧实现"目录退不回就不摘行"同一条判据）。
 */
async function memberMove(
  deps: DeleteDeps,
  member: Member,
  deletedAt: number,
  parentEntryId: string | undefined,
): Promise<{ entry: TrashEntry; journal: Journal }> {
  const { sessionId, projectDir } = member
  const workspaceId = await deps.host.workspaceOf(sessionId)
  const sessionDir = sessionDirOf(projectDir, sessionId, deps.home)
  const wasArchived = await deps.host.isArchived(sessionId)
  const trashDir = trashDirOf(makeEntryId(deletedAt, sessionId), deps.home)

  // 标题与字节要靠第一步读回来；条目对象先建好，那一步就地补上（`manifest.add` 是最后一件写）。
  const entry: TrashEntry = {
    id: makeEntryId(deletedAt, sessionId), sessionId, projectDir, workspaceId: workspaceId ?? '',
    wasArchived, deletedAt, title: '', sizeBytes: 0,
    ...(parentEntryId === undefined ? {} : { parentEntryId }),
  }
  /** 目录真的搬进回收站了吗——决定那一步的反向动作有没有东西可退。 */
  let moved = false
  /** 回滚的三件写是否都真正退回原样：目录、账本、可见性。`announceRestored` 只在这三件都成立时发。 */
  let movedBack = false
  let workspaceBack = workspaceId === undefined
  let visibleBack = wasArchived

  const steps: JournalStep[] = [
    {
      label: '读取会话现场失败',
      run: async () => {
        entry.title = await deps.host.titleOf(sessionId)
        entry.sizeBytes = await deps.fs.sizeOfDir(sessionDir)
      },
    },
    // 归档必须先于摘账本（否则中间有一段"无主且可见"的窗口，它会掉进「未分组」）
    ...(wasArchived ? [] : [{
      label: '归档失败',
      run: async () => { await deps.host.archive(sessionId, workspaceId) },
      undo: async () => {
        const failures = await attempt('可见性还原失败', async () => {
          await deps.host.unarchive(sessionId)
          visibleBack = true
        })
        return failures
      },
    }]),
    ...(workspaceId === undefined ? [] : [{
      label: '摘账本失败',
      run: async () => { await deps.host.detach(sessionId, workspaceId) },
      undo: async () => {
        const failures = await attempt('账本挂回失败', async () => {
          await deps.host.attach(sessionId, workspaceId)
          workspaceBack = true
        })
        return failures
      },
    }]),
    {
      // 目录与清册行合成一步：**行必须在目录搬进回收站之后写**（否则中间有一段"行在、目录还在
      // `sessions/`"的世界，对账会把它当成幽灵行摘掉，接着目录搬进来就成了点不开的孤儿目录）。
      // 反向动作因此也是两件、且有先后：**先搬回目录、再摘行**——搬不回去就留着行，元数据还在。
      // 目录一次都没搬动过（rename 自己就失败了）时没有可退的：那时清册行也还没写。
      label: '移动会话目录失败',
      undoOnFailure: true,
      run: async () => {
        await deps.fs.ensureDir(`${deps.home}/${TRASH_DIR_NAME}`)
        await deps.fs.rename(sessionDir, trashDir)
        moved = true
        try {
          await deps.manifest.add(entry)
        } catch (error) {
          // 这一句的措辞承重（既有上屏原文），所以在这里就地给动词码，不走 journal 的默认折法
          throw verbError('io', `登记回收站条目失败：${String(error)}`, error)
        }
      },
      undo: async () => {
        if (!moved) return []
        const failures: string[] = [...await attempt('目录搬回失败', async () => {
          await deps.fs.rename(trashDir, sessionDir)
          movedBack = true
        })]
        if (failures.length === 0) {
          failures.push(...await attempt('清册行摘除失败', () => deps.manifest.remove(entry.id)))
        }
        return failures
      },
    },
  ]

  const journal = createJournal(steps)
  return {
    entry,
    journal: {
      // 搬完之后才把"从宿主内存里摘掉 + 如实通告"补上：这两件都不抛，且只在完全搬成之后有意义。
      async run() {
        await journal.run()
        const eviction = await deps.host.evictLive(sessionId)
        if (eviction !== 'unknown') await deps.host.announceRemoved(sessionId)
      },
      /** 组级回滚：先把成员自己的步骤按相反顺序退回，再在**三件写都真正回去**时补一条"已恢复"通告。
       *  这一行此前已经收过 `api-session/removed`；不发"回来了"它就会在客户端消失到重连为止。
       *  目录没退回、账本没挂回、或可见性没还原 ⇒ 不发——那会是假话（同 restore 侧 `movedBack` 的判据）。 */
      async undo() {
        const failures = await journal.undo()
        if (movedBack && workspaceBack && visibleBack) {
          await deps.host.announceRestored(sessionId).catch(() => {})
        }
        return failures
      },
    },
  }
}
