/**
 * 会话日志（`session.vN.jsonl.zstd`）的**逐帧读法**：帧边界交给 `zstd-frames.ts`，这一层只解码。
 * **必须逐帧**：整条日志没有宿主上限，明文不能整本驻留；帧边界不保证落在行边界，下一行的余量按**字节**跨帧带走，
 * 写一半的尾巴跳过并计数。策略（哪些 `type` 算正文、截断多少）不在这里，住 `src/trash/detail.ts`。
 */
import zlib from 'node:zlib'
import type { FsPort } from '../ports/fs-port.js'
import { frameRanges } from './zstd-frames.js'

/** 一行 JSONL 的最小面：`type` / `time` 之外都留在 `data`（或记录根）上，由调用方按 `type` 自己判。 */
export interface SessionRecord {
  type?: string
  time?: number
  /** `session` 那一行把这三个成员挂在**记录根**上（不是 `data` 里），所以这里镜像出来。 */
  id?: string
  createdAt?: number
  cwd?: string
  /** `session` 头里的父会话（fork / subagent 子会话才有）；显示名兜底用它认「这是一条子会话」。 */
  parentSession?: string
  data?: unknown
}

export interface SessionLogStats {
  frames: number
  records: number
  /** 解不开 JSON 的行数（多半就是被切的那半行）。 */
  unparsedLines: number
  /** 整条日志最后一个换行之后的字节数。尾巴缺换行的**完整**记录仍会喂给回调（详情读得到），
   *  但这格有数就会让 `trash/attachments.ts` 的引用扫描判整本损坏、整目录跳过（fail closed，附件红线）。
   *  宿主写盘的行尾约定确认之前不放松这条：约定若是每条记录都带尾换行，这格只在真截断时有数，
   *  完整末行的双口径不会出现。行为由 `tests/session-log.test.ts` 的「完整末行无尾换行」用例钉住。 */
  truncatedTailBytes: number
}

const NEWLINE = 0x0a

/**
 * 单条会话日志**整本读取**的显式上限（256 MiB）：`readFile` 没有宿主上限，坏文件 / 巨型工具输出能撑到任意大，
 * 超过就按**读不出**处理——不截断、不猜。取值只住这一处；对应物是 `readFileHead` 那种有界头读。
 */
export const MAX_SESSION_LOG_BYTES = 256 * 1024 * 1024

/** 一条会话日志**整本**的读取结果。判别联合：调用方只映射落点，不必自己记得「先 stat 再 read」。 */
export type WholeSessionLogRead =
  | { readonly ok: true; readonly raw: Buffer }
  /** 超过 {@link MAX_SESSION_LOG_BYTES}：`size` 是 stat 读到的字节数；**一个字节都没读**。 */
  | { readonly ok: false; readonly kind: 'too-large'; readonly size: number }
  /** stat 或 read 抛错；`stage` 区分是哪一步（详情两条原文不同，引用扫描同判「读不出」）。 */
  | { readonly ok: false; readonly kind: 'unreadable'; readonly stage: 'stat' | 'read'; readonly cause: unknown }

/**
 * 会话日志整本读取的**唯一入口**：先 `statFile`、比上限、再 `readFile`——绕过它直接读会把一份没有宿主上限的日志整本压进内存。
 * 读错误**不折成缺席**（ADR-0039）：抛出原样进 `unreadable` 的 `cause`，由调用方按自己的落点翻译；上限**等于**时仍照常读。
 */
export async function readWholeSessionLog(
  fs: Pick<FsPort, 'statFile' | 'readFile'>,
  path: string,
): Promise<WholeSessionLogRead> {
  let size: number
  try {
    size = (await fs.statFile(path)).size
  } catch (cause) {
    return { ok: false, kind: 'unreadable', stage: 'stat', cause }
  }
  if (size > MAX_SESSION_LOG_BYTES) return { ok: false, kind: 'too-large', size }
  try {
    return { ok: true, raw: await fs.readFile(path) }
  } catch (cause) {
    return { ok: false, kind: 'unreadable', stage: 'read', cause }
  }
}

/**
 * 宿主给每一代日志的词法（取自 `@deepseek-ai/dsh-session-format@0.2.0-rc.2` 的 `CANONICAL_LOG_FILENAME`，`.zstd` 由本仓补）：
 * 裸名 `session.jsonl` 是**第 0 代**，往后是 `session.vN`；`.v0`、前导零、大写、临时名都不是规范名。
 */
const CANONICAL_ZSTD_LOG = /^session(?:\.v([1-9][0-9]*))?\.jsonl\.zstd$/u

/** 这个名字是不是规范日志（任意一代）。附件引用扫描用它区分"老一代日志"与"读不懂的旁文件"。 */
export function isCanonicalSessionLogName(name: string): boolean {
  return CANONICAL_ZSTD_LOG.test(name)
}

/**
 * 同一个会话目录里可以并存多代日志；只读版本号最大的那代（新代含旧代记录且更晚）：读旧代 = 截尾快照，拼接 = 重复计数。
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
 * 逐帧走一遍日志，每条记录交给回调。回调返回 `false` = **提前停机**；停机后 `stats` 只是停机前那部分，别拿来做全量对账。
 * `tolerateTruncatedTail` 只给**前缀读**用（尾巴切在帧中间时丢掉不完整的那一帧）；读整本的调用方不传——截断必须响亮失败。
 */
export function walkSessionLog(
  raw: Buffer,
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- 回调契约是「不关心返回值 / 返回 false 停机」：`void | false` 是它的准确形状，改成 boolean 会逼所有回调显式 return。
  onRecord: (record: SessionRecord) => void | false,
  options: { readonly tolerateTruncatedTail?: boolean } = {},
): SessionLogStats {
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
    if (onRecord(parsed !== null && typeof parsed === 'object' ? parsed : {}) === false) {
      stopped = true
    }
  }

  /** 上一帧没闭合的那一行。**存字节不存字符**：切在多字节字符中间的帧要拼回完整才解得对。 */
  let carry: Buffer = Buffer.alloc(0)
  for (const { start, end } of frameRanges(raw, options)) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `stopped` 由 `feed` 的闭包写入，TS 看不见闭包写入；删掉会让停机后的帧继续解。
    if (stopped) break
    stats.frames += 1
    let plain: Buffer
    try {
      plain = zlib.zstdDecompressSync(raw.subarray(start, end))
    } catch (error) {
      throw new Error(`回收站日志第 ${stats.frames} 帧解压失败：${String(error)}`, { cause: error })
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
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `stopped` 由闭包 `feed` 写入，TS 看不见；删了会把停机后的尾巴当整行继续喂。
      if (stopped) break
    }
  }

  stats.truncatedTailBytes = carry.length
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 同上：`stopped` 是闭包写入的停机信号，不能让未换行的尾巴在停机后再进回调。
  if (carry.length > 0 && !stopped) feed(carry.toString('utf8'))
  return stats
}

/**
 * 日志的 **header**：第一行即 header（`type: 'session'`，含 `id` 与 `cwd`）。实测逐字：
 * `{"type":"session","version":4,"id":…,"createdAt":…,"cwd":"…"}`。按 `type` 找**第一条**并停机——
 * 坏一行前缀不该让整条日志判不出身份；找不到回 `undefined`，帧坏了照抛（读不出来 ≠ 没有 header）。
 */
export function readSessionHeader(
  raw: Buffer,
  options: { readonly tolerateTruncatedTail?: boolean } = {},
): SessionRecord | undefined {
  let header: SessionRecord | undefined
  walkSessionLog(raw, (record) => {
    if (record.type !== 'session') return
    header = record
    return false
  }, options)
  return header
}
