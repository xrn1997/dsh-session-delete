import { captureAgentHandles } from './agent-handles.js'

/** 摘内存的三种落地（见 {@link HostPort.evictLive}）：`not-live` / `evicted` 都意味着**宿主列表已经不含它**；
 *  `unknown` 意味着读不到或摘不掉，**不能**据此通告客户端（发了就是假话，重连后那一行会自己长回来）。 */
export type EvictionOutcome = 'evicted' | 'not-live' | 'unknown'

/**
 * 角色一：**身份与归属**——会话是谁、落在哪个项目/工作区、活不活/归档没有，以及账本与归档的写面。
 *
 * 为什么拆成角色：宿主能力的端口按角色切成三块，而不是一个什么都有的接口。调用方要的是
 * "一句话能说清的那一组能力"，而一个什么都有的端口让每条用例都得凑齐不相干的成员。
 * 这里只切**类型**，adapter 仍是同一颗对象。
 */
export interface HostIdentityPort {
  workspaceOf(sessionId: string): Promise<string | undefined>
  /** 账本里还有这个工作区吗。**只读的判别**（`registry.get(id) !== undefined`），不抛。
   *
   *  **为什么恢复需要它**：宿主的「删除工作区」只删**注册**、保留目录与每一份会话日志
   *  （asar `WorkspaceRegistry.delete` 的 JSDoc 原文 "Delete one workspace registration while
   *  retaining its directory and every session log"），那些会话之后显示在「未分组」下。回收站里
   *  **删在工作区之前**的条目记着那个已被删掉的 `workspaceId`，恢复时若照旧 `attach` 就会
   *  `workspace not found` 整条失败（会话留在回收站里，用户看起来就是"恢复报错"）。所以恢复
   *  先问这一句：不在 ⇒ 不挂账本，照常回盘、归入「未分组」（与宿主自己处理这类会话一致）。 */
  workspaceExists(workspaceId: string): Promise<boolean>
  /** 会话落盘的**项目目录名**（`<sessions>/<projectKey(cwd)>`）；账本里没有这个会话 ⇒ `undefined`。
   *  与 `workspaceOf` 同一口径：**未命中是正常的 no-op，不是故障**（存储真故障照抛）。 */
  projectDirOf(sessionId: string): Promise<string | undefined>
  /** 删除时**尽力**取的会话标题；取不到返回空串，绝不因此让删除失败。
   *  标题只存在于宿主自己的账本/缓存里（`FsPort` 不直读文件）⇒ 取数面归宿主端口，接官方投影缓存 API。 */
  titleOf(sessionId: string): Promise<string>
  isLive(sessionId: string): Promise<boolean>
  isArchived(sessionId: string): Promise<boolean>
  unarchive(sessionId: string): Promise<void>
  detach(sessionId: string, workspaceId: string): Promise<void>
  attach(sessionId: string, workspaceId: string): Promise<void>
  /** 归档是 registry **全局**的，与工作区账目无关 ⇒ `workspaceId` 只是调用点对称用的可选入参
   *  （未分组的会话没有工作区可传）。 */
  archive(sessionId: string, workspaceId?: string): Promise<void>
}

/**
 * 角色二：**在场通告**——摘掉宿主内存里的活体，并如实通告客户端"这个会话没了 / 回来了"。
 *
 * 这一组的方法按契约**不抛**（`evictLive` 三态、`announce*` 内部吞异常）：它们是删除/恢复的收尾，
 * 收尾失败不把已经完成的那件事翻成失败。
 */
export interface HostPresencePort {
  /** 尽力把会话从宿主**内存里的 live store** 摘掉；三态见 {@link EvictionOutcome}。
   *  **这是本仓走宿主内部入口的几处之一**（另见 `src/ports/agent-handles.ts` 对 `agents.resume/create` 的包装，
   *  以及 {@link HostPresencePort.announceRemoved} 发的转发事件）：删除的两半里，"磁盘上的持久化"我们搬得走，
   *  "内存里 attach 着的活体"只有这一条路能请掉。 */
  evictLive(sessionId: string): Promise<EvictionOutcome>
  /** **如实通告**客户端"这个会话没了"：发宿主自己声明并转发的 `api-session/removed`，客户端当场删行。
   *  冷会话没有活体可摘，但同样需要这一条——否则那一行要等到重连（`handleConnected` → 重列）才消失。 */
  announceRemoved(sessionId: string): Promise<void>
  /** 一组会话的「回来了」通告：implementation 拉一次宿主会话表，按 id 逐条发 added。
   *  单条就是长度为 1 的批；批量只调一次。缺席 id 不发，不影响已完成的恢复。 */
  announceRestored(sessionIds: readonly string[]): Promise<void>
}

/**
 * 一次语料读的结果：**缺席显式化**——`available: false` 说的是"这一趟看不见语料"（`sessionQuery` 没挂，
 * 或它的读面方法缺席 / 不是函数），与"读到了、里面是空的"是两件事，调用方对两者的策略不同（前者只许
 * 降级或响亮失败，后者是可以行动的事实）。**不带原因串**：调用点的策略已经决定了怎么处理，带一个字
 * 就会有人去断言那个字；将来真要区分"没挂"与"方法缺席"，再加一个显式字段。
 */
export type CorpusRead<T> =
  | { readonly available: true; readonly value: T }
  | { readonly available: false }

/**
 * 角色三：**会话语料**——整表身份与子会话闭包。
 *
 * 两个读面都把"这一趟看不见语料"写成显式的 {@link CorpusRead}：`{ available: false }` 与
 * "看见了、里面是空的"是两件事。**缺席之后怎么办归调用方，清单见 `docs/architecture.md` §2 的「语料缺席」**。
 */
export interface HostCorpusPort {
  /** 整个会话语料（live ∪ persisted）的只读身份表。**服务缺席是显式的**：`sessionQuery` 没挂，或它的
   *  `listSessions` 缺席 / 不是函数 ⇒ `{ available: false }`，不拿空数组冒充“这个家没有会话”。 */
  listSessions(): Promise<CorpusRead<readonly SessionIdentity[]>>
  /** 一次 BFS 点出多个父的全部后代（传递闭包）。
   *  **缺席是显式的，且优先于空入参**：`sessionQuery` 没挂，或它的 `filterSessions` 缺席 / 不是函数 ⇒
   *  `{ available: false }`，不拿空表冒充"盘上没有后代"；入参是不是空的都不改变这一条。
   *  服务在场时，空入参 ⇒ `{ available: true, value: {} }`，一次宿主调用都不发。
   *  键按调用方传进来的写法回（同一个父的 `session-x` / `x` 两种写法是同一个根，见 `membersFor`）。 */
  subagentMembersOf(parentIds: readonly string[]): Promise<CorpusRead<Record<string, readonly SubagentMember[]>>>
}

/** 复合别名：adapter（`createHostPort`）与调用方把这 15 个方法当一个端口用；三个角色是它的切面。 */
export type HostPort = HostIdentityPort & HostPresencePort & HostCorpusPort

/** 动词的宿主面：身份与语料两片；不含在场三件。摘活体与通告只经 `CoreDeps.presence`（`PresenceCapability`）。
 *  用交集而不是 `Omit` 黑名单：`HostPresencePort` 将来长出新方法时，不会自动漏进每个动词的 `host`。 */
export type HostCorePort = HostIdentityPort & HostCorpusPort

/* ------------------------------------------------------------------ *
 * 宿主服务的**窄镜像**：只声明本端口用到的成员（AGENTS.md：不装宿主类型包、不做 declare module）。
 * 每一处成员的来历都附在它自己的注释里（asar 原文切片）——镜像的判据是原文，不是包名。
 * ------------------------------------------------------------------ */

/** `Workspace` 实体的最小面。asar `dsh-workspace/lib/index.js` 的声明目录原文：
 *  `export interface Workspace { readonly id; readonly path; readonly title; …; readonly sessionIds;
 *   attachSession(sessionId): Promise<void>; detachSession(sessionId): Promise<void>; … }`；
 *  运行时是 `WorkspaceEntity`（`constructor.name` 与接口名不同字 ⇒ 只按方法面判，不按 constructor.name 判）。 */
interface WorkspaceEntityLike {
  readonly id: string
  readonly sessionIds: readonly string[]
  detachSession(sessionId: string): Promise<void>
  attachSession(sessionId: string): Promise<void>
}

/** `ctx.workspaceRegistry`（`WorkspaceRegistry.inject = ['storageDomain','sessionPersistence']`）。
 *  `get(id)` 是 `this.entities.get(id)` 的直通（未知 id 返回 `undefined`）；`list()` 是**同步**的账本投影；
 *  `archivedSessionIds` 是 registry 全局归档集（数组，`state.archivedSessionIds` 的 getter）；
 *  `archiveSession(sessionId, options?)` / `unarchiveSession(sessionId)` 是官方归档面。 */
interface WorkspaceRegistryLike {
  list(): WorkspaceEntityLike[]
  get(id: string): WorkspaceEntityLike | undefined
  readonly archivedSessionIds: readonly string[]
  unarchiveSession(sessionId: string): Promise<void>
  archiveSession(sessionId: string, options?: { readonly stopActivity?: boolean }): Promise<void>
  readSessionHeader(id: string): Promise<{ readonly cwd?: string }>
}

/** `ctx.sessions`（`dsh-session` 的 `SessionStore`）里摘除一个活体所需的**最小面**。
 *  asar `dsh-session/lib/index.js` 逐字原文：
 *  `get(id) { return this.store.get(id)?.session; }`；
 *  `liveEntryFor(session) { const entry = attachments.get(session);
 *   if (entry === undefined || this.store.get(entry.id) !== entry) throw new Error(\`session "${session.id}" is not live in this store\`); return entry; }`；
 *  `enter(session)` 里 `const detach = () => { … entry.detach(); }` 而 `entry.detach = () => { this.detachEntered(entry); }`；
 *  `detachEntered(entry) { entry.detachRequested = false; if (this.store.get(entry.id) !== entry) return;
 *   this.store.delete(entry.id); attachments.delete(entry.session); if (entry.announced) this.emitDisposed(entry); }`。
 *  ⇒ `liveEntryFor(...).detach()` 就是**宿主 owner 自己用的那条**摘除路（单次、幂等、会发 `session/disposed`）。 */
interface LiveSessionsLike {
  get(id: string): unknown
  liveEntryFor(session: unknown): { detach(): void }
}

/** live store 的最小方法面判据（同 `projectionCacheOf` 的手法：按方法面判，不按 constructor.name）。 */
function liveSessionsOf(ctx: HostCtxLike): LiveSessionsLike | undefined {
  const store = ctx.get('sessions') as LiveSessionsLike | undefined
  if (store === undefined || store === null) return undefined
  if (typeof store.get !== 'function' || typeof store.liveEntryFor !== 'function') return undefined
  return store
}

/** 会话标题的官方读面：`ctx.sessionProjectionCache`（投影缓存服务，服务键 `sessionProjectionCache`）。
 *  官方消费方（`dsh-api-session-controller/lib/index.js` 的 `projectionsFor`）原文：
 *  `const cache = this.ctx.get('sessionProjectionCache'); return cache?.cachedSnapshot(header) ?? cache?.cachedPredecessorTitle(header);`
 *  ——它是**可选**服务（同处用 `ctx.get(...)?.` 而非 inject），所以这里也按可选读，不在 inject 里声明。 */
interface ProjectionCacheLike {
  cachedSnapshot(header: unknown, keys?: readonly string[]): { readonly values: Record<string, unknown> } | undefined
  cachedPredecessorTitle(header: unknown): { readonly values: Record<string, unknown> } | undefined
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
  /** cordis 的普通事件发送。**不带 carrier**（首参不是对象/函数）时 event 派发不过滤监听者
   *  ——asar `@deepseek-ai/cordis/lib/index.js` 的 `dispatch`：`const filter = thisArg?.[Context.filter]`，
   *  而 `thisArg` 只在首参是对象/函数时才取走 ⇒ 全量派发到转发器（见 {@link HostPort.announceRemoved}）。 */
  emit(name: string, ...args: readonly unknown[]): void
}

/** `ctx.get('sessionQuery')` 的最小面。**可选服务**，按 `ctx.get` 读、不进 inject（同 `sessionProjectionCache`
 *  的处理：inject 一个可能没挂的服务 = 整个插件 pending）。`filterSessions(filters, signal?)` 回匹配的记录
 *  克隆（宿主 JSDoc："matching cloned records in deterministic newest-first order"）；`kind:'parent'` 那一支的
 *  判据逐字是 `filter.values.includes(record.header.parentSession ?? null)`
 *  （`dsh-session-query/lib/index.js` 的 `sessionPredicate`，代次 0.2.0-rc.2）。 */
interface SessionQueryLike {
  listSessions(signal?: unknown): Promise<readonly {
    readonly header?: {
      readonly id?: string
      readonly cwd?: string
      readonly parentSession?: string
      readonly origin?: string
    }
  }[]>
  filterSessions(
    filters: readonly { readonly kind: string; readonly values: readonly string[] }[],
  ): Promise<readonly { readonly header?: { readonly id?: string; readonly cwd?: string; readonly parentSession?: string } }[]>
}

/** 官方的「这些父的孩子」那一支：`kind:'parent'` 的判据逐字是 `values.includes(record.header.parentSession ?? null)`。 */
async function filterChildrenOf(
  sessionQuery: SessionQueryLike,
  values: readonly string[],
): Promise<readonly { readonly header?: { readonly id?: string; readonly cwd?: string; readonly parentSession?: string } }[]> {
  return sessionQuery.filterSessions([{ kind: 'parent', values: [...values].sort() }])
}

/** 闭包里的一条后代：`id` 是宿主交回的原写法（身份只认它），`bare` 是它去前缀后的形状（归堆与去重用）。 */
interface Descendant {
  readonly id: string
  readonly bare: string
  readonly projectDir: string
}

export interface SessionIdentity {
  readonly sessionId: string
  readonly parentSessionId?: string
  readonly projectDir: string
  readonly subagent: boolean
}

export interface SubagentMember {
  readonly sessionId: string
  readonly projectDir: string
}

/**
 * 从若干根出发**逐层往下**把盘上的后代问出来，交回 `父（bare）→ 孩子` 的索引。
 *
 * 为什么一次问一层而不是官方的 `traceSession`：那条在父已经进回收站时认不出目标
 * （`SESSION_QUERY_SESSION_NOT_FOUND`），而我们要的那批正是"父已经不在宿主列表里之后还剩在盘上的"。
 * `kind:'parent'` 是唯一能按 `header.parentSession` 反着问的一支。
 *
 * 停下来的条件与代价：**层数**决定宿主调用次数，行数不参与（一层一次，问空即停）。同一条记录只收一次
 * （`seen` 连着根一起记），所以数据里真出现环时结果是"少数一条"，不是把清单读挂死。
 * 交回的 id 没有 `header.id` 的记录**整条跳过**——身份冒充不起（同 {@link HostCorpusPort.subagentMembersOf} 那条），
 * 而且没有身份就没法往下问，硬数进去只会让它将来被重复计。
 */
async function descendantsByParent(
  sessionQuery: SessionQueryLike,
  roots: readonly string[],
): Promise<Map<string, Descendant[]>> {
  const children = new Map<string, Descendant[]>()
  const seen = new Set(roots.map(bareSessionId))
  let frontier = [...seen]
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
      const bare = bareSessionId(id)
      if (seen.has(bare)) continue
      seen.add(bare)
      const cwd = record.header?.cwd
      const descendant: Descendant = {
        id, bare, projectDir: cwd === undefined ? NO_CWD_PROJECT_DIR : projectKey(cwd),
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

/** 某个根在 `descendantsByParent` 那棵树里的全部后代（深度不设上限，同一条只收一次）。 */
function subtreeOf(children: ReadonlyMap<string, Descendant[]>, rootBare: string): Descendant[] {
  const out: Descendant[] = []
  const seen = new Set([rootBare])
  let frontier = [rootBare]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const bare of frontier) {
      for (const kid of children.get(bare) ?? []) {
        if (seen.has(kid.bare)) continue
        seen.add(kid.bare)
        out.push(kid)
        next.push(kid.bare)
      }
    }
    frontier = next
  }
  return out
}

function toMember(d: Descendant): SubagentMember {
  return { sessionId: d.id, projectDir: d.projectDir }
}

/** {@link HostCorpusPort.subagentMembersOf} 的那一次 BFS。
 *  空清单在调用宿主之前就返回（不为一张空表扫全库）。 */
async function membersFor(
  sessionQuery: SessionQueryLike,
  parentIds: readonly string[],
): Promise<Record<string, readonly Descendant[]>> {
  const wanted: string[] = []
  for (const id of parentIds) if (id.length > 0 && !wanted.includes(id)) wanted.push(id)
  if (wanted.length === 0) return {}
  const children = await descendantsByParent(sessionQuery, wanted)
  const out: Record<string, readonly Descendant[]> = {}
  for (const id of wanted) out[id] = subtreeOf(children, bareSessionId(id))
  return out
}

/** `ctx.sessionController`（会话列表服务）的最小面：`list()` 回会话摘要。
 *  `dsh-api-session-controller` 的服务面与它的 remote 面同源（remote 面原文
 *  `async list(_request, signal) { return { items: await this.listState.list(signal) }; }`）
 *  ⇒ 数组与 `{ items }` 两种形状都兜住，别按一种写死。 */
interface SessionListLike {
  list(signal?: unknown): Promise<unknown>
}

/** 无 cwd 的会话落在 `<sessions>/_no-cwd/`（asar `dsh-session-persistence-jsonl/lib/index.js`
 *  的 `projectDir(root, cwd)`：`if (cwd === void 0) return join(root, "_no-cwd");`）。
 *  `projectDirOf` 与回收站对账（`src/trash/reconcile.ts` 重建条目）共用这一个字面量。 */
export const NO_CWD_PROJECT_DIR = '_no-cwd'

/**
 * 宿主的**项目目录名**算法（`projectKey`）逐字镜像。
 *
 * 为什么是镜像而不是 import：它在 `@deepseek-ai/dsh-session-persistence-jsonl` 里面，是**宿主包**，
 * 跨插件值 import 是生态红线，它也不在本插件依赖里；宿主没有把这个名字暴露成任何服务
 * （`stat()`/`list()` 的返回只有 `{header, revision, sizeBytes}`，`locate()` 的 `{kind:'jsonl', path}` 只挂在错误上）。
 *
 * 原文（asar `dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`）：
 * `function projectKey(cwd) { … if (ch === "/" || ch === "\\" || ch === ":") { if (!separatorRun) readable += "-"; separatorRun = true; }
 *  else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) { readable += ch; separatorRun = false; }
 *  else { readable += "~" + code.toString(16).toUpperCase().padStart(4, "0"); separatorRun = false; }
 *  return \`--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--\`; }`
 * 调用链：`locate(meta)` → `logPath(root, meta.cwd, meta.id, …)` → `projectDir(root, cwd)` → `projectKey(cwd)`。
 * 本机实测对得上：`D:/develop/GitHub/dsh-session-delete` → `--D-develop-GitHub-dsh-session-delete--`
 * （`~/.dsh/sessions` 下真有这个目录名；`D:/document/deepseek-harness/default-workspace` 同理）。
 *
 * **两个调用方共用这一份**：`projectDirOf`（删除时定位会话目录）与回收站对账的重建路径
 * （手工放进回收站的目录，从日志 header 的 `cwd` 反推它原本属于哪个项目目录）——算法只有这一处家。
 */
export function projectKey(cwd: string): string {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** 投影缓存服务的最小方法面判据（按方法面判，不按 `constructor.name` 判）。 */
function projectionCacheOf(ctx: HostCtxLike): ProjectionCacheLike | undefined {
  const cache = ctx.get('sessionProjectionCache') as ProjectionCacheLike | undefined
  if (cache === undefined || cache === null) return undefined
  if (typeof cache.cachedSnapshot !== 'function' || typeof cache.cachedPredecessorTitle !== 'function') return undefined
  return cache
}

/**
 * 「账本里没有这个会话」的判别串——宿主 `readSessionHeader(id)` 对未知会话抛的是**裸 `Error`**
 * （没有类型、没有码），只认这一句。asar `dsh-workspace/lib/types/index.js` 原文（逐字）：
 * `throw new Error(\`cannot validate session '${id}': session persistence holds no such session\`)`。
 *
 * 为什么按消息判而不是全吞：同一个方法里 `listStoredHeaders()` / `indexHeaders()` 会抛**真存储故障**
 * （读盘失败、账本不一致…），那是 `io` 该走的路，绝不能被当成「无此会话」。
 * 同文件另一处近似句是有类型的那条（`cannot ${verb} session '…': live sessions and session persistence
 * hold no such session`，`WorkspaceUnknownSessionError`）——`holds` 与 `hold`、有无 `live sessions and`
 * 都不相同，所以这条串不会误伤它，`toRemoteFailure` 的 cause 链映射仍按 `name` 走。
 */
const NO_SUCH_SESSION = 'session persistence holds no such session'

/** 只认上面那一句；其余（含非 Error 抛出物）一律**不算未命中**。 */
function isUnknownSession(error: unknown): boolean {
  return error instanceof Error && error.message.includes(NO_SUCH_SESSION)
}

/** 会话 id 去掉 `session-` 前缀后的形状（同一个父在两代里写法不同，见 {@link HostCorpusPort.subagentMembersOf}）。 */
export function bareSessionId(id: string): string {
  return id.startsWith('session-') ? id.slice('session-'.length) : id
}

/** 一个 id 的全部可能写法，原写法在前：`session-x` → `[session-x, x]`；`x` → `[x, session-x]`。 */
function sessionIdShapes(id: string): string[] {
  const bare = bareSessionId(id)
  return [...new Set([id, bare, `session-${bare}`])]
}

/** 宿主会话表的一次取数（`ctx.sessionController.list()` 的两种返回形状都折成数组）。
 *  服务没挂 / 形状不对 / 抛错 ⇒ 空表——**这条不替宿主兜错误**：调用方拿空表的语义都是"少发一条通告"，
 *  不是"恢复失败"。 */
async function controllerItems(host: HostCtxLike): Promise<readonly unknown[]> {
  try {
    const controller = host.get('sessionController') as SessionListLike | undefined
    if (controller === undefined || controller === null || typeof controller.list !== 'function') return []
    const listed = await controller.list()
    const items: unknown = Array.isArray(listed) ? listed : (listed as { items?: unknown } | null)?.items
    return Array.isArray(items) ? items : []
  } catch {
    return []
  }
}

/** 账本里没有那个工作区时 {@link HostPort.attach} / {@link HostPort.detach} 抛的原话开头。
 *  **原话与判据同住这里**：抛它的是这个端口，认它的也是端口给的那句，调用方不许另抄一份字符串。 */
const WORKSPACE_MISSING_MESSAGE = 'workspace not found'

/** 这次失败是不是"账本里没那个工作区"（而不是另有故障）。恢复侧靠它把两种失败分开：
 *  前者按「未分组」收，后者照旧回滚报 `io`——不给真故障静默改归属的机会。 */
export function isWorkspaceMissingError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(WORKSPACE_MISSING_MESSAGE)
}

/**
 * 宿主服务层的**真实绑定**：各方法把动词层的问题翻成宿主官方服务的调用。
 *
 * 每个方法的依据（服务 / 方法 / 入参）与原文切片见各自的实现处注释。
 * 出错一律**原样抛**（不在这里裹动词码）：动词层把原始错误挂在 `cause` 上，
 * `toRemoteFailure` 再按 `name` 把它映射回 `sessiondelete/<码>`（src/remote/map-error.ts 的两行映射）。
 */
export function createHostPort(ctx: unknown): HostPort {
  const host = ctx as HostCtxLike
  const registry = host.workspaceRegistry
  const agentHandles = captureAgentHandles(host)

  return {
    /** 账本里记着这个会话的工作区：`registry.list()` 的实体 `sessionIds`（该 getter 已按 canonical cwd 过滤过）。 */
    async workspaceOf(sessionId) {
      return registry.list().find(workspace => workspace.sessionIds.includes(sessionId))?.id
    },

    /** 账本里还有这个工作区吗：`registry.get(id)` 是 `this.entities.get(id)` 的直通（同步 Map 查找），
     *  未知 id 回 `undefined` ⇒ 这里只做一次判别，不抛。 */
    async workspaceExists(workspaceId) {
      return registry.get(workspaceId) !== undefined
    },

    /**
     * 原生 cwd → 宿主项目目录名（`projectKey`）；没有 cwd 时按宿主约定落到 `_no-cwd`。
     *
     * 「账本里没有这个会话」= **未命中**，回 `undefined`（不是抛）：这正是本方法声明的类型，
     * 也是 `delete-session.ts` 已经写好的那条分支 `if (!projectDir) throw
     * verbError('not-found', …)` 的入口。若让它裸抛，那句话永远为假 ⇒ src/shared/wire.ts 的 `not-found`
     * （「会话目录或账本条目不存在」）在这条最自然的路径上拿不到码，客户端只会看到 `sessiondelete/io`。
     *
     * **只吞这一种**：其余错误（真存储故障）照抛，让 `toRemoteFailure` 兜成 `io` 而不是假 `not-found`。
     */
    async projectDirOf(sessionId) {
      let header: { readonly cwd?: string }
      try {
        header = await registry.readSessionHeader(sessionId)
      } catch (error) {
        if (isUnknownSession(error)) return undefined
        throw error
      }
      return header.cwd === undefined ? NO_CWD_PROJECT_DIR : projectKey(header.cwd)
    },

    /**
     * 标题：走官方**投影缓存**读面（`title` 投影单元的 `wire.view` 值就是标题文本本身：
     * 单元定义原文 `{ key: "title", stateVersion: 1, wire: { view: (state) => state } }`，
     * 所以 `values.title` 是 `string | null`）。
     * 契约：**尽力取、取不到返回空串、绝不因此让删除失败** ⇒ 这里吞掉一切异常。
     */
    async titleOf(sessionId) {
      try {
        const header = await registry.readSessionHeader(sessionId)
        const cache = projectionCacheOf(host)
        const block = cache?.cachedSnapshot(header, ['title']) ?? cache?.cachedPredecessorTitle(header)
        const title = block?.values.title
        return typeof title === 'string' ? title : ''
      } catch {
        return ''
      }
    },

    /**
     * 活跃判据 = 宿主官方那一条（本文件）：`workspace/session-activity` waterfall 问一次，
     * **空数组 = 无活动**；与宿主自己的 `archiveSession` 准入同源，不自创第二套。
     * asar 原文：`const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]));
     * if (activity.length > 0) throw new WorkspaceActiveSessionError(sessionId, activity);`
     */
    async isLive(sessionId) {
      const activity = await host.waterfall(
        'workspace/session-activity',
        { sessionId },
        () => Promise.resolve([]),
      )
      return activity.length > 0
    },

    /** registry 全局归档集（数组，`state.archivedSessionIds`）。 */
    async isArchived(sessionId) {
      return registry.archivedSessionIds.includes(sessionId)
    },

    /**
     * 从 `ctx.sessions`（live store）里摘掉会话，并把它的 **agent 一起关掉**（有捕获 handle 时）。
     *
     * **为什么需要**：会话列表读面是并集——`sessionQuery.listSessions()` = 磁盘上的持久化 ∪ `ctx.sessions` 里的活体
     * （见本文件的「通告」一段）。搬走文件只清掉一侧；本机运行期打开过的会话是活体，列表照样把它交出来。
     *
     * **agent 也必须关**：`ctx.agents` 没有 per-agent dispose；宿主 `AgentService.resume` / `create` 返回的
     * `AgentHandle` 带宿主自己的外层 teardown（关写句柄、摘 agent/session），但 `SessionController` 只取
     * `.agent`、把 handle 丢掉。agent handle 捕获（`src/ports/agent-handles.ts`）在 `ctx.agents` 上包一层，
     * 按会话 id 留住 handle；这里先 `entry.detach()`（摘 session、发 `session/disposed`），再
     * `await agentHandles.dispose(sessionId)`。
     * **只摘 session 的后果**：恢复后 `SessionController.resolve` 会先命中那具旧 agent，prompt 被收下、
     * 日志不再增长，直到宿主重启（2026-10-21 真机复现）。
     *
     * **捕获不到 handle 的 agent**（插件激活前已启动的配置 agent，或 `ctx.agents` 形状变化）只能摘 session；
     * 这是已知的残留限制，不拿归档当兜底（ADR-0008）。
     *
     * **所以判据是三态**：读不到 store / 形状不符（旧版宿主）/ detach 或 dispose 抛 ⇒ `unknown`（**不通告**，
     * 因为无法断言宿主列表已经干净）；内存里本来没有 ⇒ `not-live`；摘成功 ⇒ `evicted`。
     * 任何一步都不抛：删除的持久化部分已经完成，这里不该把它翻成失败。
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
     * 通告客户端"这个会话没了"。
     *
     * **为什么需要**：客户端那一行只由两条路更新——重连时的整表重列（`handleConnected` → `refreshList`），
     * 或宿主转发的 `api-session/*` 事件。删除一个**冷**会话时宿主不会发任何事件（`session/disposed` 只在摘掉
     * 活体时才有），所以那一行会一直挂到下次重连为止（真机实测就是这个形状）。
     *
     * **为什么这样发是对的**：`api-session/removed` 是宿主**自己声明并转发**的事件
     * （asar `dsh-api-remotes/lib/remote-events.js` 的 `API_REMOTE_FORWARDED_EVENTS` 里
     * `{ event: "api-session/removed", mode: "emit" }`；转发器就是 `ctx.on(event, …)` 的普通监听者）；
     * 我们不带 carrier 地 emit ⇒ 全量派发到它（见 {@link HostCtxLike.emit}）⇒ 客户端
     * `ctx.remote.$on("api-session/removed", …)` 收到后 `recordMutation({kind:'remove'})` + `handleRemoved()`。
     * **只在"宿主列表确实已经不含它"时调用**（调用方按 {@link EvictionOutcome} 判）：这条通告在语义上是**如实**
     * 的，不是障眼法。
     */
    async announceRemoved(sessionId) {
      try {
        host.emit('api-session/removed', sessionId)
      } catch {
        // 通告是收尾：某个监听者抛错不该把已经完成的删除翻成失败
      }
    },

    /**
     * 通告客户端"这组会话回来了"：**拉一次**宿主自己的会话列表，按 id 逐条发 `api-session/added`。
     *
     * 摘要**取自宿主自己的会话列表**（`ctx.sessionController.list()`），不自己造一行：客户端 `handleSessionAdded`
     * 要的是宿主 `summaryFor` 那套形状（sessionId / updatedAt / blank / projections…），照抄宿主的那一份最可靠。
     * 取不到（控制器缺席 / 列表里没有它 / 抛错）就**一条都不发**。
     *
     * **取数从 interface 收进了 implementation**：单条就是长度为 1 的批，批量恢复与删除组回滚走同一条路。
     * 一次预取由这里保证——100 条一组的批量若按条拉表就是 100 遍全表扫，那正是 2026-10-17 那次"恢复很慢"的头号来源。
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
          // 过一遍 JSON：转发器对转发事件做 lossless-JSON 断言（`assertJsonArgs`），
          // `undefined` 字段在 stringify 时自然消失，正是客户端那一侧要的形状。
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
     *  （JSDoc 原文 "its workspace accounting — or lack of one — is irrelevant"），所以 `workspaceId` 不用
     *  ——未分组的会话没有工作区可传，签名里它是可选的。
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
          projectDir: cwd === undefined ? NO_CWD_PROJECT_DIR : projectKey(cwd),
          subagent: record.header?.origin === 'subagent',
        })
      }
      return { available: true, value: out }
    },

    /**
     * 官方 `sessionQuery.filterSessions([{kind:'parent', values}])`，不自扫 `~/.dsh/sessions`。
     *
     * 数的是**传递闭包**（孩子与孙代都算），不是"直接孩子"（issue #1）：宿主客户端对所有
     * `origin:"subagent"` 一律藏行 ⇒ 深度 ≥2 上"删了父还剩多少看不见"原样存在，只数一层就是把那件事
     * 说成没有。问法见 {@link descendantsByParent}。
     *
     * 归堆必须**两边都去前缀**再比：本机实测父会话自己的 header id 带 `session-` 前缀
     * （`session-ac07f2bb-…`）、它的子会话写的 `parentSession` 也带，但 v3 那一代的 id 不带 ⇒
     * 同一个父有两种写法。所以问的时候把一个 id 的两种形状都塞进 `values`，回来按去前缀后的形状归堆，
     * 最后按**调用方给的那个写法**把键交回去（调用方拿 `entry.sessionId` 直接查得到）。
     *
     * 删除要一起带走**整个组**，先得把他们点出来：身份取宿主自己记录里的 `header.id`，项目目录由
     * `header.cwd` 走同一个 `projectKey`（与 {@link HostPort.projectDirOf} 同一根算法，不另起一套）。
     * 交回的是**全部后代**——孙代跟着父一起进回收站（issue #1），顺序是逐层往下问出来的（近的先）。
     * `header.id` 缺席的后代直接跳过——不拿目录名冒充身份（冒充了会把一个来路不明的目录搬进回收站）。
     *
     * **缺席显式化**（见 {@link CorpusRead}）：`sessionQuery` 没挂，或它的 `filterSessions` 缺席 / 不是函数
     * ⇒ `{ available: false }`，不拿空表冒充"盘上没有后代"——写侧据此决定降级还是响亮失败，不再靠"空表"
     * 兼表两种意思。
     * **先判服务、再判空入参**：语料本来就看不见时，"没有后代"这句话不该被说出口（哪怕入参是空的）；
     * 服务在场时空入参由 `membersFor` 的短路保证零宿主调用。
     */
    async subagentMembersOf(parentIds) {
      const sessionQuery = host.get('sessionQuery') as SessionQueryLike | undefined
      if (typeof sessionQuery?.filterSessions !== 'function') return { available: false }
      const members = await membersFor(sessionQuery, parentIds)
      return {
        available: true,
        value: Object.fromEntries(Object.entries(members).map(([id, list]) => [id, list.map(toMember)])),
      }
    },
  }
}
