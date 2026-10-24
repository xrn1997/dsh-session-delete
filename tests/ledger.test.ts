import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { makeEntryId } from '../src/trash/entry.js'
import { createTrashLedger } from '../src/trash/ledger.js'
import { createMemoryManifest } from '../src/trash/manifest.js'
import { createFakeFs } from './support/fake-deps.js'
import { trashEntry } from './support/world.js'

const HOME = '/h'
const id = makeEntryId(1, 'session-a')
const row = trashEntry(id, { sessionId: 'session-a', workspaceId: '', sizeBytes: 1 })

describe('TrashLedger', () => {
  it('list 先对账：目录没了的行当场摘掉', async () => {
    const raw = createMemoryManifest([row])
    const ledger = createTrashLedger(raw, createFakeFs({ dirs: [] }), HOME)
    expect(await ledger.list()).toEqual([])
    expect(await raw.list()).toEqual([])
  })

  it('目录在而清单没有 ⇒ 对账补出行', async () => {
    const raw = createMemoryManifest()
    // `readSessionHeader` 认的是真的多帧 zstd 格式，所以夹具走真压缩。
    const log = zlib.zstdCompressSync(Buffer.from(
      `${JSON.stringify({ type: 'session', version: 4, id: 'session-a', cwd: 'C:/p' })}\n`,
      'utf8',
    ))
    const ledger = createTrashLedger(raw, createFakeFs({
      dirs: [id], files: ['session.v4.jsonl.zstd'], readFile: () => log, size: 7,
    }), HOME)
    expect(await ledger.list()).toMatchObject([{ id, sessionId: 'session-a', sizeBytes: 7 }])
  })

  it('add / remove 落到 raw 清单', async () => {
    const raw = createMemoryManifest()
    const ledger = createTrashLedger(raw, createFakeFs({ dirs: [id] }), HOME)
    await ledger.add(row)
    expect(await raw.list()).toEqual([row])
    await ledger.remove(id)
    expect(await raw.list()).toEqual([])
  })

  // 纯读扫描（`/orphans`）只认 raw：它声明为 pure，扫一次不能顺手写清册行。真相读才由 `list()` 摘。
  it('raw 只回索引：目录没了的行照样在，不对账也不写行', async () => {
    const raw = createMemoryManifest([row])
    const ledger = createTrashLedger(raw, createFakeFs({ dirs: [] }), HOME)
    expect(await ledger.raw()).toEqual([row])
    expect(await raw.list()).toEqual([row])
    expect(await ledger.list()).toEqual([])
    // 对上账之后 raw 读到的就是修过的那份（它读索引本身，不是缓存）
    expect(await ledger.raw()).toEqual([])
  })
})
