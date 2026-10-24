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
 * 所以关闭/重开是**一段生命周期**（2026-10-21），不是一个 id：删除成功后 `afterDelete` 关掉当前
 * 主视图并记下"这一条是我们关掉的"；撤销成功后 `afterRestore` 只重开自己记过的那些。调用方不再
 * 各自判定该不该关、也不再把会话 id 塞进撤销提示传一圈——判据全在这一处。两次重开排队时只有最新
 * 那条会打开（最新票守卫），`resetMainView()` 清掉这份记忆并让在等的重开作废。
 *
 * **不 import 宿主客户端包**（AGENTS.md 红线）：只通过 `ctx.get('uiWorkspace')` 可选读服务，
 * 形状不符/服务缺席都安静退回，绝不影响插件激活。字段与方法名来自上面两个包的产物原文；
 * 宿主换代时先复核 `UiWorkspaceService` 的 `selection` / `sessions` / `clearMain` / `openSession`。
 */
import type { ClientContextLike } from './context.js'
import { createLatestWins } from './store.js'

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
/** 我们自己关掉的主视图会话：只有这里记过的，撤销恢复后才会重开；面板恢复用 `forgetMainView` 清掉。 */
let closedByUs = new Set<string>()
/** 重开排队的最新票：后一次删除/恢复（或重开）签发新票，前一次的等待随之作废（只开最新那条）。 */
const reopen = createLatestWins()

/** 入口激活时绑一次；之后每次调用再读服务（客户端插件激活顺序早于 `uiWorkspace` 也没关系）。 */
export function bindMainView(ctx: ClientContextLike): void {
  client = ctx
}

/** 测试专用：模块级现场归零（记忆清空、在等的重开作废），用例之间互不串味。 */
export function resetMainView(): void {
  client = undefined
  closedByUs = new Set()
  reopen.invalidate()
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
 * 删除成功后调用：当前主视图若在这批里，把它关掉并记下"这一条是我们关掉的"（供撤销重开）。
 * 关不掉/不是当前会话都什么都不做——这只是界面收尾，绝不让删除结果变红。
 */
export function afterDelete(sessionIds: readonly string[]): void {
  if (sessionIds.length === 0) return
  // 新的删除也是新动作：旧的撤销重开等待让位，哪怕删的不是当前会话。
  reopen.invalidate()
  const ui = uiWorkspaceOf()
  if (ui === undefined) return
  const current = currentSessionOf(ui)
  if (current === undefined || !sessionIds.includes(current)) return
  try {
    ui.clearMain!()
    closedByUs.add(current)
  } catch {
    // Main-view cleanup must never turn a delete result red.
  }
}

/**
 * 撤销恢复成功后调用：把**我们自己关掉的**那几个会话重新打开（只认 `afterDelete` 记过的）。
 *
 * 一批里只有最后一条会开（`targets[targets.length - 1]`）：主视图一次只装一个会话，而撤销恢复
 * 的成功条数可能多于一条；`openWhenListed` 的最新票守卫保证前一条的等待不会后落地抢焦点。
 * 任何更新的删除/恢复都会先作废旧等待；这里只负责「这一次要开哪一条」。
 */
export function afterRestore(sessionIds: readonly string[]): void {
  if (sessionIds.length === 0) return
  // 新的恢复也是新动作：先作废旧的等待；命中自己关过的会话时再开一个新的等待。
  reopen.invalidate()
  const targets = sessionIds.filter((id) => closedByUs.has(id))
  if (targets.length === 0) return
  for (const id of targets) closedByUs.delete(id)
  openWhenListed(targets[targets.length - 1]!)
}

/**
 * 面板恢复已经替这些会话完成了“回来”的结算：只忘掉我们关过的那几条，不重开、不抢焦点。
 * 它不动 `reopen`：同一会话不会既在等重开、又躺在回收站里等面板恢复；在等的重开属于另一条动作。
 */
export function forgetMainView(sessionIds: readonly string[]): void {
  for (const id of sessionIds) closedByUs.delete(id)
}

/**
 * 把会话重新打开：`api-session/added` 从宿主发出到客户端摘要表落地有一拍（WS 与 HTTP 响应各走
 * 各的），`openSession` 的目标必须先出现在清单里才不会抛「unknown session」——所以先等它出现，
 * 最多 2 秒；期间用户若已经选了别的会话就不再抢焦点。等不到就什么都不做，行还在那里。
 *
 * **最新票守卫**（`reopen`）：开始等待时签一张票，立即开与每次 tick 都核对；后一次删除/
 * 恢复（或 `resetMainView`）签发新票或作废当前票，前一次的等待就不再打开、也不再续时。
 */
function openWhenListed(sessionId: string): void {
  const ui = uiWorkspaceOf()
  if (ui === undefined) return
  const ticket = reopen.issue()
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
    if (!ticket.current) return
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
    if (!ticket.current) return
    attempts += 1
    if (listReady()) {
      open()
      return
    }
    if (attempts < 20) setTimeout(tick, 100)
  }
  setTimeout(tick, 100)
}
