import { captureAgentHandles } from './agent-handles.js'

/** 摘内存的三种落地（见 {@link HostPort.evictLive}）：`not-live` / `evicted` 都意味着**宿主列表已经不含它**；
 *  `unknown` 意味着读不到或摘不掉，**不能**据此通告客户端（发了就是假话，重连后那一行会自己长回来）。 */
export type EvictionOutcome = 'evicted' | 'not-live' | 'unknown'

/** 角色一：身份与归属——会话是谁、落在哪个项目/工作区、活不活/归档没有，以及账本与归档的写面。
 *  只切类型，adapter 仍是同一颗对象。 */
export interface HostIdentityPort {
  workspaceOf(sessionId: string): Promise<string | undefined>
  /** 账本里还有这个工作区吗：只读判别，不抛。
   *  宿主的「删除工作区」只删注册、保留目录与日志；恢复这类会话时跳过 attach，归入「未分组」。 */
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
 * 成员注释写明宿主服务与判据，能指到 asar 的附出处——镜像的判据是宿主产物，不是包名；
 * 宿主换代先按这些出处复核。完整原文见本文件的 git 历史。
 * ------------------------------------------------------------------ */

/** Workspace 实体的最小面：按方法面判，不按 constructor.name 判。
 *  出处：asar `dsh-workspace/lib/index.js` 的 `Workspace` 声明；运行时实体名是 `WorkspaceEntity`。 */
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
  readSessionHeader(id: string): Promise<{ readonly cwd?: string }>
}

/** `ctx.sessions` 的最小面：`get(id)` 取会话，`liveEntryFor(session).detach()` 摘活体。
 *  出处：asar `dsh-session/lib/index.js` 的 `SessionStore.get` / `liveEntryFor` / `detachEntered`。
 *  detach 是宿主 owner 自己的摘除路（单次、幂等、会发 `session/disposed`）；宿主换代先复核这两个方法。 */
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

/** 会话标题的投影缓存读面；可选服务，按 `ctx.get` 读，不进 inject。
 *  出处：asar `dsh-api-session-controller/lib/index.js` 的 `projectionsFor`（`cachedSnapshot ?? cachedPredecessorTitle`）。 */
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
  /** cordis 事件发送：首参不是对象/函数时不带 carrier，全量派发到转发器；announce* 依赖这一点。
   *  出处：asar `@deepseek-ai/cordis/lib/index.js` 的 `dispatch`（`const filter = thisArg?.[Context.filter]`）。 */
  emit(name: string, ...args: readonly unknown[]): void
}

/** `ctx.get('sessionQuery')` 的最小面；可选服务，不进 inject。
 *  `filterSessions([{kind:'parent', values}])` 按 `header.parentSession` 取直接孩子；
 *  出处：asar `dsh-session-query/lib/index.js` 的 `sessionPredicate`，判据逐字
 *  `filter.values.includes(record.header.parentSession ?? null)`；宿主换代先复核这一支。 */
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
 * 从若干根逐层向下问出后代，交回 `父（bare）→ 孩子` 的索引。
 * 用 `kind:'parent'` 而不是 traceSession：父进回收站后 traceSession 认不出目标（宿主失败码
 * `SESSION_QUERY_SESSION_NOT_FOUND`），而这里要的正是父不在宿主列表之后仍留在盘上的那批。
 * 出处：asar `dsh-session-query/lib/index.js` 的 `filterSessions`。一层一次宿主调用，问空即停；
 * `seen` 防环；没有 `header.id` 的记录整条跳过（无法作为身份继续下问）。
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

/** `ctx.sessionController` 的最小面：`list()` 回会话摘要；数组与 `{items}` 两种形状都接受。
 *  出处：asar `dsh-api-session-controller` 的 `listState.list`；remote 面原文
 *  `async list(_request, signal) { return { items: await this.listState.list(signal) }; }`。 */
interface SessionListLike {
  list(signal?: unknown): Promise<unknown>
}

/** 无 cwd 的会话落在 `_no-cwd/`；`projectDirOf` 与回收站对账共用这个字面量。
 *  出处：asar `dsh-session-persistence-jsonl/lib/index.js` 的 `projectDir`（`if (cwd === void 0) return join(root, "_no-cwd");`）。 */
export const NO_CWD_PROJECT_DIR = '_no-cwd'

/** 宿主 `projectKey(cwd)` 的逐字镜像：跨插件不能 import，宿主也没把它暴露成服务。
 *  出处：asar `dsh-session-persistence-jsonl/lib/index.js` 的 `projectKey`；调用链
 *  `locate` → `logPath` → `projectDir` → `projectKey`。本机实测 `D:/develop/GitHub/dsh-session-delete`
 *  → `--D-develop-GitHub-dsh-session-delete--`。`projectDirOf` 与回收站对账重建共用这一份；
 *  宿主换代先复核算法。 */
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

/** 宿主 `readSessionHeader` 对未知会话抛的是裸 `Error`，只认这句；真存储故障照抛，不能折成未命中。
 *  出处：asar `dsh-workspace/lib/types/index.js` 的
 *  `cannot validate session '${id}': session persistence holds no such session`。
 *  同文件有类型的近似句是 `WorkspaceUnknownSessionError`（`hold` 无 `s`），不会误伤。 */
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

/** 宿主服务的真实绑定；出错原样抛，由 `toRemoteFailure` 按 name 映射。
 *  各方法调用的服务与方法见上方成员注释；错误映射表住 `src/remote/map-error.ts`。 */
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
     * cwd → 宿主项目目录名；没有 cwd 落到 `_no-cwd`。
     * 账本里没有这个会话回 `undefined`（未命中，不是故障）；真存储故障照抛。
     * 未命中由 `delete-session.ts` 折成 `not-found`，真故障留 `io`——两者不能混。
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

    /** 标题走宿主投影缓存；尽力取，取不到返回空串，绝不因此让删除失败。 */
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

    /** 活跃判据走宿主 `workspace/session-activity` waterfall：空数组 = 无活动；
     *  与宿主 archiveSession 的准入同源。 */
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
     * 从 `ctx.sessions` 摘掉会话，并关闭捕获到的 agent handle。
     *
     * 会话列表 = 磁盘持久化 ∪ 内存活体，搬走文件只清掉一侧；宿主 `SessionController` 会丢掉
     * `AgentHandle`，所以 `agent-handles.ts` 按会话 id 留住 handle，这里先 detach 再 dispose。
     * 捕获不到 handle（插件激活前已启动，或 `ctx.agents` 形状变化）时只能摘 session，这是已知限制，
     * 不拿归档兜底（ADR-0008）。
     *
     * 三态：读不到 store / 形状不符 / detach 或 dispose 抛 ⇒ `unknown`（不通告）；
     * 内存里本来没有 ⇒ `not-live`；摘成功 ⇒ `evicted`。任何一步都不抛。
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
     * 通告客户端这个会话没了：发宿主自己转发的 `api-session/removed`，客户端当场删行。
     * 冷会话没有 `session/disposed`，不发这条就只能等重连。
     * 只在宿主列表确实已不含它时调用（调用方按 {@link EvictionOutcome} 判）；不发假通告。
     */
    async announceRemoved(sessionId) {
      try {
        host.emit('api-session/removed', sessionId)
      } catch {
        // 通告是收尾：某个监听者抛错不该把已经完成的删除翻成失败
      }
    },

    /**
     * 通告这组会话回来了：拉一次宿主会话表，按 id 逐条发 `api-session/added`。
     * 摘要直接用宿主 `sessionController.list()` 的形状；取不到就不发。
     * 批量只预取一次，避免按条全表扫。
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
     * 数传递闭包（孩子与孙代），不是直接孩子；`session-` 前缀两边都去掉再比，
     * 按调用方给的写法回键。`sessionQuery` 缺席或方法缺失 ⇒ `{available:false}`，
     * 不拿空表冒充“没有后代”；服务在场时空入参零宿主调用。
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
