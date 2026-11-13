/**
 * 跨半 wire 契约：前缀、端点、请求/响应形状与失败码。
 * Node 半（src/api/dispatch.ts）与浏览器半（src/client/remote.ts）共用这一份，不各写字面量。
 *
 * 构建约束：本文件零运行时依赖、无 import；浏览器半把整个文件 inline 进 bundle。
 * 信封 {ok:true,value} / {ok:false,error:{code,message,details?}} 也是两半的共同契约。
 */

/**
 * 插件专属前缀（段名相对它命名）。
 *
 * 为什么必须带插件名：宿主 `connection.fetch.register` 对**重复的精确路径**直接抛错
 * （`connection: exact Fetch route "…" is already registered`），撞了就是整棵插件树 boot 失败——
 * 所以这条路径是与生态的硬边界，不是显示好不好看的问题。
 */
export const SESSION_DELETE_API_PREFIX = '/dsh-session-delete-api'

/**
 * 唯一的取数基础路径：宿主 `/api` + 插件前缀。全部段名 exact Fetch 路由、客户端探测与附件 URL
 * 都从它起；`SESSION_DELETE_API_PREFIX` 只作为段名的相对前缀与错误原文。
 */
export const OFFICIAL_SESSION_DELETE_API_PREFIX = `/api${SESSION_DELETE_API_PREFIX}`

/** 请求体的线上形状：`none` = 没有字段（GET，或只带空对象的 POST）；`query` = GET 查询串（二进制段）；
 *  其余是 JSON 体的字段组——**每组有哪些字段、什么种类**由 {@link BODY_GROUPS} 一次描述（键即这六个值）。
 *  **读这一格的是 Node 半**：`src/api/route-table.ts` 的 `bodyOf` 据此决定分发器要不要预读 JSON，
 *  通用解析手再按 `BODY_GROUPS` 把 JSON 体读成 typed 字段。浏览器半的入参形状由
 *  `src/client/remote.ts` 的 interface 签名决定，只投影这一格的**配对事实**（有 JSON 字段的段必然是
 *  POST），配对由 `tests/wire-shape.test.ts` 钉住。 */
export type RouteBody = 'none' | 'query' | 'config' | 'entry' | 'apply' | 'sessionId'

/** 段名表（相对前缀）。**每项 `{ path, method, body }` 三键**：某段用什么方法、带什么请求体也是线上
 *  形状的一部分（ADR-0003），家就在这一张表——路由记录（`src/api/route-table.ts`）经 `defineRoute`
 *  从这一格派生 method / body（行里不写投影），浏览器半的取数通道（`src/client/remote.ts`）从同一格
 *  投影路径与方法，两半都不逐段手写一份字面量。
 *  写动作统一走一段 `/apply`：一次 HTTP 带一组 id、逐条回结果；
 *  单条就是长度为 1 的批量，仓里不留第二条执行路径。
 *  - `list`：对账并读清单（`session-trash/` 里的目录是准）。
 *  - `ping`：最便宜的在/不在（不碰清册、不碰盘、不进链），供客户端探测。
 *  - `detail`：单条详情（用 POST 表达一个读，判据在 `src/api/route-table.ts` 的 detail 行）。
 *  - `apply`：批量执行一个动作（`delete` / `restore` / `purge` / `count` / `orphan-clean` / `unarchive`），逐条回 `ApplyOutcome`。
 *  - `empty`：清空回收站（聚合回执，不按条回）。
 *  - `orphans`：无主子会话的扫描报告（纯读）。清理是 `/apply` 的第五个动作，
 *    这一段只负责"有多少、在哪、多大"。
 *  - `attachment`：附件原始字节（全仓唯一的二进制响应段；按查询串寻址，失败仍回 JSON 信封）。
 *  - `attachmentOrphans`：无引用图片对象的扫描报告（纯读；数量/字节 + 供预览的对象清单）。
 *  - `attachmentClean`：清掉报告那一刻无引用的图片对象（聚合回执 `AttachmentCleanupWire`）。
 *  - `projectionOrphans`：无会话痕迹的投影缓存记录扫描报告（纯读；只念条数）。
 *  - `projectionClean`：清掉清理那一刻现扫出的无会话痕迹投影缓存记录（聚合回执 `ProjectionCacheCleanupWire`）。
 *  - `config`：三只可调项的读/写共用一段——空体读当前值，带字段写回 profile 的 patch 层。
 *  - `archiveList`：归档清单（registry 归档集 ∩ 语料，服务端一次算好行投影，纯读）。
 *  - `archiveDetail`：归档单条详情（POST 表达一个读；目标自己已归档，或是已归档根的 subagent 闭包成员，寻址只认 id）。 */
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
} as const

/** 段名 → 那一段的路径。从结构化段名表派生：加一段只在上面加一项，`Record<RouteName, …>` 类型闸
 *  （`src/api/route-table.ts`）与运行期键集比对（`tests/route-table.test.ts`）都跟着这一格走。 */
export type RouteName = (typeof ROUTES)[keyof typeof ROUTES]['path']

/** 三只可调项的线上形状。Node 半的 `SessionDeleteConfig`（`src/config.ts`）是它的别名：
 *  这一格固定线上字段名与接受范围（{@link CONFIG_LIMITS}），默认值与归一在 `src/config.ts`。 */
export interface SessionDeleteConfigWire {
  /** 设置页「孤儿附件」预览清单最多列多少条（数量与字节仍按全量报告）。 */
  orphanPreviewLimit: number
  /** `GET /attachment` 单次响应字节上限（服务路径与直接 fs fallback 共用）。 */
  maxAttachmentBytes: number
  /** 附件引用扫描里单个 JSON 引用源的字节上限；超过就按「读不出」fail closed。 */
  maxJsonRefBytes: number
}

/** 三只可调项的接受范围（闭区间整数）。Node 半的归一与浏览器半的表单共用这一格：
 *  两处各写一份范围就会「表单说能存、宿主激活时说越界」。 */
export const CONFIG_LIMITS = {
  orphanPreviewLimit: { min: 1, max: 10_000 },
  maxAttachmentBytes: { min: 1, max: 200 * 1024 * 1024 },
  maxJsonRefBytes: { min: 1, max: 100 * 1024 * 1024 },
} as const satisfies Record<keyof SessionDeleteConfigWire, { readonly min: number; readonly max: number }>

/** `/apply` 的六个动作。id 的含义随动作走：`delete`/`count`/`orphan-clean`/`unarchive` 是**宿主会话 id**
 *  （前两个还没进回收站，第三个压根没有回收站行，`unarchive` 写的是 registry 归档集），`restore`/`purge` 是**回收站条目 id**。
 *  两域都是 string（线上形状）；这里不引入品牌类型——错域不靠类型拦，交给各动词在运行期按自己的
 *  语义处理，批处理不猜格式。
 *
 *  **动作六面清单**（只指路：不抄各家的表达式，也不做动作逐条的映射表——映射表会随任何一家漂）：
 *  一个动作的口径散在六个家，改一个动作六处一起看。值型（成功值的线上形状）就在本文件的
 *  {@link ApplyValueByAction}；静态纯度（纯读还是写）住 `src/api/route-table.ts` 的 `APPLY_ACTION_TABLE`；
 *  执行住 `src/verbs/batch.ts` 的 `applyActions`；逐条回执怎么判读住 `src/client/receipt.ts` 的 `readReceipt`；
 *  写后收尾（何时结算、什么跟着失效）住 `src/client/write-seats.ts` 的 `settleWrite`；上屏文案的键住
 *  `src/client/copy.ts` 的 `CopyKey`。判据各住各家、各带各的闸，这里只负责让人找得到门。 */
export type ApplyAction = 'delete' | 'restore' | 'purge' | 'count' | 'orphan-clean' | 'unarchive'

/** 每个动作的成功值：`count` 是一个数（拿不到就是 0，界面上那半句整句不出现）；
 *  `delete`/`restore` 是回收站那一行（`null` = 这一条已被**同批前一条**带走，幂等 no-op）；
 *  `purge` 是这一组的聚合回执（同批已带走 ⇒ `{removed:0,freedBytes:0}`）；
 *  `orphan-clean` 删的是**盘上目录**（不进回收站），所以清册那一行给不出 `null` 这种幂等 no-op——
 *  组已经不在了就是 `not-found`，见 `verbs/batch.ts`；
 *  `unarchive` 给一个数，语义固定「这条 id 被处理成功 = 1」——**不是**实际状态变化数
 *  （宿主 `unarchiveSession` 返回 void，未归档是幂等 no-op，不为此多读一次 `isArchived` 去猜）。 */
export type ApplyValueByAction = {
  delete: TrashEntryWire | null
  restore: TrashEntryWire | null
  purge: PurgeStatsWire
  count: number
  'orphan-clean': OrphanCleanStatsWire
  unarchive: number
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
  /** **子会话的显示名**（委派 `subagent` 时的 `description`，与宿主工作中同名；ADR-0058）。
   *  只在详情 `subagents` 行过线：它是**日志里读出来的事实**——通常是父日志 `subagent/catalog`
   *  的 label；没有 catalog 登记、清册标题又和父/兄弟撞名的 fork 孩子，是它自己日志的当前标题
   *  （fork 没有 descriptor）。清册里没有这格——`/list` 的 `toWire` 不发它（缺席 = 没读到名字，
   *  界面回落 `title`）。与 `logTitle` 同一类兜底：清册标题是删除那一刻的快照，label 补的是
   *  快照起错名的存量条目。 */
  label?: string
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
   *  不念清册里记的 `sizeBytes`。它们已折进 `releaseBytes`——头部合计照念那个数，别再单独相加）。 */
  subagentBytes?: number
  /** **还留在盘上、没被带走**的孩子数（宿主 `sessionQuery`）。与 `subagentCount` 各说各的。 */
  strandedSubagents?: number
  /** 那些盘上后代的实际字节合计；彻底删除/清空会一起释放。 */
  strandedBytes?: number
  /** 删除时记下的工作区**已经不在账本里**（宿主的「删除工作区」只删注册、保留日志）。 */
  workspaceMissing?: boolean
}

/** 单条详情里的一条附件读数（`trash/attachments.ts` 的 `attachmentsInContent` 产出、详情投影上线）。
 *  `attachmentId` 是宿主附件库的 sha256 键，也是 `GET /attachment` 的唯一寻址依据。 */
export interface TrashDetailAttachmentWire {
  attachmentId: string
  kind: 'image' | 'file'
  name?: string
  mediaType?: string
  bytes: number
  width?: number
  height?: number
}

/** 单条详情里的一块正文（`trash/detail.ts` 读出来的那一份）。
 *
 *  **判别联合**：`kind` 决定这块怎么画、哪些字段有意义。`attachments` 在每种块上都必填
 *  （没有附件就是空数组）——"这一条带没带附件"不靠字段缺席判断。
 *  `truncated` / `argsTruncated` / `resultTruncated` 说的是**单块载荷闸**截过一刀；
 *  分页游标（`olderCursor`）管的是"更早的块还没取"，两者不是同一件事。
 *  出线的每块**都有内容**（非空正文或至少一个附件；工具块的名字与状态就是内容）：判据住
 *  `src/trash/detail.ts`，空块不建也不出线，渲染侧不用兜。 */
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

/** 一次工具调用：`tool/call` 建块、`tool/result` 按 `callId` 回填。
 *  `unfinished` = 日志走完也没等到结果（会话可能在工具执行中被杀），不是失败。 */
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

/** 详情右缘「提问轨」的一行：**整条会话**里的一句用户提问，与当前分页窗口无关。
 *
 *  `id` 就是那块在整条日志里的序号（与 `blocks[].id` 同一套），所以「跳到这句」在已加载窗口里
 *  按它直接找；没加载就照 `olderCursor` 一页页往回补到它进窗（`src/client/use-prompt-rail.ts`
 *  的跳转循环），不另发一次定向读。`preview` 有界（空白折叠、超长带省略号）：它是导航用的标签，
 *  不是正文的第二份抄本。 */
export interface TrashDetailPromptWire {
  id: string
  at: number
  preview: string
}

/** 会话详情的**公共基座**：回收站与归档两档共用的线上读数（块/分页/计数/日志读数）。
 *
 *  正文按块分页：`blocks` 是当前这一页（从新往旧取），`olderCursor` 指向更早一页的边界；
 *  计数是**整条日志**的，不受分页影响。 */
export interface SessionDetailWire {
  /** 日志 header 里的原串（**无损**，比从 `projectKey` 反推那一路强；组头怎么念项目名见 `src/client/trash-view.ts` 的 `projectLabel`，那是另一回事）。 */
  cwd: string
  createdAt: number
  lastActivity: number
  /** 日志内 `session/title` 那条记录；清单标题为空串时客户端拿它兜底。 */
  logTitle: string
  /** **这条会话自己的显示名**（与宿主工作中同名）。只在详情读时从被读的这条日志折出：
   *  子会话取 `subagent/descriptor` 的 `label`（值来自委派 `description`）；fork 子会话没有 descriptor，header 有
   *  `parentSession` 时取它自己日志的当前 `session/title`。它补的是没有父详情可兜的独立子会话
   *  ——那种条目的清单 `title` 是主会话那套起名法，`logTitle` 单看也是错的。
   *  缺席 = 主会话、或没有 descriptor 也没有 `parentSession` 的会话，界面回落清单标题。 */
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
  /** 整条会话的提问索引，按日志顺序；**只在首次读（不带 `before`）时出线**——它不随分页变化，
   *  跟着详情账本走，后续翻页不重复搬。没有用户提问时是空数组（缺席 = 这一读没带，不是"没有"）。 */
  prompts?: TrashDetailPromptWire[]
}

/** 回收站单条详情的线上形状（`POST /detail`）：基座 + 清册身份 + 子会话段。 */
export interface TrashDetailWire extends SessionDetailWire {
  entryId: string
  /** 跟着这条父条目一起进回收站、并**折进这一行**的孩子（清册里 `parentEntryId` 指向它，
   *  且组语义接得住——折的判据复用 `src/trash/groups.ts` 的 `visibleGroups`），按清册原序。
   *  确有孩子时出线；**缺席 = 没有孩子**，不是空数组。孩子的详情仍按 `entryId` 走同一个 `/detail`。
   *  最多过线 `src/trash/detail.ts` 的 `SUBAGENT_SUMMARY_LIMIT` 条，超出时 `subagentsTotal` 给总数。
   *  这是详情线上唯一带清册事实的一格：孩子不在客户端清单里，没有「按 entryId 与清单配对」
   *  那条路可走（`src/client/remote.ts` 头注的例外说明）。 */
  subagents?: TrashEntryWire[]
  /** 子会话总数；**只在 `subagents` 被条数闸截断时出线**（缺席 = 上面就是全部）。 */
  subagentsTotal?: number
  /** **全部**折进来的孩子的清册 `sizeBytes` 合计；有孩子时出线（即使未被条数闸截断）。
   *  摘要条报「清册大小合计」用它——不要拿 `subagents` 已列行自己求和，那只是前 N 条。 */
  subagentsSizeBytes?: number
}

/** 归档清单里的一行（`GET /archive-list`）。大小与时间的口径和回收站行**不是一个数**：
 *  这里念宿主持久化日志工件字节与「最后活动」，回收站行念清册删除时的目录实测与删除时间。 */
export interface ArchiveRowWire {
  sessionId: string
  projectDir: string
  /** 日志标题（`readTitleSnapshots` 折出的 `session/title`；缺席 = 空串）。 */
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

/** 归档清单的线上形状：**显式缺席**——`sessionQuery` 缺席时是 `{available:false}`（成功信封里的
 *  「语料不可见」），不是空列表、不是 `io`。`totalBytes` 只加已知 `sizeBytes`；`missingSizeCount > 0`
 *  时副标题必须说 N 条大小缺席。 */
export type ArchiveListWire =
  | { available: true; rows: ArchiveRowWire[]; totalBytes: number; missingSizeCount: number }
  | { available: false }

/** 归档详情里的一个子会话（宿主 `subagentMembersOf` 的闭包 + 标题/时间/大小的只读投影）。
 *  它**不是**清册行：没有条目 id、没有删除时间、也不带 `parentEntryId`。 */
export interface ArchiveSubagentWire {
  sessionId: string
  /** 这个孩子**自己**的归档态（宿主归档集，精确判据与 `isArchived` / 归档清单交集同一条，
   *  id 原样）。清单行不必带这一格（进了归档清单就是已归档的定义）；闭包行不是清单行，
   *  所以必须显式——状态行与开行路由都认这一格，**不拿「清单在不在场」冒充归档态**
   *  （清单会失败/缺席，看不见 ≠ 未归档）。 */
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

/** 归档单条详情（`POST /archive-detail`）：基座 + 会话 id + **只读子会话段**。
 *  子会话来自宿主闭包（`archiveSession` 本身不带闭包）。目标自己已归档，或是请求里
 *  `rootSessionId` 那条已归档会话的 subagent 闭包成员 ⇒ 可读；孩子正文仍只走这一条只读通道，
 *  不提供随父归档/恢复。**仅凭根放行（主体自己未归档）时不装配子会话段**：孩子视图单级，
 *  客户端对这种主体整段不画（判据住 `src/trash/archive-detail.ts`）。 */
export interface ArchiveDetailWire extends SessionDetailWire {
  sessionId: string
  /** 主体**自己**的归档态（这一读的权威判据）：`true` = 自己已归档；`false` = 仅凭已归档根的
   *  闭包放行的只读孩子。状态行认这一格，不认客户端快照或导航道。 */
  archived: boolean
  /** 主体自己已归档且有孩子时出线；**缺席 = 没有孩子，或这一条是仅凭根放行的孩子读**，
   *  不是空数组。最多过线 `SUBAGENT_SUMMARY_LIMIT` 条。 */
  subagents?: ArchiveSubagentWire[]
  /** 子会话总数；**只在 `subagents` 被条数闸截断时出线**。 */
  subagentsTotal?: number
  /** **全部**孩子里已知 `sizeBytes` 的合计；没有任何已知读数时缺席（不拿 0 冒充）。 */
  subagentsSizeBytes?: number
}

/** 一次永久删除顺带、或一次孤儿附件清理的附件读数。`skipped` 有值 = 这一轮**部分或整体没清**：
 *  有候选日志或剩余引用源读不出（原因上屏）。此时 `removed` 仍可能 > 0——损坏的只是某一组候选，
 *  其余照常清；跳过不是失败：`failed` 是逐文件真出错的那几件。 */
export interface AttachmentCleanupWire {
  removed: number
  freedBytes: number
  failed: number
  skipped?: string
}

/** 孤儿附件报告里的一条：内容哈希 + 实测字节。没有原始文件名（附件库只存内容）。 */
export interface AttachmentOrphanItemWire {
  attachmentId: string
  bytes: number
}

/** 孤儿附件报告（`GET /attachment-orphans`）：数量、总字节与对象清单。
 *  清单只带 id/bytes（不含路径/文件名），供设置页预览缩略图；条数由 Node 半配置
 *  （`src/config.ts` 的 `orphanPreviewLimit`，默认 200），数量与字节按全量算。
 *  读不出任何一处引用源时**不返回这一形状**，而是 `io` 失败——不拿 0 冒充"没有孤儿"。 */
export interface AttachmentOrphanReportWire {
  count: number
  totalBytes: number
  items: AttachmentOrphanItemWire[]
}

/** 清空回收站的聚合回执。`attachments` 缺席 = 这一版/这一轮没有附件清理读数（不拿零冒充"清过"）。 */
export interface PurgeStatsWire {
  removed: number
  freedBytes: number
  attachments?: AttachmentCleanupWire
}

/** 孤儿投影缓存报告（`GET /projection-orphans`）：条数。
 *  只念条数不猜体积——缓存记录的落盘字节不是本插件的读数面，报告不为它多引一条 stat 路径。
 *  读不出会话语料或投影缓存读面时**不返回这一形状**，而是 `io` 失败——不拿 0 冒充"没有孤儿"。 */
export interface ProjectionCacheOrphanReportWire {
  count: number
}

/** 孤儿投影缓存清理回执（`POST /projection-clean`）：删掉的条数与没能删掉的条数。
 *  `failed` 是删除失败的条数：批量写链整批失败按请求名单计；旧宿主逐条删除时是真实的部分失败。
 *  清完重查会把真实剩余量再报一次。 */
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

/** 一次孤儿扫描的报告（纯读的产物）。`roots` 是每组那个"父没了"的 subagent 自己写的原形状；
 *  `missingParents` 按**去前缀后的形状**去重——同一个失踪父在两种写法下只算一个。 */
export interface OrphanReportWire {
  roots: readonly string[]
  totalSessions: number
  totalBytes: number
  missingParents: number
  groups: readonly OrphanProjectGroupWire[]
}

/** 清理一组无主子会话的回执（与 {@link PurgeStatsWire} 同形，但计的是"删掉的会话目录"）。
 *  `attachments` 的口径与 purge 相同。 */
export interface OrphanCleanStatsWire {
  removed: number
  freedBytes: number
  attachments?: AttachmentCleanupWire
}

/** 请求参数名：浏览器半发、Node 半读，同名同义（`empty` 没有入参）。
 *  附件段是 **query 参数**（GET 二进制响应，没有请求体）。 */
export const PARAMS = {
  entryId: 'entryId',
  /** `/archive-detail` 的寻址键（红线：路径字段不过线）。 */
  sessionId: 'sessionId',
  /** 归档详情的**只读根**：看未归档子会话时带上那条已归档父会话的 id。
   *  目标自己已归档时不需要；给了也只用于校验目标在该根的 subagent 闭包里。 */
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
  /** 字节数：图片支与文件支都带——它是宿主读面的引用一部分，并先过 `maxAttachmentBytes` 闸
   *  （别为一张已知超限的图让宿主整份读出来）。 */
  attachmentBytes: 'bytes',
  attachmentWidth: 'width',
  attachmentHeight: 'height',
} as const

/* ── 请求字段组：段名表 `body` 那一格的**内容**（ADR-0003 决定 6 的字段描述面） ─────────────
 * `RouteBody` 六值只说「哪一组」，这里说「这组有哪些字段、每个字段什么种类」。字段名与种类是线上
 * 形状（浏览器半的 interface 签名按它写、Node 半的字段闸按它派生），写错与写错方法同一类事故——
 * 所以与 `path` / `method` 同家。Node 半的通用解析手（`src/api/route-table.ts`）拿这份描述把
 * JSON 体读成 typed 字段，五种错误原文各只写在解析手那一处。 */

/** 请求体字段的种类 → 解析后的类型：种类只在这一处兑现成类型（`action` 给 `ApplyAction` 而不是裸串，
 *  动作名单由类型闸钉死）。新增种类只改这张表的键，解析手的 switch 与 {@link ParsedBody} 会一起编译错
 *  直到补齐。 */
type ParsedByKind = {
  requiredString: string
  optionalString: string | undefined
  optionalCursor: number | undefined
  action: ApplyAction
  idArray: string[]
}

/** 请求体字段的种类：每一种由通用解析手的一种读法兑现，拒绝原文也按种类只写一遍。 */
export type BodyFieldKind = keyof ParsedByKind

/** 一个字段组：字段键 → 字段种类。键必须是 {@link PARAMS} 的成员——类型只收窄值、不收窄键，
 *  键↔`PARAMS` 的配对由 `tests/wire-shape.test.ts` 的运行期用例把守；组里引用同一常量，不抄第二份。 */
export type BodyGroup = Readonly<Record<string, BodyFieldKind>>

/** 段名表每格 `body` → 那一段的字段组描述。空组 = 这一层没有要拦的字段：`none` / `query` 没有
 *  JSON 字段；`config` 的三只旋钮由 `src/verbs/config.ts` 的 Standard Schema 按自己的口径校验
 *  （未知键 / 非整数 / 越界都归它），路由层的字段闸故意不覆盖它——两处都拦就是两本账。 */
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
 * 线上递过来的是**一段 JSON**（标记位不跟着过线）⇒ 标记位只由**宿主服务抛出的 `RemoteError`** 自带，
 * 本仓生产侧不造它：Node 半的 `toRemoteFailure`（`src/remote/map-error.ts`）只**消费**它，产出的
 * `RemoteFailure` 是普通过线对象；浏览器半的取数通道**不抛失败、也不补标记**——信封原样当数据交回
 * （`RemoteOutcome`），通道自己造的诊断（打不通 / 非信封 / 401·403）是普通失败对象，不进这条判别；
 * 测试假件同样不认标记位：用例设的 `RemoteFailure` 原样交回组件（`tests/client/support/fake-remote.ts`）。
 */
export function isDSHRemoteError(value: unknown): value is RemoteFailure {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { isDSHRemoteError?: unknown; code?: unknown }
  return candidate.isDSHRemoteError === true && typeof candidate.code === 'string'
}

/**
 * 运行期判形「这段 JSON 是不是信封」。中间层（反代 / SPA 兜底）会回 `{}`、`{"error":"…"}` 这类
 * 不是信封的 JSON；判形不过就该走「回的不是信封」诊断，而不是把垃圾喂给展开层炸出
 * TypeError / "undefined" 上屏（issue #8 第 1 条）。判据就是两臂的形状：`ok` 必须是布尔，
 * `ok:true` 须带 `value` 键（值可以是 null），`ok:false` 的 `error` 须是带 string `code`/`message` 的对象。
 */
export function isRemoteResult(value: unknown): value is RemoteResult<unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const body = value as { ok?: unknown; value?: unknown; error?: unknown }
  if (typeof body.ok !== 'boolean') return false
  if (body.ok) return 'value' in body
  if (typeof body.error !== 'object' || body.error === null) return false
  const error = body.error as { code?: unknown; message?: unknown }
  return typeof error.code === 'string' && typeof error.message === 'string'
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

/** 失败码的前缀。读码只走下面两条，别在调用点各写一份字面量。 */
const CODE_PREFIX = `${SESSION_DELETE_ERROR_DOMAIN}/`

/** `error.code` 是不是本仓的失败形状（`sessiondelete/<后缀>`）。**只认前缀**：后缀在不在册是
 *  {@link verbCodeOf} 的问题。任何要「已经是本仓的码就原样对待」的调用点都问这一句，不在调用点
 *  再写一份前缀字面量。 */
export function isSessionDeleteCodeError(error: unknown): boolean {
  const raw = (error as { code?: unknown } | undefined)?.code
  return typeof raw === 'string' && raw.startsWith(CODE_PREFIX)
}

/** `error.code` 折回那个动词词：前缀与后缀两件都成立才交回（后缀要在 {@link VERB_CODES} 册上）。
 *  路由自检码、别域的码、非字符串 code 一律 `undefined`。 */
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
