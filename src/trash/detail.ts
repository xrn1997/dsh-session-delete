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
import { entryWire, trashDirOf, type TrashEntry } from './entry.js'
import type { FsDetailPort } from '../ports/fs-port.js'
import { bareSessionId } from '../domain/closure.js'
import type {
  SessionDetailWire,
  TrashDetailAttachmentWire,
  TrashDetailBlockWire,
  TrashDetailInjectionBlockWire,
  TrashDetailPromptWire,
  TrashDetailTextBlockWire,
  TrashDetailToolBlockWire,
  TrashDetailWire,
  TrashEntryWire,
} from '../shared/wire.js'
import { pickSessionLog, walkSessionLog, type SessionRecord } from '../log/session-log.js'
import { descriptorLabelOf, displayNameOfLog } from './display-name.js'
import { attachmentsInContent } from './attachments.js'
import { visibleGroups } from './groups.js'
import { trashEmpty, verbError } from '../verbs/errors.js'

/** 每块文字的上限（字符）。正文、工具参数、工具结果各自吃这一刀。 */
export const PER_BLOCK_CHAR_CAP = 16_000
/** 一页最多多少块。 */
export const PAGE_BLOCK_LIMIT = 30
/** 一页正文的总字符上限（块按日志顺序累计；单块超闸时仍保留一块）。 */
export const PAGE_CHAR_LIMIT = 500_000
/** 提问轨预览的字符上限：它是导航标签，不是正文的第二份抄本。 */
export const PROMPT_PREVIEW_LIMIT = 80
/** 一块最多带多少张附件上线。 */
const MAX_ATTACHMENTS_PER_BLOCK = 20
/** 一页最多带多少张附件上线。 */
const MAX_ATTACHMENTS_PER_PAGE = 200
/** 子会话摘要最多列多少条；超出时只过线前 N 条，总数另走 `subagentsTotal`。 */
export const SUBAGENT_SUMMARY_LIMIT = 200

export type TrashDetail = TrashDetailWire

export type DetailDeps = {
  /** 详情自己直接要的三件（判目录在不在、挑日志、读日志）。对账不在这条路上，所以不需要 `listDirs`。 */
  fs: FsDetailPort
  /** 路由交来的清册 **raw 行**：`/detail` 声明为 pure，读一次不能顺手对账——对账会写清册行，那是写动作，
   *  必须排在到达序链上。读面由路由记录选好（`read: 'raw'`），这里只消费行，不再自己挑 `list()` / `raw()`。
   *  代价是有意的：只有目录、清册还没这一行的手工搬入条目读不到（`/list` 对账后可见）。 */
  rows: () => Promise<readonly TrashEntry[]>
  home: string
}

/** 四个分页/截断参数（可调是为把策略单独验穿；生产走的就是这四个默认值，用例里钉着）。 */
export interface DetailLimits {
  perBlockChars: number
  pageBlocks: number
  /** 一页正文的总字符闸；缺省 `PAGE_CHAR_LIMIT`。 */
  pageChars?: number
  /** 子会话摘要的条数闸；缺省 `SUBAGENT_SUMMARY_LIMIT`。 */
  subagents?: number
}

const DEFAULT_LIMITS: DetailLimits = {
  perBlockChars: PER_BLOCK_CHAR_CAP,
  pageBlocks: PAGE_BLOCK_LIMIT,
  pageChars: PAGE_CHAR_LIMIT,
  subagents: SUBAGENT_SUMMARY_LIMIT,
}

interface ContentPart {
  type?: string
  text?: string
  name?: string
}

/** 一条记录里那些 `content[]` 段的文字拼起来（`\n` 分隔；非 text 段一律不参与）。 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  // 过线 JSON 的数组元素可能是 null（镜像说 `ContentPart`，运行时未必）：按真实形状声明后，
  // 下面的 `part?.` 才是必要的，也才有资格把"是 text 且有字符串 text"收成谓词。
  return (content as Array<ContentPart | null>)
    .filter((part): part is ContentPart & { text: string } => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
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

/** 提问索引的预览：空白折叠、超长带省略号。Markdown 记号不清——这是标签，读者要能一眼认出原句。
 *
 *  **按码点截断**，不按 UTF-16 码元：`slice` 会把代理对（emoji 等）切成孤立的一半，过线后
 *  显示成替换字符——预览是读者认出这一句的唯一线索，不该在这里坏掉。 */
function promptPreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(normalized)
  if (chars.length <= PROMPT_PREVIEW_LIMIT) return normalized
  return `${chars.slice(0, PROMPT_PREVIEW_LIMIT - 1).join('').trimEnd()}…`
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
  private readonly end: number
  private readonly limit: number
  private readonly cap: number
  private readonly pageChars: number

  constructor(end: number, limit: number, cap: number, pageChars: number) {
    this.end = end
    this.limit = limit
    this.cap = cap
    this.pageChars = pageChars
  }

  /** 追加一块并回它在整条日志里的序号：id 用这个序号盖，页内只留最后 `limit` 块 / `pageChars` 字符。
   *  返回值**不管这块进没进页**都给（提问索引要拿它当游标），所以调用方不能拿返回值为空当"没入页"。 */
  add(block: TrashDetailBlockWire): string {
    const index = this.nextIndex++
    if (index < this.end) {
      block.id = String(index)
      const chars = blockChars(block)
      this.buffer.push({ index, block, chars })
      this.chars += chars
      this.trim()
      if (block.kind === 'tool') this.hook(block)
    }
    return String(index)
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

/**
 * 一条孩子的**自己日志**里的显示名：descriptor label 优先，其次最后一条 `session/title`。
 * 只给父详情里没有 catalog 登记、标题又撞名的 fork 孩子用（它们没有 label，清册标题是删除时的
 * 快照）；读不出就返回 `undefined`，绝不让父详情失败——看不见那个名字比整条详情打不开轻。
 */
async function childDisplayNameOf(deps: DetailDeps, entry: TrashEntry): Promise<string | undefined> {
  try {
    const dir = trashDirOf(entry.id, deps.home)
    const logName = pickSessionLog(await deps.fs.listFiles(dir))
    if (logName === undefined) return undefined
    const { label, title } = displayNameOfLog(await deps.fs.readFile(`${dir}/${logName}`))
    return label !== '' ? label : title !== '' ? title : undefined
  } catch {
    return undefined
  }
}

/**
 * 逐记录折叠详情基座：块 / 分页 / 计数 / label / 提问索引的**唯一实现**——回收站与归档两档共用
 * （`readTrashDetail` 从 raw JSONL 喂它，`readArchiveDetail` 从 `readSession` 的事件流喂它）。
 * 策略判据（②③④，见文件头注）全在这一处；喂进来的 `session` 头记录可以是合成的
 * （归档读路把 `readSession` 的 header 拼成 raw 里同形的那一条，`case 'session'` 因此两档通吃）。
 * `subagent/catalog` 不在这里：孩子显示名的登记只服务回收站子会话段，归 `readTrashDetail` 的 walk 拦截。
 */
export interface DetailFold {
  /** 喂一条记录（含合成的 `session` 头；顺序 = 日志顺序）。 */
  add(record: SessionRecord): void
  /** 收尾：分页裁剪、models、label、提问索引（只在构造时 `before` 缺席才带上）。 */
  finish(): SessionDetailWire
}

/**
 * 折叠核心的工厂。**`before` 在构造时给**：它决定分页窗口的右边界（`PageBuilder.end`），
 * 只在收尾才说就晚了——所以 `finish` 不再收参数。
 */
export function createDetailFold(limits: DetailLimits = DEFAULT_LIMITS, before?: number): DetailFold {
  const detail: SessionDetailWire = {
    cwd: '', createdAt: 0, lastActivity: 0, logTitle: '', models: [],
    turnCount: 0, userMessageCount: 0, assistantMessageCount: 0, toolCallCount: 0,
    injectedCount: 0, blocks: [], olderCursor: null,
  }
  const models = new Set<string>()
  /** 这条会话**自己**的 descriptor label（独立子会话没有父日志可查时的兜底）。
   *  与宿主 `subagent` 投影同一语义：每遇一条 descriptor 就覆盖，空 label 重置——fork 种子里的
   *  祖先 descriptor 必须被子会话自己的那条覆盖，坏/空的后写不保留祖先的名字。 */
  let ownLabel = ''
  /** 这条会话的 header 带 `parentSession`：它是子会话（fork / subagent），自己的日志标题才是
   *  当前名字；主会话没有这一格，仍按清册快照优先。 */
  let ownParentSession = false
  /** 整条会话的提问索引：与分页无关，只在首次读时过线（见 `SessionDetailWire.prompts`）。 */
  const prompts: TrashDetailPromptWire[] = []
  // 游标的合法性（非负整数）只在契约那一处判（`src/api/route-table.ts` 的 `optionalCursor` ⇒ 400）；
  // 这里再兜一层就是同一判据的第二份抄本。
  const end = before ?? Number.POSITIVE_INFINITY
  const page = new PageBuilder(
    end,
    Math.max(1, limits.pageBlocks),
    limits.perBlockChars,
    Math.max(1, limits.pageChars ?? PAGE_CHAR_LIMIT),
  )

  return {
    add(r: SessionRecord): void {
      if (typeof r.time === 'number' && r.time > detail.lastActivity) detail.lastActivity = r.time
      const data = (r.data ?? {}) as Record<string, unknown>
      const time = r.time ?? 0
      switch (r.type) {
        case 'session': {
          // `cwd` / `createdAt` 挂在**记录根**上（实测逐字：`{"type":"session","version":4,"id":…,"createdAt":…,"cwd":"…"}`）
          if (typeof r.cwd === 'string') detail.cwd = r.cwd
          if (typeof r.createdAt === 'number') detail.createdAt = r.createdAt
          if (typeof r.parentSession === 'string' && r.parentSession !== '') ownParentSession = true
          return
        }
        case 'session/title': {
          if (typeof data.title === 'string') detail.logTitle = data.title
          return
        }
        case 'subagent/descriptor': {
          // 自己的显示名：独立子会话（父条目不在）靠自己日志的这条事件；后写覆盖前写、空 label
          // 重置，与宿主 `subagent` 投影的折叠语义一致（父日志的 catalog 是另一份来源）。
          ownLabel = descriptorLabelOf(data)
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
              // 序号来自 `add`（这块不一定进本页，但序号是整条日志的那一格）：提问轨拿它当锚点。
              // 索引只在首次读时过线（`before` 的翻页到不了 `detail.prompts`，见文件尾）：翻页时连建都不建。
              const id = page.add(block)
              // 只有**带正文**的提问入轨：页级附件闸（`PageBuilder.finish` 的 200 张）可能把
              // 「只有附件、没有正文」的 user 块挤成空块并整块不出线，轨上留一格却永远跳不过去。
              // 跨页也判不出哪一块会被收（每块只出现在一页里），所以判据只能取"有没有正文"。
              // 这类消息仍在正文里（滚到就是），只是不占一格刻度。
              if (before === undefined && text !== '') prompts.push({ id, at: time, preview: promptPreview(text) })
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
          const parts = Array.isArray(message.content) ? (message.content as Array<ContentPart | null>) : []
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
    },
    finish(): SessionDetailWire {
      const finished = page.finish()
      detail.blocks = finished.blocks
      detail.olderCursor = finished.olderCursor
      // 提问索引只在首次读时过线：它不随分页变化，带 `before` 的翻页再搬一遍就是白花带宽。
      if (before === undefined) detail.prompts = prompts
      detail.models = [...models]
      // 自己的显示名随详情过线：descriptor label 优先；没有 descriptor 的子会话（fork）用它自己
      // 日志的当前标题——父详情够不到它，清册标题又可能是主会话那套起名法留下的错名字。
      // `ownParentSession` 由 `add`（走帧）写入；删了这条 fork 兜底，子会话就只剩主会话那套快照标题。
      const ownDisplayName = ownLabel !== '' ? ownLabel : ownParentSession ? detail.logTitle : ''
      if (ownDisplayName !== '') detail.label = ownDisplayName
      return detail
    },
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

    const fold = createDetailFold(limits, before)
    /** 子会话的显示名（bare id → label）：父日志的 `subagent/catalog` 事件逐孩子记着委派时的
     *  `description`（与宿主工作中同名）。清册标题是删除那一刻的快照，起错名的存量条目靠它兜（ADR-0058）。
     *  登记住这里、不住折叠核心：它只服务回收站子会话段。 */
    const subagentLabels = new Map<string, string>()

    // 解压或帧边界一旦不对，**整条判失败**：半截正文比"读不出来"更坏（用户会照着它决定删不删）
    try {
      walkSessionLog(raw, (r: SessionRecord) => {
        if (r.type === 'subagent/catalog') {
          const data = (r.data ?? {}) as Record<string, unknown>
          const childId = data.childId
          const label = data.label
          if (typeof childId === 'string' && childId !== '' && typeof label === 'string' && label !== '') {
            subagentLabels.set(bareSessionId(childId), label)
          }
          // 不在这里 `return`：折叠核心对该 type 不建块，但 `add` 会推进 `lastActivity`——
          // 归档详情走同一个 `add`，两档的「日志末条」口径必须一致（ADR-0060）。
        }
        fold.add(r)
      })
    } catch (error) {
      throw verbError('io', error instanceof Error ? `读回收站日志失败：${error.message}` : `读回收站日志失败：${String(error)}`, error)
    }

    const detail: TrashDetail = { entryId: record.id, ...fold.finish() }

    // 子会话摘要：只列**折进这一条**的孩子——折的判据复用 `visibleGroups`（ADR-0001/0029），
    // 不在这里另写一份「parentEntryId 指向谁」。父行不在、或自己也是孩子时，下一代接不住、
    // 自己占清单行；详情不重复给它们开入口。
    const kids = visibleGroups(all).find((group) => group.root.id === record.id)?.kids ?? []
    if (kids.length > 0) {
      const limit = limits.subagents ?? SUBAGENT_SUMMARY_LIMIT
      // 行 = `entryWire`（清册事实，与 `/list` 同一份投影）+ 可选 label（日志里读出来的显示名兜底，
      // 两份来源不同、不混在 `entryWire` 里——它只搬清册里真有的事实）。
      // 没有 catalog 登记、标题又和父/兄弟撞名的 fork 孩子：它没有 descriptor label，但自己的日志
      // 标题就是工作里的名字（旧判据折进来的那条就是这么起错名的）。只读这类行——`session-` 前缀
      // 是宿主普通/fork 会话的 id 形状，subagent 孩子是裸 UUID；不逐条读 200 个子会话日志。
      //
      // 读法是**串行**，不是并发：旧判据折进来的 fork 组里，孩子标题往往整组都是父标题（正是这一支
      // 要修的存量），`ambiguous` 会同时命中整组。并发读会把最多 200 份整条日志一起压进内存
      // （每份先 readFile 再逐帧解压），而日志大小没有上限；串行只压一份，代价是那个病态存量组
      // 多等几次读盘。常见组（0～2 条命中）与并发没有可感差别。
      const titleCounts = new Map<string, number>()
      for (const kid of kids) titleCounts.set(kid.title, (titleCounts.get(kid.title) ?? 0) + 1)
      const ambiguous = (kid: TrashEntry): boolean =>
        kid.title === '' || kid.title === record.title || (titleCounts.get(kid.title) ?? 0) > 1
      const listed: TrashEntryWire[] = []
      for (const kid of kids.slice(0, limit)) {
        const label = subagentLabels.get(bareSessionId(kid.sessionId))
        if (label !== undefined) {
          listed.push({ ...entryWire(kid), label })
          continue
        }
        if (!kid.sessionId.startsWith('session-') || !ambiguous(kid)) {
          listed.push(entryWire(kid))
          continue
        }
        const own = await childDisplayNameOf(deps, kid)
        listed.push(own === undefined || own === kid.title ? entryWire(kid) : { ...entryWire(kid), label: own })
      }
      detail.subagents = listed
      // 合计按**全部**孩子算：摘要条报的是清册大小合计，不是已列前 N 条的和（ADR-0055）。
      detail.subagentsSizeBytes = kids.reduce((sum, kid) => sum + kid.sizeBytes, 0)
      // 超闸只报「前 N 条 + 总数」，不静默截断：整组仍按整组释放，删前核对的合计由确认框念。
      if (kids.length > limit) detail.subagentsTotal = kids.length
    }
    return detail
  }
}
