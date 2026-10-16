/**
 * 回收站**单条详情**：从回收站目录里那条会话自己的日志读出元信息与正文（设计稿 2026-10-15 §3）。
 *
 * 三层里的策略层——编解码在 `src/log/*`，这里只回答"给谁看、给多少、算不算失败"。
 *
 * 三条硬口径，都不是口味：
 * ① **寻址只认清册**：`entryId` 先在清单里查，目录一律由 `trashDirOf(record.id, home)` 推 ⇒ 外部
 *    输入进不了文件系统寻址（不给"传个路径就读任意目录"留缝）。
 * ② **正文只认 `source.kind === "user"`**：`user/message` 里绝大多数是宿主注入的上下文
 *    （本机实测一条会话：真实提问 21 条、注入 241 条），不过滤就被淹掉；注入条数照样上线
 *    （`injectedCount`），让"为什么少了这么多条"能与页面上的数字对账。
 * ③ **两个闸是载荷闸，不是读盘闸**：每条 3 000 字符、累计 50 万字符（CJK 最坏 ≈ 1.5 MB UTF-8）。
 *    按 §1 的读数本机一条都触发不了（最大那条正文 806 KB ≈ 27 万字符、442 条消息）⇒ 它们是防异常
 *    膨胀的；**不设"文件太大就拒绝"**，那种阈值只会把真读得出来的正文挡在外面。
 *
 * 计数与正文**同源同判据**：`userMessageCount` 就是进了正文的提问条数、`assistantMessageCount` 就是
 * 有文字的回复条数——不是一套判据算两遍，否则页面上会出现"计数 421、正文 200"这种对不上账的话。
 */
import { trashDirOf, type TrashEntry } from './entry.js'
import type { ManifestPort } from './manifest.js'
import type { FsPort } from '../ports/fs-port.js'
import { SESSION_LOG_SUFFIX, walkSessionLog, type SessionRecord } from '../log/session-log.js'
import { verbError } from '../verbs/errors.js'

/** 每条文字的上限（字符）。超出即截断并置 `truncated`。 */
export const PER_MESSAGE_CHAR_CAP = 3_000
/** 一次回信的正文总量上限（字符）。 */
export const TOTAL_CHAR_CAP = 500_000

export interface TrashDetailMessage {
  role: 'user' | 'assistant'
  time: number
  text: string
  truncated: boolean
}

export interface TrashDetail {
  entryId: string
  /** 日志 header 里的原串（**无损**，比从 `projectKey` 反推那一路强，设计稿 §7 组头那条是另一回事）。 */
  cwd: string
  createdAt: number
  lastActivity: number
  /** 日志内 `session/title` 那条记录；清册标题为空串时客户端拿它兜底。 */
  logTitle: string
  models: string[]
  turnCount: number
  userMessageCount: number
  assistantMessageCount: number
  toolCallCount: number
  injectedCount: number
  messages: TrashDetailMessage[]
  omittedByPayloadCap: number
}

export type DetailDeps = { fs: FsPort; manifest: ManifestPort; home: string }

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
    const all = await deps.manifest.list()
    const record: TrashEntry | undefined = all.find((e) => e.id === entryId)
    if (record === undefined) throw verbError('trash-empty', `回收站里没有这一条：${entryId}`)

    const dir = trashDirOf(record.id, deps.home)
    if (!(await deps.fs.exists(dir))) throw verbError('io', `回收站目录不在：${dir}`)
    const names = (await deps.fs.listFiles(dir)).sort()
    const logName = names.find((n) => n.endsWith(SESSION_LOG_SUFFIX))
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
