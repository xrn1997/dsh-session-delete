// 回收站清单的**对账**（`src/trash/reconcile.ts`，CONTEXT.md 的「对账」条）。
//
// 世界模型：回收站根下有哪些目录、每个目录里有没有日志、日志读不读得出来、尺寸多少——一件一件翻。
// 判据按"文件是准"给：多出的目录重建出行、目录没了的行摘掉、认不出/读不出的目录不动不列。
import zlib from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { makeEntryId, type TrashEntry } from '../src/trash/entry.js'
import { createMemoryManifest } from './support/memory-manifest.js'
import { reconcileTrash } from '../src/trash/reconcile.js'
import { projectDirOfCwd } from '../src/ports/host-port.js'
import { trashEntry } from './support/world.js'
import { must } from './support/fixture.js'

const HOME = '/h'
const ROOT = `${HOME}/session-trash`
const DELETED_AT = Date.UTC(2026, 9, 16, 2, 0, 0)
const idOf = (sessionDirName: string) => makeEntryId(DELETED_AT, sessionDirName)

const row = (id: string, over: Partial<TrashEntry> = {}): TrashEntry =>
  trashEntry(id, { wasArchived: true, deletedAt: DELETED_AT, title: '标题', sizeBytes: 10, ...over })

const headerLog = (header: Record<string, unknown>): Buffer =>
  zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'))

/** 一副最小世界。`logs` 的键是目录名：`Buffer` = 那条日志、`null` = 目录里没有日志、
 *  `'unreadable'` = 读的时候抛。`files` / `logsByFile` 用来造**同一目录里并存多代日志**的真机形态。 */
function world(opts: {
  seed?: TrashEntry[]
  dirs?: string[]
  logs?: Record<string, Buffer | null | 'unreadable'>
  files?: Record<string, string[]>
  logsByFile?: Record<string, Record<string, Buffer>>
  rootExists?: boolean
  sizeThrows?: boolean
} = {}) {
  const manifest = createMemoryManifest(opts.seed ?? [])
  const adds = vi.fn<(entry: TrashEntry) => void>()
  const removes = vi.fn<(id: string) => void>()
  // 对账只读 header：内容按路径交回，`readFileHead` 与 `readFile` 共用同一份世界（头读是"读同一个
  // 文件的前 N 字节"，不是第二个世界）；`readFile` 仍留着，用来钉"对账不再整本读"那条断言。
  const readLog = async (p: string): Promise<Buffer> => {
    const [name, fileName] = p.slice(ROOT.length + 1).split('/') as [string, string | undefined]
    const byName = opts.logsByFile?.[name]
    if (fileName !== undefined && byName !== undefined && fileName in byName) {
      // 上一行的 `in` 已证明这一格在：must 只是让编译器跟上这个证明，真缺了是夹具脱节，响亮失败。
      return must(byName[fileName], `日志 ${name}/${fileName} 的内容`)
    }
    const log = opts.logs?.[name]
    if (log === 'unreadable') throw new Error('boom')
    return log ?? headerLog({ type: 'session', version: 4, id: 'session-x', cwd: 'C:/p' })
  }
  const fs = {
    exists: vi.fn(async (p: string) => (p === ROOT ? opts.rootExists ?? true : true)),
    ensureDir: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    removeDir: vi.fn(async () => {}),
    listDirs: vi.fn(async (p: string) => (p === ROOT ? [...(opts.dirs ?? [])] : [])),
    listFiles: vi.fn(async (p: string) => {
      const name = p.slice(ROOT.length + 1)
      if (opts.files?.[name] !== undefined) return [...opts.files[name]]
      return opts.logs?.[name] === null ? [] : ['session.v4.jsonl.zstd']
    }),
    readFile: vi.fn((p: string) => readLog(p)),
    readFileHead: vi.fn(async (p: string, maxBytes: number) => (await readLog(p)).subarray(0, maxBytes)),
    sizeOfDir: vi.fn(async () => {
      if (opts.sizeThrows === true) throw new Error('boom')
      return 512
    }),
    // 对账不碰单文件读数与单文件删除；留最安静的缺省只为补满 `FsPort`。
    realpath: vi.fn(async (p: string) => p),
    statFile: vi.fn(async () => ({ size: 0 })),
    removeFile: vi.fn(async () => {}),
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

  it('header 缺席 id 且目录段是编码段 ⇒ 反解回原始 session id，不把 `~XXXX` 当成身份', async () => {
    // 宿主把 `a~b` 落成目录段 `a~007Eb`；对账只看得到目录名，必须解回原始 id，
    // 否则重建出来的行会拿编码段去对语料 / 投影缓存，永远匹配不上。
    const extra = idOf('a~007Eb')
    const { deps } = world({ dirs: [extra], logs: { [extra]: headerLog({ type: 'session', version: 4 }) } })
    const [entry] = await reconcileTrash(deps)
    expect(entry).toMatchObject({ sessionId: 'a~b' })
  })

  it('多帧日志超过头读窗口：前缀容忍丢掉不完整的尾帧，header 仍能重建行', async () => {
    // 真实长会话日志 > 1 MiB 且多帧是常态；头读截在第二帧中间时，严格切帧会抛、目录就再也列不出来。
    // 头读只要第一帧的 header——容忍模式丢掉不完整尾帧即可（`readSessionHeader` 的 `tolerateTruncatedTail`）。
    const extra = idOf('session-multiframe')
    const tail = zlib.zstdCompressSync(randomBytes(2 * 1024 * 1024))
    const log = Buffer.concat([headerLog({ type: 'session', version: 4, id: 'session-multiframe', cwd: 'C:/p' }), tail])
    expect(log.length).toBeGreaterThan(1024 * 1024)
    const { deps } = world({ dirs: [extra], logs: { [extra]: log } })
    const [entry] = await reconcileTrash(deps)
    expect(entry).toMatchObject({ sessionId: 'session-multiframe', projectDir: '--C-p--' })
  })

  // 空串 cwd 与"缺席 cwd"不是同一件事：宿主 `projectDir` 只在 `undefined` 时落 `_no-cwd`，
  // 删除时的 `projectDir` 也按那一支算。对账重建必须复现同一条判据，否则同一条会话在删除计划、
  // 恢复与孤儿扫描里指向两个目录。
  it('cwd 是空串 ⇒ 照常走 projectKey（不是 `_no-cwd`），与删除时那一支同口径', async () => {
    const extra = idOf('session-empty-cwd')
    const { deps } = world({
      dirs: [extra],
      logs: { [extra]: headerLog({ type: 'session', version: 4, id: 'session-empty-cwd', cwd: '' }) },
    })
    const [entry] = await reconcileTrash(deps)
    expect(entry?.projectDir).toBe(projectDirOfCwd(''))
    expect(entry?.projectDir).not.toBe(projectDirOfCwd(undefined))
  })

  it('同一目录两代并存 ⇒ 读最新那代（老代是换代留底，身份与 cwd 可能都不同）', async () => {
    const extra = idOf('session-multi')
    const { deps, fs } = world({
      dirs: [extra],
      files: { [extra]: ['session.v3.jsonl.zstd', 'session.v4.jsonl.zstd'] },
      logsByFile: {
        [extra]: {
          'session.v3.jsonl.zstd': headerLog({ type: 'session', version: 3, id: 'session-multi', createdAt: 5, cwd: 'C:/develop/p' }),
          'session.v4.jsonl.zstd': headerLog({ type: 'session', version: 4, id: 'session-multi', createdAt: 5, cwd: 'C:/develop/q' }),
        },
      },
    })
    const [entry] = await reconcileTrash(deps)
    // 两代的 cwd 不同 ⇒ 反推出的项目目录不同，读错代就在项目目录上说错话
    expect(entry).toMatchObject({ sessionId: 'session-multi', projectDir: '--C-develop-q--' })
    expect(fs.readFileHead).toHaveBeenCalledWith(`${ROOT}/${extra}/session.v4.jsonl.zstd`, 1024 * 1024)
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
    expect(fs.readFileHead).not.toHaveBeenCalled()
  })

  // 对账只为读 header：走**有界头读**（1 MiB），不为一行 header 把整本日志读进内存。
  // 这条同时钉住两件事：读的是哪条口径（`readFileHead` 带窗口大小），以及整本 `readFile` 一次都不发。
  it('重建行只读日志头：走 readFileHead（1 MiB），不整本 readFile', async () => {
    const extra = idOf('session-head')
    const { deps, fs } = world({
      dirs: [extra],
      logs: { [extra]: headerLog({ type: 'session', version: 4, id: 'session-head', cwd: 'C:/p' }) },
    })
    const rows = await reconcileTrash(deps)
    expect(rows.map((r) => r.id)).toEqual([extra])
    expect(fs.readFileHead).toHaveBeenCalledWith(`${ROOT}/${extra}/session.v4.jsonl.zstd`, 1024 * 1024)
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

  it('名字像条目但原目录名带分隔符 ⇒ 也按外人跳过，不拼路径', async () => {
    const bad = '20261016T020000Z-a\\b'
    const { deps, fs } = world({ dirs: [bad], logs: { [bad]: headerLog({ type: 'session', id: 'session-a' }) } })
    const rows = await reconcileTrash(deps)
    expect(rows).toEqual([])
    expect(fs.listFiles).not.toHaveBeenCalledWith(`${ROOT}/${bad}`)
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
