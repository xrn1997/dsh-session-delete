/**
 * 宿主**主视图**的一处窄面：删掉当前打开的会话时把它关掉，撤销恢复后把它重开。
 *
 * 为什么需要：宿主客户端的常驻 `Session` 实例把 `removed` 记成**粘性**状态
 * （`dsh-api-session-controller/lib/client.js` 的 `handleRemoved()` 只置位；`handleSessionAdded()`
 * 只 merge 摘要，从不清它）。我们发 `api-session/removed` 之后，正在看的那个会话会一直停在
 * `removed=true`：输入框禁用、占位文案是「会话不可用」。恢复再发 `api-session/added` 也不会把它
 * 清掉——**除非把常驻实例本身丢掉**。宿主自己的归档走的就是这条路：`clearArchivedCurrent()`
 * 发现当前会话进了归档集就 `clearMain()`（`dsh-client-ui-workspace/lib/client.js`）。
 *
 * 所以删除成功后：当前主视图若正是被删的会话，调 `clearMain()` 释放它；撤销恢复成功后，
 * 等客户端清单收到这条摘要再 `openSession()` 重开（新实例的 `removed` 从 false 开始）。
 *
 * **不 import 宿主客户端包**（AGENTS.md 红线）：只通过 `ctx.get('uiWorkspace')` 可选读服务，
 * 形状不符/服务缺席都安静退回，绝不影响插件激活。字段与方法名来自上面两个包的产物原文；
 * 宿主换代时先复核 `UiWorkspaceService` 的 `selection` / `sessions` / `clearMain` / `openSession`。
 */
import type { ClientContextLike } from './context.js'

interface SnapshotStoreLike<T> {
  getSnapshot(): T
}

/** `uiWorkspace` 服务里用到的字段（构造函数原文：`selection = createSnapshotStore({}, …)`、
 *  `this.sessions = sessions`；方法 `clearMain()` / `openSession(target)`）。 */
interface UiWorkspaceLike {
  readonly selection?: SnapshotStoreLike<{ readonly sessionId?: string }>
  /** 客户端 Session Controller 服务；它的 `list` 是摘要快照（`byId` 里有这条就说明 added 已落地）。 */
  readonly sessions?: { readonly list?: SnapshotStoreLike<{ readonly byId?: Record<string, unknown> }> }
  clearMain?(): void
  openSession?(target: string): void
}

let client: ClientContextLike | undefined

/** 入口激活时绑一次；之后每次调用再读服务（客户端插件激活顺序早于 `uiWorkspace` 也没关系）。 */
export function bindMainView(ctx: ClientContextLike): void {
  client = ctx
}

/** 测试专用：模块级现场归零，用例之间互不串味。 */
export function resetMainView(): void {
  client = undefined
}

function uiWorkspaceOf(): UiWorkspaceLike | undefined {
  try {
    const candidate = client?.get?.('uiWorkspace') as UiWorkspaceLike | undefined
    if (candidate === undefined || candidate === null) return undefined
    if (typeof candidate.clearMain !== 'function' || typeof candidate.openSession !== 'function') return undefined
    if (candidate.selection === undefined || typeof candidate.selection.getSnapshot !== 'function') return undefined
    return candidate
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
 * 删除成功后调用：当前主视图若在这批里，把它关掉并交回那个会话 id（供撤销重开）。
 * 关不掉/不是当前会话都回 `undefined`——这只是界面收尾，绝不让删除结果变红。
 */
export function closeMainIfDeleted(ids: readonly string[]): string | undefined {
  if (ids.length === 0) return undefined
  const ui = uiWorkspaceOf()
  if (ui === undefined) return undefined
  const current = currentSessionOf(ui)
  if (current === undefined || !ids.includes(current)) return undefined
  try {
    ui.clearMain!()
    return current
  } catch {
    return undefined
  }
}

/**
 * 撤销恢复成功后调用：把刚被关掉的会话重新打开。
 *
 * `api-session/added` 从宿主发出到客户端摘要表落地有一拍（WS 与 HTTP 响应各走各的），
 * `openSession` 的目标必须先出现在清单里才不会抛「unknown session」——所以先等它出现，
 * 最多 2 秒；期间用户若已经选了别的会话就不再抢焦点。等不到就什么都不做，行还在那里。
 */
export function openMainWhenListed(sessionId: string): void {
  const ui = uiWorkspaceOf()
  if (ui === undefined) return
  const listReady = (): boolean => {
    try {
      return ui.sessions?.list?.getSnapshot()?.byId?.[sessionId] !== undefined
    } catch {
      return false
    }
  }
  const canTakeFocus = (): boolean => {
    const current = currentSessionOf(ui)
    return current === undefined || current === sessionId
  }
  const open = (): void => {
    if (!canTakeFocus()) return
    try {
      ui.openSession?.(sessionId)
    } catch {
      // 主视图服务换代：放弃重开，行仍在清单里。
    }
  }
  if (listReady()) {
    open()
    return
  }
  let attempts = 0
  const tick = (): void => {
    attempts += 1
    if (listReady()) {
      open()
      return
    }
    if (attempts < 20) setTimeout(tick, 100)
  }
  setTimeout(tick, 100)
}
