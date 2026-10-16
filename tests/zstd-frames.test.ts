// 多帧 zstd 的帧边界（设计稿 2026-10-15 §1.1）。
// 判据来自本机实测：125 个文件 / 36 904 帧与「扫 magic」逐帧一致、每片都解得开。
// 为什么要有这一层：Node 的 `zstdDecompressSync` 与 `createZstdDecompress()` **都只给第一帧**，
// 而回收站里的会话日志是一次次 append 出来的帧序列。
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { frameRanges } from '../src/log/zstd-frames.js'

const texts = ['header line\n', 'a'.repeat(4000) + '\n', 'tail\n']
const frames = texts.map((t) => zlib.zstdCompressSync(Buffer.from(t, 'utf8')))
/** A：帧帧相接（扫 magic 与规范块头都该给出同样的边界）；B：每帧后插 4 字节 = DSH 实测形状 */
const glue = (tail: boolean) =>
  Buffer.concat(frames.flatMap((f) => (tail ? [f, Buffer.from([9, 9, 9, 9])] : [f])))

const rangesOf = (raw: Buffer) => frameRanges(raw).map(({ start, end }) => [start, end])

describe('frameRanges · 无尾（帧帧相接）', () => {
  it('无缝铺满整段，片数与压缩段数相同', () => {
    const raw = glue(false)
    const ranges = rangesOf(raw)
    expect(ranges).toHaveLength(frames.length)
    expect(ranges[0][0]).toBe(0)
    expect(ranges.at(-1)![1]).toBe(raw.length)
    expect(ranges.every(([start], i) => i === 0 || start === ranges[i - 1]![1])).toBe(true)
  })

  it('每一片单独解压正好回到那一段明文', () => {
    const raw = glue(false)
    const decoded = frameRanges(raw).map(({ start, end }) =>
      zlib.zstdDecompressSync(raw.subarray(start, end)).toString('utf8'),
    )
    expect(decoded).toEqual(texts)
  })

  it('边界就是各段压缩产物的接缝（不靠猜：逐段长度累加）', () => {
    const raw = glue(false)
    const expected: number[][] = []
    let at = 0
    for (const f of frames) {
      expected.push([at, at + f.length])
      at += f.length
    }
    expect(rangesOf(raw)).toEqual(expected)
  })
})

describe('frameRanges · 有尾（DSH 实测形状：每帧后多 4 字节）', () => {
  it('把 4 字节尾巴归进本帧，铺满且每片仍解得回原文', () => {
    const raw = glue(true)
    const ranges = rangesOf(raw)
    expect(ranges).toHaveLength(frames.length)
    expect(ranges.at(-1)![1]).toBe(raw.length)
    expect(ranges.every(([start], i) => i === 0 || start === ranges[i - 1]![1])).toBe(true)
    const decoded = ranges.map(([start, end]) =>
      zlib.zstdDecompressSync(raw.subarray(start, end)).toString('utf8'),
    )
    expect(decoded).toEqual(texts)
  })
})

describe('frameRanges · 一帧多块（真实产物里每帧 1～120 块都有）', () => {
  it('按块头的 last 位收帧，两块之间的边界不再靠猜', () => {
    const a = Buffer.from('first block\n', 'utf8')
    const b = Buffer.from('second block\n', 'utf8')
    const block = (size: number, last: number) => {
      const v = last | (0 << 1) | (size << 3) // type=0 Raw：后面直接跟 size 个字节
      return Buffer.from([v & 255, (v >>> 8) & 255, (v >>> 16) & 255])
    }
    const raw = Buffer.concat([
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x04, a.length + b.length]), // desc=0x04：单段、FCS 1 字节、无字典
      block(a.length, 0),
      a,
      block(b.length, 1),
      b,
    ])
    expect(rangesOf(raw)).toEqual([[0, raw.length]])
    expect(zlib.zstdDecompressSync(raw.subarray(0, raw.length)).toString('utf8')).toBe('first block\nsecond block\n')
  })
})

describe('frameRanges · 块类型按各自的块体长度走（设计稿 §4.1 门 1）', () => {
  /** 块头：bit0 last，bit1-2 type，bit3-23 size。 */
  const header = (type: number, size: number, last: number) => {
    const v = last | (type << 1) | (size << 3)
    return Buffer.from([v & 255, (v >>> 8) & 255, (v >>> 16) & 255])
  }
  const WINDOW = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00])

  it('Raw(0) 跟 size 字节、RLE(1) 只跟 1 字节：混在一帧里边界照样准，且对面解出同一句明文', () => {
    const raw = Buffer.concat([WINDOW, header(0, 6, 0), Buffer.from('abc123', 'utf8'), header(1, 3, 1), Buffer.from([0x21])])
    expect(rangesOf(raw)).toEqual([[0, raw.length]])
    // 对面（Node 的解压端）认这帧并解出「6 字节 + 3 个 !」⇒ 块体长度算的是规范那套，不是我们把形状喂给自家解析器。
    expect(zlib.zstdDecompressSync(raw).toString('utf8')).toBe('abc123!!!')
  })

  it('type 3 是规范的 Reserved 位：不照 Raw 那样吞块体，直接抛（Node 对同一帧也是拒解）', () => {
    const raw = Buffer.concat([WINDOW, header(3, 6, 1), Buffer.from('abc123', 'utf8')])
    expect(() => frameRanges(raw)).toThrow(/保留块类型/)
    expect(() => zlib.zstdDecompressSync(raw)).toThrow(/corruption/)
  })
})

describe('frameRanges · 坏输入响亮失败', () => {
  it('块头把块体指向文件之外 ⇒ 抛（而不是在块循环里空转）', () => {
    const blockHeader = Buffer.alloc(3)
    blockHeader.writeUIntLE(0 | (9999 << 3), 0, 3) // last=0, type=0 Raw, 声称块体 9999 字节
    const raw = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x04, 10]), blockHeader, Buffer.from('0123456789')])
    expect(() => frameRanges(raw)).toThrow(/越界/)
  })

  it('最后一帧被截断 ⇒ 抛，说的是第几帧的边界算歪了', () => {
    const raw = glue(false)
    expect(() => frameRanges(raw.subarray(0, raw.length - 3))).toThrow(/帧/)
  })

  it('开头就不是 magic ⇒ 抛', () => {
    expect(() => frameRanges(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/magic/)
  })

  it('空 buffer ⇒ 零帧（不抛；一条记录都没有是合法状态）', () => {
    expect(frameRanges(Buffer.alloc(0))).toEqual([])
  })
})
