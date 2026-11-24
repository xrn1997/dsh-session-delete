/** 跨半 wire 契约：前缀、端点、请求/响应形状与失败码；两半共用这一份，不各写字面量。
 *  零宿主依赖：只 import `shared/` 内的值形状 schema。信封仍是两半共同的落地形状。 */
import {
  APPLY_VALUE_SCHEMAS,
  ATTACHMENT_CLEANUP_SCHEMA,
  PURGE_STATS_SCHEMA,
  TRASH_ENTRY_SCHEMA,
} from './apply-values.js'
import type { Infer } from './value-schema.js'

/** 插件专属前缀（段名相对它命名）。必须带插件名：宿主 exact Fetch 路由重名直接抛错，撞了整棵插件树 boot 失败。 */
export const SESSION_DELETE_API_PREFIX = '/dsh-session-delete-api'

/** 唯一的取数基础路径：宿主 `/api` + 插件前缀；全部段名与附件 URL 都从它起。 */
export const OFFICIAL_SESSION_DELETE_API_PREFIX = `/api${SESSION_DELETE_API_PREFIX}`

/** 请求体线上形状：`none` 无字段、`query` 查询串，其余是 JSON 字段组（字段清单见 {@link BODY_GROUPS}）。
 *  Node 半按它决定是否预读 JSON；浏览器半只投影「有 JSON 字段即 POST」的配对事实。 */
export type RouteBody = 'none' | 'query' | 'config' | 'entry' | 'apply' | 'sessionId'

/** 段名表（相对前缀）。每项 `{ path, method, body }`：方法与请求体也是线上形状（ADR-0003），
 *  路由记录与浏览器半都从这里派生，不写第二份字面量。写动作统一走一段 `/apply`；
 *  单条是长度为 1 的批量，仓里不留第二条执行路径。各段语义见下。 */
export const ROUTES = {
  list: { path: '/list', method: 'GET', body: 'none' },
  /** 通道的"在不在"专用：没有入参、没有副作用、没有磁盘读。 */
  ping: { path: '/ping', method: 'GET', body: 'none' },
  /** 可调项：空体读（与 `/detail` 同法，用 POST 表达一个读）；带字段写，写必须进到达序链。 */
  config: { path: '/config', method: 'POST', body: 'config' },
  /** 单条详情（读回收站目录里那条会话自己的日志）。 */
  detail: { path: '/detail', method: 'POST', body: 'entry' },
  /** 一组 id 上的同一个动作；删除确认框那句「含 N 个子会话」也走这里（`action: 'count'`，纯读语义）。 */
  apply: { path: '/apply', method: 'POST', body: 'apply' },
  /** 清空回收站。 */
  empty: { path: '/empty', method: 'POST', body: 'none' },
  /** 纯读：扫描回收站之外的无主子会话（父已不在语料/清册）。 */
  orphans: { path: '/orphans', method: 'GET', body: 'none' },
  /** 附件字节（图片/普通文件）：全仓唯一的二进制响应段，按查询串寻址。 */
  attachment: { path: '/attachment', method: 'GET', body: 'query' },
  /** 纯读：扫全部引用源与附件库 `objects`，报无引用图片的数量、字节与预览清单。 */
  attachmentOrphans: { path: '/attachment-orphans', method: 'GET', body: 'none' },
  /** 聚合清理：只删 `objects` 下无引用的图片，回 `AttachmentCleanupWire`。 */
  attachmentClean: { path: '/attachment-clean', method: 'POST', body: 'none' },
  /** 纯读：宿主 `session_projcache` 里找不到会话痕迹（语料/持久化、清册 raw 行与回收站目录都不认）的记录条数。 */
  projectionOrphans: { path: '/projection-orphans', method: 'GET', body: 'none' },
  /** 聚合清理：按 raw 行 + 目录名现扫（不对账、不改写清册），只删这一刻仍找不到会话痕迹的记录（不信任旧报告）。 */
  projectionClean: { path: '/projection-clean', method: 'POST', body: 'none' },
  /** 纯读：归档清单（registry 归档集 ∩ 语料，服务端一次算好行投影）。 */
  archiveList: { path: '/archive-list', method: 'GET', body: 'none' },
  /** 归档单条详情（POST 表达一个读，判据在 `src/api/route-table.ts` 的 archiveDetail 行）：
   *  目标自己仍在归档集，**或**目标是 `rootSessionId` 那条已归档会话的 subagent 闭包成员；
   *  不是通用会话正文通道。 */
  archiveDetail: { path: '/archive-detail', method: 'POST', body: 'sessionId' },
  /** 纯读：在飞写入的进度快照（`idle` = 没写在飞）；写在飞时轮询也要立刻回，不进到达序链。 */
  progress: { path: '/progress', method: 'GET', body: 'none' },
} as const

/** 段名 → 那一段的路径；类型闸与运行期键集比对都跟着这张表走。 */
export type RouteName = (typeof ROUTES)[keyof typeof ROUTES]['path']

/** 三只可调项的线上形状；`SessionDeleteConfig` 是它的别名，默认值与归一在 `src/config.ts`。 */
export interface SessionDeleteConfigWire {
  /** 设置页「孤儿附件」预览清单最多列多少条（数量与字节仍按全量报告）。 */
  orphanPreviewLimit: number
  /** `GET /attachment` 单次响应字节上限（服务路径与直接 fs fallback 共用）。 */
  maxAttachmentBytes: number
  /** 附件引用扫描里单个 JSON 引用源的字节上限；超过就按「读不出」fail closed。 */
  maxJsonRefBytes: number
}

/** 三只可调项的接受范围；表单与归一共用这一格，各写一份就会「表单说能存、激活时说越界」。 */
export const CONFIG_LIMITS = {
  orphanPreviewLimit: { min: 1, max: 10_000 },
  maxAttachmentBytes: { min: 1, max: 200 * 1024 * 1024 },
  maxJsonRefBytes: { min: 1, max: 100 * 1024 * 1024 },
} as const satisfies Record<keyof SessionDeleteConfigWire, { readonly min: number; readonly max: number }>

/** `/apply` 的六个动作。id 的含义随动作走：`delete`/`count`/`orphan-clean`/`unarchive` 是宿主会话 id，
 *  `restore`/`purge` 是回收站条目 id；两域都是 string，错域由各动词在运行期处理。
 *  静态事实收在 `src/shared/apply-actions.ts` 的 `APPLY_ACTION_INDEX`，成功值形状见 `APPLY_VALUE_SCHEMAS`。 */
export type ApplyAction = 'delete' | 'restore' | 'purge' | 'count' | 'orphan-clean' | 'unarchive'

/** 每个动作的成功值：`count`/`unarchive` 是数，`delete`/`restore` 是清册行或 `null`（同批前一条带走），
 *  `purge`/`orphan-clean` 是聚合回执。值形状只声明一次，见 `APPLY_VALUE_SCHEMAS`。 */
export type ApplyValueByAction = {
  [A in ApplyAction]: Infer<(typeof APPLY_VALUE_SCHEMAS)[A]>
}

/** 一条动作的落地：原始 id 回带，成败各按信封；按 `action` + `ok` 双重可判别。 */
export type ApplyOutcome = { id: string } & {
  [A in ApplyAction]:
    | { action: A; ok: true; value: ApplyValueByAction[A] }
    | { action: A; ok: false; error: RemoteFailure }
}[ApplyAction]

/** 写入进度报的是哪些动作：写动作 + `/empty`（`count` 是纯读，不报进度）。
 *  身份就按 `action` + `ids` 认领，请求形状不必为进度改。 */
export type WriteProgressAction = Exclude<ApplyAction, 'count'> | 'empty'

/** 写入进度的步骤码（渲染文案归浏览器半，码只住这一处）。**码只表达动作点**：步骤码→动作点的唯一映射
 *  住 `src/verbs/write-progress.ts`，没有动作点的码不上册（`resuming` 就这样收窄掉——冷 resume 归宿主）。 */
export const WRITE_PROGRESS_STEPS = ['checking', 'measuring', 'moving', 'ledger', 'deleting', 'attachments', 'finishing'] as const
export type WriteProgressStep = (typeof WRITE_PROGRESS_STEPS)[number]

/** `GET /progress` 的线上形状：没写在飞是 `idle`；在飞是那趟写的快照（身份、k/N、步骤、起始时刻）。
 *  生命周期随进程：宿主重启天然回 `idle`，不留残留。 */
export type WriteProgressWire =
  | { readonly status: 'idle' }
  | {
      readonly status: 'running'
      readonly action: WriteProgressAction
      readonly ids: readonly string[]
      readonly done: number
      readonly total: number
      readonly step: WriteProgressStep
      readonly startedAt: number
    }

/** 清册那一行的线上形状：字段清单住 `TRASH_ENTRY_SCHEMA`（判形与类型同源）。 */
export type TrashEntryWire = Infer<typeof TRASH_ENTRY_SCHEMA>

/**
 * `GET /list` 真正发出去的那一行：清册行 + 现算现给的只读数（ADR-0003）。
 *
 * 只读数不落清册：它们随盘上状态随时变。「缺席」与「是 0」是两件事——界面不许拿 0 冒充「没有」。
 */
export type TrashRowWire = TrashEntryWire & {
  /** 这一行「彻底删除」会释放的字节：盘上实测，与 purge 的 `freedBytes` 同一口径（算式住 `planVisibleTrash`）。
   *  头部合计与单条确认框共用这一个数，不许各算一遍。 */
  releaseBytes: number
  /** 跟着这条父会话**一起进了回收站**的孩子数（清册里 `parentEntryId` 指向它的行）。 */
  subagentCount?: number
  /** 那些孩子回收站目录的实测字节合计（`planVisibleTrash` 现量）；已折进 `releaseBytes`，别再单独相加。 */
  subagentBytes?: number
  /** **还留在盘上、没被带走**的孩子数（宿主 `sessionQuery`）。与 `subagentCount` 各说各的。 */
  strandedSubagents?: number
  /** 那些盘上后代的实际字节合计；彻底删除/清空会一起释放。 */
  strandedBytes?: number
  /** 删除时记下的工作区**已经不在账本里**（宿主的「删除工作区」只删注册、保留日志）。 */
  workspaceMissing?: boolean
}

/** 单条详情里的一条附件读数；`attachmentId` 是附件库 sha256 键，也是附件段的寻址依据。 */
export interface TrashDetailAttachmentWire {
  attachmentId: string
  kind: 'image' | 'file'
  name?: string
  mediaType?: string
  bytes: number
  width?: number
  height?: number
}

/** 单条详情里的一块正文（判据住 `src/trash/detail.ts`）。
 *
 *  `kind` 决定这块怎么画；`attachments` 每种块都必填（空数组 = 没有）。`truncated` 是单块载荷闸，
 *  与分页游标 `olderCursor` 是两件事；空块不建也不出线。
 */
export interface TrashDetailTextBlockWire {
  kind: 'user' | 'assistant' | 'reasoning' | 'system' | 'compaction'
  /** 块在整条日志里的稳定序号（分页游标也用它）；跨页不重复。 */
  id: string
  time: number
  text: string
  truncated: boolean
  attachments: TrashDetailAttachmentWire[]
}

/** 宿主注入的上下文（`user/message` 里 `source.kind !== 'user'` 的那些）。 */
export interface TrashDetailInjectionBlockWire {
  kind: 'injection'
  id: string
  time: number
  /** 日志里的 `source.kind` 原串（`runtime-context` / `agent-instructions` / …；日志里没写就是空串）；界面自己映射标签。 */
  sourceKind: string
  text: string
  truncated: boolean
  attachments: TrashDetailAttachmentWire[]
}

/** 一次工具调用：`tool/call` 建块、`tool/result` 按 `callId` 回填；`unfinished` 不是失败。 */
export interface TrashDetailToolBlockWire {
  kind: 'tool'
  id: string
  time: number
  callId: string
  name: string
  status: 'ok' | 'error' | 'unfinished'
  args: string
  argsTruncated: boolean
  result: string
  resultTruncated: boolean
  attachments: TrashDetailAttachmentWire[]
}

export type TrashDetailBlockWire =
  | TrashDetailTextBlockWire
  | TrashDetailInjectionBlockWire
  | TrashDetailToolBlockWire

/** 详情右缘「提问轨」的一行：整条会话里的一句用户提问，与当前分页窗口无关。
 *
 *  `id` 与 `blocks[].id` 同一套，跳转按 `olderCursor` 回补；`preview` 有界，不是正文抄本。 */
export interface TrashDetailPromptWire {
  id: string
  at: number
  preview: string
}

/** 会话详情公共基座（回收站与归档两档共用）：块按页给，计数按整条日志。 */
export interface SessionDetailWire {
  /** 日志 header 里的原串（**无损**，比从 `projectKey` 反推那一路强；组头怎么念项目名见 `src/client/trash-view.ts` 的 `projectLabel`，那是另一回事）。 */
  cwd: string
  createdAt: number
  lastActivity: number
  /** 日志内 `session/title` 那条记录；清单标题为空串时客户端拿它兜底。 */
  logTitle: string
  /** 这条会话自己的显示名，只在详情读时折出：子会话取 descriptor 的 `label`，fork 子会话取自身标题。
   *  缺席 = 主会话或没有可用名字，界面回落清单标题。 */
  label?: string
  models: string[]
  turnCount: number
  userMessageCount: number
  /** 日志里**每一条** assistant/message 记录（含只带 reasoning / tool-call 的那些）。 */
  assistantMessageCount: number
  toolCallCount: number
  /** 宿主注入的上下文块数（空文本且无附件的注入不建块，也不计）。 */
  injectedCount: number
  blocks: TrashDetailBlockWire[]
  /** 更早一页的块序号；`null` = 已经到顶。把它原样回传给详情段的 `before`。 */
  olderCursor: number | null
  /** 整条会话的提问索引；只在首次读（不带 `before`）时出线，翻页不重搬。 */
  prompts?: TrashDetailPromptWire[]
}

/** 回收站单条详情的线上形状（`POST /detail`）：基座 + 清册身份 + 子会话段。 */
export interface TrashDetailWire extends SessionDetailWire {
  entryId: string
  /** 折进这一行的孩子（清册里 `parentEntryId` 指向它，判据复用 `visibleGroups`），按清册原序。
   *  缺席 = 没有孩子；最多过线 `SUBAGENT_SUMMARY_LIMIT` 条，超出时 `subagentsTotal` 给总数。 */
  subagents?: TrashEntryWire[]
  /** 子会话总数；**只在 `subagents` 被条数闸截断时出线**（缺席 = 上面就是全部）。 */
  subagentsTotal?: number
  /** 全部折进来孩子的清册 `sizeBytes` 合计；不要拿已列行求和，那只是前 N 条。 */
  subagentsSizeBytes?: number
}

/** 归档清单的一行；大小与时间口径和回收站行不是一个数（ADR-0060 决定第 3 条）。 */
export interface ArchiveRowWire {
  sessionId: string
  projectDir: string
  /** 日志标题（`session/title`；缺席 = 空串）。旧宿主没有批量读面时回退 `titleOf` 投影，属降级口径。 */
  title: string
  /** 子会话的宿主 `subagent` 投影 label；空串/缺席 = 没有。显示名按 label 非空优先，否则 title。 */
  label?: string
  /** 最后活动；缺席 = 宿主既没给提问时间、身份记录也没有创建时间（时间未知，不拿 0 冒充 1970）。 */
  updatedAt?: number
  /** `updatedAt` 的口径；与 `updatedAt` 同进同退。 */
  updatedAtSource?: 'prompt' | 'created'
  /** 宿主持久化日志工件字节；缺席 = 这一行没有可信读数（不是 0）。 */
  sizeBytes?: number
  /** `origin:'subagent'`；行上要带「子代理」标签。 */
  subagent: boolean
}

/** 归档清单：`sessionQuery` 缺席时显式 `{available:false}`（语料不可见），不是空列表也不是 `io`；
 *  `totalBytes` 只加已知大小，`missingSizeCount > 0` 时副标题要说 N 条大小缺席。 */
export type ArchiveListWire =
  | { available: true; rows: ArchiveRowWire[]; totalBytes: number; missingSizeCount: number }
  | { available: false }

/** 归档详情里的一个子会话（宿主闭包 + 只读投影），不是清册行。 */
export interface ArchiveSubagentWire {
  sessionId: string
  /** 这个孩子自己的归档态（宿主归档集精确判据）；不拿「清单在不在场」冒充归档态。 */
  archived: boolean
  projectDir: string
  title: string
  /** 宿主 `subagent` 投影 label；空串/缺席 = 没有，显示名回落 title。 */
  label?: string
  /** 最后活动；缺席 = 宿主列表没给（不拿 0 冒充）。 */
  updatedAt?: number
  /** `updatedAt` 的口径：真有提问时间才标 `prompt`。 */
  updatedAtSource?: 'prompt' | 'created'
  /** 宿主持久化日志工件字节；缺席 = 没有可信读数（不是 0）。 */
  sizeBytes?: number
}

/** 归档单条详情：基座 + 会话 id + 只读子会话段。目标自己已归档，或是 `rootSessionId` 的闭包成员
 *  ⇒ 可读；仅凭根放行（主体自己未归档）时不装配子会话段。 */
export interface ArchiveDetailWire extends SessionDetailWire {
  sessionId: string
  /** 主体自己的归档态（这一读的权威判据）；状态行认这一格，不认客户端快照。 */
  archived: boolean
  /** 自己已归档且有孩子时出线；缺席 = 没有孩子或仅凭根放行的孩子读。 */
  subagents?: ArchiveSubagentWire[]
  /** 子会话总数；**只在 `subagents` 被条数闸截断时出线**。 */
  subagentsTotal?: number
  /** **全部**孩子里已知 `sizeBytes` 的合计；没有任何已知读数时缺席（不拿 0 冒充）。 */
  subagentsSizeBytes?: number
}

/** 一次永久删除顺带或孤儿附件清理的附件读数（字段清单住 `ATTACHMENT_CLEANUP_SCHEMA`）。
 *  `skipped` 有值 = 部分或整体没清，`removed` 仍可能 > 0；`failed` 是逐文件真出错的那几件。 */
export type AttachmentCleanupWire = Infer<typeof ATTACHMENT_CLEANUP_SCHEMA>

/** 孤儿附件报告里的一条：内容哈希 + 实测字节。没有原始文件名（附件库只存内容）。 */
export interface AttachmentOrphanItemWire {
  attachmentId: string
  bytes: number
}

/** 孤儿附件报告：数量、总字节与对象清单（供设置页预览，条数由 `orphanPreviewLimit` 限）。
 *  任何一处引用源读不出时不返回这一形状，而是 `io` 失败——不拿 0 冒充「没有孤儿」。 */
export interface AttachmentOrphanReportWire {
  count: number
  totalBytes: number
  items: AttachmentOrphanItemWire[]
}

/** 清空回收站的聚合回执（字段清单住 `PURGE_STATS_SCHEMA`）；`attachments` 缺席 = 这一轮没有读数。 */
export type PurgeStatsWire = Infer<typeof PURGE_STATS_SCHEMA>

/** 孤儿投影缓存报告：只念条数（ADR-0021）；读面读不出时 `io` 失败，不拿 0 冒充。 */
export interface ProjectionCacheOrphanReportWire {
  count: number
}

/** 孤儿投影缓存清理回执：删掉与没删掉的条数；清完重查会再报真实剩余量。 */
export interface ProjectionCacheCleanupWire {
  removed: number
  failed: number
}

/** 无主子会话扫描里**一个项目目录**的汇总（界面上那条"哪一家还剩多少"的读数）。 */
export interface OrphanProjectGroupWire {
  projectDir: string
  sessions: number
  bytes: number
}

/** 一次孤儿扫描的报告；`missingParents` 按去前缀后的形状去重，同一个失踪父只算一个。 */
export interface OrphanReportWire {
  roots: readonly string[]
  totalSessions: number
  totalBytes: number
  missingParents: number
  groups: readonly OrphanProjectGroupWire[]
}

/** 清理一组无主子会话的回执（与 {@link PurgeStatsWire} 同形，计的是删掉的会话目录）。 */
export type OrphanCleanStatsWire = PurgeStatsWire

/** 请求参数名：浏览器半发、Node 半读，同名同义；附件段是 query 参数。 */
export const PARAMS = {
  entryId: 'entryId',
  /** `/archive-detail` 的寻址键（红线：路径字段不过线）。 */
  sessionId: 'sessionId',
  /** 归档详情的只读根：看未归档子会话时带上已归档父会话的 id；给了也只用于校验闭包归属。 */
  rootSessionId: 'rootSessionId',
  /** `/detail` 的分页游标：只取这个块序号之前的块。缺省 = 从尾部取。 */
  before: 'before',
  action: 'action',
  ids: 'ids',
  attachmentId: 'id',
  attachmentKind: 'kind',
  attachmentName: 'name',
  /** 图片引用的媒体类型 / 宽高：只给宿主 `attachments.readImage` 做引用校验，不参与路径拼接。 */
  attachmentMediaType: 'mediaType',
  /** 字节数：图片支与文件支都带，先过 `maxAttachmentBytes` 闸再让宿主读。 */
  attachmentBytes: 'bytes',
  attachmentWidth: 'width',
  attachmentHeight: 'height',
} as const

/* ── 请求字段组：段名表 `body` 那一格的**内容**（ADR-0003 决定 6） ───────────────────
 * 字段名与种类是线上形状；Node 半的通用解析手按它把 JSON 体读成 typed 字段。 */

/** 请求体字段的种类 → 解析后的类型：新增种类只改这张表的键，解析手与 {@link ParsedBody} 会一起编译错。 */
type ParsedByKind = {
  requiredString: string
  optionalString: string | undefined
  optionalCursor: number | undefined
  action: ApplyAction
  idArray: string[]
}

/** 请求体字段的种类：每一种由通用解析手的一种读法兑现，拒绝原文也按种类只写一遍。 */
export type BodyFieldKind = keyof ParsedByKind

/** 一个字段组：字段键 → 种类；键必须是 {@link PARAMS} 的成员（配对由 `tests/wire-shape.test.ts` 把守）。 */
export type BodyGroup = Readonly<Record<string, BodyFieldKind>>

/** 段名表每格 `body` → 字段组；`config` 的三只旋钮由 `src/verbs/config.ts` 自己校验，路由层不重复拦。 */
export const BODY_GROUPS = {
  none: {},
  query: {},
  config: {},
  entry: { [PARAMS.entryId]: 'requiredString', [PARAMS.before]: 'optionalCursor' },
  apply: { [PARAMS.action]: 'action', [PARAMS.ids]: 'idArray' },
  sessionId: { [PARAMS.sessionId]: 'requiredString', [PARAMS.before]: 'optionalCursor', [PARAMS.rootSessionId]: 'optionalString' },
} as const satisfies Record<RouteBody, BodyGroup>

/** 描述 → 解析后的字段类型：描述与本型同源 ⇒ 解析手交回的字段，用法在类型层就对得上。 */
export type ParsedBody<G extends BodyGroup> = { [K in keyof G]: ParsedByKind[G[K]] }

/** 失败信封的线上形状：`code` 判别、`message` 上屏、`details` 可选结构化附带物（对齐官方 `rpcErrorSchema`）。
 *  没有附带物时整件缺席，不写空表。 */
export interface RemoteFailure {
  code: string
  message: string
  details?: Record<string, unknown>
}

/** 两半之间的一次落地（**信封**）：要么值，要么失败。 */
export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: RemoteFailure }

/** 进程内判别「这已经是一次失败」：按标记位认，不按 `instanceof`（跨 realm / 跨 bundle 不成立）。
 *  标记位只由宿主服务抛出的 `RemoteError` 自带；线上 JSON 不跟着过线，生产侧不造它。 */
export function isDSHRemoteError(value: unknown): value is RemoteFailure {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { isDSHRemoteError?: unknown; code?: unknown }
  return candidate.isDSHRemoteError === true && typeof candidate.code === 'string'
}

/** 运行期判形「这段 JSON 是不是信封」：中间层会回非信封 JSON，判形不过就走「回的不是信封」诊断。
 *  `ok:true` 须带 `value` 键；`ok:false` 的 `error` 须是带 string `code`/`message` 的对象。 */
export function isRemoteResult(value: unknown): value is RemoteResult<unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const body = value as { ok?: unknown; value?: unknown; error?: unknown }
  if (typeof body.ok !== 'boolean') return false
  if (body.ok) return 'value' in body
  if (typeof body.error !== 'object' || body.error === null) return false
  const error = body.error as { code?: unknown; message?: unknown }
  return typeof error.code === 'string' && typeof error.message === 'string'
}

/* ── 失败码与那个目录名：两半都知道的事实，住这一处（ADR-0003） ──────────────
 * 浏览器半要认 `not-found`、也要念出回收站在哪；Node 半要产出同一批码、拼同一个路径。 */

/** 失败码的域。与宿主官方域（`workspace/*`、`session/*`…）不重名，见本文件。 */
export const SESSION_DELETE_ERROR_DOMAIN = 'sessiondelete'

/** 五个**动词码**（本文件那张表）。`io` 是唯一兜底。 */
export const VERB_CODES = ['live', 'not-found', 'trash-empty', 'project-missing', 'io'] as const
export type VerbCode = (typeof VERB_CODES)[number]

/** 三个**路由自检码**：请求本身不对，不是一次操作的结果（它们带 HTTP 状态，见 `api/dispatch.ts`）。 */
export const ROUTE_CODES = ['bad-method', 'not-found-route', 'bad-request'] as const
export type RouteCode = (typeof ROUTE_CODES)[number]

/** 完整码（`sessiondelete/<后缀>`）：`Record` 是闸，加后缀忘了这里或写错字面量都编译不过。 */
export type AllCodeSuffix = VerbCode | RouteCode

export const SESSION_DELETE_CODES: Record<AllCodeSuffix, `sessiondelete/${AllCodeSuffix}`> = {
  live: 'sessiondelete/live',
  'not-found': 'sessiondelete/not-found',
  'trash-empty': 'sessiondelete/trash-empty',
  'project-missing': 'sessiondelete/project-missing',
  io: 'sessiondelete/io',
  'bad-method': 'sessiondelete/bad-method',
  'not-found-route': 'sessiondelete/not-found-route',
  'bad-request': 'sessiondelete/bad-request',
}

/** 失败码的前缀。读码只走下面两条，别在调用点各写一份字面量。 */
const CODE_PREFIX = `${SESSION_DELETE_ERROR_DOMAIN}/`

/** `error.code` 是不是本仓的失败形状：只认前缀，后缀在不在册是 {@link verbCodeOf} 的问题。 */
export function isSessionDeleteCodeError(error: unknown): boolean {
  const raw = (error as { code?: unknown } | undefined)?.code
  return typeof raw === 'string' && raw.startsWith(CODE_PREFIX)
}

/** `error.code` 折回动词词：前缀与后缀两件都成立才交回；路由自检码与别域的码一律 `undefined`。 */
export function verbCodeOf(error: unknown): VerbCode | undefined {
  const raw = (error as { code?: unknown } | undefined)?.code
  if (typeof raw !== 'string' || !raw.startsWith(CODE_PREFIX)) return undefined
  const suffix = raw.slice(CODE_PREFIX.length)
  return (VERB_CODES as readonly string[]).includes(suffix) ? suffix as VerbCode : undefined
}

/** 回收站目录名（相对宿主数据根）。Node 半拼路径，浏览器半在页脚念它——同一个字面量。 */
export const TRASH_DIR_NAME = 'session-trash'

/** 页脚/文案里带尾斜杠的那一版（`splitOn` 按它切一刀再把目录名包成 code）。 */
export const TRASH_DIR_LABEL = `${TRASH_DIR_NAME}/`

/* ── 线上值的轻量运行期判形（浏览器半落地前问一次） ────────────────────────────────
 * 只校到「数组 / 对象 / 判别键 / 渲染必读的那几格」，不复制完整类型；形状漂移在界面上是静默
 * `undefined` 上屏，运行期只有取数通道能当场折成固定诊断。
 *
 * 键集与段名表逐段对齐：加一段 JSON 段就必须在这里补一格（`Record` 闸编译不过）。 */
export type WireValueGuard = (value: unknown) => boolean

/** 走 JSON 信封的段名（段名表的键；二进制段以后若改走 JSON，这里与表一起改）。 */
type JsonRouteName = Exclude<keyof typeof ROUTES, 'attachment'>

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringValue(value: unknown): value is string {
  return typeof value === 'string'
}

function isFiniteNumberValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isBooleanValue(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

/** 可选字符串字段：缺席（`undefined`）放行，在场必须是字符串。 */
function isOptionalStringValue(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

/** 可选数字字段：缺席放行，在场必须是有限数字（`NaN` / `Infinity` 不算读数）。 */
function isOptionalNumberValue(value: unknown): boolean {
  return value === undefined || isFiniteNumberValue(value)
}

function isOptionalBooleanValue(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean'
}

function isStringArrayValue(value: unknown): boolean {
  return Array.isArray(value) && value.every(isStringValue)
}

/** 详情的一块附件（`TrashDetailAttachmentWire` 的必填三格 + 可选读数）。 */
function isAttachmentValue(value: unknown): boolean {
  if (!isRecordValue(value)) return false
  return isStringValue(value.attachmentId)
    && (value.kind === 'image' || value.kind === 'file')
    && isFiniteNumberValue(value.bytes)
    && isOptionalStringValue(value.name)
    && isOptionalStringValue(value.mediaType)
    && isOptionalNumberValue(value.width)
    && isOptionalNumberValue(value.height)
}

/** 详情的一块正文：`kind` 是判别键，判别键那几支的渲染必读字段逐支校。 */
function isDetailBlockValue(value: unknown): boolean {
  if (!isRecordValue(value)) return false
  if (!isStringValue(value.id) || !isFiniteNumberValue(value.time)) return false
  if (!Array.isArray(value.attachments) || !value.attachments.every(isAttachmentValue)) return false
  switch (value.kind) {
    case 'user':
    case 'assistant':
    case 'reasoning':
    case 'system':
    case 'compaction':
      return isStringValue(value.text) && isBooleanValue(value.truncated)
    case 'injection':
      return isStringValue(value.sourceKind) && isStringValue(value.text) && isBooleanValue(value.truncated)
    case 'tool':
      return isStringValue(value.callId)
        && isStringValue(value.name)
        && (value.status === 'ok' || value.status === 'error' || value.status === 'unfinished')
        && isStringValue(value.args)
        && isStringValue(value.result)
        && isBooleanValue(value.argsTruncated)
        && isBooleanValue(value.resultTruncated)
    default:
      return false
  }
}

/** 提问轨的一格（`TrashDetailPromptWire`）。 */
function isPromptValue(value: unknown): boolean {
  if (!isRecordValue(value)) return false
  return isStringValue(value.id) && isFiniteNumberValue(value.at) && isStringValue(value.preview)
}

/** 会话详情公共基座（`SessionDetailWire`）：两档详情共用的必填读数。 */
function isDetailBaseFields(value: Record<string, unknown>): boolean {
  return isStringValue(value.cwd)
    && isFiniteNumberValue(value.createdAt)
    && isFiniteNumberValue(value.lastActivity)
    && isStringValue(value.logTitle)
    && isOptionalStringValue(value.label)
    && isStringArrayValue(value.models)
    && isFiniteNumberValue(value.turnCount)
    && isFiniteNumberValue(value.userMessageCount)
    && isFiniteNumberValue(value.assistantMessageCount)
    && isFiniteNumberValue(value.toolCallCount)
    && isFiniteNumberValue(value.injectedCount)
    && Array.isArray(value.blocks)
    && value.blocks.every(isDetailBlockValue)
    && (value.olderCursor === null || isFiniteNumberValue(value.olderCursor))
    && (value.prompts === undefined || (Array.isArray(value.prompts) && value.prompts.every(isPromptValue)))
}

/** 清册行：判形读 `TRASH_ENTRY_SCHEMA`，字段清单不在这里抄第二遍。 */
function isTrashEntryValue(value: unknown): boolean {
  return TRASH_ENTRY_SCHEMA.check(value)
}

/** `GET /list` 的一行：清册身份 + 现算的 `releaseBytes`（必填读数列）。 */
function isTrashRowFields(value: Record<string, unknown>): boolean {
  return isTrashEntryValue(value)
    && isFiniteNumberValue(value.releaseBytes)
    && isOptionalNumberValue(value.subagentCount)
    && isOptionalNumberValue(value.subagentBytes)
    && isOptionalNumberValue(value.strandedSubagents)
    && isOptionalNumberValue(value.strandedBytes)
    && isOptionalBooleanValue(value.workspaceMissing)
}

/** 归档清单的一行（`ArchiveRowWire`）：大小 / 时间可缺席，挑剔的只是必填那几格。 */
function isArchiveRowFields(value: Record<string, unknown>): boolean {
  return isStringValue(value.sessionId)
    && isStringValue(value.projectDir)
    && isStringValue(value.title)
    && isOptionalStringValue(value.label)
    && isOptionalNumberValue(value.updatedAt)
    && (value.updatedAtSource === undefined || value.updatedAtSource === 'prompt' || value.updatedAtSource === 'created')
    && isOptionalNumberValue(value.sizeBytes)
    && isBooleanValue(value.subagent)
}

/** 归档详情里的只读子会话行（`ArchiveSubagentWire`）。 */
function isArchiveChildFields(value: Record<string, unknown>): boolean {
  return isStringValue(value.sessionId)
    && isBooleanValue(value.archived)
    && isStringValue(value.projectDir)
    && isStringValue(value.title)
    && isOptionalStringValue(value.label)
    && isOptionalNumberValue(value.updatedAt)
    && (value.updatedAtSource === undefined || value.updatedAtSource === 'prompt' || value.updatedAtSource === 'created')
    && isOptionalNumberValue(value.sizeBytes)
}

function isArchiveListValue(value: unknown): boolean {
  if (!isRecordValue(value)) return false
  if (value.available === false) return true
  if (value.available !== true) return false
  return Array.isArray(value.rows)
    && value.rows.every((row) => isRecordValue(row) && isArchiveRowFields(row))
    && isFiniteNumberValue(value.totalBytes)
    && isFiniteNumberValue(value.missingSizeCount)
}

/** 附件清理读数（`AttachmentCleanupWire`）：字段清单住 `ATTACHMENT_CLEANUP_SCHEMA`。 */
function isAttachmentCleanupValue(value: unknown): boolean {
  return ATTACHMENT_CLEANUP_SCHEMA.check(value)
}

/** 永久删除 / 清空的聚合回执（`PurgeStatsWire`）：字段清单住 `PURGE_STATS_SCHEMA`。 */
function isPurgeStatsValue(value: unknown): boolean {
  return PURGE_STATS_SCHEMA.check(value)
}

function isOrphanReportValue(value: unknown): boolean {
  if (!isRecordValue(value)) return false
  return isStringArrayValue(value.roots)
    && isFiniteNumberValue(value.totalSessions)
    && isFiniteNumberValue(value.totalBytes)
    && isFiniteNumberValue(value.missingParents)
    && Array.isArray(value.groups)
    && value.groups.every((group) => isRecordValue(group)
      && isStringValue(group.projectDir)
      && isFiniteNumberValue(group.sessions)
      && isFiniteNumberValue(group.bytes))
}

function isAttachmentOrphanReportValue(value: unknown): boolean {
  if (!isRecordValue(value)) return false
  return isFiniteNumberValue(value.count)
    && isFiniteNumberValue(value.totalBytes)
    && Array.isArray(value.items)
    && value.items.every((item) => isRecordValue(item)
      && isStringValue(item.attachmentId)
      && isFiniteNumberValue(item.bytes))
}

function isConfigFields(value: Record<string, unknown>): boolean {
  return isFiniteNumberValue(value.orphanPreviewLimit)
    && isFiniteNumberValue(value.maxAttachmentBytes)
    && isFiniteNumberValue(value.maxJsonRefBytes)
}

/** 动作是否在册：判形与成功值查表共用这一句，不在调用点各写一份名单。 */
function isApplyActionValue(value: unknown): value is ApplyAction {
  return typeof value === 'string' && Object.hasOwn(APPLY_VALUE_SCHEMAS, value)
}

/** `/apply` 的一条逐条结果：按 `action` 查 `APPLY_VALUE_SCHEMAS` 校成功值。 */
function isApplyOutcomeValue(value: unknown): boolean {
  if (!isRecordValue(value)) return false
  if (!isStringValue(value.id) || !isBooleanValue(value.ok)) return false
  if (!value.ok) {
    return isRecordValue(value.error)
      && isStringValue(value.error.code)
      && isStringValue(value.error.message)
  }
  return isApplyActionValue(value.action) && APPLY_VALUE_SCHEMAS[value.action].check(value.value)
}

/** 构造面的按动作收窄（`ApplyOutcome` 的辅助判别）：`Extract` 那格是条件类型，泛型装配的字面量
 *  TS 证不过它——收窄统一走这一枚谓词（装配即验），装配处不留窄化断言。信封判形复用
 *  `isApplyOutcomeValue`，形状不在这里抄第二份。 */
export function isApplyOutcomeOf<A extends ApplyAction>(
  value: unknown,
  action: A,
): value is Extract<ApplyOutcome, { action: A }> {
  return isRecordValue(value) && value.action === action && isApplyOutcomeValue(value)
}

/** 写入进度的动作在册：`empty` 归 `/empty`，其余是 `/apply` 的写动作（`count` 纯读不报进度）。
 *  在册判据复用 `isApplyActionValue`，动作名单不在这里抄第二份。 */
function isWriteProgressActionValue(value: unknown): value is WriteProgressAction {
  return value === 'empty' || (isApplyActionValue(value) && value !== 'count')
}

/** 步骤码在册：名单住 `WRITE_PROGRESS_STEPS`。 */
function isWriteProgressStepValue(value: unknown): value is WriteProgressStep {
  return typeof value === 'string' && (WRITE_PROGRESS_STEPS as readonly string[]).includes(value)
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 写入进度（`WriteProgressWire`）的判形：遥测快照不走 `/apply` 值那套 schema DSL，
 *  与 `list`/`ping` 同法手写——只校判别键与渲染必读的那几格。 */
export function isWriteProgressWire(value: unknown): value is WriteProgressWire {
  if (!isRecordValue(value)) return false
  if (value.status === 'idle') return true
  if (value.status !== 'running') return false
  return isWriteProgressActionValue(value.action)
    && isStringArrayValue(value.ids)
    && isSafeNonNegativeInteger(value.done)
    && isSafeNonNegativeInteger(value.total)
    && value.done <= value.total
    && isWriteProgressStepValue(value.step)
    && isSafeNonNegativeInteger(value.startedAt)
}

/** 段名表逐段的 JSON 值判形（`src/client/remote.ts` 的成功支只在这里问一次）。 */
export const WIRE_VALUE_GUARDS: Record<JsonRouteName, WireValueGuard> = {
  list: (value) => Array.isArray(value) && value.every((row) => isRecordValue(row) && isTrashRowFields(row)),
  ping: isStringValue,
  config: (value) => isRecordValue(value) && isConfigFields(value),
  detail: (value) => isRecordValue(value)
    && isDetailBaseFields(value)
    && isStringValue(value.entryId)
    && (value.subagents === undefined
      || (Array.isArray(value.subagents) && value.subagents.every(isTrashEntryValue)))
    && isOptionalNumberValue(value.subagentsTotal)
    && isOptionalNumberValue(value.subagentsSizeBytes),
  apply: (value) => Array.isArray(value) && value.every(isApplyOutcomeValue),
  empty: isPurgeStatsValue,
  orphans: isOrphanReportValue,
  attachmentOrphans: isAttachmentOrphanReportValue,
  attachmentClean: isAttachmentCleanupValue,
  projectionOrphans: (value) => isRecordValue(value) && isFiniteNumberValue(value.count),
  projectionClean: (value) => isRecordValue(value)
    && isFiniteNumberValue(value.removed)
    && isFiniteNumberValue(value.failed),
  archiveList: isArchiveListValue,
  archiveDetail: (value) => isRecordValue(value)
    && isDetailBaseFields(value)
    && isStringValue(value.sessionId)
    && isBooleanValue(value.archived)
    && (value.subagents === undefined
      || (Array.isArray(value.subagents) && value.subagents.every((child) => isRecordValue(child) && isArchiveChildFields(child))))
    && isOptionalNumberValue(value.subagentsTotal)
    && isOptionalNumberValue(value.subagentsSizeBytes),
  progress: isWriteProgressWire,
}
