import zlib from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  attachmentPathOf,
  attachmentsInContent,
  cleanOrphanImageAttachments,
  executeImageAttachmentRemoval,
  imageIdsOfDir,
  planImageAttachmentRemoval,
  scanOrphanImageAttachments,
} from '../src/trash/attachments.js'
import { createFakeDeps } from './support/fake-deps.js'

const HOME = '/h'
const ID = `sha256:${'a'.repeat(64)}`
const ID2 = `sha256:${'b'.repeat(64)}`
const ID3 = `sha256:${'c'.repeat(64)}`
const log = (id: string) =>
  zlib.zstdCompressSync(Buffer.from(
    [
      JSON.stringify({ type: 'session', version: 4, id: 'session-x', createdAt: 1, cwd: 'C:/p' }),
      JSON.stringify({
        type: 'user/message', time: 2,
        data: {
          source: { kind: 'user' },
          content: [
            { type: 'text', text: '看图' },
            { type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', bytes: 3, width: 1, height: 1 } },
          ],
        },
      }),
    ].join('\n') + '\n',
    'utf8',
  ))

const imagePath = (id: string) => attachmentPathOf(HOME, 'image', id)

/** 额外安全用例的载荷构造：与 `log` 同一日志形状，content 段由用例点名。 */
const imageBlock = (id: string) => ({
  type: 'image',
  attachment: { attachmentId: id, mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
})
const fileBlock = (id: string) => ({ type: 'file', attachment: { attachmentId: id, name: 'a.pdf', bytes: 9 } })
const logWith = (...content: unknown[]) =>
  zlib.zstdCompressSync(Buffer.from(
    [
      JSON.stringify({ type: 'session', version: 4, id: 'session-x', createdAt: 1, cwd: 'C:/p' }),
      JSON.stringify({ type: 'user/message', time: 2, data: { source: { kind: 'user' }, content } }),
    ].join('\n') + '\n',
    'utf8',
  ))

/** 中间夹一行坏 JSON：`walkSessionLog` 不抛，只把坏行计数（`unparsedLines`）。 */
const logWithBadLine = (id: string) =>
  zlib.zstdCompressSync(Buffer.from(
    [
      JSON.stringify({ type: 'session', version: 4, id: 'session-x', createdAt: 1, cwd: 'C:/p' }),
      '{"type":"user/message","time":2,"data":',
      JSON.stringify({ type: 'user/message', time: 3, data: { source: { kind: 'user' }, content: [imageBlock(id)] } }),
    ].join('\n') + '\n',
    'utf8',
  ))

/** 末尾不带换行：最后一行等于"写了一半"，`walkSessionLog` 记 `truncatedTailBytes > 0`。 */
const logTruncatedTail = (...content: unknown[]) =>
  zlib.zstdCompressSync(Buffer.from(
    [
      JSON.stringify({ type: 'session', version: 4, id: 'session-x', createdAt: 1, cwd: 'C:/p' }),
      JSON.stringify({ type: 'user/message', time: 2, data: { source: { kind: 'user' }, content } }),
    ].join('\n'),
    'utf8',
  ))

function makeWorld(over: {
  logs: Record<string, Buffer>
  dirs?: (p: string) => string[]
  files?: (p: string) => string[]
  sizes?: Record<string, number>
  statFile?: (p: string) => { size: number }
  removeFile?: (p: string) => void
}) {
  const made = createFakeDeps({
    home: HOME,
    fs: {
      exists: true,
      dirs: over.dirs ?? (() => []),
      files: over.files ?? (() => []),
      readFile: (p) => {
        const found = over.logs[p]
        if (found !== undefined) return found
        throw new Error(`no fixture for ${p}`)
      },
      fileSize: (p) => over.sizes?.[p] ?? 100,
      statFile: over.statFile,
      removeFile: over.removeFile,
    },
  })
  return made
}

describe('附件内容块', () => {
  it('只认合法 image/file block；畸形 id 与非附件段跳过', () => {
    expect(attachmentsInContent([
      { type: 'text', text: 'x' },
      { type: 'image', attachment: { attachmentId: ID, mediaType: 'image/png', bytes: 3, width: 1, height: 1 } },
      { type: 'file', attachment: { attachmentId: ID2, name: 'a.pdf', bytes: 9 } },
      { type: 'image', attachment: { attachmentId: '../../etc/passwd' } },
    ])).toEqual([
      { kind: 'image', id: ID, mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
      { kind: 'file', id: ID2, name: 'a.pdf', bytes: 9 },
    ])
  })
})

describe('路径闸', () => {
  it('只由 ID 推导到 objects/file-objects，且拒绝路径穿越', () => {
    expect(imagePath(ID)).toBe(`/h/attachments/v1/objects/aa/${'a'.repeat(64)}`)
    expect(attachmentPathOf(HOME, 'file', ID2)).toBe(`/h/attachments/v1/file-objects/bb/${'b'.repeat(64)}`)
    expect(() => attachmentPathOf(HOME, 'image', 'sha256:../../x')).toThrow(/附件 id/)
    expect(() => attachmentPathOf(HOME, 'image', `sha256:${'A'.repeat(64)}`)).toThrow(/附件 id/)
    // 长度够 64 但含穿越字符：栅栏是整串形状，不是长度。
    expect(() => attachmentPathOf(HOME, 'image', `sha256:${'a'.repeat(62)}/..`)).toThrow(/附件 id/)
  })
})

describe('日志提取', () => {
  it('从 user/message 的 content 里读出图片 id', async () => {
    const dir = '/h/sessions/--p--/session-x'
    const made = makeWorld({
      logs: { [`${dir}/session.v4.jsonl.zstd`]: log(ID) },
      files: (p) => p === dir ? ['session.v4.jsonl.zstd'] : [],
    })
    const read = await imageIdsOfDir(made.deps, dir)
    expect(read.unreadable).toBeUndefined()
    expect([...read.ids]).toEqual([ID])
  })

  it('有规范日志但目录里还有子目录 = 不可读：日志看不到子目录里的引用', async () => {
    const dir = '/h/sessions/--p--/session-nested'
    const made = makeWorld({
      logs: { [`${dir}/session.v4.jsonl.zstd`]: log(ID) },
      dirs: (p) => p === dir ? ['child'] : [],
      files: (p) => p === dir ? ['session.v4.jsonl.zstd'] : [],
    })
    const read = await imageIdsOfDir(made.deps, dir)
    expect(read.ids.size).toBe(0)
    expect(read.unreadable).toMatch(/子目录/)
  })
})

describe('单目录引用扫描', () => {
  it('空目录 = 没有引用；只有子目录、没有规范日志 = 不可读', async () => {
    const empty = makeWorld({ logs: {}, dirs: () => [], files: () => [] })
    expect(await imageIdsOfDir(empty.deps, '/h/sessions/--p--/session-empty')).toEqual({ ids: new Set() })

    const nested = makeWorld({
      logs: {},
      dirs: (p) => p === '/h/sessions/--p--/session-nested' ? ['child'] : [],
      files: () => [],
    })
    const read = await imageIdsOfDir(nested.deps, '/h/sessions/--p--/session-nested')
    expect(read.ids.size).toBe(0)
    expect(read.unreadable).toMatch(/没有可读的会话日志/)
  })

  it('只有 0 字节临时日志 = 没有引用；非零临时日志仍不可读', async () => {
    const dir = '/h/sessions/--p--/session-temp'
    const temp = 'session.v4.jsonl.zstd.f7eb592e2207.tmp'
    const zero = makeWorld({
      logs: {},
      files: (p) => p === dir ? [temp] : [],
      statFile: () => ({ size: 0 }),
    })
    expect(await imageIdsOfDir(zero.deps, dir)).toEqual({ ids: new Set() })

    const nonZero = makeWorld({
      logs: {},
      files: (p) => p === dir ? [temp] : [],
      statFile: () => ({ size: 1 }),
    })
    const read = await imageIdsOfDir(nonZero.deps, dir)
    expect(read.ids.size).toBe(0)
    expect(read.unreadable).toMatch(/没有可读的会话日志/)
  })

  it('规范日志旁：老一代日志可并存，0 字节临时日志可忽略，非空临时日志/明文日志不可读', async () => {
    const dir = '/h/sessions/--p--/session-mixed'
    const canonical = 'session.v4.jsonl.zstd'
    const older = 'session.v3.jsonl.zstd'
    const plain = 'session.v4.jsonl'
    const temp = 'session.v4.jsonl.zstd.f7eb592e2207.tmp'

    const withOlder = makeWorld({
      logs: { [`${dir}/${canonical}`]: log(ID) },
      files: (p) => p === dir ? [canonical, older] : [],
    })
    const olderRead = await imageIdsOfDir(withOlder.deps, dir)
    expect(olderRead.unreadable).toBeUndefined()
    expect([...olderRead.ids]).toEqual([ID])

    const withEmptyTemp = makeWorld({
      logs: { [`${dir}/${canonical}`]: log(ID) },
      files: (p) => p === dir ? [canonical, temp] : [],
      statFile: () => ({ size: 0 }),
    })
    const emptyRead = await imageIdsOfDir(withEmptyTemp.deps, dir)
    expect(emptyRead.unreadable).toBeUndefined()
    expect([...emptyRead.ids]).toEqual([ID])

    const withBusyTemp = makeWorld({
      logs: { [`${dir}/${canonical}`]: log(ID) },
      files: (p) => p === dir ? [canonical, temp] : [],
      statFile: () => ({ size: 1 }),
    })
    const busyRead = await imageIdsOfDir(withBusyTemp.deps, dir)
    expect(busyRead.ids.size).toBe(0)
    expect(busyRead.unreadable).toMatch(/非空临时日志/)

    const withPlain = makeWorld({
      logs: { [`${dir}/${canonical}`]: log(ID) },
      files: (p) => p === dir ? [canonical, plain] : [],
    })
    const plainRead = await imageIdsOfDir(withPlain.deps, dir)
    expect(plainRead.ids.size).toBe(0)
    expect(plainRead.unreadable).toMatch(/无法确认/)
  })
})

describe('独占计划与执行', () => {
  it('只删被删会话引用、剩余任何会话都不引用的图片', async () => {
    const removed = '/h/session-trash/20260101T000000Z-session-a'
    const remaining = '/h/sessions/--p--/session-b'
    const made = makeWorld({
      logs: {
        [`${removed}/session.v4.jsonl.zstd`]: log(ID),
        [`${remaining}/session.v4.jsonl.zstd`]: log(ID),
      },
      dirs: (p) => p === '/h/sessions' ? ['--p--'] : p === '/h/sessions/--p--' ? ['session-b'] : [],
      files: (p) => p === remaining ? ['session.v4.jsonl.zstd'] : [],
      sizes: { [imagePath(ID)]: 7 },
    })
    const plan = await planImageAttachmentRemoval(made.deps, [removed])
    expect(plan.entries).toEqual([])
    expect(plan.bytes).toBe(0)
  })

  it('候选日志读不出：跳过它自己的 id，不删；其他候选照常', async () => {
    const bad = '/h/session-trash/20260101T000000Z-session-bad'
    const good = '/h/session-trash/20260101T000000Z-session-good'
    const made = makeWorld({
      logs: { [`${good}/session.v4.jsonl.zstd`]: log(ID) },
      dirs: (p) => p === '/h/sessions' ? [] : [],
      files: (p) => p === bad ? ['session.v4.jsonl.zstd'] : p === good ? ['session.v4.jsonl.zstd'] : [],
      sizes: { [imagePath(ID)]: 7 },
    })
    // bad 目录存在且声明有日志，但 readFile 没夹具 ⇒ 抛 ⇒ 该候选被跳过
    const plan = await planImageAttachmentRemoval(made.deps, [bad, good])
    expect(plan.entries.map((e) => e.id)).toEqual([ID])
    expect(plan.skipped).toMatch(/日志读不出/)
  })

  it('剩余会话日志读不出：整体跳过（fail closed）', async () => {
    const removed = '/h/session-trash/20260101T000000Z-session-a'
    const remaining = '/h/sessions/--p--/session-b'
    const made = makeWorld({
      logs: { [`${removed}/session.v4.jsonl.zstd`]: log(ID) },
      dirs: (p) => p === '/h/sessions' ? ['--p--'] : p === '/h/sessions/--p--' ? ['session-b'] : [],
      files: (p) => p === removed ? ['session.v4.jsonl.zstd'] : p === remaining ? ['session.v4.jsonl.zstd'] : [],
      sizes: { [imagePath(ID)]: 7 },
    })
    const plan = await planImageAttachmentRemoval(made.deps, [removed])
    expect(plan.entries).toEqual([])
    expect(plan.skipped).toMatch(/无法证明独占|读不到/)
  })

  it('执行只碰计划里的 objects 路径；失败计数、成功字节分开算', async () => {
    const removed = '/h/session-trash/20260101T000000Z-session-a'
    const removedFiles: string[] = []
    const made = makeWorld({
      logs: { [`${removed}/session.v4.jsonl.zstd`]: log(ID) },
      dirs: () => [],
      files: (p) => p === removed ? ['session.v4.jsonl.zstd'] : [],
      sizes: { [imagePath(ID)]: 7 },
      removeFile: (p) => { removedFiles.push(p) },
    })
    const plan = await planImageAttachmentRemoval(made.deps, [removed])
    const stats = await executeImageAttachmentRemoval(made.deps, plan)
    expect(removedFiles).toEqual([imagePath(ID)])
    expect(stats).toEqual({ removed: 1, freedBytes: 7, failed: 0 })
  })

  // 以下三条补简报样例没走到的分支：ENOENT、失败计数、普通文件不代删。
  it('对象已不在（ENOENT）：不进计划，也不算失败、不置 skipped', async () => {
    const removed = '/h/session-trash/20260101T000000Z-session-a'
    const made = makeWorld({
      logs: { [`${removed}/session.v4.jsonl.zstd`]: log(ID) },
      files: (p) => p === removed ? ['session.v4.jsonl.zstd'] : [],
      statFile: (p) => {
        if (p === imagePath(ID)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return { size: 100 }
      },
    })
    const plan = await planImageAttachmentRemoval(made.deps, [removed])
    const stats = await executeImageAttachmentRemoval(made.deps, plan)
    expect(plan.entries).toEqual([])
    expect(plan.bytes).toBe(0)
    expect(plan.skipped).toBeUndefined()
    expect(stats).toEqual({ removed: 0, freedBytes: 0, failed: 0 })
    expect(made.fs.removeFile).not.toHaveBeenCalled()
  })

  it('附件对象 stat 的非 ENOENT 失败：记进部分 skipped，其余读得出的照常计划', async () => {
    const removed = '/h/session-trash/20260101T000000Z-session-a'
    const made = makeWorld({
      logs: { [`${removed}/session.v4.jsonl.zstd`]: logWith(imageBlock(ID), imageBlock(ID2), imageBlock(ID3)) },
      files: (p) => p === removed ? ['session.v4.jsonl.zstd'] : [],
      statFile: (p) => {
        if (p === imagePath(ID)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        if (p === imagePath(ID2)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return { size: 7 }
      },
    })
    const plan = await planImageAttachmentRemoval(made.deps, [removed])
    expect(plan.entries.map((e) => e.id)).toEqual([ID3])
    expect(plan.bytes).toBe(7)
    // ENOENT 是"本来就不在"，不置 skipped；只有 EACCES 那一件算"读不出"。
    expect(plan.skipped).toBe('1 个附件对象读不出')
  })

  it('删除失败：计数并继续，freedBytes 只算成功的那一份', async () => {
    const removed = '/h/session-trash/20260101T000000Z-session-a'
    const removedFiles: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const made = makeWorld({
        logs: { [`${removed}/session.v4.jsonl.zstd`]: logWith(imageBlock(ID), imageBlock(ID2)) },
        files: (p) => p === removed ? ['session.v4.jsonl.zstd'] : [],
        sizes: { [imagePath(ID)]: 7, [imagePath(ID2)]: 9 },
        removeFile: (p) => {
          if (p === imagePath(ID)) throw new Error('EBUSY')
          removedFiles.push(p)
        },
      })
      const plan = await planImageAttachmentRemoval(made.deps, [removed])
      const stats = await executeImageAttachmentRemoval(made.deps, plan)
      expect(plan.entries.map((e) => e.id)).toEqual([ID, ID2])
      expect(removedFiles).toEqual([imagePath(ID2)])
      expect(stats).toEqual({ removed: 1, freedBytes: 9, failed: 1 })
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('普通文件附件只渲染、不代删', async () => {
    const removed = '/h/session-trash/20260101T000000Z-session-a'
    const made = makeWorld({
      logs: { [`${removed}/session.v4.jsonl.zstd`]: logWith(fileBlock(ID2)) },
      files: (p) => p === removed ? ['session.v4.jsonl.zstd'] : [],
    })
    const plan = await planImageAttachmentRemoval(made.deps, [removed])
    const stats = await executeImageAttachmentRemoval(made.deps, plan)
    expect(plan.entries).toEqual([])
    expect(stats).toEqual({ removed: 0, freedBytes: 0, failed: 0 })
    expect(made.fs.removeFile).not.toHaveBeenCalled()
  })

  it('storages/cache 的 JSON 引用也算共享：保留对象', async () => {
    const removed = '/h/session-trash/20260101T000000Z-session-a'
    const storages = '/h/storages'
    const projectCache = `${storages}/session_projcache`
    const cacheSessions = `${projectCache}/sessions`
    const json = `${cacheSessions}/session-b.json`
    const made = makeWorld({
      logs: {
        [`${removed}/session.v4.jsonl.zstd`]: log(ID),
        [json]: Buffer.from(JSON.stringify({ title: 'b', attachments: [ID] }), 'utf8'),
      },
      dirs: (p) => p === storages ? ['session_projcache'] : p === projectCache ? ['sessions'] : [],
      files: (p) => p === removed ? ['session.v4.jsonl.zstd'] : p === cacheSessions ? ['session-b.json'] : [],
      sizes: { [json]: 64 },
    })
    const plan = await planImageAttachmentRemoval(made.deps, [removed])
    expect(plan.entries).toEqual([])
    expect(plan.bytes).toBe(0)
  })
})

describe('引用源不可读（fail closed）', () => {
  it('storages 里超过 10 MiB 的 JSON 不是"没有引用"：整体跳过，不删', async () => {
    const removed = '/h/session-trash/20260101T000000Z-session-a'
    const storages = '/h/storages'
    const big = `${storages}/session_projcache.json`
    const made = makeWorld({
      logs: { [`${removed}/session.v4.jsonl.zstd`]: log(ID) },
      files: (p) => p === removed ? ['session.v4.jsonl.zstd'] : p === storages ? ['session_projcache.json'] : [],
      // 夹具只声明尺寸：判据本来就是 stat.size，读满 10 MiB 不增加信息。
      statFile: () => ({ size: 10 * 1024 * 1024 + 1 }),
    })
    const plan = await planImageAttachmentRemoval(made.deps, [removed])
    const stats = await executeImageAttachmentRemoval(made.deps, plan)
    expect(plan.entries).toEqual([])
    expect(plan.bytes).toBe(0)
    expect(plan.skipped).toMatch(/无法证明独占/)
    expect(plan.skipped).toMatch(/未扫描/)
    expect(plan.skipped).toContain(big)
    expect(stats).toEqual({ removed: 0, freedBytes: 0, failed: 0 })
    expect(made.fs.removeFile).not.toHaveBeenCalled()
  })

  it('剩余会话目录只有明文日志（没有规范 zstd）：非空目录按读不出处理，整体跳过', async () => {
    const removed = '/h/session-trash/20260101T000000Z-session-a'
    const remaining = '/h/sessions/--p--/session-b'
    const made = makeWorld({
      logs: { [`${removed}/session.v4.jsonl.zstd`]: log(ID) },
      dirs: (p) => p === '/h/sessions' ? ['--p--'] : p === '/h/sessions/--p--' ? ['session-b'] : [],
      // 明文日志不是 `pickSessionLog` 认的名字：目录里有东西但读法不认识。
      files: (p) => p === removed ? ['session.v4.jsonl.zstd'] : p === remaining ? ['session.v4.jsonl'] : [],
      sizes: { [imagePath(ID)]: 7 },
    })
    const plan = await planImageAttachmentRemoval(made.deps, [removed])
    expect(plan.entries).toEqual([])
    expect(plan.bytes).toBe(0)
    expect(plan.skipped).toMatch(/无法证明独占/)
    expect(plan.skipped).toMatch(/没有可读的会话日志/)
    expect(made.fs.removeFile).not.toHaveBeenCalled()
  })

  it('清册外的 session-trash 子目录也算剩余引用：引用 IMAGE 即保留', async () => {
    const removed = '/h/session-trash/20260101T000000Z-session-a'
    const unlisted = '/h/session-trash/20260101T000000Z-manual'
    const made = makeWorld({
      logs: {
        [`${removed}/session.v4.jsonl.zstd`]: log(ID),
        [`${unlisted}/session.v4.jsonl.zstd`]: log(ID),
      },
      dirs: (p) => p === '/h/session-trash'
        ? ['20260101T000000Z-session-a', '20260101T000000Z-manual']
        : [],
      files: (p) => p === removed || p === unlisted ? ['session.v4.jsonl.zstd'] : [],
      sizes: { [imagePath(ID)]: 7 },
    })
    const plan = await planImageAttachmentRemoval(made.deps, [removed])
    expect(plan.entries).toEqual([])
    expect(plan.bytes).toBe(0)
    expect(plan.skipped).toBeUndefined()
    expect(made.fs.removeFile).not.toHaveBeenCalled()
  })
})

describe('损坏日志按不可读处理', () => {
  it('候选日志有坏行：即使还能解析出合法图片引用，也跳过不删', async () => {
    const removed = '/h/session-trash/20260101T000000Z-session-a'
    const made = makeWorld({
      logs: { [`${removed}/session.v4.jsonl.zstd`]: logWithBadLine(ID) },
      files: (p) => p === removed ? ['session.v4.jsonl.zstd'] : [],
      sizes: { [imagePath(ID)]: 7 },
    })
    const plan = await planImageAttachmentRemoval(made.deps, [removed])
    const stats = await executeImageAttachmentRemoval(made.deps, plan)
    expect(plan.entries).toEqual([])
    expect(plan.bytes).toBe(0)
    expect(plan.skipped).toMatch(/日志读不出/)
    expect(stats).toEqual({ removed: 0, freedBytes: 0, failed: 0 })
    expect(made.fs.removeFile).not.toHaveBeenCalled()
  })

  it('剩余会话日志尾巴被截断：整体跳过（fail closed）', async () => {
    const removed = '/h/session-trash/20260101T000000Z-session-a'
    const remaining = '/h/sessions/--p--/session-b'
    const made = makeWorld({
      logs: {
        [`${removed}/session.v4.jsonl.zstd`]: log(ID),
        // 剩下这条日志没有任何图片引用，但最后一行少了换行 ⇒ 少读的行可能正是共享引用
        [`${remaining}/session.v4.jsonl.zstd`]: logTruncatedTail({ type: 'text', text: 'hi' }),
      },
      dirs: (p) => p === '/h/sessions' ? ['--p--'] : p === '/h/sessions/--p--' ? ['session-b'] : [],
      files: (p) => p === removed ? ['session.v4.jsonl.zstd'] : p === remaining ? ['session.v4.jsonl.zstd'] : [],
      sizes: { [imagePath(ID)]: 7 },
    })
    const plan = await planImageAttachmentRemoval(made.deps, [removed])
    expect(plan.entries).toEqual([])
    expect(plan.bytes).toBe(0)
    expect(plan.skipped).toMatch(/无法证明独占/)
    expect(made.fs.removeFile).not.toHaveBeenCalled()
  })
})

describe('执行闸：只认 ID 推导出的 objects 路径', () => {
  it('手搭计划里指向 objects 之外的路径被拒绝，且不删', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const made = makeWorld({ logs: {} })
      const plan = {
        entries: [{ id: ID, path: '/h/sessions/--p--/session-b/session.v4.jsonl.zstd', bytes: 7 }],
        bytes: 7,
      }
      expect(await executeImageAttachmentRemoval(made.deps, plan)).toEqual({ removed: 0, freedBytes: 0, failed: 1 })
      expect(made.fs.removeFile).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('计划路径带 .. 穿越（id 合法）：与推导不一致即拒绝', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const made = makeWorld({ logs: {} })
      const plan = {
        entries: [{ id: ID, path: `${imagePath(ID)}/../../../sessions/--p--/session-b/session.v4.jsonl.zstd`, bytes: 7 }],
        bytes: 7,
      }
      expect(await executeImageAttachmentRemoval(made.deps, plan)).toEqual({ removed: 0, freedBytes: 0, failed: 1 })
      expect(made.fs.removeFile).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('计划条目用 file-objects 路径也拒绝：只删图片', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const made = makeWorld({ logs: {} })
      const plan = { entries: [{ id: ID, path: attachmentPathOf(HOME, 'file', ID), bytes: 7 }], bytes: 7 }
      expect(await executeImageAttachmentRemoval(made.deps, plan)).toEqual({ removed: 0, freedBytes: 0, failed: 1 })
      expect(made.fs.removeFile).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('畸形 id 的条目被拒绝，不碰它声明的路径', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const made = makeWorld({ logs: {} })
      const plan = { entries: [{ id: `sha256:${'a'.repeat(62)}/..`, path: '../../etc/passwd', bytes: 7 }], bytes: 7 }
      expect(await executeImageAttachmentRemoval(made.deps, plan)).toEqual({ removed: 0, freedBytes: 0, failed: 1 })
      expect(made.fs.removeFile).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

// 孤儿附件（2026-10-27）：对象存在、但活动会话、清册外回收站目录与 storages/cache 都不再引用它。
// 扫的是**全部引用源**（`collectRemainingImageRefs`），只列 `objects/<2 hex>/<64 hex>` 这一种真实形状；
// file-objects / tmp / v2 / cache 与非规范名字一律不进候选。任一引用源或对象列表读不出 ⇒ 整份跳过。
describe('孤儿附件扫描与清理', () => {
  const OBJECTS = `${HOME}/attachments/v1/objects`
  const ACTIVE = '/h/sessions/--p--/session-active'
  const TRASHED = '/h/session-trash/20260101T000000Z-session-trashed'
  const LOG = 'session.v4.jsonl.zstd'
  const hex = (char: string) => char.repeat(64)

  const worldDirs = (p: string): string[] => {
    if (p === '/h/sessions') return ['--p--']
    if (p === '/h/sessions/--p--') return ['session-active']
    if (p === '/h/session-trash') return ['20260101T000000Z-session-trashed']
    // 真实布局里 tmp/file-objects/v2 与 objects 平级；这里故意塞进 objects，钉住"不认的名字一律跳过"。
    if (p === OBJECTS) return ['aa', 'bb', 'cc', 'tmp', 'file-objects', 'v2', 'cache']
    return []
  }
  const worldFiles = (p: string): string[] => {
    if (p === ACTIVE || p === TRASHED) return [LOG]
    if (p === `${OBJECTS}/aa`) return [hex('a')]
    if (p === `${OBJECTS}/bb`) return [hex('b')]
    if (p === `${OBJECTS}/cc`) return [hex('c')]
    return []
  }
  const worldLogs = () => ({
    [`${ACTIVE}/${LOG}`]: log(ID),
    [`${TRASHED}/${LOG}`]: log(ID2),
  })
  const worldSizes = () => ({ [imagePath(ID)]: 10, [imagePath(ID2)]: 20, [imagePath(ID3)]: 30 })

  function orphanWorld(over: {
    dirs?: (p: string) => string[]
    files?: (p: string) => string[]
    logs?: Record<string, Buffer>
    sizes?: Record<string, number>
    statFile?: (p: string) => { size: number }
    removeFile?: (p: string) => void
  } = {}) {
    return makeWorld({
      logs: over.logs ?? worldLogs(),
      dirs: over.dirs ?? worldDirs,
      files: over.files ?? worldFiles,
      sizes: over.sizes ?? worldSizes(),
      statFile: over.statFile,
      removeFile: over.removeFile,
    })
  }

  it('objects 下三个对象：活动会话与回收站引用保留，只报无引用那个', async () => {
    const made = orphanWorld()
    const plan = await scanOrphanImageAttachments(made.deps)
    expect(plan.skipped).toBeUndefined()
    expect(plan.entries).toEqual([{ id: ID3, path: imagePath(ID3), bytes: 30 }])
    expect(plan.bytes).toBe(30)
  })

  it('引用源读不出 ⇒ 整份报告跳过（entries 为空，不拿 0 冒充"没有孤儿"）', async () => {
    const made = orphanWorld({
      files: (p) => (p === ACTIVE ? ['session.v4.jsonl'] : worldFiles(p)),
    })
    const plan = await scanOrphanImageAttachments(made.deps)
    expect(plan.entries).toEqual([])
    expect(plan.bytes).toBe(0)
    expect(plan.skipped).toMatch(/无法判定孤儿/)
    expect(plan.skipped).toMatch(/没有可读的会话日志/)
  })

  it('对象前缀目录列不出 ⇒ 跳过；非 ENOENT 的 stat 失败同样整份跳过（fail closed）', async () => {
    const listFailed = orphanWorld({
      dirs: (p) => {
        if (p === OBJECTS) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return worldDirs(p)
      },
    })
    const listed = await scanOrphanImageAttachments(listFailed.deps)
    expect(listed.entries).toEqual([])
    expect(listed.skipped).toMatch(/无法判定孤儿/)

    const statFailed = orphanWorld({
      statFile: (p) => {
        if (p === imagePath(ID3)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return { size: worldSizes()[p] ?? 0 }
      },
    })
    const planned = await scanOrphanImageAttachments(statFailed.deps)
    expect(planned.entries).toEqual([])
    expect(planned.bytes).toBe(0)
    expect(planned.skipped).toMatch(/无法判定孤儿/)
  })

  it('clean 只删计划里的孤儿对象；file-objects / tmp / v2 / cache 一个都不碰', async () => {
    const removed: string[] = []
    const made = orphanWorld({ removeFile: (p) => { removed.push(p) } })
    const stats = await cleanOrphanImageAttachments(made.deps)
    expect(stats).toEqual({ removed: 1, freedBytes: 30, failed: 0 })
    expect(removed).toEqual([imagePath(ID3)])
    const listed = made.fs.listFiles.mock.calls.map(([p]) => String(p))
    for (const ignored of ['tmp', 'file-objects', 'v2', 'cache']) {
      expect(listed).not.toContain(`${OBJECTS}/${ignored}`)
      expect(listed).not.toContain(`${HOME}/attachments/v1/${ignored}`)
    }
  })

  it('跳过时 clean 一件都不删，回执原样带 skipped', async () => {
    const removed: string[] = []
    const made = orphanWorld({
      files: (p) => (p === ACTIVE ? ['session.v4.jsonl'] : worldFiles(p)),
      removeFile: (p) => { removed.push(p) },
    })
    const stats = await cleanOrphanImageAttachments(made.deps)
    expect(stats).toMatchObject({ removed: 0, freedBytes: 0, failed: 0 })
    expect(stats.skipped).toMatch(/无法判定孤儿/)
    expect(removed).toEqual([])
    expect(made.fs.removeFile).not.toHaveBeenCalled()
  })
})
