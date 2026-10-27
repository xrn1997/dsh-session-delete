/**
 * 永久删除的**只读计划**：`/list` 那一行「这一次会释放多少」与 purge / orphan-clean 的删除计划
 * 都来自盘上实测，不是清册里记的 `sizeBytes`。
 *
 * 这些用例钉的是计划侧的口径（与 purge / orphan-clean 共用同一批 helper）：
 * 回收站目录实测、孩子折进 `subagentBytes`、盘上后代按**全部清册 id** 排除并按 bare id 去重、
 * 目录缺席的成员不算残留、`sessionQuery` 缺席不抛、活体准入在零写之前、`unarchive` 覆盖谁。
 *
 * 后半是执行器：计划怎么排、写就怎么做（顺序、统计、目录缺席、部分回执与失败措辞）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import type { EvictionOutcome } from '../src/ports/host-port.js'
import { sessionDirOf, trashDirOf, type TrashEntry } from '../src/trash/entry.js'
import { attachmentPathOf } from '../src/trash/attachments.js'
import { visibleGroups } from '../src/trash/groups.js'
import { verbError } from '../src/verbs/errors.js'
import {
  executeRemoval,
  planOrphanRemoval,
  planTrashRemoval,
  planVisibleTrash,
  type RemovalPlan,
} from '../src/verbs/permanent-removal.js'
import { createLogWorld, failureOf, trashEntry } from './support/world.js'

const HOME = '/h'

/** 条目 id 按真实形状造（`<时间戳>-<会话目录名>`，单段）：`trashDirOf` 只接单段 id。 */
const entry = (sessionId: string, over: Partial<TrashEntry> = {}): TrashEntry =>
  trashEntry(`20260101T000000Z-${sessionId}`, { sessionId, ...over })

/**
 * 盘上世界：`sizes` 按**完整路径**给字节（缺省 0），`missing` 是盘上不存在的目录（缺省都在），
 * `members` 是宿主 `subagentMembersOf` 交回的盘上后代（`membersAvailable:false` = 语料看不见），
 * `live` 是活体判定。
 * 清册行由调用方给，组视图一并算好。
 */
function world(over: {
  rows: readonly TrashEntry[]
  sizes?: Readonly<Record<string, number>>
  missing?: readonly string[]
  members?: Record<string, readonly { readonly sessionId: string; readonly projectDir: string }[]>
  membersAvailable?: boolean
  live?: boolean | ((sessionId: string) => boolean)
  workspaceOf?: string | undefined | ((sessionId: string) => string | undefined)
  evicted?: EvictionOutcome
  logMethods?: readonly string[]
  format?: (method: string, args: readonly unknown[]) => string
}) {
  const sizes = over.sizes ?? {}
  const absent = new Set(over.missing ?? [])
  const made = createLogWorld({
    seed: [...over.rows],
    members: over.members,
    membersAvailable: over.membersAvailable,
    live: over.live,
    workspaceOf: over.workspaceOf,
    evicted: over.evicted,
    logMethods: over.logMethods ?? [],
    format: over.format,
    fs: { exists: (p) => !absent.has(p), size: 0 },
  })
  made.fs.sizeOfDir.mockImplementation(async (p: string) => sizes[p] ?? 0)
  return { ...made, groups: visibleGroups(over.rows) }
}

/** 执行器用例的盘上世界：把执行期真正会碰的那几件写进一条调用日志（fs 与 host 共用），
 *  路径去掉 `HOME/` 前缀，断言里逐条看得见顺序。 */
function execWorld(over: Parameters<typeof world>[0]) {
  return world({
    ...over,
    logMethods: ['unarchive', 'detach', 'removeDir', 'evictLive', 'announceRemoved'],
    format: (method, args) => `${method}(${args.map(shortPath).join(',')})`,
  })
}

function shortPath(arg: unknown): string {
  return typeof arg === 'string' ? arg.replace(`${HOME}/`, '') : String(arg)
}

/** 一条盘上成员（宿主 `SubagentMember` 的形状）。 */
const member = (sessionId: string, projectDir = '--p--') => ({ sessionId, projectDir })

const IMAGE = `sha256:${'a'.repeat(64)}`
const imagePath = (id: string) => attachmentPathOf(HOME, 'image', id)
/** 一条带独占图片引用的会话日志（压缩格式与 `pickSessionLog` 认的那一代一致）。 */
const imageLog = () => zlib.zstdCompressSync(Buffer.from(
  `${JSON.stringify({ type: 'session', version: 4, id: 'session-a', createdAt: 1, cwd: 'C:/p' })}\n` +
  `${JSON.stringify({
    type: 'user/message',
    time: 2,
    data: {
      source: { kind: 'user' },
      content: [{ type: 'image', attachment: { attachmentId: IMAGE, mediaType: 'image/png', bytes: 3, width: 1, height: 1 } }],
    },
  })}\n`,
  'utf8',
))

/** 计划里没有可清的附件（空计划、无 `skipped`）。 */
const NO_ATTACHMENTS = { entries: [], bytes: 0 } as const
/** 执行器一个附件都没碰的回执。 */
const NOTHING_CLEANED = { removed: 0, freedBytes: 0, failed: 0 } as const

/** `exists` 与 `sizeOfDir` 之间目录消失时 Node 抛的那种错误（判据只看 `code`）。 */
function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, scandir '${path}'`), { code: 'ENOENT' })
}

describe('planVisibleTrash：/list 的只读计划', () => {
  it('releaseBytes 用回收站目录的实测字节，不用清册里记的 sizeBytes', async () => {
    const root = entry('session-a', { sizeBytes: 1 })
    const dir = trashDirOf(root.id, HOME)
    const { deps, groups } = world({ rows: [root], sizes: { [dir]: 4096 } })

    const [group] = await planVisibleTrash(deps, [root], groups)

    expect(group?.releaseBytes).toBe(4096)
    expect(group?.trash).toEqual([{ entry: root, dir, present: true, bytes: 4096 }])
  })

  it('kids 折进 subagentBytes（同样按回收站目录实测；条数就是 kids 的长度）', async () => {
    const root = entry('session-p', { sizeBytes: 1 })
    const kidA = entry('session-kA', { parentEntryId: root.id, sizeBytes: 1 })
    const kidB = entry('session-kB', { parentEntryId: root.id, sizeBytes: 1 })
    const stranded = { sessionId: 'session-x', projectDir: '--p--' }
    const sizes = {
      [trashDirOf(root.id, HOME)]: 4096,
      [trashDirOf(kidA.id, HOME)]: 500,
      [trashDirOf(kidB.id, HOME)]: 300,
      [sessionDirOf('--p--', 'session-x', HOME)]: 200,
    }
    const rows = [root, kidA, kidB]
    const { deps, groups } = world({ rows, sizes, members: { 'session-p': [stranded] } })

    const [group] = await planVisibleTrash(deps, rows, groups)

    // 孩子折进父那一行、不单独露面：界面上数的是 kids 的长度，字节是实测的孩子目录。
    expect(groups).toHaveLength(1)
    expect(group?.kids.map((kid) => kid.id)).toEqual([kidA.id, kidB.id])
    expect(group?.subagentBytes).toBe(800)
    expect(group?.strandedCount).toBe(1)
    expect(group?.strandedBytes).toBe(200)
    expect(group?.releaseBytes).toBe(4096 + 800 + 200)
    expect(group?.trash.map((row) => row.entry.id)).toEqual([root.id, kidA.id, kidB.id])
  })

  it('盘上后代排除全部清册 id（不只本组的 kids），跟着父进来的孩子不重复计一遍', async () => {
    const root = entry('session-p')
    const kid = entry('session-k', { parentEntryId: root.id })
    const other = entry('session-o')
    const sizes = { [sessionDirOf('--p--', 'session-x', HOME)]: 700 }
    const rows = [root, kid, other]
    const { deps, groups } = world({
      rows,
      sizes,
      members: {
        'session-p': [
          { sessionId: 'session-k', projectDir: '--p--' }, // 本组 kid：已在清册里
          { sessionId: 'session-o', projectDir: '--p--' }, // 别组的行：也不该算成 p 的盘上还剩
          { sessionId: 'session-x', projectDir: '--p--' }, // 真·盘上后代
        ],
      },
    })

    const planned = await planVisibleTrash(deps, rows, groups)
    const p = planned.find((group) => group.root.id === root.id)

    expect(p?.members.map((member) => member.sessionId)).toEqual(['session-x'])
    expect(p?.strandedCount).toBe(1)
    expect(p?.strandedBytes).toBe(700)
    expect(deps.fs.sizeOfDir).not.toHaveBeenCalledWith(sessionDirOf('--p--', 'session-k', HOME))
    expect(deps.fs.sizeOfDir).not.toHaveBeenCalledWith(sessionDirOf('--p--', 'session-o', HOME))
  })

  it('同一 bare id 只算一次（同一个会话的两代写法不各计一份）', async () => {
    const root = entry('session-p')
    const dir = sessionDirOf('--p--', 'session-x', HOME)
    const { deps, groups } = world({
      rows: [root],
      sizes: { [dir]: 700 },
      members: {
        'session-p': [
          { sessionId: 'session-x', projectDir: '--p--' },
          { sessionId: 'x', projectDir: '--p--' },
        ],
      },
    })

    const [group] = await planVisibleTrash(deps, [root], groups)

    expect(group?.members).toHaveLength(1)
    expect(group?.members[0]?.sessionId).toBe('session-x')
    expect(group?.strandedBytes).toBe(700)
    expect(deps.fs.sizeOfDir).toHaveBeenCalledTimes(2) // 根目录 + 这一个成员，不是三个
  })

  it('盘上目录缺席的成员不进 members/strandedBytes；回收站目录缺席的行 present=false、bytes=0', async () => {
    const root = entry('session-p')
    const kid = entry('session-k', { parentEntryId: root.id })
    const present = { sessionId: 'session-x', projectDir: '--p--' }
    const gone = { sessionId: 'session-gone', projectDir: '--p--' }
    const kidDir = trashDirOf(kid.id, HOME)
    const goneDir = sessionDirOf('--p--', 'session-gone', HOME)
    const sizes = {
      [trashDirOf(root.id, HOME)]: 4096,
      [sessionDirOf('--p--', 'session-x', HOME)]: 100,
    }
    const rows = [root, kid]
    const { deps, groups } = world({
      rows,
      sizes,
      missing: [kidDir, goneDir],
      members: { 'session-p': [present, gone] },
    })

    const [group] = await planVisibleTrash(deps, rows, groups)

    expect(group?.members).toEqual([{
      sessionId: 'session-x',
      dir: sessionDirOf('--p--', 'session-x', HOME),
      bytes: 100,
      workspaceId: 'ws-1',
    }])
    expect(group?.strandedCount).toBe(1)
    expect(group?.strandedBytes).toBe(100)
    expect(group?.trash.find((row) => row.entry.id === kid.id))
      .toEqual({ entry: kid, dir: kidDir, present: false, bytes: 0 })
    expect(group?.subagentBytes).toBe(0)
    expect(group?.releaseBytes).toBe(4096 + 100)
    expect(deps.fs.sizeOfDir).not.toHaveBeenCalledWith(kidDir)
    expect(deps.fs.sizeOfDir).not.toHaveBeenCalledWith(goneDir)
  })

  it('subagentMembersOf 缺席（available:false）⇒ members 为空、不抛', async () => {
    const root = entry('session-a')
    const { deps, groups } = world({
      rows: [root],
      sizes: { [trashDirOf(root.id, HOME)]: 4096 },
      membersAvailable: false,
    })

    const [group] = await planVisibleTrash(deps, [root], groups)

    expect(group?.members).toEqual([])
    expect(group?.strandedCount).toBe(0)
    expect(group?.strandedBytes).toBe(0)
    expect(group?.releaseBytes).toBe(4096)
    expect(deps.host.subagentMembersOf).toHaveBeenCalledTimes(1)
  })

  it('一次 subagentMembersOf 问全部组根；返回顺序与传入 groups 一致', async () => {
    const a = entry('session-a')
    const b = entry('session-b')
    const { deps, groups } = world({ rows: [a, b] })

    const planned = await planVisibleTrash(deps, [a, b], groups)

    expect(planned.map((group) => group.root.id)).toEqual([a.id, b.id])
    expect(deps.host.subagentMembersOf).toHaveBeenCalledTimes(1)
    expect(deps.host.subagentMembersOf).toHaveBeenCalledWith(['session-a', 'session-b'])
  })

  it('同一个盘上后代挂在两个组根下：只算先出现的那一组（跨根按组序去重）', async () => {
    const a = entry('session-a')
    const b = entry('session-b')
    const sharedDir = sessionDirOf('--p--', 'session-x', HOME)
    const { deps, groups } = world({
      rows: [a, b],
      sizes: { [sharedDir]: 50 },
      members: {
        'session-a': [member('session-x')],
        'session-b': [member('x')], // 同一个 bare id 的另一种写法
      },
    })

    const planned = await planVisibleTrash(deps, [a, b], groups)

    expect(planned[0]?.members.map((item) => item.sessionId)).toEqual(['session-x'])
    expect(planned[1]?.members).toEqual([])
    expect(planned[0]?.strandedBytes).toBe(50)
    expect(planned[1]?.strandedBytes).toBe(0)
    expect(deps.fs.sizeOfDir).toHaveBeenCalledTimes(3) // 两个根目录 + 这一个成员
  })
})

describe('测量：exists 之后目录消失当"不在"，别的失败照旧响亮', () => {
  it('回收站目录在 exists 与 sizeOfDir 之间消失（ENOENT）⇒ present:false / 0 字节，不抛', async () => {
    const root = entry('session-p')
    const kid = entry('session-k', { parentEntryId: root.id })
    const rootDir = trashDirOf(root.id, HOME)
    const kidDir = trashDirOf(kid.id, HOME)
    const { deps, groups } = world({ rows: [root, kid], sizes: { [rootDir]: 100 } })
    deps.fs.sizeOfDir.mockImplementation(async (p: string) => {
      if (p === kidDir) throw enoent(p)
      return p === rootDir ? 100 : 0
    })

    const [group] = await planVisibleTrash(deps, [root, kid], groups)

    expect(group?.trash.find((row) => row.entry.id === kid.id))
      .toEqual({ entry: kid, dir: kidDir, present: false, bytes: 0 })
    expect(group?.releaseBytes).toBe(100)
  })

  it('成员目录在 exists 与 sizeOfDir 之间消失（ENOENT）⇒ 不进 members，不抛', async () => {
    const root = entry('session-p')
    const rootDir = trashDirOf(root.id, HOME)
    const memberDir = sessionDirOf('--p--', 'session-x', HOME)
    const { deps, groups } = world({
      rows: [root],
      sizes: { [rootDir]: 100 },
      members: { 'session-p': [member('session-x')] },
    })
    deps.fs.sizeOfDir.mockImplementation(async (p: string) => {
      if (p === memberDir) throw enoent(p)
      return p === rootDir ? 100 : 0
    })

    const [group] = await planVisibleTrash(deps, [root], groups)

    expect(group?.members).toEqual([])
    expect(group?.strandedBytes).toBe(0)
    expect(group?.releaseBytes).toBe(100)
    expect(deps.host.workspaceOf).not.toHaveBeenCalled()
  })

  it('非 ENOENT 的 sizeOfDir 失败照旧抛（不拿 0 / 缺席冒充）', async () => {
    const root = entry('session-p')
    const { deps, groups } = world({ rows: [root] })
    deps.fs.sizeOfDir.mockImplementation(async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    })

    await expect(planVisibleTrash(deps, [root], groups)).rejects.toThrow('EACCES: permission denied')
  })
})

describe('planTrashRemoval：purge 的删除计划', () => {
  it('trash 按 targets 逐个实测；unarchive = targets；bytes = 实测之和', async () => {
    const root = entry('session-a', { sizeBytes: 1 })
    const kid = entry('session-k', { parentEntryId: root.id, sizeBytes: 1 })
    const sizes = { [trashDirOf(root.id, HOME)]: 100, [trashDirOf(kid.id, HOME)]: 40 }
    const { deps, manifest } = world({ rows: [root, kid], sizes })

    const plan = await planTrashRemoval(deps, [root, kid], [root, kid])

    expect(plan).toEqual({
      kind: 'trash',
      trash: [
        { entry: root, dir: trashDirOf(root.id, HOME), present: true, bytes: 100 },
        { entry: kid, dir: trashDirOf(kid.id, HOME), present: true, bytes: 40 },
      ],
      members: [],
      unarchive: ['session-a', 'session-k'],
      bytes: 140,
      attachments: NO_ATTACHMENTS,
    })
    expect(deps.host.subagentMembersOf).toHaveBeenCalledTimes(1)
    expect(deps.host.subagentMembersOf).toHaveBeenCalledWith(['session-a', 'session-k'])
    // 计划只读：拿到计划之后才轮到执行器动盘/动宿主。
    expect(deps.fs.removeDir).not.toHaveBeenCalled()
    expect(deps.host.unarchive).not.toHaveBeenCalled()
    expect(deps.host.detach).not.toHaveBeenCalled()
    expect(await manifest.list()).toHaveLength(2)
  })

  it('盘上后代排除全部清册 id（按 bare 比）并按 bare id 全局去重；有目录的进 members 与 unarchive', async () => {
    const root = entry('session-p')
    const other = entry('session-o')
    const strandedDir = sessionDirOf('--p--', 'session-x', HOME)
    const { deps } = world({
      rows: [root, other],
      sizes: { [trashDirOf(root.id, HOME)]: 4096, [strandedDir]: 700 },
      members: {
        'session-p': [
          member('session-o'), // 别组的清册行：不算这条根盘上还剩的
          member('session-x'), // 真·盘上后代
          member('x'), // 同一个 bare id 的另一种写法：只算一次
        ],
      },
    })

    const plan = await planTrashRemoval(deps, [root, other], [root])

    expect(plan.kind).toBe('trash')
    expect(plan.trash.map((row) => row.entry.id)).toEqual([root.id])
    expect(plan.members).toEqual([{
      sessionId: 'session-x',
      dir: strandedDir,
      bytes: 700,
      workspaceId: 'ws-1',
    }])
    expect(plan.unarchive).toEqual(['session-p', 'session-x'])
    expect(plan.bytes).toBe(4096 + 700)
    expect(deps.fs.sizeOfDir).not.toHaveBeenCalledWith(sessionDirOf('--p--', 'session-o', HOME))
    expect(deps.fs.sizeOfDir).not.toHaveBeenCalledWith(sessionDirOf('--p--', 'x', HOME))
  })

  it('成员目录缺席不进 members/unarchive；回收站目录缺席的行 present=false、bytes=0，但 target 仍进 unarchive', async () => {
    const root = entry('session-p')
    const kid = entry('session-k', { parentEntryId: root.id })
    const goneMember = member('session-gone')
    const goneTrashDir = trashDirOf(kid.id, HOME)
    const goneMemberDir = sessionDirOf('--p--', 'session-gone', HOME)
    const { deps } = world({
      rows: [root, kid],
      sizes: { [trashDirOf(root.id, HOME)]: 4096 },
      missing: [goneTrashDir, goneMemberDir],
      members: { 'session-p': [goneMember] },
    })

    const plan = await planTrashRemoval(deps, [root, kid], [root, kid])

    expect(plan.trash).toEqual([
      { entry: root, dir: trashDirOf(root.id, HOME), present: true, bytes: 4096 },
      { entry: kid, dir: goneTrashDir, present: false, bytes: 0 },
    ])
    expect(plan.members).toEqual([])
    expect(plan.unarchive).toEqual(['session-p', 'session-k'])
    expect(plan.bytes).toBe(4096)
    expect(deps.fs.sizeOfDir).not.toHaveBeenCalledWith(goneTrashDir)
    expect(deps.fs.sizeOfDir).not.toHaveBeenCalledWith(goneMemberDir)
  })

  it('target 在跑 ⇒ live，零写、清册不动', async () => {
    const root = entry('session-p')
    const { deps, manifest } = world({ rows: [root], live: (id) => id === 'session-p' })

    await expect(planTrashRemoval(deps, [root], [root]))
      .rejects.toMatchObject({ code: 'sessiondelete/live' })

    expect(deps.host.isLive).toHaveBeenCalledWith('session-p')
    expect(deps.fs.removeDir).not.toHaveBeenCalled()
    expect(deps.host.unarchive).not.toHaveBeenCalled()
    expect(deps.host.detach).not.toHaveBeenCalled()
    expect(await manifest.list()).toHaveLength(1)
  })

  it('盘上后代在跑 ⇒ live，target 与成员都逐个查、零写', async () => {
    const root = entry('session-p')
    const { deps } = world({
      rows: [root],
      members: { 'session-p': [member('session-x')] },
      live: (id) => id === 'session-x',
    })

    await expect(planTrashRemoval(deps, [root], [root]))
      .rejects.toMatchObject({ code: 'sessiondelete/live' })

    expect(deps.host.isLive).toHaveBeenCalledWith('session-p')
    expect(deps.host.isLive).toHaveBeenCalledWith('session-x')
    expect(deps.fs.removeDir).not.toHaveBeenCalled()
    expect(deps.host.unarchive).not.toHaveBeenCalled()
    expect(deps.host.detach).not.toHaveBeenCalled()
  })

  it('计划就是执行前的闸：没有跳过活体准入的开关', async () => {
    const root = entry('session-p')
    const { deps } = world({ rows: [root], live: true })

    await expect(planTrashRemoval(deps, [root], [root]))
      .rejects.toMatchObject({ code: 'sessiondelete/live' })

    expect(deps.host.isLive).toHaveBeenCalledWith('session-p')
    expect(deps.fs.removeDir).not.toHaveBeenCalled()
    expect(deps.host.unarchive).not.toHaveBeenCalled()
  })

  it('subagentMembersOf 缺席（available:false）⇒ members 为空、unarchive 只有 targets、不抛', async () => {
    const root = entry('session-p')
    const dir = trashDirOf(root.id, HOME)
    const { deps } = world({ rows: [root], sizes: { [dir]: 8 }, membersAvailable: false })

    const plan = await planTrashRemoval(deps, [root], [root])

    expect(plan.members).toEqual([])
    expect(plan.unarchive).toEqual(['session-p'])
    expect(plan.bytes).toBe(8)
    expect(deps.host.subagentMembersOf).toHaveBeenCalledTimes(1)
  })
})

describe('planOrphanRemoval：orphan-clean 的删除计划', () => {
  it('members 只收有目录的；unarchive 覆盖全部传入成员（含目录缺席）；live 查全部传入', async () => {
    const present = member('session-root')
    const gone = member('session-gone')
    const presentDir = sessionDirOf('--p--', 'session-root', HOME)
    const goneDir = sessionDirOf('--p--', 'session-gone', HOME)
    const { deps } = world({ rows: [], sizes: { [presentDir]: 300 }, missing: [goneDir] })

    const plan = await planOrphanRemoval(deps, [present, gone])

    expect(plan).toEqual({
      kind: 'orphan',
      trash: [],
      members: [{ sessionId: 'session-root', dir: presentDir, bytes: 300, workspaceId: 'ws-1' }],
      unarchive: ['session-root', 'session-gone'],
      bytes: 300,
      attachments: NO_ATTACHMENTS,
    })
    expect(deps.host.isLive).toHaveBeenCalledTimes(2)
    expect(deps.host.isLive).toHaveBeenCalledWith('session-root')
    expect(deps.host.isLive).toHaveBeenCalledWith('session-gone')
    expect(deps.host.workspaceOf).toHaveBeenCalledWith('session-root')
    expect(deps.host.workspaceOf).not.toHaveBeenCalledWith('session-gone')
    expect(deps.fs.sizeOfDir).not.toHaveBeenCalledWith(goneDir)
    // 计划只读：拿到计划之后才轮到执行器。
    expect(deps.fs.removeDir).not.toHaveBeenCalled()
    expect(deps.host.unarchive).not.toHaveBeenCalled()
    expect(deps.host.detach).not.toHaveBeenCalled()
  })

  it('目录缺席的成员在跑也整组拒绝（live 查的是全部传入成员），零写', async () => {
    const present = member('session-root')
    const gone = member('session-gone')
    const goneDir = sessionDirOf('--p--', 'session-gone', HOME)
    const { deps } = world({ rows: [], missing: [goneDir], live: (id) => id === 'session-gone' })

    await expect(planOrphanRemoval(deps, [present, gone]))
      .rejects.toMatchObject({ code: 'sessiondelete/live' })

    expect(deps.host.isLive).toHaveBeenCalledWith('session-gone')
    expect(deps.fs.removeDir).not.toHaveBeenCalled()
    expect(deps.host.unarchive).not.toHaveBeenCalled()
    expect(deps.host.detach).not.toHaveBeenCalled()
    expect(deps.host.workspaceOf).not.toHaveBeenCalled()
  })

  it('空成员 ⇒ 空计划、零字节、不抛', async () => {
    const { deps } = world({ rows: [] })

    const plan = await planOrphanRemoval(deps, [])

    expect(plan).toEqual({ kind: 'orphan', trash: [], members: [], unarchive: [], bytes: 0, attachments: NO_ATTACHMENTS })
    expect(deps.host.isLive).not.toHaveBeenCalled()
  })
})

describe('附件连带清理：独占图片', () => {
  it('purge 计划带上独占图片；执行在删目录之后删对象', async () => {
    const root = entry('session-a')
    const dir = trashDirOf(root.id, HOME)
    const made = world({ rows: [root], sizes: { [dir]: 100 }, logMethods: [] })
    // 剩余引用源只扫这一层：本用例不造任何剩余会话 / storages / cache。
    made.fs.listDirs.mockImplementation(async () => [])
    made.fs.listFiles.mockImplementation(async (p: string) => p === dir ? ['session.v4.jsonl.zstd'] : [])
    made.fs.readFile.mockImplementation(async (p: string) =>
      p === `${dir}/session.v4.jsonl.zstd` ? imageLog() : Buffer.alloc(0))
    made.fs.statFile.mockImplementation(async (p: string) => ({
      size: p === imagePath(IMAGE) ? 7 : 0,
    }))
    const calls: string[] = []
    made.fs.removeDir.mockImplementation(async (p: string) => { calls.push(`removeDir:${p}`) })
    made.fs.removeFile.mockImplementation(async (p: string) => { calls.push(`removeFile:${p}`) })

    const plan = await planTrashRemoval(made.deps, [root], [root])
    const stats = await executeRemoval(made.deps, plan)

    expect(plan.attachments.entries.map((item) => item.id)).toEqual([IMAGE])
    expect(calls).toEqual([`removeDir:${dir}`, `removeFile:${imagePath(IMAGE)}`])
    // 附件字节不进 freedBytes：那是会话目录的释放量，附件读数单独走回执的 attachments。
    expect(stats).toEqual({
      removed: 1,
      freedBytes: 100,
      attachments: { removed: 1, freedBytes: 7, failed: 0 },
    })
  })

  it('共享图片被剩余会话引用 ⇒ 计划为空', async () => {
    const root = entry('session-a')
    const dir = trashDirOf(root.id, HOME)
    const sessionRoot = `${HOME}/sessions`
    const remaining = `${sessionRoot}/--p--/session-b`
    const made = world({ rows: [root] })
    made.fs.listDirs.mockImplementation(async (p: string) =>
      p === sessionRoot ? ['--p--'] : p === `${sessionRoot}/--p--` ? ['session-b'] : [])
    made.fs.listFiles.mockImplementation(async (p: string) =>
      p === dir || p === remaining ? ['session.v4.jsonl.zstd'] : [])
    made.fs.readFile.mockImplementation(async () => imageLog())

    const plan = await planTrashRemoval(made.deps, [root], [root])

    expect(plan.attachments.entries).toEqual([])
    // 有剩余引用是**判定出来**的共享，不是读不出：不置 skipped（上屏的提示半句不出现）。
    expect(plan.attachments.skipped).toBeUndefined()
  })

  it('剩余清册行引用同一图片 ⇒ 计划为空、不置 skipped', async () => {
    const target = entry('session-a')
    const remaining = entry('session-b')
    const targetDir = trashDirOf(target.id, HOME)
    const remainingDir = trashDirOf(remaining.id, HOME)
    const made = world({ rows: [target, remaining], logMethods: [] })
    // 引用源只有这两条回收站目录：会话根、storages、cache 都是空的。
    made.fs.listDirs.mockImplementation(async (p: string) =>
      p === `${HOME}/session-trash` ? [target.id, remaining.id] : [])
    made.fs.listFiles.mockImplementation(async (p: string) =>
      p === targetDir || p === remainingDir ? ['session.v4.jsonl.zstd'] : [])
    made.fs.readFile.mockImplementation(async () => imageLog())
    made.fs.statFile.mockImplementation(async (p: string) => ({
      size: p === imagePath(IMAGE) ? 7 : 0,
    }))

    const plan = await planTrashRemoval(made.deps, [target, remaining], [target])

    // 不删的那一行仍算剩余引用源（附件域扫整个 session-trash，排除本次被删目录）：图片保留、不跳过。
    expect(made.fs.listFiles).toHaveBeenCalledWith(remainingDir)
    expect(plan.attachments.entries).toEqual([])
    expect(plan.attachments.skipped).toBeUndefined()
    expect(made.fs.removeFile).not.toHaveBeenCalled()
  })

  it('剩余引用源读不出 ⇒ 空计划 + skipped，会话删除仍然成功', async () => {
    const root = entry('session-a')
    const dir = trashDirOf(root.id, HOME)
    const sessionRoot = `${HOME}/sessions`
    const remaining = `${sessionRoot}/--p--/session-b`
    const made = world({ rows: [root], sizes: { [dir]: 100 }, logMethods: [] })
    made.fs.listDirs.mockImplementation(async (p: string) =>
      p === sessionRoot ? ['--p--'] : p === `${sessionRoot}/--p--` ? ['session-b'] : [])
    made.fs.listFiles.mockImplementation(async (p: string) =>
      p === dir || p === remaining ? ['session.v4.jsonl.zstd'] : [])
    made.fs.readFile.mockImplementation(async (p: string) => {
      if (p === `${dir}/session.v4.jsonl.zstd`) return imageLog()
      throw new Error('EACCES: permission denied')
    })

    const plan = await planTrashRemoval(made.deps, [root], [root])
    const stats = await executeRemoval(made.deps, plan)

    expect(plan.attachments).toMatchObject({ entries: [], bytes: 0 })
    expect(plan.attachments.skipped).toMatch(/无法证明独占/)
    expect(stats).toMatchObject({ removed: 1, freedBytes: 100 })
    expect(stats.attachments).toMatchObject({ removed: 0, freedBytes: 0, failed: 0 })
    expect(stats.attachments.skipped).toBe(plan.attachments.skipped)
    expect(made.fs.removeDir).toHaveBeenCalledWith(dir)
    expect(await made.manifest.list()).toEqual([])
  })

  it('附件删除失败只计数，会话删除照旧完成', async () => {
    const root = entry('session-a')
    const dir = trashDirOf(root.id, HOME)
    const made = world({ rows: [root], sizes: { [dir]: 100 }, logMethods: [] })
    // 剩余引用源只扫这一层：本用例不造任何剩余会话 / storages / cache。
    made.fs.listDirs.mockImplementation(async () => [])
    made.fs.listFiles.mockImplementation(async (p: string) => p === dir ? ['session.v4.jsonl.zstd'] : [])
    made.fs.readFile.mockImplementation(async (p: string) =>
      p === `${dir}/session.v4.jsonl.zstd` ? imageLog() : Buffer.alloc(0))
    made.fs.statFile.mockImplementation(async (p: string) => ({
      size: p === imagePath(IMAGE) ? 7 : 0,
    }))
    made.fs.removeFile.mockImplementation(async () => { throw new Error('EBUSY') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const plan = await planTrashRemoval(made.deps, [root], [root])
      const stats = await executeRemoval(made.deps, plan)

      expect(stats).toMatchObject({ removed: 1, freedBytes: 100 })
      expect(stats.attachments).toEqual({ removed: 0, freedBytes: 0, failed: 1 })
      expect(made.fs.removeDir).toHaveBeenCalledWith(dir)
      expect(await made.manifest.list()).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('orphan 计划的剩余引用源扫全部 session-trash：那里没有引用 ⇒ 进计划；目录里引用它 ⇒ 保留', async () => {
    const removedDir = sessionDirOf('--p--', 'session-root', HOME)
    const row = entry('session-gone')
    const trashDir = trashDirOf(row.id, HOME)
    const made = world({ rows: [row], logMethods: [] })
    // 会话根、storages、cache 都是空的：这一趟只走"被删目录 + session-trash 目录"两条引用源。
    made.fs.listDirs.mockImplementation(async () => [])
    made.fs.listFiles.mockImplementation(async (p: string) =>
      p === removedDir || p === trashDir ? ['session.v4.jsonl.zstd'] : [])
    made.fs.readFile.mockImplementation(async () => imageLog())
    made.fs.statFile.mockImplementation(async (p: string) => ({
      size: p === imagePath(IMAGE) ? 7 : 0,
    }))

    const exclusive = await planOrphanRemoval(made.deps, [member('session-root')])
    expect(exclusive.attachments.entries.map((item) => item.id)).toEqual([IMAGE])

    // 清册行所在的目录也是剩余引用源：把它列出来，扫描就会读它并保留 IMAGE。
    made.fs.listDirs.mockImplementation(async (p: string) => p === '/h/session-trash' ? [row.id] : [])
    const shared = await planOrphanRemoval(made.deps, [member('session-root')])
    expect(shared.attachments.entries).toEqual([])
    expect(shared.attachments.skipped).toBeUndefined()
  })
})

describe('executeRemoval：执行器', () => {
  it('按计划顺序执行：unarchive 全部 → detach 有账本的成员 → 回收站行 → 盘上成员', async () => {
    const root = entry('session-p')
    const kid = entry('session-k', { parentEntryId: root.id })
    const x = member('session-x')
    const y = member('session-y')
    const sizes = {
      [trashDirOf(root.id, HOME)]: 100,
      [trashDirOf(kid.id, HOME)]: 40,
      [sessionDirOf('--p--', 'session-x', HOME)]: 20,
      [sessionDirOf('--p--', 'session-y', HOME)]: 10,
    }
    const { deps, calls, manifest } = execWorld({
      rows: [root, kid],
      sizes,
      members: { 'session-p': [x, y] },
      workspaceOf: (id) => (id === 'session-x' ? 'ws-1' : undefined),
    })
    const plan = await planTrashRemoval(deps, [root, kid], [root, kid])
    deps.fs.exists.mockClear()

    const result = await executeRemoval(deps, plan)

    expect(result).toEqual({ removed: 4, freedBytes: 170, attachments: NOTHING_CLEANED })
    expect(result.freedBytes).toBe(plan.bytes)
    expect(calls).toEqual([
      'unarchive(session-p)', 'unarchive(session-k)', 'unarchive(session-x)', 'unarchive(session-y)',
      'detach(session-x,ws-1)',
      `removeDir(${shortPath(trashDirOf(root.id, HOME))})`,
      'evictLive(session-p)', 'announceRemoved(session-p)',
      `removeDir(${shortPath(trashDirOf(kid.id, HOME))})`,
      'evictLive(session-k)', 'announceRemoved(session-k)',
      `removeDir(${shortPath(sessionDirOf('--p--', 'session-x', HOME))})`,
      'evictLive(session-x)', 'announceRemoved(session-x)',
      `removeDir(${shortPath(sessionDirOf('--p--', 'session-y', HOME))})`,
      'evictLive(session-y)', 'announceRemoved(session-y)',
    ])
    expect(await manifest.list()).toEqual([])
    // 执行器只认计划：不再回头问盘上目录在不在（计划就是执行前的闸）。
    expect(deps.fs.exists).not.toHaveBeenCalled()
  })

  it('成功回执的字节念计划里的 bytes（执行器不另算一遍）', async () => {
    const root = entry('session-p')
    const rootDir = trashDirOf(root.id, HOME)
    const { deps } = execWorld({ rows: [root], sizes: { [rootDir]: 100 } })
    // 只手造一份「计划合计 ≠ 逐条之和」的计划：两边各算一次时，只有它看得出谁说了算。
    const plan: RemovalPlan = {
      kind: 'trash',
      trash: [{ entry: root, dir: rootDir, present: true, bytes: 100 }],
      members: [],
      unarchive: [root.sessionId],
      bytes: 999,
      attachments: NO_ATTACHMENTS,
    }

    const result = await executeRemoval(deps, plan)

    expect(result).toEqual({ removed: 1, freedBytes: 999, attachments: NOTHING_CLEANED })
  })

  it('回收站目录缺席的行：不删目录、仍摘清册行、计 1 条 0 字节', async () => {
    const root = entry('session-p')
    const kid = entry('session-k', { parentEntryId: root.id })
    const rootDir = trashDirOf(root.id, HOME)
    const goneDir = trashDirOf(kid.id, HOME)
    const { deps, manifest } = execWorld({ rows: [root, kid], sizes: { [rootDir]: 100 }, missing: [goneDir] })

    const plan = await planTrashRemoval(deps, [root, kid], [root, kid])
    const result = await executeRemoval(deps, plan)

    expect(plan.trash.map((row) => row.present)).toEqual([true, false])
    expect(result).toEqual({ removed: 2, freedBytes: 100, attachments: NOTHING_CLEANED })
    expect(deps.fs.removeDir).toHaveBeenCalledTimes(1)
    expect(deps.fs.removeDir).toHaveBeenCalledWith(rootDir)
    expect(await manifest.list()).toEqual([])
    // 目录不在也照样摘活体、如实通告：那一行（如果有）不该留到重连。
    expect(deps.host.evictLive).toHaveBeenCalledWith('session-k')
  })

  it('回收站行删到一半失败（trash 计划）：io + 现有标签、无 details、已删的不回滚', async () => {
    const root = entry('session-p')
    const kid = entry('session-k', { parentEntryId: root.id })
    const rootDir = trashDirOf(root.id, HOME)
    const kidDir = trashDirOf(kid.id, HOME)
    const { deps, manifest } = execWorld({ rows: [root, kid], sizes: { [rootDir]: 100, [kidDir]: 40 } })
    const plan = await planTrashRemoval(deps, [root, kid], [root, kid])
    deps.fs.removeDir.mockImplementation(async (p: string) => {
      if (p === kidDir) throw new Error('boom')
    })

    const error = await failureOf(executeRemoval(deps, plan))

    expect(error).toMatchObject({ code: 'sessiondelete/io', message: '删除回收站目录失败：Error: boom' })
    expect(error.details).toBeUndefined()
    // 已经删掉的第一行不回滚（永久删除没有回收站这一层可退），失败那一行连清册行都还在。
    expect(await manifest.list()).toEqual([kid])
    expect(deps.host.evictLive).toHaveBeenCalledWith('session-p')
    expect(deps.host.evictLive).not.toHaveBeenCalledWith('session-k')
  })

  it('manifest.remove 失败：那一行不摘活体、不通告，清册行还在（摘行先于通告）', async () => {
    const root = entry('session-p')
    const kid = entry('session-k', { parentEntryId: root.id })
    const rootDir = trashDirOf(root.id, HOME)
    const kidDir = trashDirOf(kid.id, HOME)
    const { deps, manifest } = execWorld({ rows: [root, kid], sizes: { [rootDir]: 100, [kidDir]: 40 } })
    const plan = await planTrashRemoval(deps, [root, kid], [root, kid])
    const remove = manifest.remove.bind(manifest)
    manifest.remove = async (id: string) => {
      if (id === kid.id) throw new Error('manifest boom')
      await remove(id)
    }

    const error = await failureOf(executeRemoval(deps, plan))

    // 失败仍用删回收站那一段的标签；trash 计划不带部分回执（回执只由 kind='orphan' 派生）。
    expect(error).toMatchObject({
      code: 'sessiondelete/io',
      message: '删除回收站目录失败：Error: manifest boom',
    })
    expect(error.details).toBeUndefined()
    // 那一行没摘走：清册里还剩它。
    expect((await manifest.list()).map((row) => row.id)).toEqual([kid.id])
    // 通告只在行真摘掉之后：父行走过，失败这一条一步都没走。
    expect(deps.host.evictLive).toHaveBeenCalledWith('session-p')
    expect(deps.host.evictLive).not.toHaveBeenCalledWith('session-k')
    expect(deps.host.announceRemoved).not.toHaveBeenCalledWith('session-k')
  })

  it('盘上成员删失败（trash 计划）：删除盘上后代目录失败、无 details', async () => {
    const root = entry('session-p')
    const rootDir = trashDirOf(root.id, HOME)
    const memberDir = sessionDirOf('--p--', 'session-x', HOME)
    const { deps, manifest } = execWorld({
      rows: [root],
      sizes: { [rootDir]: 100, [memberDir]: 20 },
      members: { 'session-p': [member('session-x')] },
    })
    const plan = await planTrashRemoval(deps, [root], [root])
    deps.fs.removeDir.mockImplementation(async (p: string) => {
      if (p === memberDir) throw new Error('boom')
    })

    const error = await failureOf(executeRemoval(deps, plan))

    expect(error).toMatchObject({ code: 'sessiondelete/io', message: '删除盘上后代目录失败：Error: boom' })
    expect(error.details).toBeUndefined()
    expect(await manifest.list()).toEqual([]) // 回收站行已在成员之前删干净，不回滚
    expect(deps.host.evictLive).not.toHaveBeenCalledWith('session-x')
  })

  it('回执只看 kind：orphan 计划里回收站行失败同样带部分回执', async () => {
    const root = entry('session-p')
    const rootDir = trashDirOf(root.id, HOME)
    const { deps } = execWorld({ rows: [root], sizes: { [rootDir]: 100 } })
    // 生产里 orphan 计划的 trash 恒为空（orphan-clean 只删盘上目录）；只手造这一格，钉住
    // 「回执由 kind 派生，不看失败的那一行来自哪一段」。
    const plan: RemovalPlan = {
      kind: 'orphan',
      trash: [{ entry: root, dir: rootDir, present: true, bytes: 100 }],
      members: [],
      unarchive: [root.sessionId],
      bytes: 100,
      attachments: NO_ATTACHMENTS,
    }
    deps.fs.removeDir.mockImplementation(async () => { throw new Error('boom') })

    const error = await failureOf(executeRemoval(deps, plan))

    expect(error).toMatchObject({
      code: 'sessiondelete/io',
      message: '删除回收站目录失败：Error: boom',
      details: { removed: 0, freedBytes: 0, failedSessionId: 'session-p' },
    })
  })

  it('orphan 删到一半失败：删除会话目录失败 + 部分回执', async () => {
    const rootDir = sessionDirOf('--p--', 'session-root', HOME)
    const kidDir = sessionDirOf('--p--', 'session-kid', HOME)
    const { deps } = execWorld({
      rows: [],
      sizes: { [rootDir]: 100, [kidDir]: 60 },
      workspaceOf: (id) => (id === 'session-kid' ? 'ws-1' : undefined),
    })
    const plan = await planOrphanRemoval(deps, [member('session-root'), member('session-kid')])
    deps.fs.removeDir.mockImplementation(async (p: string) => {
      if (p === kidDir) throw new Error('boom')
    })

    const error = await failureOf(executeRemoval(deps, plan))

    expect(error).toMatchObject({
      code: 'sessiondelete/io',
      message: '删除会话目录失败：Error: boom',
      details: { removed: 1, freedBytes: 100, failedSessionId: 'session-kid' },
    })
    expect(deps.host.evictLive).toHaveBeenCalledWith('session-root')
    expect(deps.host.evictLive).not.toHaveBeenCalledWith('session-kid')
  })

  it('端口抛的已是本仓动词码：原样抛出，不折成 io、不改码', async () => {
    const root = entry('session-p')
    const { deps } = execWorld({ rows: [root], sizes: { [trashDirOf(root.id, HOME)]: 5 } })
    const plan = await planTrashRemoval(deps, [root], [root])
    const coded = verbError('not-found', '这一组已经不在了')
    deps.host.unarchive.mockImplementation(async () => { throw coded })

    await expect(executeRemoval(deps, plan)).rejects.toBe(coded)
    expect(deps.fs.removeDir).not.toHaveBeenCalled()
  })

  it('purge 的 unarchive 失败：取消归档失败、io、无 details、零删目录、清册不动', async () => {
    const root = entry('session-p')
    const kid = entry('session-k', { parentEntryId: root.id })
    const { deps, manifest } = execWorld({
      rows: [root, kid],
      sizes: { [trashDirOf(root.id, HOME)]: 100, [trashDirOf(kid.id, HOME)]: 40 },
    })
    const plan = await planTrashRemoval(deps, [root, kid], [root, kid])
    deps.host.unarchive.mockImplementation(async () => { throw new Error('archive boom') })

    const error = await failureOf(executeRemoval(deps, plan))

    expect(error).toMatchObject({ code: 'sessiondelete/io', message: '取消归档失败：Error: archive boom' })
    expect(error.details).toBeUndefined()
    expect(deps.fs.removeDir).not.toHaveBeenCalled()
    expect(deps.host.detach).not.toHaveBeenCalled()
    expect(await manifest.list()).toHaveLength(2)
  })

  it('purge 的 detach 失败：摘账本失败、io、无 details、零删目录', async () => {
    const root = entry('session-p')
    const { deps, manifest } = execWorld({
      rows: [root],
      sizes: { [trashDirOf(root.id, HOME)]: 100, [sessionDirOf('--p--', 'session-x', HOME)]: 20 },
      members: { 'session-p': [member('session-x')] },
    })
    const plan = await planTrashRemoval(deps, [root], [root])
    deps.host.detach.mockImplementation(async () => { throw new Error('detach boom') })

    const error = await failureOf(executeRemoval(deps, plan))

    expect(error).toMatchObject({ code: 'sessiondelete/io', message: '摘账本失败：Error: detach boom' })
    expect(error.details).toBeUndefined()
    expect(deps.host.unarchive).toHaveBeenCalledWith('session-x')
    expect(deps.fs.removeDir).not.toHaveBeenCalled()
    expect(await manifest.list()).toHaveLength(1)
  })

  it('orphan 的 unarchive 失败保留原始错误（不包装成动词码）', async () => {
    const { deps } = execWorld({ rows: [], sizes: { [sessionDirOf('--p--', 'session-root', HOME)]: 100 } })
    const plan = await planOrphanRemoval(deps, [member('session-root')])
    const boom = new Error('archive boom')
    deps.host.unarchive.mockImplementation(async () => { throw boom })

    await expect(executeRemoval(deps, plan)).rejects.toBe(boom)
    expect(deps.fs.removeDir).not.toHaveBeenCalled()
  })

  it('orphan 的 detach 失败同样原样抛出', async () => {
    const { deps } = execWorld({ rows: [], sizes: { [sessionDirOf('--p--', 'session-root', HOME)]: 100 } })
    const plan = await planOrphanRemoval(deps, [member('session-root')])
    const boom = new Error('detach boom')
    deps.host.detach.mockImplementation(async () => { throw boom })

    await expect(executeRemoval(deps, plan)).rejects.toBe(boom)
    expect(deps.fs.removeDir).not.toHaveBeenCalled()
  })

  it('通告走 member-presence：evictLive 回 unknown 时不发 announceRemoved', async () => {
    const root = entry('session-p')
    const { deps } = execWorld({
      rows: [root],
      sizes: { [trashDirOf(root.id, HOME)]: 5 },
      evicted: 'unknown',
    })
    const plan = await planTrashRemoval(deps, [root], [root])

    const result = await executeRemoval(deps, plan)

    expect(result).toEqual({ removed: 1, freedBytes: 5, attachments: NOTHING_CLEANED })
    expect(deps.host.evictLive).toHaveBeenCalledWith('session-p')
    expect(deps.host.announceRemoved).not.toHaveBeenCalled()
  })

  it('空计划：零条零字节、不碰盘也不碰宿主', async () => {
    const { deps } = execWorld({ rows: [] })
    const plan = await planOrphanRemoval(deps, [])

    const result = await executeRemoval(deps, plan)

    expect(result).toEqual({ removed: 0, freedBytes: 0, attachments: NOTHING_CLEANED })
    expect(deps.fs.removeDir).not.toHaveBeenCalled()
    expect(deps.host.unarchive).not.toHaveBeenCalled()
  })
})

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')

/** 唯一允许删目录的家。 */
const REMOVE_DIR_HOME = 'src/verbs/permanent-removal.ts'
/** 比 `deps.fs.removeDir(` 宽一格：换个接收者（`fs.removeDir(`、`io.fs.removeDir(`）也躲不过。 */
const REMOVE_DIR_CALL = /\bfs\.removeDir\s*\(/

/** 唯一允许开 journal 的三个家：定义处，与删除 / 恢复这两条要逆序回滚的动词。 */
const JOURNAL_HOMES = [
  'src/verbs/member-journal.ts',
  'src/verbs/delete-session.ts',
  'src/verbs/restore-session.ts',
] as const

const CREATE_JOURNAL_CALL = /\bcreateJournal\s*\(/

interface SourceHit {
  readonly file: string
  readonly line: number
  readonly text: string
}

function walkSrc(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'lib' || entry === '.git') continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walkSrc(p, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p)
  }
  return out
}

/** 扫 `src` 下全部 `.ts|.tsx`；路径统一成 `/` 分隔，命中定位到行。 */
function scanSrc(pattern: RegExp): SourceHit[] {
  return walkSrc(join(ROOT, 'src')).flatMap((file) => {
    const relative = file.slice(ROOT.length + 1).replace(/\\/g, '/')
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .flatMap((text, index) => (pattern.test(text) ? [{ file: relative, line: index + 1, text: text.trim() }] : []))
  })
}

function violations(hits: readonly SourceHit[], allowed: readonly string[]): string[] {
  return hits
    .filter((hit) => !allowed.includes(hit.file))
    .map((hit) => `${hit.file}: ${hit.line}  ${hit.text}`)
}

function filesWithHits(hits: readonly SourceHit[]): string[] {
  return [...new Set(hits.map((hit) => hit.file))]
}

/**
 * 删目录在动词面由 `RemovalDeps` 收口（`CoreDeps` / `DeleteSessionDeps` 上都没有 `removeDir`），
 * 但组合根与路由持有全量的 `DeleteDeps`，类型面挡不住那里新长出的第二处调用——「唯一调用处」
 * 继续扫源码。
 */
describe('永久删除是唯一的删目录者', () => {
  it('fs.removeDir 只在 permanent-removal 里被调用', () => {
    expect(violations(scanSrc(REMOVE_DIR_CALL), [REMOVE_DIR_HOME])).toEqual([])
  })

  it('扫描不是空转：允许的家还命中着（删空执行器不会让上一条变绿）', () => {
    expect(filesWithHits(scanSrc(REMOVE_DIR_CALL))).toContain(REMOVE_DIR_HOME)
  })
})

/**
 * journal 只服务"一次成员移动"（有反向动作）；永久删除没有可回滚的那一半，所以不许再开一个。
 *
 * 在场通告已由 `PresenceCapability` 在依赖面收口（`CoreDeps.host` 是 `HostCorePort`，不含在场三件，
 * `tests/deps.test.ts` 钉住）；journal 的 import confinement 无法用类型表达，只能继续扫源码。
 * purge / orphan-clean 的「委托给执行器」结构同理（各自的用例里扫）。
 */
describe('journal 只服务可回滚的成员移动', () => {
  it('createJournal( 只在 member-journal 定义、delete / restore 调用', () => {
    expect(violations(scanSrc(CREATE_JOURNAL_CALL), JOURNAL_HOMES)).toEqual([])
  })

  it('扫描不是空转：每个允许的家都还命中着（删空一个文件不会让它变绿）', () => {
    const journalFiles = filesWithHits(scanSrc(CREATE_JOURNAL_CALL))
    for (const home of JOURNAL_HOMES) {
      expect(journalFiles).toContain(home)
    }
  })
})
