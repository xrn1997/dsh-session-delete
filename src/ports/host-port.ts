import { captureAgentHandles } from './agent-handles.js'
// 闭包与 bare 归一的唯一实现在领域纯部件里（见其头注）：端口只保留「一层一次宿主调用」的 adapter 职责。
import { bareSessionId, closureOf, sessionIdShapes } from '../domain/closure.js'
import { NO_CWD_PROJECT_DIR, escapeProjectKey } from '../shared/project-key.js'

/** 摘内存的三种落地（见 {@link HostPort.evictLive}）：`not-live` / `evicted` 都意味着**宿主列表已经不含它**；
 *  `unknown` 意味着读不到或摘不掉，**不能**据此通告客户端（发了就是假话，重连后那一行会自己长回来）。 */
export type EvictionOutcome = 'evicted' | 'not-live' | 'unknown'

/** 角色一：身份与归属——会话是谁、落在哪个项目/工作区、活不活/归档没有，以及账本与归档的写面。只切类型，adapter 仍是同一颗对象。 */
export interface HostIdentityPort {
  workspaceOf(sessionId: string): Promise<string | undefined>
  /** 账本里还有这个工作区吗：只读判别，不抛。宿主的「删除工作区」只删注册、保留目录与日志；恢复这类会话时跳过 attach，归入「未分组」。 */
  workspaceExists(workspaceId: string): Promise<boolean>
  /** 会话落盘的**项目目录名**（`<sessions>/<projectKey(cwd)>`）；账本里没有这个会话 ⇒ `undefined`。header 走公开 live/持久化读面；
   *  与 `workspaceOf` 同一口径：**未命中是正常的 no-op，不是故障**（存储真故障照抛）。 */
  projectDirOf(sessionId: string): Promise<string | undefined>
  /** 删除时**尽力**取的会话显示名，**与宿主工作中同名**：子会话（`subagent` 投影有 label）取 label，其余取 `title` 投影；取不到返回空串，
   *  绝不因此让删除失败。子会话不按 `title` 起名：同批子会话会撞成同名分不清（ADR-0058）。名字只存在于宿主自己的账本/缓存里 ⇒ 取数面归宿主端口。 */
  titleOf(sessionId: string): Promise<string>
  /** 子会话显示名的**投影 label 本体**（`subagent` 行的 `label`）：空串 = 没有，**不回落标题**——回落是 {@link HostIdentityPort.titleOf} 的口径。 */
  labelOf(sessionId: string): Promise<string>
  isLive(sessionId: string): Promise<boolean>
  isArchived(sessionId: string): Promise<boolean>
  /** registry **全局**归档集原样（同步数组读；Promise 外壳与其余成员同形）。 */
  archivedSessionIds(): Promise<readonly string[]>
  unarchive(sessionId: string): Promise<void>
  detach(sessionId: string, workspaceId: string): Promise<void>
  attach(sessionId: string, workspaceId: string): Promise<void>
  /** 归档是 registry **全局**的，与工作区账目无关 ⇒ 只收 `sessionId`（未分组的会话同样只有这一条归档路）。 */
  archive(sessionId: string): Promise<void>
}

/**
 * 角色二：**在场通告**——摘掉宿主内存里的活体，并如实通告客户端"这个会话没了 / 回来了"。
 * 这一组的方法按契约**不抛**（`evictLive` 三态、`announce*` 内部吞异常）：收尾失败不把已经完成的那件事翻成失败。
 */
export interface HostPresencePort {
  /** 尽力把会话从宿主**内存里的 live store** 摘掉；三态见 {@link EvictionOutcome}。**这是本仓走宿主内部入口的几处之一**：
   *  "磁盘上的持久化"我们搬得走，"内存里 attach 着的活体"只有这一条路能请掉。 */
  evictLive(sessionId: string): Promise<EvictionOutcome>
  /** **如实通告**客户端"这个会话没了"：发宿主自己声明并转发的 `api-session/removed`，客户端当场删行。冷会话没有活体可摘，同样需要这一条。 */
  announceRemoved(sessionId: string): Promise<void>
  /** 一组会话的「回来了」通告：宿主会话表拉一次，按 id 逐条发 added。单条就是长度为 1 的批；缺席 id 不发，不影响已完成的恢复。 */
  announceRestored(sessionIds: readonly string[]): Promise<void>
}

/**
 * 一次语料读的结果：**缺席显式化**——`available: false` 说的是"这一趟看不见语料"（服务没挂或读面方法缺席），
 * 与"读到了、里面是空的"是两件事。**不带原因串**：调用点的策略已经决定了怎么处理，带一个字就会有人去断言那个字。
 */
export type CorpusRead<T> =
  | { readonly available: true; readonly value: T }
  | { readonly available: false }

/**
 * 角色三：**会话语料**——整表身份与子会话闭包。可缺席的读面都把"这一趟看不见语料"写成显式的 {@link CorpusRead}；
 * **缺席之后怎么办归调用方，清单见 `docs/architecture.md` §2 的「语料缺席」**。`readSession` 是整本读：方法缺席与读失败都抛，不折成缺席。
 */
export interface HostCorpusPort {
  /** 整个会话语料（live ∪ persisted）的只读身份表。**服务缺席是显式的**：不拿空数组冒充“这个家没有会话”。 */
  listSessions(): Promise<CorpusRead<readonly SessionIdentity[]>>
  /** 一次 BFS 点出多个父的全部后代（传递闭包）。**缺席是显式的，且优先于空入参**：不拿空表冒充"盘上没有后代"。
   *  服务在场时，空入参 ⇒ `{ available: true, value: {} }`，一次宿主调用都不发；键按调用方传进来的写法回。 */
  subagentMembersOf(parentIds: readonly string[]): Promise<CorpusRead<Record<string, readonly SubagentMember[]>>>
  /** 批量读日志标题：id → 标题；无标题 / 单条 rejected ⇒ **该 id 不在 map**（不失败整张表）。方法缺席或整次读抛错 ⇒ `{ available: false }`。 */
  titleSnapshots(ids: readonly string[]): Promise<CorpusRead<ReadonlyMap<string, string>>>
  /** 提问时间表（`sessionController.list()` 的 `updatedAt`）：id → 最后提问时间；服务缺席 / 抛错 ⇒ `{ available: false }`（调用方回退 `createdAt`）。 */
  sessionActivity(): Promise<CorpusRead<ReadonlyMap<string, number>>>
  /** 持久化日志工件字节表（`sessionPersistence.list()` 的 `sizeBytes`）；值 `undefined` = 该行**没有可信读数**（不是 0）。
   *  服务缺席 ⇒ `{ available: false }`；`list()` 抛错 ⇒ 抛（调用方整档 `io`，不拿 0 冒充没有大小）。 */
  persistedSizes(): Promise<CorpusRead<ReadonlyMap<string, number | undefined>>>
  /** 持久化服务是否挂载（只探服务，不读列表）：用来区分「没有持久化服务」与「服务在场但列表读面坏了」——
   *  后者可能有看不见的会话，必须失败关闭（ADR-0062）；单看 `persistedSizes()` 的 `available:false` 分不出来。 */
  persistenceMounted(): boolean
  /** 整本读（replay 校验、不 make live）：header 事实 + 完整事件流。**事件流不含 `session` 头记录**——调用方自己合成头。
   *  方法缺席（旧宿主）⇒ 抛；读失败**原样抛**（含 `SESSION_QUERY_SESSION_NOT_FOUND`，折 `not-found` 归上层）。 */
  readSession(sessionId: string): Promise<CorpusLogRead>
}

/** `readSession` 的窄读面：header 事实三格 + 事件流。多余字段留在原对象上，类型面只声明消费方用到的。 */
export interface CorpusLogRead {
  readonly session: {
    readonly createdAt?: number
    readonly cwd?: string
    readonly parentSession?: string
  }
  readonly events: readonly CorpusEvent[]
}

/** 一条事件的窄读面（宿主 `SessionEvent` 的 `{ type, seq, time, data }` 信封；`seq` 等多余字段原样留着）。 */
export interface CorpusEvent {
  readonly type: string
  readonly time: number
  readonly data?: unknown
}

/**
 * 角色四：**投影缓存**——宿主 `session_projcache` 域的会话记录键集与落盘删除面。
 *
 * 缓存服务本身只有写与读，**没有删除方法**；记录由 storage domain 的 `sessions` 表承载（`per-record` 布局）。
 * 删除只能经 `storageDomain.get('session_projcache').table('sessions')` 的同一条写链：**不直接删 `storages/`
 * 下的文件**——那会绕过域的内存权威（`docs/architecture.md` §6：storages 是内部索引，外面改它要重启宿主才自洽）。
 *
 * 读面只认**已打开的存储域**，不拿缓存服务缺席当「没有记录」：旧版本或另一份 composition 可能留下记录，
 * 服务没挂时更要报 `{ available: false }`。域不可用、形状不符或 `keys()` 抛错都算读面不可用。
 * 读/写再分两片：`HostCorePort` 只拿读面，`dropProjectionCache` 只进 `HostRemovalPort`（最小权限，ADR-0032）。
 */
export interface HostProjectionReadPort {
  /** `session_projcache` 域 `sessions` 表的全部键（**键就是会话 id**；`session-` 与 bare 两代写法原样返回）。域不可用 ⇒ `{ available: false }`。 */
  projectionCacheIds(): Promise<CorpusRead<readonly string[]>>
}

/** 投影缓存的删除回执：真正删掉的条数与**逐条删除时**失败的条数（批量删除失败整体抛，不折回执）。 */
export interface ProjectionCacheDropResult {
  readonly removed: number
  readonly failed: number
}

export interface HostProjectionWritePort {
  /** 从 `session_projcache` 域删掉这些会话的记录。批量写链抛错 ⇒ 原样抛；旧宿主逐条 `delete` 时单条失败收进 `failed`、继续删其余条。 */
  dropProjectionCache(sessionIds: readonly string[]): Promise<ProjectionCacheDropResult>
}

export interface HostProjectionPort extends HostProjectionReadPort, HostProjectionWritePort {}

/** 复合别名：adapter（`createHostPort`）与调用方把四个角色的方法当一个端口用；角色是它的切面。 */
export type HostPort = HostIdentityPort & HostPresencePort & HostCorpusPort & HostProjectionPort

/** 动词的宿主面：身份、语料与投影缓存**读面**三片；不含在场三件，也不含投影缓存删除面。摘活体与通告只经 `CoreDeps.presence`，
 *  删缓存只经 {@link HostRemovalPort}。用交集而不是 `Omit` 黑名单：`HostPresencePort` 将来长出新方法时不会自动漏进每个动词的 `host`。 */
export type HostCorePort = HostIdentityPort & HostCorpusPort & HostProjectionReadPort

/** 永久删除的宿主面：核心面 + 投影缓存删除面。只给 `RemovalDeps`（执行器与维护卡清理段）。 */
export type HostRemovalPort = HostCorePort & HostProjectionWritePort

/* ------------------------------------------------------------------ *
 * 宿主服务的**窄镜像**：只声明本端口用到的成员（AGENTS.md：不装宿主类型包、不做 declare module）。
 * 成员注释写明宿主服务与出处——镜像的判据是宿主产物，不是包名；宿主换代先按这些出处复核。
 * ------------------------------------------------------------------ */

/** Workspace 实体的最小面：按方法面判，不按 constructor.name 判。出处：asar `dsh-workspace/lib/index.js` 的 `Workspace` 声明（运行时实体名 `WorkspaceEntity`）。 */
interface WorkspaceEntityLike {
  readonly id: string
  readonly sessionIds: readonly string[]
  detachSession(sessionId: string): Promise<void>
  attachSession(sessionId: string): Promise<void>
}

/** `ctx.workspaceRegistry` 的最小面：`list()` 同步账本投影，`get(id)` 未知返回 `undefined`，归档集是全局的。
 *  出处：asar `dsh-workspace/lib/index.js` 的 `WorkspaceRegistry`（inject `storageDomain` / `sessionPersistence`）。 */
interface WorkspaceRegistryLike {
  list(): WorkspaceEntityLike[]
  get(id: string): WorkspaceEntityLike | undefined
  readonly archivedSessionIds: readonly string[]
  unarchiveSession(sessionId: string): Promise<void>
  archiveSession(sessionId: string, options?: { readonly stopActivity?: boolean }): Promise<void>
}

/** `ctx.sessions` 的最小面：`get(id)` 取会话（header 供公开 header 读面用），`liveEntryFor(session).detach()` 摘活体。
 *  出处：asar `dsh-session/lib/index.js` 的 `SessionStore.get` / `liveEntryFor` / `detachEntered`；detach 是宿主 owner 自己的摘除路
 *  （单次、幂等、会发 `session/disposed`）。宿主换代先复核这两个方法。 */
interface LiveSessionsLike {
  get(id: string): unknown
  /** 返回形状按真实宿主放宽：找不到活体时可能回 null / undefined，`detach` 也未必在——「镜像钉死≠运行时必有」。 */
  liveEntryFor(session: unknown): { detach?: () => void } | null | undefined
}

/** live store 的最小方法面判据（同 `projectionCacheOf` 的手法：按方法面判，不按 constructor.name）。 */
function liveSessionsOf(ctx: HostCtxLike): LiveSessionsLike | undefined {
  const store = ctx.get('sessions') as LiveSessionsLike | null | undefined
  // 宿主 `ctx.get` 可能回 null（镜像钉死≠运行时必有），空值判据连同 null 一起写。
  if (store === undefined || store === null) return undefined
  if (typeof store.get !== 'function' || typeof store.liveEntryFor !== 'function') return undefined
  return store
}

/** `ctx.sessionPersistence` 的最小面：公开的单条会话元数据读面。出处：`@deepseek-ai/dsh-session-persistence` 的 `SessionPersistence.stat`
 *  （快照 `header` 带 `cwd`）。它是 `workspaceRegistry` 的硬注入服务（标准组合必有），按 `ctx.get` 可选读、不进 inject。
 *  `list` 是批量快照读（`SessionPersistenceSnapshot` 带可选 `sizeBytes`——JSONL 后端给物理工件字节，其他后端可能不给）。 */
interface SessionPersistenceLike {
  stat(id: string, options?: unknown): Promise<{ readonly header?: { readonly cwd?: string } } | undefined>
  list?(): Promise<readonly { readonly header?: { readonly id?: string }; readonly sizeBytes?: unknown }[]>
}

/**
 * 会话 header 的**公开**读面：live `sessions.get(id).header` 优先，否则 `sessionPersistence.stat(id).header`。未知会话回 `undefined`；
 * 需要落到持久化时服务缺席 / 形状不符抛错，由调用方决定是响亮失败（projectDirOf）还是降级（titleOf 的空串）。
 */
async function headerOf(host: HostCtxLike, sessionId: string): Promise<{ readonly cwd?: string } | undefined> {
  const store = liveSessionsOf(host)
  if (store !== undefined) {
    try {
      const live = store.get(sessionId) as { header?: { cwd?: string } } | null | undefined
      if (live?.header !== undefined) return live.header
    } catch {
      // live 读面失败不改走"未命中"：交给持久化再答一次
    }
  }
  const persistence = host.get('sessionPersistence') as SessionPersistenceLike | null | undefined
  if (persistence === undefined || persistence === null || typeof persistence.stat !== 'function') {
    throw new Error('session-delete: sessionPersistence 服务缺席')
  }
  const snapshot = await persistence.stat(sessionId)
  return snapshot?.header
}

/** 会话标题的投影缓存读面；可选服务，按 `ctx.get` 读，不进 inject。出处：asar `dsh-api-session-controller/lib/index.js` 的 `projectionsFor`（`cachedSnapshot` 优先、回退 `cachedPredecessorTitle`）。
 *  `title` 与 `subagent` 两个投影行都在同一份 checkpoint 里：`subagent` 行的 `label` 是宿主子智能体面给子会话的显示名。 */
interface ProjectionCacheLike {
  cachedSnapshot(header: unknown, keys?: readonly string[]): { readonly values: Record<string, unknown> } | undefined
  cachedPredecessorTitle(header: unknown): { readonly values: Record<string, unknown> } | undefined
}

/** `subagent` 投影行里的 label：形状不符 / 空串一律当没有（降级，不响亮失败）。 */
function subagentLabelOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return ''
  const label = (value as { label?: unknown }).label
  return typeof label === 'string' ? label : ''
}

/** `storageDomain` facility 的最小面：`get(name)` 取**已经打开**的域。官方 `.d.ts` 把它标成 diagnostic surface；但缓存服务自己没有
 *  删除面，这是当前唯一一条仍走域写链的落盘入口。`session_projcache` 由宿主的缓存服务以 `per-record` 布局打开，本插件只 `get`、不 `open`
 *  （同名域第二次 `open` 会抛 `already-open`）。 */
interface ProjectionCacheTableLike {
  keys(): IterableIterator<string>
  delete(key: string): Promise<boolean>
  /** 批量删：一个写槽；旧宿主没有就逐条 `delete`。 */
  deleteMany?(keys: readonly string[]): Promise<number>
}

interface ProjectionCacheDomainLike {
  /** 运行时可能回 null / undefined（镜像钉死≠运行时必有）；调用方按方法面判。 */
  table(name: string): ProjectionCacheTableLike | null | undefined
}

interface StorageDomainFacilityLike {
  /** 运行时可能回 null（镜像钉死≠运行时必有）；调用方按形状判。 */
  get?(name: string): ProjectionCacheDomainLike | null | undefined
}

const PROJECTION_CACHE_DOMAIN = 'session_projcache'
const PROJECTION_CACHE_TABLE = 'sessions'

/** 取已打开的投影缓存表；域未打开 / 形状不符 ⇒ `undefined`。**缓存服务缺席不是一条判据**：旧版本可能留下记录，
 *  只要域已打开就照读；读面回显式缺席，删除收尾降级为 warning。 */
function projectionCacheTableOf(host: HostCtxLike): ProjectionCacheTableLike | undefined {
  const facility = host.get('storageDomain') as StorageDomainFacilityLike | null | undefined
  if (facility === undefined || facility === null || typeof facility.get !== 'function') return undefined
  let domain: ProjectionCacheDomainLike | null | undefined
  try {
    domain = facility.get(PROJECTION_CACHE_DOMAIN)
  } catch {
    return undefined
  }
  if (domain === undefined || domain === null) return undefined
  let table: ProjectionCacheTableLike | null | undefined
  try {
    table = domain.table(PROJECTION_CACHE_TABLE)
  } catch {
    return undefined
  }
  if (typeof table?.keys !== 'function' || typeof table.delete !== 'function') return undefined
  return table
}

/** 端口实际读到的 ctx 面（一次强转的落点）。 */
interface HostCtxLike {
  readonly workspaceRegistry: WorkspaceRegistryLike
  waterfall(
    name: string,
    args: { readonly sessionId: string },
    next: () => Promise<readonly unknown[]>,
  ): Promise<readonly unknown[]>
  /** cordis 的可选服务读法（`ctx.get(name)`），官方用它读可选服务。 */
  get(name: string): unknown
  /** cordis 的卸载钩子：`effect` 当场跑交回的工厂、把返回的清理挂在插件作用域上。`agent-handles.ts` 用它登记 wrapper 的恢复；
   *  缺席（旧 ctx / 假件）时只是没有恢复。 */
  effect?(execute: () => () => unknown, label?: string): unknown
  /** cordis 事件发送：首参不是对象/函数时不带 carrier，全量派发到转发器；announce* 依赖这一点。
   *  出处：asar `@deepseek-ai/cordis/lib/index.js` 的 `dispatch`（`const filter = thisArg?.[Context.filter]`）。 */
  emit(name: string, ...args: readonly unknown[]): void
}

/** `ctx.get('sessionQuery')` 的最小面；可选服务，不进 inject。出处：asar `dsh-session-query/lib/index.js` 的 `sessionPredicate`
 *  （`filterSessions` 按 `header.parentSession` 取直接孩子，宿主换代先复核这一支）；`readTitleSnapshots` 与 `readSession`
 *  供归档档读面，两者都是可选成员（旧宿主缺席，降级/失败口径归 `HostCorpusPort` 的成员注释）。 */
interface SessionQueryLike {
  listSessions(signal?: unknown): Promise<readonly {
    readonly header?: {
      readonly id?: string
      readonly cwd?: string
      readonly parentSession?: string
      readonly origin?: string
      readonly createdAt?: number
    }
  }[]>
  filterSessions(
    filters: readonly { readonly kind: string; readonly values: readonly string[] }[],
  ): Promise<readonly { readonly header?: { readonly id?: string; readonly cwd?: string; readonly parentSession?: string; readonly origin?: string } }[]>
  readTitleSnapshots?(ids: readonly string[], signal?: unknown): Promise<readonly unknown[]>
  readSession?(sessionId: string, signal?: unknown): Promise<unknown>
}

/** 官方的「这些父的孩子」那一支：`kind:'parent'` 只按 `parentSession` 原样匹配，**不是**子会话分类器——旧宿主（≤0.2.1-rc.5）
 *  的普通 fork 也写 `parentSession`，0.2.2-alpha.2 起才不写。子会话的判据是 `origin` 的 subagent 标记，所以调用方必须再筛一遍。 */
async function filterChildrenOf(
  sessionQuery: SessionQueryLike,
  values: readonly string[],
): Promise<readonly { readonly header?: { readonly id?: string; readonly cwd?: string; readonly parentSession?: string; readonly origin?: string } }[]> {
  return sessionQuery.filterSessions([{ kind: 'parent', values: [...values].sort() }])
}

export interface SessionIdentity {
  readonly sessionId: string
  readonly parentSessionId?: string
  readonly projectDir: string
  readonly subagent: boolean
  /** `header.createdAt`（归档行「创建于」回退与排序的原料）；header 上真缺席或非正数 ⇒ **不落键**（不拿 0 冒充 1970）。 */
  readonly createdAt?: number
}

/** 闭包里的一条后代：`sessionId` 是宿主交回的原写法（身份只认它，归一比对交给闭包部件）。 */
export interface SubagentMember {
  readonly sessionId: string
  readonly projectDir: string
}

/**
 * 从若干根逐层向下问出后代，交回 `父（bare）→ 孩子` 的索引。用 `kind:'parent'` 而不是 traceSession：父进回收站后 traceSession
 * 认不出目标（`SESSION_QUERY_SESSION_NOT_FOUND`），而这里要的正是父不在宿主列表之后仍留在盘上的那批。官方那一支的判据逐字是
 * `values.includes(record.header.parentSession ?? null)`，只按原样匹配、不是子会话分类器（旧宿主的普通 fork 也写它）。一层一次宿主调用，问空即停；
 * `seen` 防环；没有 `header.id` 的记录整条跳过（无法作为身份继续下问）。
 */
async function descendantsByParent(
  sessionQuery: SessionQueryLike,
  roots: readonly string[],
): Promise<Map<string, SubagentMember[]>> {
  const children = new Map<string, SubagentMember[]>()
  // 请求根也要能被父根发现：预先把所有根塞进 seen 会把「父+子同批」的子根从父闭包里抹掉。
  const seen = new Set<string>()
  let frontier = [...new Set(roots.map(bareSessionId))]
  while (frontier.length > 0) {
    const values: string[] = []
    for (const bare of frontier) {
      for (const shape of sessionIdShapes(bare)) if (!values.includes(shape)) values.push(shape)
    }
    const next: string[] = []
    for (const record of await filterChildrenOf(sessionQuery, values)) {
      const id = record.header?.id
      const parent = record.header?.parentSession
      if (typeof id !== 'string' || id.length === 0) continue
      if (typeof parent !== 'string' || parent.length === 0) continue
      // 只有 subagent 才是组员；普通 fork 的 parentSession 只是来源记录。非 subagent 不穿透：它的 subagent 孩子属于它，不属于正在删的父。
      if (record.header?.origin !== 'subagent') continue
      const bare = bareSessionId(id)
      if (seen.has(bare)) continue
      seen.add(bare)
      const cwd = record.header.cwd
      const descendant: SubagentMember = {
        sessionId: id, projectDir: projectDirOfCwd(cwd),
      }
      const parentBare = bareSessionId(parent)
      const siblings = children.get(parentBare)
      if (siblings === undefined) children.set(parentBare, [descendant])
      else siblings.push(descendant)
      next.push(bare)
    }
    frontier = next
  }
  return children
}

/**
 * 语料读面的父 id 清单归一：**丢空 id、重复只算第一次、保序**，返回新数组（不改入参）。**为什么导出**：`subagentMembersOf` 的键集
 * 与 `tests/support/fake-deps.ts` 的假 adapter 是同一件事——两边调同一个函数，改口径时生产与假件一起红。
 */
export function normalizeParentIds(parentIds: readonly string[]): string[] {
  const wanted: string[] = []
  for (const id of parentIds) if (id.length > 0 && !wanted.includes(id)) wanted.push(id)
  return wanted
}

/** {@link HostCorpusPort.subagentMembersOf} 的那一次 BFS：这里只负责问宿主，某个根的后代闭包由纯部件的 `closureOf` 在交回的索引上收
 *  （深度不设上限、防环、首见去重都在那一处）；空清单在调用宿主之前就返回。 */
async function membersFor(
  sessionQuery: SessionQueryLike,
  parentIds: readonly string[],
): Promise<Record<string, readonly SubagentMember[]>> {
  const wanted = normalizeParentIds(parentIds)
  if (wanted.length === 0) return {}
  const children = await descendantsByParent(sessionQuery, wanted)
  const out: Record<string, readonly SubagentMember[]> = {}
  for (const id of wanted) out[id] = closureOf(children, id)
  return out
}

/** `ctx.sessionController` 的最小面：`list()` 回会话摘要；数组与 `{items}` 两种形状都接受。出处：asar `dsh-api-session-controller/lib/index.js` 的 `listState.list`。 */
interface SessionListLike {
  list(signal?: unknown): Promise<unknown>
}

/** 宿主 `projectKey(cwd)` 的逐字镜像：编码与解码配对住在 `src/shared/project-key.ts`（字母表只有一份）；`projectDirOf` 与回收站对账重建共用。 */
export const projectKey = escapeProjectKey

/**
 * cwd（可缺席）→ 会话落盘的项目目录名：**只有缺席**（`undefined`）落 `_no-cwd`；空串照常编码——`''` 不是"没有这一格"。
 * 删除计划、会话列表投影与对账重建**共用这一处**：三处各写一遍三元式，`''` 迟早有一处落成 `_no-cwd`，同一条会话就会指向两个目录。
 */
export function projectDirOfCwd(cwd: string | undefined): string {
  return cwd === undefined ? NO_CWD_PROJECT_DIR : projectKey(cwd)
}

/** 投影缓存服务的最小方法面判据（按方法面判，不按 `constructor.name` 判）。 */
function projectionCacheOf(ctx: HostCtxLike): ProjectionCacheLike | undefined {
  const cache = ctx.get('sessionProjectionCache') as ProjectionCacheLike | null | undefined
  // 同 `liveSessionsOf`：镜像钉死≠运行时必有，null 也是缺席的一种。
  if (cache === undefined || cache === null) return undefined
  if (typeof cache.cachedSnapshot !== 'function' || typeof cache.cachedPredecessorTitle !== 'function') return undefined
  return cache
}

/** 宿主会话表的一次取数（`ctx.sessionController.list()` 的两种返回形状都折成数组）。服务没挂 / 形状不对 / 抛错 ⇒ 空表——
 *  **这条不替宿主兜错误**：调用方拿空表的语义都是"少发一条通告"，不是"恢复失败"。 */
async function controllerItems(host: HostCtxLike): Promise<readonly unknown[]> {
  try {
    const controller = host.get('sessionController') as SessionListLike | null | undefined
    // 宿主读面可能回 null（镜像钉死≠运行时必有），空值判据必须认它。
    if (controller === undefined || controller === null || typeof controller.list !== 'function') return []
    const listed = await controller.list()
    const items: unknown = Array.isArray(listed) ? listed : (listed as { items?: unknown } | null)?.items
    // `Array.isArray` 只证明"是数组"，元素仍是 any：逐个过一遍把它交成 unknown[]，不断言形状。
    return Array.isArray(items) ? items.map((item: unknown) => item) : []
  } catch {
    return []
  }
}

/** 一条事件的形状判据：折叠要读 `type` 与 `time` 两格，判过就把原对象交出去（信封多余字段留着）。 */
function isCorpusEvent(item: unknown): item is CorpusEvent {
  if (typeof item !== 'object' || item === null) return false
  const { type, time } = item as { readonly type?: unknown; readonly time?: unknown }
  return typeof type === 'string' && typeof time === 'number'
}

/** 账本里没有那个工作区时 {@link HostPort.attach} / {@link HostPort.detach} 抛的原话开头。**原话与判据同住这里**：调用方不许另抄一份字符串。 */
const WORKSPACE_MISSING_MESSAGE = 'workspace not found'

/** 这次失败是不是"账本里没那个工作区"（而不是另有故障）：前者按「未分组」收，后者照旧回滚报 `io`——不给真故障静默改归属的机会。 */
export function isWorkspaceMissingError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(WORKSPACE_MISSING_MESSAGE)
}

/** 宿主服务的真实绑定；出错原样抛，由 `toRemoteFailure` 按 name 映射（错误映射表住 `src/remote/map-error.ts`）。 */
export function createHostPort(ctx: unknown): HostPort {
  const host = ctx as HostCtxLike
  const registry = host.workspaceRegistry
  const agentHandles = captureAgentHandles(host)

  return {
    /** 账本里记着这个会话的工作区：`registry.list()` 的实体 `sessionIds`（该 getter 已按 canonical cwd 过滤过）。 */
    // eslint-disable-next-line @typescript-eslint/require-await -- 账本读面按 Promise 声明（与在场其余成员同形），这一问是 `registry.list()` 的同步 getter。
    async workspaceOf(sessionId) {
      return registry.list().find(workspace => workspace.sessionIds.includes(sessionId))?.id
    },

    /** 账本里还有这个工作区吗：`registry.get(id)` 是同步 Map 查找，未知 id 回 `undefined` ⇒ 只做一次判别，不抛。 */
    // eslint-disable-next-line @typescript-eslint/require-await -- 上面那条说的就是它：同步直通，Promise 只来自成员面的统一形状。
    async workspaceExists(workspaceId) {
      return registry.get(workspaceId) !== undefined
    },

    /**
     * cwd → 宿主项目目录名；没有 cwd 落到 `_no-cwd`。header 走公开面（live `sessions` → `sessionPersistence.stat`）；
     * 未知会话回 `undefined`（未命中，不是故障），服务缺席/真存储故障照抛。未命中由 `delete-session.ts` 折成 `not-found`，真故障留 `io`。
     */
    async projectDirOf(sessionId) {
      const header = await headerOf(host, sessionId)
      if (header === undefined) return undefined
      return projectDirOfCwd(header.cwd)
    },

    /** 显示名走宿主投影缓存（与工作中同名）：子会话取 `subagent` 投影的 label，其余取 `title` 行的**视图值**（整条未命中才回落 predecessor）。
     *  header 来自公开的 live/持久化读面，尽力取，取不到返回空串。 */
    async titleOf(sessionId) {
      try {
        const header = await headerOf(host, sessionId)
        if (header === undefined) return ''
        const cache = projectionCacheOf(host)
        const snapshot = cache?.cachedSnapshot(header, ['title', 'subagent'])
        const label = subagentLabelOf(snapshot?.values.subagent)
        if (label !== '') return label
        // 回落沿用旧口径：**缓存这一格缺席**（不是"有行但值是 null"）才换 predecessor 标题那一问。
        const block = snapshot !== undefined && snapshot.values.title !== undefined
          ? snapshot
          : cache?.cachedPredecessorTitle(header)
        const title = block?.values.title
        return typeof title === 'string' ? title : ''
      } catch {
        return ''
      }
    },

    /** 子会话 label 的单问面：`subagent` 投影行的 `label` 本体，空串 = 没有（不回落标题，见接口注释）。 */
    async labelOf(sessionId) {
      try {
        const header = await headerOf(host, sessionId)
        if (header === undefined) return ''
        const cache = projectionCacheOf(host)
        return subagentLabelOf(cache?.cachedSnapshot(header, ['subagent'])?.values.subagent)
      } catch {
        return ''
      }
    },

    /** 活跃判据走宿主 `workspace/session-activity` waterfall：空数组 = 无活动，与宿主 archiveSession 的准入同源。
     *  family 不止 turn（后台 job / 活动定时任务也会回条目），所以只判"非空"，不按某一个 family 现推。 */
    async isLive(sessionId) {
      const activity = await host.waterfall(
        'workspace/session-activity',
        { sessionId },
        () => Promise.resolve([]),
      )
      return activity.length > 0
    },

    /** registry 全局归档集（数组，`state.archivedSessionIds`）。 */
    // eslint-disable-next-line @typescript-eslint/require-await -- 归档集是同步数组读，Promise 只来自在场其余成员的统一形状。
    async isArchived(sessionId) {
      return registry.archivedSessionIds.includes(sessionId)
    },

    /** registry 全局归档集**原样**（归档清单的交集原料；与 {@link HostIdentityPort.isArchived} 同一格事实）。 */
    // eslint-disable-next-line @typescript-eslint/require-await -- 归档集是同步数组读，Promise 只来自在场其余成员的统一形状。
    async archivedSessionIds() {
      return registry.archivedSessionIds
    },

    /**
     * 从 `ctx.sessions` 摘掉会话，并关闭捕获到的 agent handle。会话列表 = 磁盘持久化 ∪ 内存活体，搬走文件只清掉一侧；宿主
     * `SessionController` 会丢掉 `AgentHandle`，所以 `agent-handles.ts` 按会话 id 留住 handle，这里先 detach 再 dispose。
     * 捕获不到 handle（插件激活前已启动，或 `ctx.agents` 形状变化）时只能摘 session，这是已知限制，不拿归档兜底（ADR-0008）。
     *
     * 三态：读不到 store / 形状不符 / detach 或 dispose 抛 ⇒ `unknown`（不通告）；内存里本来没有 ⇒ `not-live`；摘成功 ⇒ `evicted`。任何一步都不抛。
     */
    async evictLive(sessionId) {
      try {
        const store = liveSessionsOf(host)
        const session = store?.get(sessionId)
        if (store === undefined) return 'unknown'
        if (session === undefined || session === null) {
          // session 已不在 store，但捕获到 handle（前一次半摘/宿主自己摘过）⇒ 仍把 agent 关掉。
          await agentHandles.dispose(sessionId)
          return 'not-live'
        }
        const entry = store.liveEntryFor(session)
        if (entry === undefined || entry === null || typeof entry.detach !== 'function') return 'unknown'
        entry.detach()
        await agentHandles.dispose(sessionId)
        return 'evicted'
      } catch {
        return 'unknown'
      }
    },

    /**
     * 通告客户端这个会话没了：发宿主自己转发的 `api-session/removed`，客户端当场删行。冷会话没有 `session/disposed`，不发这条就只能等重连。
     * 只在宿主列表确实已不含它时调用（调用方按 {@link EvictionOutcome} 判）；不发假通告。
     */
    // eslint-disable-next-line @typescript-eslint/require-await -- `host.emit` 是同步派发，没有要等的一问；下面的 catch 只收成「监听者抛错不翻掉已完成的删除」。
    async announceRemoved(sessionId) {
      try {
        host.emit('api-session/removed', sessionId)
      } catch {
        // 通告是收尾：某个监听者抛错不该把已经完成的删除翻成失败
      }
    },

    /**
     * 通告这组会话回来了：拉一次宿主会话表，按 id 逐条发 `api-session/added`；摘要直接用 `sessionController.list()` 的形状，取不到就不发（批量只预取一次）。
     */
    async announceRestored(sessionIds) {
      if (sessionIds.length === 0) return
      const summaries: { sessionId: string; summary: unknown }[] = []
      for (const item of await controllerItems(host)) {
        const sessionId = (item as { sessionId?: unknown } | null)?.sessionId
        if (typeof sessionId === 'string') summaries.push({ sessionId, summary: item })
      }
      for (const id of sessionIds) {
        const summary = summaries.find(item => item.sessionId === id)?.summary
        if (summary === undefined) continue
        try {
          // 过一遍 JSON：转发器对转发事件做 lossless-JSON 断言（`assertJsonArgs`），`undefined` 字段在 stringify 时自然消失，正是客户端要的形状。
          host.emit('api-session/added', JSON.parse(JSON.stringify(summary)))
        } catch {
          // 通告是收尾：某个监听者抛错不该把已经完成的恢复翻成失败
        }
      }
    },

    /** 官方 `unarchiveSession(sessionId)`：未归档是幂等 no-op。 */
    async unarchive(sessionId) {
      await registry.unarchiveSession(sessionId)
    },

    /** 摘账本：实体方法 `detachSession`（顶层没有）；未知工作区**响亮失败**，不静默当成功。 */
    async detach(sessionId, workspaceId) {
      const workspace = registry.get(workspaceId)
      if (workspace === undefined) throw new Error(`${WORKSPACE_MISSING_MESSAGE} (detach): ${workspaceId}`)
      await workspace.detachSession(sessionId)
    },

    /** 挂账本：实体方法 `attachSession`（顶层没有）。 */
    async attach(sessionId, workspaceId) {
      const workspace = registry.get(workspaceId)
      if (workspace === undefined) throw new Error(`${WORKSPACE_MISSING_MESSAGE} (attach): ${workspaceId}`)
      await workspace.attachSession(sessionId)
    },

    /** 确保归档：官方 `archiveSession(sessionId)`。归档是 registry **全局**的，与工作区账目无关
     *  （JSDoc 原文 "its workspace accounting — or lack of one — is irrelevant"）⇒ 没有工作区入参，调用方也不许再传。
     *  不带 `stopActivity` ⇒ 有活动即抛 `WorkspaceActiveSessionError`（→ `sessiondelete/live`，src/shared/wire.ts）。 */
    async archive(sessionId) {
      await registry.archiveSession(sessionId)
    },

    async listSessions() {
      const sessionQuery = host.get('sessionQuery') as SessionQueryLike | undefined
      if (typeof sessionQuery?.listSessions !== 'function') return { available: false }
      const records = await sessionQuery.listSessions()
      const out: SessionIdentity[] = []
      for (const record of records) {
        const id = record.header?.id
        if (typeof id !== 'string' || id === '') continue
        const parent = record.header?.parentSession
        const cwd = record.header?.cwd
        out.push({
          sessionId: id,
          ...(typeof parent === 'string' && parent !== '' ? { parentSessionId: parent } : {}),
          projectDir: projectDirOfCwd(cwd),
          subagent: record.header?.origin === 'subagent',
          ...(typeof record.header?.createdAt === 'number' && record.header.createdAt > 0
            ? { createdAt: record.header.createdAt }
            : {}),
        })
      }
      return { available: true, value: out }
    },

    /**
     * 官方 `sessionQuery.filterSessions([{kind:'parent', values}])`，不自扫 `~/.dsh/sessions`。数传递闭包（孩子与孙代），
     *  `session-` 前缀两边都去掉再比，按调用方给的写法回键。`sessionQuery` 缺席或方法缺失 ⇒ `{available:false}`；服务在场时空入参零宿主调用。
     */
    async subagentMembersOf(parentIds) {
      const sessionQuery = host.get('sessionQuery') as SessionQueryLike | undefined
      if (typeof sessionQuery?.filterSessions !== 'function') return { available: false }
      return { available: true, value: await membersFor(sessionQuery, parentIds) }
    },

    /** 批量折日志标题：无标题与 rejected 同落「不在 map」；方法缺席或整次读抛错 ⇒ `{available:false}`——调用方逐条回退 `titleOf`，标题问题永不失败整档。 */
    async titleSnapshots(ids) {
      const sessionQuery = host.get('sessionQuery') as SessionQueryLike | undefined
      if (typeof sessionQuery?.readTitleSnapshots !== 'function') return { available: false }
      try {
        const out = new Map<string, string>()
        for (const item of await sessionQuery.readTitleSnapshots([...new Set(ids)])) {
          const row = item as {
            readonly sessionId?: unknown
            readonly status?: unknown
            readonly value?: { readonly title?: unknown } | null
          } | null
          if (typeof row?.sessionId !== 'string' || row.status !== 'fulfilled') continue
          const title = (row.value?.title as { readonly title?: unknown } | undefined)?.title
          if (typeof title === 'string' && title !== '') out.set(row.sessionId, title)
        }
        return { available: true, value: out }
      } catch {
        return { available: false }
      }
    },

    /** 提问时间表：`sessionController.list()` 逐条 `sessionId`/`updatedAt`（正数才收；0 不是「1970 年提问过」）；服务缺席或抛错 ⇒ `{available:false}`。 */
    async sessionActivity() {
      try {
        const controller = host.get('sessionController') as SessionListLike | null | undefined
        if (controller === undefined || controller === null || typeof controller.list !== 'function') {
          return { available: false }
        }
        const listed = await controller.list()
        const items: unknown = Array.isArray(listed) ? listed : (listed as { items?: unknown } | null)?.items
        const out = new Map<string, number>()
        if (Array.isArray(items)) {
          for (const item of items) {
            const row = item as { readonly sessionId?: unknown; readonly updatedAt?: unknown } | null
            if (typeof row?.sessionId !== 'string') continue
            if (typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt) || row.updatedAt <= 0) continue
            out.set(row.sessionId, row.updatedAt)
          }
        }
        return { available: true, value: out }
      } catch {
        return { available: false }
      }
    },

    /** 持久化字节表：`sessionPersistence.list()` 的 `sizeBytes`（缺席 = 没有可信读数）。服务缺席 ⇒ `{ available: false }`；
     *  `list()` 抛错照抛——调用方整档 `io`，不拿空表冒充"没有大小"。 */
    async persistedSizes() {
      const persistence = host.get('sessionPersistence') as SessionPersistenceLike | null | undefined
      if (persistence === undefined || persistence === null || typeof persistence.list !== 'function') {
        return { available: false }
      }
      const out = new Map<string, number | undefined>()
      for (const snapshot of await persistence.list()) {
        const id = snapshot.header?.id
        if (typeof id !== 'string' || id === '') continue
        const size = snapshot.sizeBytes
        out.set(id, typeof size === 'number' && Number.isFinite(size) ? size : undefined)
      }
      return { available: true, value: out }
    },

    /** 持久化服务是否在场：只探服务对象，不读列表。维护卡的孤儿判定需要把「服务在但列表读面坏了」失败关闭（ADR-0062）。 */
    persistenceMounted() {
      try {
        const persistence = host.get('sessionPersistence')
        return persistence !== undefined && persistence !== null
      } catch {
        return false
      }
    },

    /** 投影缓存记录键集：只认已打开的存储域，**不拿服务缺席当空表**；域取不到/形状不符/`keys()` 抛错都回显式缺席。
     *  `keys()` 是域内存表的快照迭代器——与缓存服务读写的是同一份状态。 */
    // eslint-disable-next-line @typescript-eslint/require-await -- `keys()` 是同步内存读；Promise 只来自成员面的统一形状。
    async projectionCacheIds() {
      const table = projectionCacheTableOf(host)
      if (table === undefined) return { available: false }
      try {
        return { available: true, value: [...table.keys()] }
      } catch {
        return { available: false }
      }
    },

    /** 删投影缓存记录：经 storage domain 的写链，内存与盘一起更新。批量写链失败原样抛；旧宿主逐条 `delete` 时单条失败收进 `failed`、
     *  继续删其余条——回执始终是这一趟的真实后果，永久删除的收尾自己吞成 warning。 */
    async dropProjectionCache(sessionIds) {
      if (sessionIds.length === 0) return { removed: 0, failed: 0 }
      const table = projectionCacheTableOf(host)
      if (table === undefined) throw new Error('session-delete: 宿主的 session_projcache 存储域不可用')
      const unique = [...new Set(sessionIds)]
      if (typeof table.deleteMany === 'function') {
        const removed = await table.deleteMany(unique)
        return { removed, failed: 0 }
      }
      let removed = 0
      let failed = 0
      for (const id of unique) {
        try {
          if (await table.delete(id)) removed += 1
        } catch {
          failed += 1
        }
      }
      return { removed, failed }
    },

    /** 整本读：`sessionQuery.readSession`（replay 校验、不 make live）。header 只投影折叠消费的三格；事件流原样交回，
     *  **逐条判形状**：不符就抛（上层折 `io`），不静默折成空正文。方法缺席抛「缺席」；读失败原样抛（含 `SESSION_QUERY_SESSION_NOT_FOUND`）。 */
    async readSession(sessionId) {
      const sessionQuery = host.get('sessionQuery') as SessionQueryLike | undefined
      if (typeof sessionQuery?.readSession !== 'function') {
        throw new Error('session-delete: sessionQuery.readSession 缺席')
      }
      const raw = (await sessionQuery.readSession(sessionId)) as {
        readonly session?: { readonly createdAt?: unknown; readonly cwd?: unknown; readonly parentSession?: unknown }
        readonly events?: unknown
      } | null
      const head = raw?.session ?? {}
      const listed: unknown = raw?.events
      if (!Array.isArray(listed)) {
        throw new Error('session-delete: sessionQuery.readSession 的事件流形状不符')
      }
      const events: CorpusEvent[] = []
      for (const item of listed as readonly unknown[]) {
        if (!isCorpusEvent(item)) {
          throw new Error('session-delete: sessionQuery.readSession 的事件流形状不符')
        }
        events.push(item)
      }
      return {
        session: {
          ...(typeof head.createdAt === 'number' ? { createdAt: head.createdAt } : {}),
          ...(typeof head.cwd === 'string' ? { cwd: head.cwd } : {}),
          ...(typeof head.parentSession === 'string' ? { parentSession: head.parentSession } : {}),
        },
        events,
      }
    },
  }
}
