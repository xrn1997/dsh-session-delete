import { makeEntryId, sessionDirForId, sessionDirOf, sessionDirSegmentOf, trashDirOf, type TrashEntry } from '../trash/entry.js'
import type { CoreDeps, DeleteSessionDeps } from '../deps.js'
import { TRASH_DIR_NAME } from '../shared/wire.js'
import { verbError } from '../errors.js'
import { attempt, createJournal, stepUndo, type Journal, type JournalStep } from './member-journal.js'
import { assertNoLive } from './live-admission.js'
import { withPresenceTail } from './member-presence.js'
import type { PresenceCapability } from '../ports/presence-port.js'
import { moveGroup } from './move-group.js'
import { writeProgress } from './write-progress.js'

export interface DeleteResult {
  readonly entry: TrashEntry
  /** 这一次真的搬进回收站的成员（父 + 盘上存在的孩子）；批量层用它建同批已带走集。 */
  readonly movedSessionIds: readonly string[]
}

/** 组里的一个成员（父自己也是一个成员）。 */
interface Member {
  sessionId: string
  /** 父的由宿主的项目目录面给出；孩子的由端口随记录一起交回来（同一个 `projectKey` 算法）。 */
  projectDir: string
}

/**
 * 删除 = 移入回收站，**按组走**：用户点掉一条父会话时宿主把 `origin:"subagent"` 的孩子整排藏了 ⇒ 那些目录既看不见也继续占字节，
 * 所以父在盘上的孩子一起搬进来，各自一行，清册用 `parentEntryId` 记归属。
 *
 * 三段，顺序承重（成员循环与整组回滚住 `verbs/move-group.ts`）：
 * ① **先点组、先验活体**（一个字节都不写）：任一成员在跑就整组拒绝，不替用户终止活体，也不留半套；
 * ② **逐个搬**：每个成员一份 `journal`（`member-journal.ts`），搬不动时它自己退回已做成的步骤；
 * ③ **组级回滚**：某成员搬不动时把已搬进去的按相反顺序退回原处，失败照抛——不留"半组在回收站、半组在原地"。
 *
 * interface 只有**一个 id**：批量的性质与组语义都不在这里（`batch-carried.ts` / `trash/groups.ts`）；
 * 结果带回这次真的搬走的整组（`movedSessionIds`）——内部数据，不靠回调借用动词的手。
 */
export function deleteSession(deps: DeleteSessionDeps) {
  const presence = deps.presence
  return async function deleteSession(sessionId: string): Promise<DeleteResult> {
    // 语料看不见（`available: false`）⇒ 只删父：写侧只许降级，盘上残留留给 `GET /orphans` 兜底。
    const read = await deps.host.subagentMembersOf([sessionId])
    const kids = read.available ? (read.value[sessionId] ?? []) : []

    const parentProjectDir = await deps.host.projectDirOf(sessionId)
    if (parentProjectDir === undefined) throw verbError('not-found', `宿主的持久化里没有这个会话：${sessionId}`)

    // ① 准入：父与孩子逐个查活体（判据与原文住 `verbs/live-admission.ts`）；查的是宿主报的全部孩子，
    //    **不是**后面按盘上目录筛过的 `members`——目录不在不代表它没在跑。
    await assertNoLive(deps.host, [sessionId, ...kids.map((kid) => kid.sessionId)])

    // 父的目录必须在盘上（不在就是"账本说有、盘上没有"，按 not-found）；孩子的目录缺席**跳过它**：
    // 宿主记录与磁盘不一致是孩子的问题，不该让父删不掉。路径先编成宿主目录段，不拿原始 id 拼。
    const parentDir = sessionDirForId(parentProjectDir, sessionId, deps.home)
    if (!(await deps.fs.exists(parentDir))) throw verbError('not-found', `会话目录不存在：${parentDir}`)
    const parent: Member = { sessionId, projectDir: parentProjectDir }
    const members: Member[] = [parent]
    for (const kid of kids) {
      if (await deps.fs.exists(sessionDirForId(kid.projectDir, kid.sessionId, deps.home))) {
        members.push({ sessionId: kid.sessionId, projectDir: kid.projectDir })
      }
    }

    const deletedAt = deps.now()
    // 相反顺序退回去（执行的最后一件先退）；某一步退不干净时**不能**让原错误独走——
    // 客户端只看 code 会以为已经回到删除前，实际半组还挂在回收站里。
    const rootEntry = await moveGroup<Member, TrashEntry>({
      root: parent,
      followers: members.slice(1),
      move: async (member, rootResult) => {
        // 组根（父）由 interface 直接交回；跟随者拿到的根结果就是父条目，孩子用它记 `parentEntryId`。
        const parentEntryId = rootResult?.id
        const move = await memberMove(deps, presence, member, deletedAt, parentEntryId)
        return { journal: move.journal, result: move.entry }
      },
    })
    return { entry: rootEntry, movedSessionIds: members.map((member) => member.sessionId) }
  }
}

/**
 * 一个成员的步骤（顺序承重）：读现场 → 摘账本 → 搬目录 → 写清册行；搬完由 `memberGone` 关掉活体（session + agent）。
 * **删除不碰归档**——回收站与归档是两套状态，归档只在用户自己归档过时保留。
 *
 * **已知窗口**：摘账本之后、`memberGone` 之前活体短暂无主；这是 ADR-0008 去掉归档后的已知代价。`memberGone` 不能提前到
 * 文件/清册写成功之前，否则一次失败回滚会留下"文件在、agent 已关"的半个世界。
 *
 * 每一步的反向动作都是"把这件写退回原样"；清册行是最后一件写，失败时 journal 把目录搬回去、账本挂回去；
 * 它的反向动作带闸：**回收站目录还没搬回来就不摘那一行**，留着行至少元数据还在。
 */
async function memberMove(
  deps: CoreDeps,
  presence: PresenceCapability,
  member: Member,
  deletedAt: number,
  parentEntryId: string | undefined,
): Promise<{ entry: TrashEntry; journal: Journal }> {
  const { sessionId, projectDir } = member
  const workspaceId = await deps.host.workspaceOf(sessionId)
  // 编码只做一次：目录与条目 id 用的是同一段（宿主目录名），不会一边编码一边不编码。
  const sessionDirName = sessionDirSegmentOf(sessionId)
  const sessionDir = sessionDirOf(projectDir, sessionDirName, deps.home)
  const wasArchived = await deps.host.isArchived(sessionId)
  const entryId = makeEntryId(deletedAt, sessionDirName)
  const trashDir = trashDirOf(entryId, deps.home)

  // 标题与字节要靠第一步读回来；条目对象先建好，那一步就地补上（`ledger.add` 是最后一件写）。
  const entry: TrashEntry = {
    id: entryId, sessionId, projectDir, workspaceId: workspaceId ?? '',
    wasArchived, deletedAt, title: '', sizeBytes: 0,
    ...(parentEntryId === undefined ? {} : { parentEntryId }),
  }
  /** 目录真的搬进回收站了吗——决定那一步的反向动作有没有东西可退。 */
  let moved = false

  const steps: JournalStep[] = [
    {
      key: 'read',
      label: '读取会话现场失败',
      run: async () => {
        // 步骤 tick（只加观测，下同）：量现场。
        writeProgress.step('measuring')
        entry.title = await deps.host.titleOf(sessionId)
        entry.sizeBytes = await deps.fs.sizeOfDir(sessionDir)
      },
    },
    ...(workspaceId === undefined ? [] : [{
      key: 'workspace' as const,
      label: '摘账本失败',
      run: async () => {
        // 摘账本是「元数据写」，码归 ledger。
        writeProgress.step('ledger')
        await deps.host.detach(sessionId, workspaceId)
      },
      undo: () => stepUndo('账本挂回失败', () => deps.host.attach(sessionId, workspaceId)),
    }]),
    {
      // 目录与清册行合成一步：**行必须在目录搬进回收站之后写**（否则中间那段"行在、目录还在 sessions/"会被对账
      // 当幽灵行摘掉，之后目录搬进来就成了点不开的孤儿目录）。反向动作两件且有先后：**先搬回目录、再摘行**——
      // 搬不回去就留着行，元数据还在；目录一次都没搬动过时没有可退的（那时清册行也还没写）。
      key: 'dir',
      label: '移动会话目录失败',
      undoOnFailure: true,
      run: async () => {
        writeProgress.step('moving')
        await deps.fs.ensureDir(`${deps.home}/${TRASH_DIR_NAME}`)
        await deps.fs.rename(sessionDir, trashDir)
        moved = true
        try {
          // 同一步里两格是两个动作点：搬完目录后写清册行前回到 ledger。
          writeProgress.step('ledger')
          await deps.ledger.add(entry)
        } catch (error) {
          // 这一句的措辞承重（既有上屏原文），所以在这里就地给动词码，不走 journal 的默认折法
          throw verbError('io', `登记回收站条目失败：${String(error)}`, error)
        }
      },
      undo: async () => {
        if (!moved) return { restored: true, failures: [] }
        const directory = await stepUndo('目录搬回失败', () => deps.fs.rename(trashDir, sessionDir))
        const failures: string[] = [...directory.failures]
        if (directory.restored) {
          failures.push(...await attempt('清册行摘除失败', () => deps.ledger.remove(entry.id)))
        }
        // 键是 `dir`：目录回来就算归位；清册行是附属写，失败只进 failures（客户端仍要收到 added）。
        return { restored: directory.restored, failures }
      },
    },
  ]

  const journal = createJournal(steps)
  // 步骤 tick 的最后一格 `finishing` 落在 journal run 的收尾、紧邻尾巴的 `memberGone` 之前；
  // run 没跑完（回滚）就没有「收尾」这一步，失败路不报。纯观测：步骤与反向动作一格不动。
  const observed: Journal = {
    async run() {
      await journal.run()
      writeProgress.step('finishing')
    },
    undo: () => journal.undo(),
  }
  return {
    entry,
    journal: withPresenceTail(presence, observed, {
      sessionId,
      // 搬完之后才把「离开可见面」补上：摘活体与如实通告都不抛，且只在完全搬成之后有意义。
      onDone: 'leave',
      /** 组级回滚：先按相反顺序退步骤，再判目录与账本两件写是否都回去了。这一行已经收过 `api-session/removed`，
       *  不发「回来了」它就会在客户端消失到重连为止；「退没退成」由 journal 的逐步结果交出来。 */
      onUndone: (undo) => ({
        kind: 'return',
        diskBack: undo.restored('dir'),
        workspaceBack: workspaceId === undefined ? true : undo.restored('workspace'),
      }),
    }),
  }
}
