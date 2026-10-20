/**
 * 跨半 wire 契约：`/dsh-session-delete-api` 的**前缀、六个端点段、请求字段名**——
 * Node 半（`src/api/dispatch.ts` 注册并分发）与浏览器半（`src/client/remote.ts` 同源 fetch）
 * 之间唯一的那份真相。两侧都 import 它，不各写一份字面量。
 *
 * 两条构建期硬约束（不是偏好）：
 *  ① tsdown 的浏览器半纯度门拦 Node 内建与平台模块表外的 `@deepseek-ai/*` 值 import——
 *     本文件两者都不涉及，且**零运行时依赖**（client 半把它整个 inline 进 bundle）；
 *  ② 跨插件一律 `import type`——本文件干脆没有 import。
 *
 * 信封（`RemoteResult`）与失败形状（`RemoteFailure`）也在这里——**因为它们本来就是两半的共同契约**：
 * Node 半按它产出（`src/api/dispatch.ts` 的失败支就是 `RemoteFailure` 那三件），浏览器半按它判别
 * （`src/client/remote.ts` 的 `unwrapRemoteResult` / `failureOf`）。形状取自宿主网关客户端面的原文
 * 「每次 unary 调用 resolve 成 RemoteResult、不为载体问题 reject」，但**它是本仓自己的 wire 契约**，
 * 不是对宿主模块的 import。
 */

/**
 * 插件专属前缀。
 *
 * 为什么必须带插件名：宿主 web server 的 `register({kind:'prefix', path})` 对**重复的 (kind, path)
 * 直接抛错**（`dsh-host-webserver` 原文 `webserver: duplicate ${route.kind} route "${route.path}"`），
 * 撞了就是整棵插件树 boot 失败——所以这条路径是与生态的硬边界，不是显示好不好看的问题。
 */
export const SESSION_DELETE_API_PREFIX = '/dsh-session-delete-api'

/** 六个段名（相对前缀）。2026-10-17 批量重构：写动词从「一条一段」收成**一段 `/apply`**——
 *  一次 HTTP 带一组 id、逐条回结果；单条就是长度为 1 的批量，仓里不再留第二条执行路径。
 *  - `GET /list`：**对账并读**清单（`session-trash/` 里的目录是准）。
 *  - `GET /ping`：最便宜的在/不在（不碰清册、不碰盘、不进链）——客户端探测用它，不用一次全表读。
 *  - `POST /detail`：单条详情（用 POST 表达一个读：判据就写在 `src/api/route-table.ts` 那一行的上方）。
 *  - `POST /apply`：批量执行一个动作（`delete` / `restore` / `purge` / `count` / `orphan-clean`），逐条回 `ApplyOutcome`。
 *  - `POST /empty`：清空回收站（聚合回执，**不**按条回）。
 *  - `GET /orphans`：无主子会话的扫描报告（纯读，2026-10-19）。**清理不在这里**——它是 `/apply` 的
 *    第五个动作，这一段只负责"有多少、在哪、多大"。 */
export const ROUTES = {
  list: '/list',
  /** 通道的"在不在"专用：没有入参、没有副作用、没有磁盘读。 */
  ping: '/ping',
  /** 单条详情（读回收站目录里那条会话自己的日志）。 */
  detail: '/detail',
  /** 一组 id 上的同一个动作；删除确认框那句「含 N 个子会话」也走这里（`action: 'count'`，纯读语义）。 */
  apply: '/apply',
  /** 清空回收站。 */
  empty: '/empty',
  /** 纯读：扫描回收站之外的无主子会话（父已不在语料/清册）。 */
  orphans: '/orphans',
} as const

/** `/apply` 的五个动作。id 的含义随动作走：`delete`/`count`/`orphan-clean` 是**宿主会话 id**
 *  （前两个还没进回收站，第三个压根没有回收站行），`restore`/`purge` 是**回收站条目 id**。 */
export type ApplyAction = 'delete' | 'restore' | 'purge' | 'count' | 'orphan-clean'

/** 每个动作的成功值：`count` 是一个数（拿不到就是 0，界面上那半句整句不出现）；
 *  `delete`/`restore` 是回收站那一行（`null` = 这一条已被**同批前一条**带走，幂等 no-op）；
 *  `purge` 是这一组的聚合回执（同批已带走 ⇒ `{removed:0,freedBytes:0}`）；
 *  `orphan-clean` 删的是**盘上目录**（不进回收站），所以清册那一行给不出 `null` 这种幂等 no-op——
 *  组已经不在了就是 `not-found`，见 `verbs/batch.ts`。 */
export type ApplyValueByAction = {
  delete: TrashEntryWire | null
  restore: TrashEntryWire | null
  purge: PurgeStatsWire
  count: number
  'orphan-clean': OrphanCleanStatsWire
}

/** 一条动作的落地：原始输入 id 一律回带，成败各按信封（成功 `value` / 失败 `error`）。
 *  按 `action` + `ok` 双重可判别——浏览器半的便捷包装靠它把 `value` 收成各自动作的类型。 */
export type ApplyOutcome = { id: string } & {
  [A in ApplyAction]:
    | { action: A; ok: true; value: ApplyValueByAction[A] }
    | { action: A; ok: false; error: RemoteFailure }
}[ApplyAction]

/** 清册那一行（`trash/entry.ts` 的 `TrashEntry`）的**线上形状**。
 *  它与落地形状不是同一个东西：线上**只发**这里列的东西，落地形状另有运行期必填清单（见 `entry.ts`）。 */
export interface TrashEntryWire {
  id: string
  sessionId: string
  projectDir: string
  workspaceId: string
  wasArchived: boolean
  deletedAt: number
  title: string
  sizeBytes: number
  parentEntryId?: string
}

/**
 * `GET /list` 真正发出去的那一行：清册那一行 + 六个**现算现给**的只读数（ADR-0003）。
 *
 * 六个只读数都**不落清册**：它们随盘上状态随时变，清册只记文件里真有的事实。所以除了必填的
 * `releaseBytes` 之外全是可选字段，而且「缺席」与「是 0」是两件事——界面上不许拿 0 冒充「没有」，
 * 也不许拿缺席冒充否。
 */
export interface TrashRowWire extends TrashEntryWire {
  /** **这一行「彻底删除」会释放多少**：这一组在盘上**实测**的字节合计（回收站里本行与孩子的目录 +
   *  盘上还留着的后代），与 purge 的 `freedBytes` 同一口径。算式只住 `verbs/permanent-removal.ts` 的
   *  `planVisibleTrash`，Node 半算一次过线、投影原样搬运；界面上头部合计与单条确认框共用这一个数——
   *  不许各算一遍（各算一遍就是两套口径，且客户端那套会重复计数）。 */
  releaseBytes: number
  /** 跟着这条父会话**一起进了回收站**的孩子数（清册里 `parentEntryId` 指向它的行）。 */
  subagentCount?: number
  /** 那些孩子**回收站目录的实测字节**合计（`planVisibleTrash` 在盘上现量，与 `releaseBytes` 同一条口径；
   *  不念清册里记的 `sizeBytes`。头部合计要算上它们，不能只加父自己那一格）。 */
  subagentBytes?: number
  /** **还留在盘上、没被带走**的孩子数（宿主 `sessionQuery`）。与 `subagentCount` 各说各的。 */
  strandedSubagents?: number
  /** 那些盘上后代的实际字节合计；彻底删除/清空会一起释放。 */
  strandedBytes?: number
  /** 删除时记下的工作区**已经不在账本里**（宿主的「删除工作区」只删注册、保留日志）。 */
  workspaceMissing?: boolean
}

/** 单条详情里的一条消息（`trash/detail.ts` 读出来的那一份）。 */
export interface TrashDetailMessageWire {
  role: 'user' | 'assistant'
  time: number
  text: string
  truncated: boolean
}

/** 回收站单条详情的线上形状（`POST /detail`）。 */
export interface TrashDetailWire {
  entryId: string
  /** 日志 header 里的原串（**无损**，比从 `projectKey` 反推那一路强；组头怎么念项目名见 `src/client/trash-view.ts` 的 `projectLabel`，那是另一回事）。 */
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
  messages: TrashDetailMessageWire[]
  omittedByPayloadCap: number
}

/** 清空回收站的回执（与旧 `purge` 同形）。 */
export interface PurgeStatsWire {
  removed: number
  freedBytes: number
}

/** 无主子会话扫描里**一个项目目录**的汇总（界面上那条"哪一家还剩多少"的读数）。 */
export interface OrphanProjectGroupWire {
  projectDir: string
  sessions: number
  bytes: number
}

/** 一次孤儿扫描的报告（纯读的产物）。`roots` 是每组那个"父没了"的 subagent 自己写的原形状；
 *  `missingParents` 按**去前缀后的形状**去重——同一个失踪父在两种写法下只算一个。 */
export interface OrphanReportWire {
  roots: readonly string[]
  totalSessions: number
  totalBytes: number
  missingParents: number
  groups: readonly OrphanProjectGroupWire[]
}

/** 清理一组无主子会话的回执（与 {@link PurgeStatsWire} 同形，但计的是"删掉的会话目录"）。 */
export interface OrphanCleanStatsWire {
  removed: number
  freedBytes: number
}

/** 请求体字段名：浏览器半发、Node 半读，同名同义（`empty` 没有入参）。 */
export const PARAMS = {
  entryId: 'entryId',
  action: 'action',
  ids: 'ids',
} as const

/**
 * 失败信封的**线上形状**（本文件）：`code` 是判别依据、`message` 是上屏原文、
 * `details` 是**可选的结构化附带物**——对齐官方 `rpcErrorSchema` 那三件
 * （`dsh-client-connection` 原文：`z.object({ code, message, details: z.record(z.string(), z.unknown()) })`）。
 * 来历两类：宿主类型化错误自己身上的字段（`WorkspaceActiveSessionError` 的 `sessionId` / `activity`…），
 * 以及动词在抛出处就地给的（`verbError(code, msg, cause, details)`）。没有附带物时**整件缺席**，
 * 不写空表——"带过但为空"和"没有可带的"是两件事。
 */
export interface RemoteFailure {
  code: string
  message: string
  details?: Record<string, unknown>
}

/** 两半之间的一次落地（**信封**）：要么值，要么失败。 */
export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: RemoteFailure }

/**
 * 进程内判别「这已经是一次失败」——**按标记位认，不按 `instanceof`**（跨 realm / 跨 bundle 都不成立）。
 * 位名与判法取自宿主网关客户端面的原文：
 * `if (typeof value === "object" && value !== null && value.isDSHRemoteError === true && typeof value.code === "string") return value`。
 *
 * 线上递过来的是**一段 JSON**（标记位不跟着过线）⇒ 落到哪一端，由那端的构造处就地补上标记：
 * 浏览器半是 `src/client/remote.ts` 的 `throwRemoteFailure`。
 */
export function isDSHRemoteError(value: unknown): value is RemoteFailure {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { isDSHRemoteError?: unknown; code?: unknown }
  return candidate.isDSHRemoteError === true && typeof candidate.code === 'string'
}

/* ── 失败码与那个目录名：**两半都知道**的事实，所以住这一处（ADR-0003） ──────────────
 * 浏览器半要认 `not-found`（「这一组已经不在了」是中性提示、不是失败），也要在页脚念出回收站在哪；
 * Node 半要产出同一批码、拼同一个路径。两边各写一个字面量，就是两本账。 */

/** 失败码的域。与宿主官方域（`workspace/*`、`session/*`…）不重名，见本文件。 */
export const SESSION_DELETE_ERROR_DOMAIN = 'sessiondelete'

/** 五个**动词码**（本文件那张表）。`io` 是唯一兜底。 */
export const VERB_CODES = ['live', 'not-found', 'trash-empty', 'project-missing', 'io'] as const
export type VerbCode = (typeof VERB_CODES)[number]

/** 三个**路由自检码**：请求本身不对，不是一次操作的结果（它们带 HTTP 状态，见 `api/dispatch.ts`）。 */
export const ROUTE_CODES = ['bad-method', 'not-found-route', 'bad-request'] as const
export type RouteCode = (typeof ROUTE_CODES)[number]

/**
 * 完整码（`sessiondelete/<后缀>`）。**`Record<…, …>` 是闸**：加一个后缀而忘了这里，
 * 编译不过；写错一个字面量，也编译不过。
 */
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

/** 回收站目录名（相对宿主数据根）。Node 半拼路径，浏览器半在页脚念它——同一个字面量。 */
export const TRASH_DIR_NAME = 'session-trash'

/** 页脚/文案里带尾斜杠的那一版（`splitOn` 按它切一刀再把目录名包成 code）。 */
export const TRASH_DIR_LABEL = `${TRASH_DIR_NAME}/`

/**
 * 宿主 `projectKey` 的 **`~XXXX` 转义还原**。
 *
 * 编码那一半在 Node 侧（`src/ports/host-port.ts` 的 `projectKey`，逐字镜像宿主实现）；这里放与它配对的
 * 解码，客户端渲染回收站组头用它——**字母表只有这一份**，两边不会各自漂移（配对关系由
 * `tests/assembly.test.ts` 的往返用例钉住）。
 *
 * **只还原可还原的那部分**：不在 `[A-Za-z0-9._-]` 里、又不是 `~` 的字符编成 `~` + 4 位大写十六进制码元，
 * 字面 `~` 自己编成 `~007E` ⇒ `~XXXX` 不含歧义。而**分隔符（`/` `\` `:`）被折成一个 `-`，那一段是有损的**，
 * 这里还原不回来——调用方按"尽力显示"用它，别拿它反推真实路径。
 */
export function unescapeProjectKey(encoded: string): string {
  return encoded.replace(
    /~([0-9A-F]{4})/g,
    (_whole, hex: string) => String.fromCharCode(parseInt(hex, 16)),
  )
}
