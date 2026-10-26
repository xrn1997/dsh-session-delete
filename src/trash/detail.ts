/**
 * 回收站**单条详情**：从回收站目录里那条会话自己的日志读出元信息与正文（用例见 `tests/trash-detail.test.ts`）。
 *
 * 三层里的策略层——编解码在 `src/log/*`，这里只回答"给谁看、给多少、算不算失败"。
 *
 * 三条硬口径，都不是口味：
 * ① **寻址只认清册（raw 索引）**：`entryId` 先在对账之外的 raw 索引里查，目录一律由 `trashDirOf(record.id, home)` 推
 *    ⇒ 外部输入进不了文件系统寻址（不给"传个路径就读任意目录"留缝）。
 * ② **正文只认 `source.kind === "user"`**：`user/message` 里绝大多数是宿主注入的上下文
 *    （本机实测一条会话：真实提问 21 条、注入 241 条），不过滤就被淹掉；注入条数照样上线
 *    （`injectedCount`），让"为什么少了这么多条"能与页面上的数字对账。
 * ③ **两个闸是载荷闸，不是读盘闸**：每条 3 000 字符、累计 50 万字符（CJK 最坏 ≈ 1.5 MB UTF-8）。
 *    本机存量一条都触发不了（量级随盘上会话数摆动，不在这里钉数）⇒ 它们是防异常
 *    膨胀的；**不设"文件太大就拒绝"**，那种阈值只会把真读得出来的正文挡在外面。
 *
 * 计数与正文**同源同判据**：`userMessageCount` 就是进了正文的提问条数、`assistantMessageCount` 就是
 * 有文字的回复条数——不是一套判据算两遍，否则页面上会出现"计数 421、正文 200"这种对不上账的话。
 */
import { trashDirOf, type TrashEntry } from './entry.js'
import type { FsPort } from '../ports/fs-port.js'
import type { TrashDetailMessageWire, TrashDetailWire } from '../shared/wire.js'
import { pickSessionLog, walkSessionLog, type SessionRecord } from '../log/session-log.js'
import { verbError } from '../verbs/errors.js'

/** 每条文字的上限（字符）。超出即截断并置 `truncated`。 */
export const PER_MESSAGE_CHAR_CAP = 3_000
/** 一次回信的正文总量上限（字符）。 */
export const TOTAL_CHAR_CAP = 500_000

/** 详情正文里的一条消息 / 整份详情：**线上形状的家在 `shared/wire.ts`**（ADR-0003）——
 *  Node 半产出它，浏览器半按同一份类型消费，这里只留旧名做别名。 */
export type TrashDetailMessage = TrashDetailMessageWire

export type TrashDetail = TrashDetailWire

export type DetailDeps = {
  /** 详情自己直接要的三件（判目录在不在、挑日志、读日志）。对账不在这条路上，所以不需要 `listDirs`。 */
  fs: Pick<FsPort, 'exists' | 'listFiles' | 'readFile'>
  /** 路由交来的清册 **raw 行**：`/detail` 声明为 pure，读一次不能顺手对账——对账会写清册行，那是写动作，
   *  必须排在到达序链上。读面由路由记录选好（`read: 'raw'`），这里只消费行，不再自己挑 `list()` / `raw()`。
   *  代价是有意的：只有目录、清册还没这一行的手工搬入条目读不到（`/list` 对账后可见）。 */
  rows: () => Promise<readonly TrashEntry[]>
  home: string
}

/** 两个载荷闸（可调是为把策略单独验穿；生产走的就是这两个默认值，用例里钉着）。 */
export interface DetailLimits {
  perMessageChars: number
  totalChars: number
}

const DEFAULT_LIMITS: DetailLimits = {
  perMessageChars: PER_MESSAGE_CHAR_CAP,
  totalChars: TOTAL_CHAR_CAP,
}

interface ContentPart {
  type?: string
  text?: string
  name?: string
}

/** 一条记录里那些 `content[]` 段的文字拼起来（`\n` 分隔；非 text 段一律不参与）。 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((part: ContentPart) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: ContentPart) => part.text as string)
    .join('\n')
    .trim()
}

export function readTrashDetail(deps: DetailDeps, limits: DetailLimits = DEFAULT_LIMITS) {
  return async function readTrashDetail(entryId: string): Promise<TrashDetail> {
    const all = await deps.rows()
    const record: TrashEntry | undefined = all.find((e) => e.id === entryId)
    if (record === undefined) throw verbError('trash-empty', `回收站里没有这一条：${entryId}`)

    const dir = trashDirOf(record.id, deps.home)
    if (!(await deps.fs.exists(dir))) throw verbError('io', `回收站目录不在：${dir}`)
    const names = await deps.fs.listFiles(dir)
    const logName = pickSessionLog(names)
    if (logName === undefined) {
      throw verbError('io', `回收站目录里没有会话日志：${dir}（里面有：${names.join(', ') || '空目录'}）`)
    }

    let raw: Buffer
    try {
      raw = await deps.fs.readFile(`${dir}/${logName}`)
    } catch (error) {
      throw verbError('io', `读会话日志失败：${String(error)}`, error)
    }

    const detail: TrashDetail = {
      entryId: record.id, cwd: '', createdAt: 0, lastActivity: 0, logTitle: '', models: [],
      turnCount: 0, userMessageCount: 0, assistantMessageCount: 0, toolCallCount: 0,
      injectedCount: 0, messages: [], omittedByPayloadCap: 0,
    }
    const models = new Set<string>()
    let usedChars = 0
    let capped = false

    /** 收进正文，顺带管两个闸：截到单条上限，累计到总量就停。 */
    function push(role: 'user' | 'assistant', time: number, text: string): void {
      if (capped) {
        detail.omittedByPayloadCap += 1
        return
      }
      const truncated = text.length > limits.perMessageChars
      const kept = truncated ? text.slice(0, limits.perMessageChars) : text
      if (usedChars + kept.length > limits.totalChars) {
        capped = true
        detail.omittedByPayloadCap += 1
        return
      }
      usedChars += kept.length
      detail.messages.push({ role, time, text: kept, truncated })
    }

    // 解压或帧边界一旦不对，**整条判失败**：半截正文比"读不出来"更坏（用户会照着它决定删不删）
    try {
      walkSessionLog(raw, (r: SessionRecord) => {
      if (typeof r.time === 'number' && r.time > detail.lastActivity) detail.lastActivity = r.time
      const data = (r.data ?? {}) as Record<string, unknown>
      switch (r.type) {
        case 'session': {
          // `cwd` / `createdAt` 挂在**记录根**上（实测逐字：`{"type":"session","version":4,"id":…,"createdAt":…,"cwd":"…"}`）
          if (typeof r.cwd === 'string') detail.cwd = r.cwd
          if (typeof r.createdAt === 'number') detail.createdAt = r.createdAt
          return
        }
        case 'session/title': {
          if (typeof data.title === 'string') detail.logTitle = data.title
          return
        }
        case 'turn/start': {
          detail.turnCount += 1
          return
        }
        case 'tool/call': {
          detail.toolCallCount += 1
          return
        }
        case 'user/message': {
          const source = (data.source ?? {}) as Record<string, unknown>
          if (source.kind !== 'user') {
            detail.injectedCount += 1
            return
          }
          const text = textOf(data.content)
          if (text === '') return
          detail.userMessageCount += 1
          push('user', r.time ?? 0, text)
          return
        }
        case 'assistant/message': {
          const message = (data.message ?? {}) as Record<string, unknown>
          const source = (message.source ?? {}) as Record<string, unknown>
          if (typeof source.model === 'string') models.add(source.model)
          const text = textOf(message.content)
          if (text === '') return
          detail.assistantMessageCount += 1
          push('assistant', r.time ?? 0, text)
          return
        }
        default:
          // 其余 type（step/*、compaction/*、deliverables/*、command/*…）一律不参与，也不报错：
          // 宿主日志的词汇表随代次变，认不出来的只增不减（v3 更不必说），认得出多少就摆多少。
          return
      }
      })
    } catch (error) {
      throw verbError('io', error instanceof Error ? `读回收站日志失败：${error.message}` : `读回收站日志失败：${String(error)}`, error)
    }

    detail.models = [...models]
    return detail
  }
}
