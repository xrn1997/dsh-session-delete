/** 摘内存的三种落地（见 {@link HostPort.evictLive}）：`not-live` / `evicted` 都意味着**宿主列表已经不含它**；
 *  `unknown` 意味着读不到或摘不掉，**不能**据此通告客户端（发了就是假话，重连后那一行会自己长回来）。 */
export type EvictionOutcome = 'evicted' | 'not-live' | 'unknown'

export interface HostPort {
  workspaceOf(sessionId: string): Promise<string | undefined>
  /** 会话落盘的**项目目录名**（`<sessions>/<projectKey(cwd)>`）；账本里没有这个会话 ⇒ `undefined`。
   *  与 `workspaceOf` 同一口径：**未命中是正常的 no-op，不是故障**（存储真故障照抛）。 */
  projectDirOf(sessionId: string): Promise<string | undefined>
  /** 删除时**尽力**取的会话标题；取不到返回空串，绝不因此让删除失败。
   *  标题只存在于宿主自己的账本/缓存里（`FsPort` 不直读文件）⇒ 取数面归宿主端口，接官方投影缓存 API。 */
  titleOf(sessionId: string): Promise<string>
  isLive(sessionId: string): Promise<boolean>
  isArchived(sessionId: string): Promise<boolean>
  /** 尽力把会话从宿主**内存里的 live store** 摘掉；三态见 {@link EvictionOutcome}。
   *  **这是本仓走宿主内部入口的两处之一**（另一处是 {@link HostPort.announceRemoved} 发的转发事件，
   *  理由与代价见实现处的注释）：删除的两半里，"磁盘上的持久化"我们搬得走，
   *  "内存里 attach 着的活体"只有这一条路能请掉。 */
  evictLive(sessionId: string): Promise<EvictionOutcome>
  /** **如实通告**客户端"这个会话没了"：发宿主自己声明并转发的 `api-session/removed`，客户端当场删行。
   *  冷会话没有活体可摘，但同样需要这一条——否则那一行要等到重连（`handleConnected` → 重列）才消失。 */
  announceRemoved(sessionId: string): Promise<void>
  /** **如实通告**客户端"这个会话回来了"：摘要取自宿主自己的会话列表，发 `api-session/added`。
   *  取不到摘要就不发（恢复本身已经完成）。 */
  announceRestored(sessionId: string): Promise<void>
  unarchive(sessionId: string): Promise<void>
  detach(sessionId: string, workspaceId: string): Promise<void>
  attach(sessionId: string, workspaceId: string): Promise<void>
  /** 归档是 registry **全局**的，与工作区账目无关 ⇒ `workspaceId` 只是调用点对称用的可选入参
   *  （未分组的会话没有工作区可传）。 */
  archive(sessionId: string, workspaceId?: string): Promise<void>
}

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

/** `ctx.sessionController`（会话列表服务）的最小面：`list()` 回会话摘要。
 *  `dsh-api-session-controller` 的服务面与它的 remote 面同源（remote 面原文
 *  `async list(_request, signal) { return { items: await this.listState.list(signal) }; }`）
 *  ⇒ 数组与 `{ items }` 两种形状都兜住，别按一种写死。 */
interface SessionListLike {
  list(signal?: unknown): Promise<unknown>
}

/** 无 cwd 的会话落在 `<sessions>/_no-cwd/`（asar `dsh-session-persistence-jsonl/lib/index.js`
 *  的 `projectDir(root, cwd)`：`if (cwd === void 0) return join(root, "_no-cwd");`）。 */
const NO_CWD_PROJECT_DIR = '_no-cwd'

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
 */
function projectKey(cwd: string): string {
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

/**
 * 宿主服务层的**真实绑定**：十二个方法各自把动词层的问题翻成宿主官方服务的调用。
 *
 * 每个方法的依据（服务 / 方法 / 入参）与原文切片见各自的实现处注释。
 * 出错一律**原样抛**（不在这里裹动词码）：动词层把原始错误挂在 `cause` 上，
 * `toRemoteFailure` 再按 `name` 把它映射回 `sessiondelete/<码>`（设计稿 §6 的两行映射）。
 */
export function createHostPort(ctx: unknown): HostPort {
  const host = ctx as HostCtxLike
  const registry = host.workspaceRegistry

  return {
    /** 账本里记着这个会话的工作区：`registry.list()` 的实体 `sessionIds`（该 getter 已按 canonical cwd 过滤过）。 */
    async workspaceOf(sessionId) {
      return registry.list().find(workspace => workspace.sessionIds.includes(sessionId))?.id
    },

    /**
     * 原生 cwd → 宿主项目目录名（`projectKey`）；没有 cwd 时按宿主约定落到 `_no-cwd`。
     *
     * 「账本里没有这个会话」= **未命中**，回 `undefined`（不是抛）：这正是本方法声明的类型，
     * 也是 `delete-session.ts` 已经写好的那条分支 `if (!projectDir) throw
     * verbError('not-found', …)` 的入口。若让它裸抛，那句话永远为假 ⇒ 设计稿 §6 的 `not-found`
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
     * 活跃判据 = 宿主官方那一条（设计稿 §5）：`workspace/session-activity` waterfall 问一次，
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
     * 从 `ctx.sessions`（live store）里摘掉一个会话。
     *
     * **为什么需要**：会话列表读面是并集——`sessionQuery.listSessions()` = 磁盘上的持久化 ∪ `ctx.sessions` 里的活体
     * （见设计稿 §4 末）。搬走文件只清掉一侧；本机运行期打开过的会话是活体，列表照样把它交出来，
     * 于是"删了还在"（真机实测：文件已进回收站、账本已摘，侧栏仍留着那一行）。
     *
     * **这是未声明为契约的内部入口**（设计稿 §4 末记了这次偏离）：`liveEntryFor` / `entry.detach()` 是 store
     * 给**会话 owner**（agent 的 effect 链）用的，宿主自己的控制器 `createOrAdopt` 只取 `agents.create()`
     * 返回的 `.agent`、把带 `dispose` 的 handle 丢掉了，`ctx.agents` 也没有 `liveEntryFor` 那样的入口
     * （会话 store 有、agent store 没有，逐成员面核过）⇒ 只能摘到"会话"这一层，上面那具 agent 摘不到，
     * 它之后若走到 `flush(session)` 会撞 `liveEntryFor` 抛 `session "…" is not live in this store`。
     *
     * **所以判据是三态**：读不到 store / 形状不符（旧版宿主）/ detach 抛 ⇒ `unknown`（**不通告**，
     * 因为无法断言宿主列表已经干净）；内存里本来没有 ⇒ `not-live`；摘成功 ⇒ `evicted`。
     * 任何一步都不抛：删除的持久化部分已经完成，这里不该把它翻成失败。
     */
    async evictLive(sessionId) {
      try {
        const store = liveSessionsOf(host)
        if (store === undefined) return 'unknown'
        const session = store.get(sessionId)
        if (session === undefined || session === null) return 'not-live'
        const entry = store.liveEntryFor(session)
        if (entry === undefined || entry === null || typeof entry.detach !== 'function') return 'unknown'
        entry.detach()
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
     * 通告客户端"这个会话回来了"（恢复用）。
     *
     * 摘要**取自宿主自己的会话列表**（`ctx.sessionController.list()`），不自己造一行：客户端 `handleSessionAdded`
     * 要的是宿主 `summaryFor` 那套形状（sessionId / updatedAt / blank / projections…），照抄宿主的那一份最可靠。
     * 取不到（控制器缺席 / 列表里没有它 / 抛错）就**一条都不发**——恢复本身已经完成，只是要等下次重连才上屏。
     */
    async announceRestored(sessionId) {
      try {
        const controller = host.get('sessionController') as SessionListLike | undefined
        if (controller === undefined || controller === null || typeof controller.list !== 'function') return
        const listed = await controller.list()
        const items: unknown = Array.isArray(listed) ? listed : (listed as { items?: unknown } | null)?.items
        if (!Array.isArray(items)) return
        const summary = items.find(item => (item as { sessionId?: unknown } | null)?.sessionId === sessionId)
        if (summary === undefined) return
        // 过一遍 JSON：转发器对转发事件做 lossless-JSON 断言（`assertJsonArgs`），
        // `undefined` 字段在 stringify 时自然消失，正是客户端那一侧要的形状。
        host.emit('api-session/added', JSON.parse(JSON.stringify(summary)))
      } catch {
        // 同上：通告失败不影响恢复的结果
      }
    },

    /** 官方 `unarchiveSession(sessionId)`：未归档是幂等 no-op。 */
    async unarchive(sessionId) {
      await registry.unarchiveSession(sessionId)
    },

    /** 摘账本：实体方法 `detachSession`（顶层没有）；未知工作区**响亮失败**，不静默当成功。 */
    async detach(sessionId, workspaceId) {
      const workspace = registry.get(workspaceId)
      if (workspace === undefined) throw new Error(`workspace not found (detach): ${workspaceId}`)
      await workspace.detachSession(sessionId)
    },

    /** 挂账本：实体方法 `attachSession`（顶层没有）。 */
    async attach(sessionId, workspaceId) {
      const workspace = registry.get(workspaceId)
      if (workspace === undefined) throw new Error(`workspace not found (attach): ${workspaceId}`)
      await workspace.attachSession(sessionId)
    },

    /** 确保归档：官方 `archiveSession(sessionId)`。归档是 registry **全局**的，与工作区账目无关
     *  （JSDoc 原文 "its workspace accounting — or lack of one — is irrelevant"），所以 `workspaceId` 不用
     *  ——未分组的会话没有工作区可传，签名里它是可选的。
     *  不带 `stopActivity` ⇒ 有活动即抛 `WorkspaceActiveSessionError`（→ `sessiondelete/live`，设计稿 §6）。 */
    async archive(sessionId) {
      await registry.archiveSession(sessionId)
    },
  }
}
