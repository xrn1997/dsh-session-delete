/**
 * 回收站**单条详情**：从回收站目录里那条会话自己的日志读出元信息与正文块（用例见 `tests/trash-detail.test.ts`）。
 *
 * 三层里的策略层——编解码在 `src/log/*`，这里只回答"给谁看、给多少、算不算失败"。
 *
 * 四条硬口径，都不是口味：
 * ① **寻址只认清册（raw 索引）**：`entryId` 先在对账之外的 raw 索引里查，目录一律由 `trashDirOf(record.id, home)` 推
 *    ⇒ 外部输入进不了文件系统寻址（不给"传个路径就读任意目录"留缝）。
 * ② **正文是块，不是消息**：`user/message` 按 `source.kind` 拆成 user / injection；`assistant/message.content`
 *    按 `text` / `reasoning` 拆块，附件并进相邻的文字块；`tool/call` 建工具块、`tool/result` 按 `callId` 回填；
 *    `system/message` 与 `compaction/summary` 各成一块。turn/step/job/request 这类簿记事件不进正文——它们不是
 *    "用户想看的对话"，铺进来只会把真正的提问和回复淹掉。
 * ③ **分页是游标，不是总量闸**：一次只回尾部一页，`olderCursor` 指页首；客户端把游标原样回传取更早一页。
 *    页有两道闸：块数 `pageBlocks` 与正文总量 `pageChars`（单块超字符闸仍保留一块，游标才能前进）；
 *    每块另有 `perBlockChars` 的单块闸（正文与工具参数/结果各自算），超了标 `truncated`。
 *    构建时用**有界缓冲只留当前页**，不把整条日志的正文堆在内存里；工具结果可能落在游标之后，
 *    仍会回填到页内那个调用块（别把"已完成"误报成"未完成"）。
 * ④ **计数与正文同源过滤、各过各的闸**：`userMessageCount` / `injectedCount` 只数建了块的；`assistantMessageCount`
 *    数**每一条** assistant/message（含只带 reasoning / tool-call 的）；`toolCallCount` 数每一条 tool/call。
 *    计数是整条日志的，不受分页与任何字符闸影响。
 *
 * 附件随块一起收（`attachmentsInContent`）：每块最多 20、每页最多 200；超出的**静默丢**，不另立计数——
 * "少了几张图"与"这块被截断"不是同一件事，拿一个数兼报会让两个数都对不上。
 */
import { trashDirOf, type TrashEntry } from './entry.js'
import type { FsPort } from '../ports/fs-port.js'
import type {
  TrashDetailAttachmentWire,
  TrashDetailBlockWire,
  TrashDetailInjectionBlockWire,
  TrashDetailTextBlockWire,
  TrashDetailToolBlockWire,
  TrashDetailWire,
} from '../shared/wire.js'
import { pickSessionLog, walkSessionLog, type SessionRecord } from '../log/session-log.js'
import { attachmentsInContent } from './attachments.js'
import { trashEmpty, verbError } from '../verbs/errors.js'

/** 每块文字的上限（字符）。正文、工具参数、工具结果各自吃这一刀。 */
export const PER_BLOCK_CHAR_CAP = 16_000
/** 一页最多多少块。 */
export const PAGE_BLOCK_LIMIT = 30
/** 一页正文的总字符上限（块按日志顺序累计；单块超闸时仍保留一块）。 */
export const PAGE_CHAR_LIMIT = 500_000
/** 一块最多带多少张附件上线。 */
const MAX_ATTACHMENTS_PER_BLOCK = 20
/** 一页最多带多少张附件上线。 */
const MAX_ATTACHMENTS_PER_PAGE = 200

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

/** 三个分页/截断参数（可调是为把策略单独验穿；生产走的就是这三个默认值，用例里钉着）。 */
export interface DetailLimits {
  perBlockChars: number
  pageBlocks: number
  /** 一页正文的总字符闸；缺省 `PAGE_CHAR_LIMIT`。 */
  pageChars?: number
}

const DEFAULT_LIMITS: DetailLimits = {
  perBlockChars: PER_BLOCK_CHAR_CAP,
  pageBlocks: PAGE_BLOCK_LIMIT,
  pageChars: PAGE_CHAR_LIMIT,
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

/** 一条记录的 `content[]` 里的附件块，映射成线上读数（形状只映射，不改判据——闸在 `attachmentsInContent` 里）。 */
function attachmentWires(content: unknown): TrashDetailAttachmentWire[] {
  return attachmentsInContent(content).map((ref) => ({
    attachmentId: ref.id,
    kind: ref.kind,
    ...(ref.name === undefined ? {} : { name: ref.name }),
    // 文件的 `mediaType` / 宽高不是它的读数：按 kind 分开给，别让 file 也带着空壳字段。
    ...(ref.kind === 'image' && ref.mediaType !== undefined ? { mediaType: ref.mediaType } : {}),
    bytes: ref.bytes,
    ...(ref.kind === 'image' && ref.width !== undefined ? { width: ref.width } : {}),
    ...(ref.kind === 'image' && ref.height !== undefined ? { height: ref.height } : {}),
  }))
}

/** 单块闸：超过上限就截一刀并置标记。 */
function clip(text: string, cap: number): { text: string; truncated: boolean } {
  return text.length > cap ? { text: text.slice(0, cap), truncated: true } : { text, truncated: false }
}

/** 「这块有没有内容」的**唯一判据**：非空正文或至少一个附件。建块（`blockBody`）与出线收尾
 *  （`PageBuilder.finish` 的附件总量闸之后）都认这一支——判据写两遍就是两份会漂移的抄本，
 *  渲染侧因此不必、也不许再兜空块。 */
function hasContent(text: string, attachments: readonly TrashDetailAttachmentWire[]): boolean {
  return text !== '' || attachments.length > 0
}

/** 一块的正文：没内容 ⇒ 这块不建；否则过单块闸截一刀。 */
function blockBody(
  rawText: string,
  attachments: TrashDetailAttachmentWire[],
  cap: number,
): { text: string; truncated: boolean; attachments: TrashDetailAttachmentWire[] } | undefined {
  const text = rawText.trim()
  const kept = attachments.slice(0, MAX_ATTACHMENTS_PER_BLOCK)
  if (!hasContent(text, kept)) return undefined
  const clipped = clip(text, cap)
  return { text: clipped.text, truncated: clipped.truncated, attachments: kept }
}

function textBlock(
  kind: TrashDetailTextBlockWire['kind'],
  time: number,
  rawText: string,
  attachments: TrashDetailAttachmentWire[],
  cap: number,
): TrashDetailTextBlockWire | undefined {
  const body = blockBody(rawText, attachments, cap)
  return body === undefined ? undefined : { kind, id: '', time, ...body }
}

function injectionBlock(
  time: number,
  sourceKind: string,
  rawText: string,
  attachments: TrashDetailAttachmentWire[],
  cap: number,
): TrashDetailInjectionBlockWire | undefined {
  const body = blockBody(rawText, attachments, cap)
  return body === undefined ? undefined : { kind: 'injection', id: '', time, sourceKind, ...body }
}

/** 一块在页级字符闸里占多少字符：正文与工具参数/结果都算；截断标记与附件元数据不计。 */
function blockChars(block: TrashDetailBlockWire): number {
  switch (block.kind) {
    case 'tool': return block.args.length + block.result.length
    case 'user':
    case 'assistant':
    case 'reasoning':
    case 'injection':
    case 'system':
    case 'compaction':
      return block.text.length
    default:
      return unhandledChars(block)
  }
}

/** 新块类型没登记字符口径时编译失败；运行时（前后半版本错配）按 0 计。 */
function unhandledChars(block: never): 0 {
  void block
  return 0
}

/**
 * 一页的有界缓冲：只留游标之前**最后** `pageBlocks` 块，且正文总量不超过 `pageChars`。
 *
 * `nextIndex` 数的是整条日志的块序（包括游标之后的块），`buffer` 只装本页。工具结果可能落在
 * 游标之后：`toolByCallId` 让它在页内那个调用块上回填。
 *
 * 配对认的是**块对象**，不是 callId 这一格：宿主重试会让同一个 callId 建出两块，按 callId 摘映射
 * 会把仍然在页内的另一块误摘成「未完成」——ADR-0026 决定 3 明令不许。所以每个 callId 挂一串页内
 * 块（按日志顺序），挤出谁就摘谁。本机回收站与 live 日志实测：callId 与结果一比一、无重复、无逆序，
 * 这一串常态只有一个元素；串与下面的配法是给非常态兜底的。
 */
class PageBuilder {
  private readonly buffer: Array<{ index: number; block: TrashDetailBlockWire; chars: number }> = []
  private readonly toolByCallId = new Map<string, TrashDetailToolBlockWire[]>()
  private nextIndex = 0
  private chars = 0

  /** `end` 是本页的右边界（不含）：块序号大于等于它的不入页；`Infinity` = 从尾部取。 */
  constructor(
    private readonly end: number,
    private readonly limit: number,
    private readonly cap: number,
    private readonly pageChars: number,
  ) {}

  /** 追加一块：id 用整条日志的块序号盖，页内只留最后 `limit` 块 / `pageChars` 字符。 */
  add(block: TrashDetailBlockWire): void {
    const index = this.nextIndex++
    if (index >= this.end) return
    block.id = String(index)
    const chars = blockChars(block)
    this.buffer.push({ index, block, chars })
    this.chars += chars
    this.trim()
    if (block.kind === 'tool') this.hook(block)
  }

  /** 挤出页首：块数超限，或正文超字符闸（但至少留一块，游标才能前进）。 */
  private trim(): void {
    while (this.buffer.length > this.limit || (this.buffer.length > 1 && this.chars > this.pageChars)) {
      const evicted = this.buffer.shift()
      if (evicted === undefined) return
      this.chars -= evicted.chars
      if (evicted.block.kind === 'tool') this.unhook(evicted.block)
    }
  }

  /** 没带 callId 的调用块无从配对：照常入页（界面念「未完成」），只是不进配对串。 */
  private static pairable(block: TrashDetailToolBlockWire): boolean {
    return block.callId !== ''
  }

  private hook(block: TrashDetailToolBlockWire): void {
    if (!PageBuilder.pairable(block)) return
    const queued = this.toolByCallId.get(block.callId)
    if (queued === undefined) this.toolByCallId.set(block.callId, [block])
    else queued.push(block)
  }

  /** 挤出页的块从它的配对串里按对象摘掉；串空了连 key 一起摘，不留空串。 */
  private unhook(block: TrashDetailToolBlockWire): void {
    if (!PageBuilder.pairable(block)) return
    const queued = this.toolByCallId.get(block.callId)
    if (queued === undefined) return
    const at = queued.indexOf(block)
    if (at < 0) return
    if (queued.length === 1) this.toolByCallId.delete(block.callId)
    else queued.splice(at, 1)
  }

  /**
   * `tool/result` 回填：配给这一串里**最早那还没有结果**的调用块（同一个 callId 出两块时，结果按
   * 到达顺序配给先出的调用，两块各留一个读数）。
   *
   * 两种情况落不了点，都不改写已经配上结果的块：调用块在更早的页里（那一页自己走一趟时配上）；
   * 结果条数多过页内待配的调用块（一次调用一个读数，后到的不覆盖先配上的）。口径见
   * `tests/trash-detail.test.ts` 的工具配对那几例。
   *
   * 落不了点就丢，不缓存：日志按时间落盘、结果恒在它的调用之后，逆序时这条结果无家可归、块停在
   * 未完成——为它把游标之后的结果正文留在手里，就拆掉了「只留当前页」这个内存界（ADR-0026 决定 3）。
   *
   * 同一 callId 的前一块已被挤出页时，结果会配给页内后一块，后一块自己的结果随之落空：宿主重试
   * 造出的双块没有可区分的结果序，宁可配对错位也不把仍在页内的块报成「未完成」。这是非常态兜底的
   * 代价，不另开缓存去修（那会重新把游标之后的正文留在手里）。
   *
   * 回填的正文也要计入页级字符闸：超了就挤页首，被挤掉的调用块会随更早一页重新走一遍日志、
   * 在那一页里配上同一个结果，不会丢成「未完成」。
   */
  result(callId: string, rawResult: string, isError: boolean, attachments: TrashDetailAttachmentWire[]): void {
    const queued = this.toolByCallId.get(callId)
    if (queued === undefined) return
    const block = queued.find((candidate) => candidate.status === 'unfinished')
    if (block === undefined) return
    const clipped = clip(rawResult.trim(), this.cap)
    block.result = clipped.text
    block.resultTruncated = clipped.truncated
    block.status = isError ? 'error' : 'ok'
    block.attachments = attachments.slice(0, MAX_ATTACHMENTS_PER_BLOCK)
    const entry = this.buffer.find((candidate) => candidate.block === block)
    if (entry !== undefined) {
      const chars = blockChars(block)
      this.chars += chars - entry.chars
      entry.chars = chars
      this.trim()
    }
  }

  finish(): { blocks: TrashDetailBlockWire[]; olderCursor: number | null } {
    // 附件总量闸在页落定后再切：按页内顺序留前 200 张。被挤出页的块不在 buffer 里，
    // 不占这一页的额度。
    let used = 0
    for (const { block } of this.buffer) {
      const room = Math.max(0, Math.min(block.attachments.length, MAX_ATTACHMENTS_PER_PAGE - used))
      block.attachments = block.attachments.slice(0, room)
      used += room
    }
    // 闸可能把纯附件块挤成没内容的空块（正文本来就空）：整块不出线——判据与建块同一支
    // （`hasContent`），出线口是它的第二个调用点，不是第二份判据。工具块豁免：名字与状态
    // 就是内容，没正文的「未完成」也要看得见。游标仍指页首那块的序号：被收掉的空块没有
    // 内容可丢，更早一页从它的序号之前继续取，不重不漏。
    const first = this.buffer[0]
    return {
      blocks: this.buffer
        .map(({ block }) => block)
        .filter((block) => block.kind === 'tool' || hasContent(block.text, block.attachments)),
      olderCursor: first !== undefined && first.index > 0 ? first.index : null,
    }
  }
}

export function readTrashDetail(deps: DetailDeps, limits: DetailLimits = DEFAULT_LIMITS) {
  return async function readTrashDetail(entryId: string, before?: number): Promise<TrashDetail> {
    const all = await deps.rows()
    const record: TrashEntry | undefined = all.find((e) => e.id === entryId)
    if (record === undefined) throw trashEmpty(entryId)

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
      injectedCount: 0, blocks: [], olderCursor: null,
    }
    const models = new Set<string>()
    // 游标的合法性（非负整数）只在契约那一处判（`src/api/route-table.ts` 的 `optionalCursor` ⇒ 400）；
    // 这里再兜一层就是同一判据的第二份抄本。
    const end = before ?? Number.POSITIVE_INFINITY
    const page = new PageBuilder(
      end,
      Math.max(1, limits.pageBlocks),
      limits.perBlockChars,
      Math.max(1, limits.pageChars ?? PAGE_CHAR_LIMIT),
    )

    // 解压或帧边界一旦不对，**整条判失败**：半截正文比"读不出来"更坏（用户会照着它决定删不删）
    try {
      walkSessionLog(raw, (r: SessionRecord) => {
        if (typeof r.time === 'number' && r.time > detail.lastActivity) detail.lastActivity = r.time
        const data = (r.data ?? {}) as Record<string, unknown>
        const time = r.time ?? 0
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
          case 'user/message': {
            const source = (data.source ?? {}) as Record<string, unknown>
            // `source.kind` 原样过线（缺席就是空串），标签由界面映射：这里不自造哨兵值。
            const sourceKind = typeof source.kind === 'string' ? source.kind : ''
            const text = textOf(data.content)
            const attachments = attachmentWires(data.content)
            if (sourceKind === 'user') {
              const block = textBlock('user', time, text, attachments, limits.perBlockChars)
              if (block !== undefined) {
                detail.userMessageCount += 1
                page.add(block)
              }
              return
            }
            const block = injectionBlock(time, sourceKind, text, attachments, limits.perBlockChars)
            if (block !== undefined) {
              detail.injectedCount += 1
              page.add(block)
            }
            return
          }
          case 'assistant/message': {
            // 每一条 assistant/message 都算；正文块可能一条都没有（只带 tool-call 的那种）。
            detail.assistantMessageCount += 1
            const message = (data.message ?? {}) as Record<string, unknown>
            const source = (message.source ?? {}) as Record<string, unknown>
            if (typeof source.model === 'string') models.add(source.model)
            const parts = Array.isArray(message.content) ? (message.content as ContentPart[]) : []
            let pendingText: string[] = []
            let pendingAttachments: TrashDetailAttachmentWire[] = []
            const flush = (): void => {
              const block = textBlock('assistant', time, pendingText.join('\n'), pendingAttachments, limits.perBlockChars)
              if (block !== undefined) page.add(block)
              pendingText = []
              pendingAttachments = []
            }
            for (const part of parts) {
              if (part?.type === 'text' && typeof part.text === 'string') {
                pendingText.push(part.text)
                continue
              }
              if (part?.type === 'reasoning' && typeof part.text === 'string') {
                flush()
                const block = textBlock('reasoning', time, part.text, [], limits.perBlockChars)
                if (block !== undefined) page.add(block)
                continue
              }
              if (part?.type === 'image' || part?.type === 'file') {
                pendingAttachments.push(...attachmentWires([part]))
                continue
              }
              // tool-call 段不在这里建块：工具行由 `tool/call` 建，结果由 `tool/result` 回填。
            }
            flush()
            return
          }
          case 'tool/call': {
            detail.toolCallCount += 1
            const callId = typeof data.callId === 'string' ? data.callId : ''
            const name = typeof data.name === 'string' ? data.name : ''
            // 真实日志里 `arguments` 是 JSON 字符串；不认对象形态，别把未知形状硬编码成 [object Object]。
            const args = clip(typeof data.arguments === 'string' ? data.arguments : '', limits.perBlockChars)
            page.add({
              kind: 'tool', id: '', time, callId, name, status: 'unfinished',
              args: args.text, argsTruncated: args.truncated,
              result: '', resultTruncated: false, attachments: [],
            })
            return
          }
          case 'tool/result': {
            const message = (data.message ?? {}) as Record<string, unknown>
            const callId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
            if (callId === '') return
            page.result(callId, textOf(message.content), message.isError === true, attachmentWires(message.content))
            return
          }
          case 'system/message': {
            const message = (data.message ?? {}) as Record<string, unknown>
            const block = textBlock('system', time, textOf(message.content), attachmentWires(message.content), limits.perBlockChars)
            if (block !== undefined) page.add(block)
            return
          }
          case 'compaction/summary': {
            const block = textBlock('compaction', time, textOf(data.summary), [], limits.perBlockChars)
            if (block !== undefined) page.add(block)
            return
          }
          default:
            // 其余 type（step/*、job/*、request/*、permission/*、deliverables/*…）一律不参与，也不报错：
            // 宿主日志的词汇表随代次变，认不出来的只增不减，认得出多少就摆多少。
            return
        }
      })
    } catch (error) {
      throw verbError('io', error instanceof Error ? `读回收站日志失败：${error.message}` : `读回收站日志失败：${String(error)}`, error)
    }

    const finished = page.finish()
    detail.blocks = finished.blocks
    detail.olderCursor = finished.olderCursor
    detail.models = [...models]
    return detail
  }
}
