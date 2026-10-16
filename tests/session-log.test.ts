// 会话日志的逐帧读法：帧 → 明文 → 一行一条 JSON 记录（设计稿 2026-10-15 §1.1 / §3）
import zlib from 'node:zlib'
import { expect, it } from 'vitest'
import { walkSessionLog, type SessionRecord } from '../src/log/session-log.js'

const frame = (...lines: string[]) =>
  zlib.zstdCompressSync(Buffer.from(lines.filter(Boolean).join('\n') + '\n', 'utf8'))

const collect = (...logs: Buffer[]) => {
  const seen: SessionRecord[] = []
  const stats = walkSessionLog(Buffer.concat(logs), (r) => seen.push(r))
  return { seen, stats }
}

const rec = (o: unknown) => JSON.stringify(o)

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
  expect(walkSessionLog(Buffer.alloc(0), (r) => seen.push(r))).toEqual({
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
  // 边界算得出、内容解不开：带 Dictionary_ID 的帧（没字典必然失败），帧头按 descriptor 走
  const payload = Buffer.from(rec({ type: 'tool/call' }) + '\n', 'utf8')
  const block = (size: number) => {
    const v = 1 | (0 << 1) | (size << 3) // last=1, type=0 Raw
    return Buffer.from([v & 255, (v >>> 8) & 255, (v >>> 16) & 255])
  }
  const needsDictionary = Buffer.concat([
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x44, 0x07, payload.length & 255]), // desc=0x44：单段 + DID 1 字节 + FCS 1 字节
    block(payload.length),
    payload,
  ])
  const raw = Buffer.concat([frame(rec({ type: 'turn/start' })), needsDictionary])
  expect(() => walkSessionLog(raw, () => undefined)).toThrow(/第 2 帧/)
})
