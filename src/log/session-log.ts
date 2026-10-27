/**
 * 会话日志（`session.vN.jsonl.zstd`）的**逐帧读法**：帧边界交给 `zstd-frames.ts`，这一层只做
 * 「帧 → 明文 → 一行一条 JSON」的解码，并把每条记录原样交给回调。
 *
 * **策略不在这里**（哪些 `type` 算正文、截断到多少字、算不算失败）——那是 `src/trash/detail.ts` 的事。
 * 这一层只懂编解码，所以它能被单独验穿。
 *
 * 两条实测决定的口径：
 * ① **必须逐帧**：Node 的 `zstdDecompressSync` 与 `createZstdDecompress()` 都只给第一帧（见
 *    `zstd-frames.ts` 头注）；明文留在手里会一次装下整条日志（本机 125 条合计 280.7 MB），
 *    所以**一帧一帧解、解完就撒手**，内存口径是"最大那一帧的明文"（实测 8.99 MB）而不是整条。
 * ② **一行的余量跨帧带走**：写作侧一条条 append，帧边界不保证落在行边界；逐帧 split('\n') 会静默少一条
 *    记录（半个头加半个身，两半都解不开 JSON）。带上余量后跨帧的多字节字符也解对了——拼接在字节层做，
 *    toString('utf8') 只看整行。真被切断的尾巴（写一半）跳过并计数，绝不因为一行就抛整个读数。
 */
import zlib from 'node:zlib'
import { frameRanges } from './zstd-frames.js'

/** 一行 JSONL 的最小面：`type` / `time` 之外都留在 `data`（或记录根）上，由调用方按 `type` 自己判。 */
export interface SessionRecord {
  type?: string
  time?: number
  /** `session` 那一行把这三个成员挂在**记录根**上（实测逐字：`{"type":"session","version":4,"id":…,"createdAt":…,"cwd":"…"}`），所以这里镜像出来。 */
  id?: string
  createdAt?: number
  cwd?: string
  data?: unknown
}

export interface SessionLogStats {
  frames: number
  records: number
  /** 解不开 JSON 的行数（多半就是被切的那半行）。 */
  unparsedLines: number
  /** 整条日志最后一个换行之后的字节数（>0 说明尾巴被切了一刀）。 */
  truncatedTailBytes: number
}

const NEWLINE = 0x0a

/**
 * 宿主给每一代日志的词法（逐字取自 `@deepseek-ai/dsh-session-format@0.2.0-rc.2` 的
 * `CANONICAL_LOG_FILENAME`，剥掉压缩后缀那段由我们自己在正则里补上 `.zstd`）：
 * 裸名 `session.jsonl` 是**第 0 代**，往后是 `session.vN`；`.v0`、前导零、大写、临时名都不是规范名。
 */
const CANONICAL_ZSTD_LOG = /^session(?:\.v([1-9][0-9]*))?\.jsonl\.zstd$/u

/** 这个名字是不是规范日志（任意一代）。附件引用扫描用它区分"老一代日志"与"读不懂的旁文件"。 */
export function isCanonicalSessionLogName(name: string): boolean {
  return CANONICAL_ZSTD_LOG.test(name)
}

/**
 * 同一个会话目录里可以并存多代日志；只读版本号最大的那代，因为新代包含旧代的记录且末尾更晚
 * ⇒ 读旧代 = 一份截了尾巴的快照；把几代拼起来 = 重复计数。
 *
 * 明文（无 `.zstd`）不在此列：本插件的读法逐帧解 zstd，明文得走另一条解码路。
 */
export function pickSessionLog(names: readonly string[]): string | undefined {
  let best: string | undefined
  let bestVersion = -1
  for (const name of names) {
    const match = CANONICAL_ZSTD_LOG.exec(name)
    if (match === null) continue
    const version = match[1] === undefined ? 0 : Number(match[1])
    if (version > bestVersion) {
      bestVersion = version
      best = name
    }
  }
  return best
}

/**
 * 逐帧走一遍日志，每条记录交给回调。
 *
 * 回调返回 `false` = **提前停机**（后面的帧不再解——`readSessionHeader` 只要第一行）。
 * 停机后 `stats` 只是停机前那部分，别拿来做全量对账。
 */
export function walkSessionLog(raw: Buffer, onRecord: (record: SessionRecord) => void | false): SessionLogStats {
  const stats: SessionLogStats = { frames: 0, records: 0, unparsedLines: 0, truncatedTailBytes: 0 }
  let stopped = false
  const feed = (line: string): void => {
    if (line === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      stats.unparsedLines += 1
      return
    }
    stats.records += 1
    if (onRecord(parsed !== null && typeof parsed === 'object' ? (parsed as SessionRecord) : {}) === false) {
      stopped = true
    }
  }

  /** 上一帧没闭合的那一行。**存字节不存字符**：切在多字节字符中间的帧要拼回完整才解得对。 */
  let carry: Buffer = Buffer.alloc(0)
  for (const { start, end } of frameRanges(raw)) {
    if (stopped) break
    stats.frames += 1
    let plain: Buffer
    try {
      plain = zlib.zstdDecompressSync(raw.subarray(start, end))
    } catch (error) {
      throw new Error(`回收站日志第 ${stats.frames} 帧解压失败：${String(error)}`)
    }
    const merged = carry.length === 0 ? plain : Buffer.concat([carry, plain])
    const cut = merged.lastIndexOf(NEWLINE)
    if (cut === -1) {
      carry = merged
      continue
    }
    carry = merged.subarray(cut + 1)
    for (const line of merged.subarray(0, cut).toString('utf8').split('\n')) {
      feed(line)
      if (stopped) break
    }
  }

  stats.truncatedTailBytes = carry.length
  if (carry.length > 0 && !stopped) feed(carry.toString('utf8'))
  return stats
}

/**
 * 日志的 **header**：格式事实是"第一行即 header"（`type: 'session'`，含 `id` 与 `cwd`，v3/v4 均如此，
 * AGENTS.md 有实测背书）——这里按 `type === 'session'` 找**第一条**这样的记录并就地停机
 * （不要求它恰是第一个可解析行：坏一行前缀不该让整条日志判不出身份）。
 * 找不到（空日志 / 全是别种记录）回 `undefined`；帧坏了照抛——那是"读不出来"，与"没有 header"是两件事。
 */
export function readSessionHeader(raw: Buffer): SessionRecord | undefined {
  let header: SessionRecord | undefined
  walkSessionLog(raw, (record) => {
    if (record.type !== 'session') return
    header = record
    return false
  })
  return header
}
