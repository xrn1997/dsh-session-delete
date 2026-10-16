// 回收站清单的**对账**（`src/trash/reconcile.ts`，设计稿 2026-10-15 §9）。
//
// 世界模型：回收站根下有哪些目录、每个目录里有没有日志、日志读不读得出来、尺寸多少——一件一件翻。
// 判据按"文件是准"给：多出的目录重建出行、目录没了的行摘掉、认不出/读不出的目录不动不列。
import zlib from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { makeEntryId, type TrashEntry } from '../src/trash/entry.js'
import { createMemoryManifest } from '../src/trash/manifest.js'
import { reconcileTrash } from '../src/trash/reconcile.js'

const HOME = '/h'
const ROOT = `${HOME}/session-trash`
const DELETED_AT = Date.UTC(2026, 9, 16, 2, 0, 0)
const idOf = (sessionDirName: string) => makeEntryId(DELETED_AT, sessionDirName)

const row = (id: string, over: Partial<TrashEntry> = {}): TrashEntry => ({
  id, sessionId: id, projectDir: '--p--', workspaceId: 'ws-1', wasArchived: true,
  deletedAt: DELETED_AT, title: '标题', sizeBytes: 10, ...over,
})

const headerLog = (header: Record<string, unknown>): Buffer =>
  zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'))

/** 一副最小世界。`logs` 的键是目录名：`Buffer` = 那条日志、`null` = 目录里没有日志、
 *  `'unreadable'` = 读的时候抛。 */
function world(opts: {
  seed?: TrashEntry[]
  dirs?: string[]
  logs?: Record<string, Buffer | null | 'unreadable'>
  rootExists?: boolean
  sizeThrows?: boolean
} = {}) {
  const manifest = createMemoryManifest(opts.seed ?? [])
  const adds = vi.fn<(entry: TrashEntry) => void>()
  const removes = vi.fn<(id: string) => void>()
  const fs = {
    exists: vi.fn(async (p: string) => (p === ROOT ? opts.rootExists ?? true : true)),
    ensureDir: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    removeDir: vi.fn(async () => {}),
    listDirs: vi.fn(async (p: string) => (p === ROOT ? [...(opts.dirs ?? [])] : [])),
    listFiles: vi.fn(async (p: string) => {
      const name = p.slice(ROOT.length + 1)
      return opts.logs?.[name] === null ? [] : ['session.v4.jsonl.zstd']
    }),
    readFile: vi.fn(async (p: string) => {
      const name = p.slice(ROOT.length + 1).split('/')[0] as string
      const log = opts.logs?.[name]
      if (log === 'unreadable') throw new Error('boom')
      return log ?? headerLog({ type: 'session', version: 4, id: 'session-x', cwd: 'C:/p' })
    }),
    sizeOfDir: vi.fn(async () => {
      if (opts.sizeThrows === true) throw new Error('boom')
      return 512
    }),
  }
  const deps = {
    fs,
    manifest: {
      list: manifest.list,
      add: async (entry: TrashEntry) => { adds(entry); await manifest.add(entry) },
      remove: async (id: string) => { removes(id); await manifest.remove(id) },
    },
    home: HOME,
  }
  return { deps, adds, removes, fs, raw: manifest }
}

describe('回收站对账', () => {
  it('多出来的目录被重建出行：id=目录名、时间戳从目录名解、尺寸现场量、项目目录从 header 的 cwd 反推', async () => {
    const extra = idOf('session-new')
    const { deps } = world({
      dirs: [extra],
      logs: { [extra]: headerLog({ type: 'session', version: 4, id: 'session-new', createdAt: 5, cwd: 'C:/develop/p' }) },
    })
    const rows = await reconcileTrash(deps)
    expect(rows).toEqual([{
      id: extra,
      sessionId: 'session-new',
      projectDir: '--C-develop-p--',
      workspaceId: '',
      wasArchived: false,
      deletedAt: DELETED_AT,
      title: '',
      sizeBytes: 512,
    }])
  })

  it('header 缺席 id ⇒ sessionId 回落到目录名里那段原目录名；缺席 cwd ⇒ `_no-cwd`', async () => {
    const extra = idOf('session-fallback')
    const { deps } = world({ dirs: [extra], logs: { [extra]: headerLog({ type: 'session', version: 4 }) } })
    const [entry] = await reconcileTrash(deps)
    expect(entry).toMatchObject({ sessionId: 'session-fallback', projectDir: '_no-cwd' })
  })

  it('目录没了的行被摘掉，且摘的就是那一条', async () => {
    const gone = idOf('session-gone')
    const kept = idOf('session-kept')
    const { deps, removes } = world({ seed: [row(gone), row(kept)], dirs: [kept] })
    const rows = await reconcileTrash(deps)
    expect(rows.map((r) => r.id)).toEqual([kept])
    expect(removes).toHaveBeenCalledExactlyOnceWith(gone)
  })

  it('一一对应时零漂移：不读日志、不写清单，原样返回同一份', async () => {
    const id = idOf('session-a')
    const { deps, adds, removes, fs } = world({ seed: [row(id)], dirs: [id] })
    const rows = await reconcileTrash(deps)
    expect(rows.map((r) => r.id)).toEqual([id])
    expect(adds).not.toHaveBeenCalled()
    expect(removes).not.toHaveBeenCalled()
    expect(fs.readFile).not.toHaveBeenCalled()
  })

  it('幂等：重建之后再跑一遍，零写入', async () => {
    const extra = idOf('session-new')
    const { deps, adds, removes } = world({ dirs: [extra] })
    await reconcileTrash(deps)
    const first = adds.mock.calls.length
    await reconcileTrash(deps)
    expect(adds.mock.calls.length).toBe(first)
    expect(removes).not.toHaveBeenCalled()
  })

  it('回收站根不在 ⇒ 一个字节都不动（不枚举、不摘行——那不是"回收站空了"）', async () => {
    const id = idOf('session-a')
    const { deps, adds, removes, fs } = world({ seed: [row(id)], dirs: [id], rootExists: false })
    const rows = await reconcileTrash(deps)
    expect(rows.map((r) => r.id)).toEqual([id])
    expect(adds).not.toHaveBeenCalled()
    expect(removes).not.toHaveBeenCalled()
    expect(fs.listDirs).not.toHaveBeenCalled()
  })

  it('名字不像条目的目录当外人：不动、不列，连它的日志都不去看', async () => {
    const id = idOf('session-a')
    const { deps, fs } = world({ dirs: ['backup', 'not-a-stamp-session-x', id], logs: { backup: headerLog({ type: 'session', id: 'x' }) } })
    const rows = await reconcileTrash(deps)
    expect(rows.map((r) => r.id)).toEqual([id])
    expect(fs.listFiles).not.toHaveBeenCalledWith(`${ROOT}/backup`)
  })

  it('目录里没有日志 / 日志读不出 / 日志里没有 header：各跳过各的，绝不抛、也绝不为它删目录', async () => {
    const noLog = idOf('session-nolog')
    const unreadable = idOf('session-unreadable')
    const headerless = idOf('session-headerless')
    const { deps, removes } = world({
      dirs: [noLog, unreadable, headerless],
      logs: {
        [noLog]: null,
        [unreadable]: 'unreadable',
        [headerless]: headerLog({ type: 'turn/start' }),
      },
    })
    const rows = await reconcileTrash(deps)
    expect(rows).toEqual([])
    expect(removes).not.toHaveBeenCalled()
  })

  it('尺寸量不出 ⇒ 整条不重建（半截行会把恢复带去错的地方）', async () => {
    const extra = idOf('session-new')
    const { deps } = world({ dirs: [extra], sizeThrows: true })
    expect(await reconcileTrash(deps)).toEqual([])
  })
})
