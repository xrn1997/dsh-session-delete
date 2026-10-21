/**
 * `ctx.agents`（宿主 Agent 服务）的窄面：`resume` / `create` 返回的 **AgentHandle** 带一具
 *  这个 agent 的 dispose，正是 `agentLoop` 里那个会关写句柄、摘 agent/session 的外层 teardown。
 *  `SessionController` 只取 `.agent`、把 handle 丢掉；本模块在服务实例上包一层，把 handle 按会话 id
 *  记下来，供 `evictLive` 在删除时**真正把 agent 也关掉**。不是公开契约（见 `evictLive` 的注释）。
 */
interface AgentHandleLike {
  readonly agent?: { readonly id?: unknown }
  dispose?: () => Promise<void>
}
type AgentMethod = (...args: unknown[]) => Promise<unknown>
const CAPTURED_AGENT_HANDLES = Symbol.for('dsh-session-delete.captured-agent-handles')
interface AgentServiceLike {
  resume?: AgentMethod
  create?: AgentMethod
  [CAPTURED_AGENT_HANDLES]?: Map<string, () => Promise<void>>
}

/** 捕获所需的 ctx 窄面：可选服务读法（`get`）与按依赖注入的子上下文（`inject`，晚挂载的 `agents` 靠它补装）。
 *  旧 ctx / 假件可以没有 `inject`——那就只在 apply 时 `get` 一次。 */
export interface AgentCtxLike {
  get(name: string): unknown
  inject?(names: readonly string[], callback: (child: { get(name: string): unknown }) => void): void
}

/** 一次捕获交回的句柄表：按会话 id `dispose`。没捕到 / 已经 dispose 过都是 no-op；
 *  dispose 本身的失败**原样抛出**（调用方 `evictLive` 把它折成 `unknown`，不通告）。 */
export interface AgentHandleStore {
  dispose(sessionId: string): Promise<void>
}

/** 在 `ctx.agents` 上包一层 `resume` / `create`，把返回的 agent handle 的 dispose 按会话 id 记下。
 *  服务缺席时走 `ctx.inject(['agents'])` **等服务挂上再装**——live profile 的插件激活顺序可能早于
 *  `agents` 服务就绪；只在 apply 时 `get` 一次会让捕获静默缺席（真机症状：重启前在回收站的能冷恢复，
 *  刚删除的会话恢复后旧 agent 拦住 prompt）。形状不符 / 属性不可写都只是**不捕获**，不影响插件激活。
 *
 *  **安装时机**：先 `get('agents')`，没装成再 `inject(['agents'])`（两者只装一次，符号表兜住）。
 *  **symbol 表**：句柄表挂在服务实例的 {@link CAPTURED_AGENT_HANDLES} 上；同一个 agents 服务上的第二次
 *  安装（`get` 与 `inject` 各一次，或第二个 `createHostPort`）看见它就直接共用，不把 wrapper 套第二层。
 *  **读回判据**：cordis 的 traceable 服务代理每次读函数都会新包一层（`get` 里的 `createShadowMethod`），
 *  所以只能看 own property descriptor 的身份；拿 `service[name]` 读回比身份是必然的假警报。
 */
export function captureAgentHandles(ctx: AgentCtxLike): AgentHandleStore {
  let handles = new Map<string, () => Promise<void>>()
  let installed = false
  const install = (candidate: unknown): void => {
    if (installed) return
    const service = candidate as AgentServiceLike | undefined
    if (service === undefined || service === null) return
    const existing = service[CAPTURED_AGENT_HANDLES]
    if (existing !== undefined) {
      // 同一个 agents 服务上第二次安装：它必须看第一层 wrapper 写的同一张表。
      handles = existing
      installed = true
      return
    }
    let wrappedCount = 0
    for (const name of ['resume', 'create'] as const) {
      try {
        const original = service[name]
        if (typeof original !== 'function') continue
        const wrapped: AgentMethod = function (this: unknown, ...args: unknown[]) {
          const result = Reflect.apply(original, this, args) as Promise<unknown>
          void result.then((value) => {
            const handle = value as AgentHandleLike | null | undefined
            const id = handle?.agent?.id
            if (typeof id !== 'string' || id.length === 0 || typeof handle?.dispose !== 'function') return
            handles.set(id, async () => { await handle.dispose!() })
          }, () => undefined)
          return result
        }
        service[name] = wrapped
        // **不能拿 `service[name]` 读回比身份**：cordis 的 traceable 服务代理每次读函数都会新包一层
        // （`get` 里的 `createShadowMethod`），读回永远不等于刚写进去的那个函数。赋值本身落在代理的
        // 目标对象上（实测：`Object.getOwnPropertyDescriptor(proxy, name).value === wrapped`），
        // 调用也真的走 wrapper。2026-10-21 真机事故就是这条假警报：resume 已包上却在这里抛，
        // 循环随后没走到 create ⇒ 新建会话的 handle 一个都没捕获。
        if (Object.getOwnPropertyDescriptor(service, name)?.value !== wrapped) {
          throw new Error(`agents.${name} is not writable`)
        }
        wrappedCount += 1
      } catch {
        // 一个方法装不上不该拖死另一个；两个都没装上才是"不捕获"。
      }
    }
    if (wrappedCount === 0) return
    try {
      // 只改类型；运行时仍是同一颗服务对象。标记写在 symbol 上，代理的 symbol 分支直通目标，
      // 第二次安装（get 与 inject 各一次）会看见它，不会把 resume/create 套第二层。
      ;(service as AgentServiceLike)[CAPTURED_AGENT_HANDLES] = handles
    } catch {
      // 标记只是防重复安装；写不上不改变 wrapper 已经装上这一事实。
    }
    installed = true
  }
  const service = ctx.get('agents')
  if (service !== undefined && service !== null) install(service)
  if (!installed && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['agents'], (child) => { install(child.get('agents')) })
    } catch {
      // 没有 inject 的旧 ctx：不捕获。
    }
  }
  return {
    async dispose(sessionId) {
      const dispose = handles.get(sessionId)
      if (dispose === undefined) return
      try {
        await dispose()
      } finally {
        handles.delete(sessionId)
      }
    },
  }
}
