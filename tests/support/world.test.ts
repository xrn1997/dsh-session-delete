import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { makeEntryId } from '../../src/trash/entry.js'
import { createLogWorld, failureOf, trashEntry } from './world.js'

describe('条目记录', () => {
  it('缺省就是一条最安静的条目；over 逐格覆盖', () => {
    expect(trashEntry('e1')).toEqual({
      id: 'e1', sessionId: 'e1', projectDir: '--p--', workspaceId: 'ws-1',
      wasArchived: false, deletedAt: 1, title: '', sizeBytes: 0,
    })
    expect(trashEntry('e1', { sessionId: 'session-a', sizeBytes: 7 }))
      .toMatchObject({ id: 'e1', sessionId: 'session-a', sizeBytes: 7 })
  })
})

describe('带调用日志的世界', () => {
  it('calls 按发生顺序记；只记点名的方法；fs 与 host 共用一条', async () => {
    const world = createLogWorld({ logMethods: ['unarchive', 'removeDir'] })
    await world.host.unarchive('s1')
    await world.fs.removeDir('/h/x')
    await world.host.detach('s1', 'ws-1')

    expect(world.calls).toEqual(['unarchive', 'removeDir'])
  })

  it('format 决定一条日志怎么写；缺省只有方法名', async () => {
    const plain = createLogWorld({ logMethods: ['detach'] })
    await plain.host.detach('s1', 'ws-1')
    expect(plain.calls).toEqual(['detach'])

    const formatted = createLogWorld({
      logMethods: ['detach'],
      format: (method, args) => `${method}(${args.join(',')})`,
    })
    await formatted.host.detach('s1', 'ws-1')
    expect(formatted.calls).toEqual(['detach(s1,ws-1)'])
  })

  it('世界仍是可交给动词的依赖面：种子、清册与端口替身都在', async () => {
    const world = createLogWorld({ logMethods: [], seed: [trashEntry('e1')] })

    expect((await world.manifest.list()).map((row) => row.id)).toEqual(['e1'])
    expect(world.deps.home).toBe('/h')
    expect(world.deps.ledger).toBe(world.ledger)
  })
})

describe('被拒绝的错误', () => {
  it('原样取回（code / cause / details 都还在）；没拒绝就炸', async () => {
    const boom = Object.assign(new Error('boom'), { code: 'sessiondelete/io' })
    expect(await failureOf(Promise.reject(boom))).toBe(boom)
    await expect(failureOf(Promise.resolve(1))).rejects.toThrow(/expected the call to reject/)
  })
})

// 假 fs 从"读数表"升成"路径树状态机"。判据是**漂移可观察**——一整类世界观 bug（目标路径算错、
// 写了行忘了搬目录、rename 后源目录仍在）过去对假件不可见：`rename` 只记账不搬、`removeDir` 只记账不删、
// `dirs` 缺省从清册行集派生（写了行 ⇒ 目录"自动出现"）。现在写操作真的改世界，用例能当场看见漂移。
describe('假 fs 的路径树世界', () => {
  it('① rename 真搬：源目录消失、目标出现（漂移可观察）', async () => {
    const world = createLogWorld({ logMethods: [] })
    await world.fs.rename('/h/sessions/--p--/session-a', '/h/session-trash/e1')
    // 源消失：`exists` 落墓碑为假（旧假件 `exists` 恒真 ⇒ 这半边 RED 时就是它红）。
    expect(await world.fs.exists('/h/sessions/--p--/session-a')).toBe(false)
    // 目标出现：`present` 里真装上了它，`listDirs` 才列得出——`exists` 缺省恒真，单靠它这半边是空转，
    // 所以钉在 `listDirs` 上（旧假件 `listDirs` 走行集缺省、装不上目标 ⇒ 这半边也会红）。
    expect(await world.fs.listDirs('/h/session-trash')).toContain('e1')
  })

  it('② removeDir 真删：listDirs 不再含它', async () => {
    const world = createLogWorld({ logMethods: [], fs: { dirs: ['e1'] } })
    expect(await world.fs.listDirs('/h/session-trash')).toContain('e1')
    await world.fs.removeDir('/h/session-trash/e1')
    expect(await world.fs.listDirs('/h/session-trash')).not.toContain('e1')
  })

  it('④ rename 搬整棵子树：后代跟着走、size 按世界求和、往返后墓碑翻面', async () => {
    const world = createLogWorld({
      logMethods: [],
      fs: { seedDirs: ['/h/sessions/p/a', '/h/sessions/p/a/log'], seedSize: 10 },
    })
    expect(await world.fs.sizeOfDir('/h/sessions/p/a')).toBe(20)
    await world.fs.rename('/h/sessions/p/a', '/h/session-trash/e1')
    // 后代跟着搬：源侧子树全部落墓碑，目标侧按原相对路径出现。
    expect(await world.fs.exists('/h/sessions/p/a/log')).toBe(false)
    expect(await world.fs.listDirs('/h/session-trash/e1')).toEqual(['log'])
    expect(await world.fs.sizeOfDir('/h/session-trash/e1')).toBe(20)
    // 往返（撤销恢复的形状）：搬回来后目标侧自洽，旧目标落墓碑。
    await world.fs.rename('/h/session-trash/e1', '/h/sessions/p/a')
    expect(await world.fs.listDirs('/h/sessions/p/a')).toEqual(['log'])
    expect(await world.fs.sizeOfDir('/h/sessions/p/a')).toBe(20)
    expect(await world.fs.exists('/h/session-trash/e1')).toBe(false)
  })

  it('⑤ removeDir 摘掉整棵子树，不是只摘一层', async () => {
    const world = createLogWorld({
      logMethods: [],
      fs: { seedDirs: ['/h/session-trash/e1', '/h/session-trash/e1/log'], seedSize: 3 },
    })
    await world.fs.removeDir('/h/session-trash/e1')
    expect(await world.fs.listDirs('/h/session-trash')).not.toContain('e1')
    expect(await world.fs.exists('/h/session-trash/e1/log')).toBe(false)
  })

  it('③ seedDirs 声明的漂移目录在 ledger.list() 对账里被重建为行', async () => {
    // 一条**清册里没有**、但 seedDirs 显式声明在回收站根下的目录：对账以盘为准 ⇒ 必须被重建成行。
    const DELETED_AT = Date.UTC(2026, 9, 16, 2, 0, 0)
    const id = makeEntryId(DELETED_AT, 'session-drift')
    const log = zlib.zstdCompressSync(Buffer.from(
      `${JSON.stringify({ type: 'session', version: 4, id: 'session-drift', cwd: 'C:/p' })}\n`, 'utf8'))
    const world = createLogWorld({
      logMethods: [],
      fs: {
        seedDirs: [`/h/session-trash/${id}`],
        files: ['session.v4.jsonl.zstd'],
        readFile: () => log,
      },
    })
    const rows = await world.ledger.list()
    expect(rows.map((r) => r.id)).toEqual([id])
  })
})
