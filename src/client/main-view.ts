/**
 * 宿主**主视图**的一处窄面：删掉当前打开的会话时把它关掉，撤销恢复后把它重开。
 * 宿主常驻 `Session` 的 `removed` 是**粘性**的（`dsh-api-session-controller/lib/client.js` 的 `handleRemoved()`
 * 只置位，`handleSessionAdded()` 只 merge 摘要、从不清它），除非把
 * 常驻实例本身丢掉：所以关闭/重开是**一段生命周期**，不是一个 id——`afterDelete` 只记我们自己关过的，
 * `afterRestore` 只重开记过的；两次重开排队时只有最新那条会打开（等待住 `pending-open.ts`）。
 * 归档时 `clearMain()` 的判据在 `dsh-client-ui-workspace/lib/client.js`。
 * 不 import 宿主客户端包（AGENTS.md 红线）：只通过 `ctx.get('uiWorkspace')` 可选读服务，形状不符/缺席安静退回。
 */
import type { ClientContextLike } from './context.js'
import { createPendingOpen } from './pending-open.js'
import { getDefaultClientScene } from './scene.js'

interface SnapshotStoreLike<T> {
  /** 返回值允许空：宿主 `getSnapshot()` 在"还没装好"那一拍可能回 null / undefined（「缺席不等于没有」）。 */
  getSnapshot(): T | null | undefined
  /** 快照变化通知；返回退订。旧 store 可能没有——那时 `openWhenListed` 放弃这次等待，不退回轮询。 */
  subscribe?(listener: () => void): () => void
}

/** `uiWorkspace` 服务里用到的字段与方法（构造函数原文：`selection = createSnapshotStore({}, …)`、
 *  `this.sessions = sessions`；方法 `clearMain()` / `openSession(target)`）；服务缺席/形状不符都安静退回。 */
interface UiWorkspaceLike {
  readonly selection?: SnapshotStoreLike<{ readonly sessionId?: string }>
  /** 客户端 Session Controller 服务；它的 `list` 是摘要快照（`byId` 里有这条就说明 added 已落地）。 */
  readonly sessions?: { readonly list?: SnapshotStoreLike<{ readonly byId?: Record<string, unknown> }> }
  clearMain?(): void
  openSession?(target: string): void
}

/** 过了就绪判据之后的形状：方法不再可选，`afterRestore` 的 `openSession(...)` 与
 *  `afterDelete` 的 `clearMain()` 不必再用非空断言逼编译器相信判据。判据本身仍只在 `uiWorkspaceOf`。 */
type ReadyUiWorkspace = UiWorkspaceLike & Required<Pick<UiWorkspaceLike, 'clearMain' | 'openSession'>>

/** 一台主视图收尾现场：绑定宿主 / 关主视图 / 重开 / 遗忘 / 收场。 */
export interface MainViewScene {
  /** 入口激活时绑一次；之后每次调用再读服务（客户端插件激活顺序早于 `uiWorkspace` 也没关系）。 */
  bind(ctx: ClientContextLike): void
  /** 测试/场景收场：记忆清空、在等的重开作废。 */
  reset(): void
  /** 删除成功后调用：当前主视图若在这批里，把它关掉并记下"这一条是我们关掉的"（供撤销重开）。 */
  afterDelete(sessionIds: readonly string[]): void
  /** 撤销恢复成功后调用：把**我们自己关掉的**那几个会话重新打开（只认 `afterDelete` 记过的）。 */
  afterRestore(sessionIds: readonly string[]): void
  /** 面板恢复已经替这些会话完成结算：只忘掉我们关过的那几条，不重开、不抢焦点。 */
  forget(sessionIds: readonly string[]): void
}

/** 宿主服务是否可用：把检查写成类型谓词，调用点拿到的就是 `ReadyUiWorkspace`。
 *  `ctx.get` 的窄镜像声明成可能回 null（宿主可回 null），所以空值判据必须同时认 undefined / null。 */
function isReadyUiWorkspace(candidate: UiWorkspaceLike | null | undefined): candidate is ReadyUiWorkspace {
  if (candidate === undefined || candidate === null) return false
  if (typeof candidate.clearMain !== 'function' || typeof candidate.openSession !== 'function') return false
  if (candidate.selection === undefined || typeof candidate.selection.getSnapshot !== 'function') return false
  return true
}

export function createMainViewScene(): MainViewScene {
  let client: ClientContextLike | undefined
  /** 我们自己关掉的主视图会话：只有这里记过的，撤销恢复后才会重开；面板恢复用 `forget` 清掉。 */
  let closedByUs = new Set<string>()
  /** 在等的重开：票、订阅、放弃 timer 与 cleanup 都归这个句柄（`src/client/pending-open.ts`）。 */
  const pendingOpen = createPendingOpen()

  function uiWorkspaceOf(): ReadyUiWorkspace | undefined {
    try {
      const candidate = client?.get?.('uiWorkspace') as UiWorkspaceLike | null | undefined
      return isReadyUiWorkspace(candidate) ? candidate : undefined
    } catch {
      return undefined
    }
  }

  function currentSessionOf(ui: UiWorkspaceLike): string | undefined {
    try {
      return ui.selection?.getSnapshot()?.sessionId
    } catch {
      return undefined
    }
  }

  /**
   * 把会话重新打开：`api-session/added` 从宿主发出到客户端摘要表落地有一拍，`openSession` 的目标必须先
   * 出现在清单里才不会抛「unknown session」——没有就**订阅**宿主快照 store；出现且票仍是当前、焦点没被
   * 抢走时打开。最多等 2 秒、一个放弃 timer、不轮询；等不到就什么都不做，行还在那里。状态机住
   * `pending-open.ts`；没有 `subscribe` 的旧 store 直接放弃，不退回轮询（ADR-0036）。
   */
  function openWhenListed(sessionId: string): void {
    const ui = uiWorkspaceOf()
    if (ui === undefined) return
    const store = ui.sessions?.list
    if (store === undefined) return
    const subscribe = typeof store.subscribe === 'function' ? store.subscribe.bind(store) : undefined
    const listReady = (): boolean => {
      try {
        return store.getSnapshot()?.byId?.[sessionId] !== undefined
      } catch {
        return false
      }
    }
    const canTakeFocus = (): boolean => {
      const current = currentSessionOf(ui)
      return current === undefined || current === sessionId
    }
    pendingOpen.schedule({
      subscribe,
      isReady: listReady,
      canOpen: canTakeFocus,
      open: () => {
        try {
          ui.openSession(sessionId)
        } catch {
          // 主视图服务换代：放弃重开，行仍在清单里。
        }
      },
    })
  }

  const scene: MainViewScene = {
    bind(ctx: ClientContextLike): void {
      client = ctx
      // 插件卸载时把在等的重开与记忆一起收掉；测试的窄 ctx 没有 effect 时安静跳过。
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          pendingOpen.cancel()
          closedByUs = new Set()
        }, 'session-delete: main-view')
      }
    },
    reset(): void {
      pendingOpen.cancel()
      client = undefined
      closedByUs = new Set()
    },
    afterDelete(sessionIds: readonly string[]): void {
      if (sessionIds.length === 0) return
      // 新的删除也是新动作：旧的撤销重开等待让位，哪怕删的不是当前会话。
      pendingOpen.cancel()
      const ui = uiWorkspaceOf()
      if (ui === undefined) return
      const current = currentSessionOf(ui)
      if (current === undefined || !sessionIds.includes(current)) return
      try {
        ui.clearMain()
        closedByUs.add(current)
      } catch {
        // Main-view cleanup must never turn a delete result red.
      }
    },
    afterRestore(sessionIds: readonly string[]): void {
      if (sessionIds.length === 0) return
      // 新的恢复也是新动作：先作废旧的等待；命中自己关过的会话时再开一个新的等待。
      pendingOpen.cancel()
      const targets = sessionIds.filter((id) => closedByUs.has(id))
      if (targets.length === 0) return
      for (const id of targets) closedByUs.delete(id)
      const last = targets[targets.length - 1]
      if (last === undefined) return
      openWhenListed(last)
    },
    forget(sessionIds: readonly string[]): void {
      for (const id of sessionIds) closedByUs.delete(id)
    },
  }
  return scene
}

/* ── 兼容自由函数（旧调用点与测试）：委托默认场景的实例 ────────────────────────── */

/** 入口激活时绑一次（默认场景）。 */
export function bindMainView(ctx: ClientContextLike): void {
  getDefaultClientScene().mainView.bind(ctx)
}

/** 测试专用：默认场景的主视图现场归零（记忆清空、在等的重开作废）。 */
export function resetMainView(): void {
  getDefaultClientScene().mainView.reset()
}

/** 删除成功后调用（默认场景）：当前主视图若在这批里，把它关掉并记下。 */
export function afterDelete(sessionIds: readonly string[]): void {
  getDefaultClientScene().mainView.afterDelete(sessionIds)
}

/** 撤销恢复成功后调用（默认场景）：重开我们自己关掉的会话。 */
export function afterRestore(sessionIds: readonly string[]): void {
  getDefaultClientScene().mainView.afterRestore(sessionIds)
}

/** 面板恢复后遗忘（默认场景）：只忘、不重开。 */
export function forgetMainView(sessionIds: readonly string[]): void {
  getDefaultClientScene().mainView.forget(sessionIds)
}
