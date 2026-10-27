// 会话日志的逐帧读法：帧 → 明文 → 一行一条 JSON 记录（src/log/zstd-frames.ts）
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { pickSessionLog, readSessionHeader, walkSessionLog, type SessionRecord } from '../src/log/session-log.js'

const frame = (...lines: string[]) =>
  zlib.zstdCompressSync(Buffer.from(lines.filter(Boolean).join('\n') + '\n', 'utf8'))

const collect = (...logs: Buffer[]) => {
  const seen: SessionRecord[] = []
  const stats = walkSessionLog(Buffer.concat(logs), (r) => { seen.push(r) })
  return { seen, stats }
}

const rec = (o: unknown) => JSON.stringify(o)

/** 边界算得出、内容解不开的帧：带 Dictionary_ID（没字典必然失败），帧头按 RFC 8878 表 3 走。
 *  早停用例用它证明"header 之后的部分根本没被解到"。 */
const undecodableFrame = (line: string = rec({ type: 'tool/call' })): Buffer => {
  const payload = Buffer.from(line + '\n', 'utf8')
  const v = 1 | (0 << 1) | (payload.length << 3) // last=1, type=0 Raw
  const block = Buffer.from([v & 255, (v >>> 8) & 255, (v >>> 16) & 255])
  return Buffer.concat([
    // desc=0x01：DID 1 字节 + 非单段（带 Window 字节）+ 无 FCS + 不承诺校验和
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x01, 0x00, 0x07]),
    block,
    payload,
  ])
}

it('跨帧把每条记录交出来，顺序即写入顺序', () => {
  const { seen, stats } = collect(
    frame(rec({ type: 'session', id: 's', createdAt: 1, cwd: 'C:/x' })),
    frame(rec({ type: 'user/message', time: 2, data: { content: [] } })),
  )
  expect(seen.map((r) => r.type)).toEqual(['session', 'user/message'])
  expect(stats).toMatchObject({ frames: 2, records: 2, unparsedLines: 0 })
})

it('一行之内多条记录也逐条交（一帧可以 append 好几行）', () => {
  const { seen, stats } = collect(frame(rec({ type: 'turn/start' }), rec({ type: 'tool/call' })))
  expect(seen.map((r) => r.type)).toEqual(['turn/start', 'tool/call'])
  expect(stats.frames).toBe(1)
  expect(stats.records).toBe(2)
})

it('最后一行被截断 ⇒ 跳过那一行、不抛，两笔账都记上', () => {
  const half = zlib.zstdCompressSync(Buffer.from('{"type":"assistant/', 'utf8'))
  const { seen, stats } = collect(frame(rec({ type: 'turn/start', time: 3 })), half)
  expect(seen.map((r) => r.type)).toEqual(['turn/start'])
  expect(stats.unparsedLines).toBe(1)
  expect(stats.truncatedTailBytes).toBe(Buffer.from('{"type":"assistant/', 'utf8').length)
})

it('一条记录切在**帧之间** ⇒ 拼回同一条，既不丢也不计入 unparsedLines', () => {
  // 写作侧 append 若切在行中间（含多字节字符中间），逐帧 split 会把一条变成"两半都解不开"
  const line = rec({ type: 'assistant/message', time: 4, data: { content: '甲乙丙 · tail' } })
  const cut = Math.floor(line.length / 2)
  const { seen, stats } = collect(
    zlib.zstdCompressSync(Buffer.from(line.slice(0, cut), 'utf8')),
    zlib.zstdCompressSync(Buffer.from(line.slice(cut) + '\n', 'utf8')),
  )
  expect(seen).toEqual([{ type: 'assistant/message', time: 4, data: { content: '甲乙丙 · tail' } }])
  expect(stats).toMatchObject({ frames: 2, records: 1, unparsedLines: 0, truncatedTailBytes: 0 })
})

it('空 buffer ⇒ 全零统计，一条回调都不发（不抛）', () => {
  const seen: SessionRecord[] = []
  expect(walkSessionLog(Buffer.alloc(0), (r) => { seen.push(r) })).toEqual({
    frames: 0,
    records: 0,
    unparsedLines: 0,
    truncatedTailBytes: 0,
  })
  expect(seen).toEqual([])
})

it('非对象的一行（`null`、数组）照样交出去，由策略层判', () => {
  const { seen } = collect(frame('null', '[1,2]', rec({ type: 'x' })))
  expect(seen.map((r) => r.type)).toEqual([undefined, undefined, 'x'])
})

it('某一帧解不开 ⇒ 抛，且说的是第几帧（绝不半解半装）', () => {
  const raw = Buffer.concat([frame(rec({ type: 'turn/start' })), undecodableFrame()])
  expect(() => walkSessionLog(raw, () => undefined)).toThrow(/第 2 帧/)
})

it('回调返回 false ⇒ 就地停机：后面的帧不再解、不再交', () => {
  const seen: SessionRecord[] = []
  const stats = walkSessionLog(
    Buffer.concat([frame(rec({ type: 'session', id: 's' })), frame(rec({ type: 'turn/start' }))]),
    (r) => { seen.push(r); return false },
  )
  expect(seen.map((r) => r.type)).toEqual(['session'])
  expect(stats.frames).toBe(1)
})

it('readSessionHeader：第一行即 header（id / cwd / createdAt 都在记录根上）', () => {
  const raw = Buffer.concat([
    frame(rec({ type: 'session', version: 4, id: 'session-a', createdAt: 5, cwd: 'C:/x' })),
    frame(rec({ type: 'turn/start' })),
  ])
  expect(readSessionHeader(raw)).toMatchObject({ id: 'session-a', cwd: 'C:/x', createdAt: 5 })
})

it('readSessionHeader 取到就停机：header 之后的坏帧不会被解到（读 header 不要求整条日志可读）', () => {
  const raw = Buffer.concat([frame(rec({ type: 'session', id: 's' })), undecodableFrame()])
  expect(readSessionHeader(raw)).toMatchObject({ id: 's' })
  expect(() => walkSessionLog(raw, () => undefined)).toThrow(/第 2 帧/) // 全量走照样抛
})

it('readSessionHeader：没有 session 记录 ⇒ undefined（不拿别的记录冒充）', () => {
  expect(readSessionHeader(frame(rec({ type: 'turn/start' })))).toBeUndefined()
})

// 同一个目录里可以并存**多代**日志：宿主升过代（本机 `SESSION_FORMAT_VERSION` 从 0 → 3 → 4），
// 老代留在原地当历史语料。真机读数（2026-10-16，本机 7 个两代目录）：v4 的 `firstTs` 与开头那条
// 提问与 v3 **完全相同**、记录更多、末尾晚了 6.6 天 ⇒ v4 是 v3 迁移后的**超集**。
// 所以判据是"取版本号最大的一代"，**不是把两代拼起来**（拼接会把 v3 的记录重复计一遍），
// 也不是字母序第一个（那样读到的是最旧那代）。代次词法照宿主的
// `/^session(?:\.v([1-9][0-9]*))?\.jsonl$/u`（裸名 = 第 0 代；`.v0`、前导零、大写、临时名一律非规范）。
describe('pickSessionLog：同一目录多代并存时选哪一代', () => {
  it('取版本号最大的一代，且与输入顺序无关', () => {
    const names = ['session.v3.jsonl.zstd', 'session.v4.jsonl.zstd']
    expect(pickSessionLog(names)).toBe('session.v4.jsonl.zstd')
    expect(pickSessionLog([...names].reverse())).toBe('session.v4.jsonl.zstd')
  })

  it('裸名算第 0 代：老代留底的会话（裸名 + v4）读 v4', () => {
    expect(pickSessionLog(['session.jsonl.zstd', 'session.v4.jsonl.zstd'])).toBe('session.v4.jsonl.zstd')
    expect(pickSessionLog(['session.jsonl.zstd'])).toBe('session.jsonl.zstd')
  })

  it('版本号按数值比，不按字符串（v10 胜过 v9）', () => {
    expect(pickSessionLog(['session.v9.jsonl.zstd', 'session.v10.jsonl.zstd'])).toBe('session.v10.jsonl.zstd')
  })

  it('非规范名一律不当会话日志：`.v0`、前导零、大写、临时文件、外人的文件', () => {
    for (const junk of ['session.v0.jsonl.zstd', 'session.v03.jsonl.zstd', 'SESSION.V4.JSONL.ZSTD', 'session.v4.jsonl.zstd.tmp', 'notes.jsonl.zstd', 'session.vX.jsonl.zstd']) {
      expect(pickSessionLog([junk]), junk).toBeUndefined()
    }
    // 混在里面的规范名照样选出来
    expect(pickSessionLog(['session.v0.jsonl.zstd', 'a.tmp', 'session.v4.jsonl.zstd'])).toBe('session.v4.jsonl.zstd')
  })

  it('只有非 zstd 明文日志时返回 undefined（本插件的读法逐帧解 zstd，读不了明文）', () => {
    expect(pickSessionLog(['session.jsonl', 'session.v4.jsonl'])).toBeUndefined()
  })
})
