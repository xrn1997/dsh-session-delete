/**
 * A1：宿主归档集的**旁路观察**——浏览器半可选读宿主客户端服务
 * `ctx.get('workspaces').list`（`getSnapshot().archivedSessionIds` / `subscribe`），
 * 归档集一变就 `invalidateArchive()`。零新增宿主↔Node 面（ADR-0036「订阅不轮询」的路子）。
 *
 * 纪律（AGENTS 红线 + ADR-0060 决定第 4 条）：
 * - 窄镜像**只声明这两格**、按方法面判形；不 import 宿主包、不做 `declare module`。
 * - 可选服务走 `ctx.get`，**不进条目 `inject`**（写进去 = 这一代没有它就整条 pending）。
 * - 服务**可能迟到**：`dsh-api-workspace-controller` 自己 inject `remote` / `remote.workspace`，
 *   而本条目只 inject `slots`，可以在它之前激活。所以 `get` 落空时按 AGENTS 的规矩用
 *   `ctx.inject(['workspaces'], child => …)` 的 **scoped 等待**切过去；等待装在 child 上，
 *   服务就绪才回调、条目卸载时随 child 一起收。
 * - 服务缺席 / 形状不符 / 安装期读面抛错 ⇒ **安静降级**（console.info 一句留因，不抛、不戳）：
 *   A1 不可用时归档档退化为"打开时重取 + 自己动作后重取"（`useArchiveQuery` 本来就有这两条腿）。
 * - 只在**归档集数组内容**变化时戳（逐元素比较）：无关的 workspace 变更不许把归档档拉起来重读。
 */
import type { ClientContextLike } from './context.js'
import { invalidateArchive } from './archive-store.js'

/** `ctx.get('workspaces')` 的最小面：只声明 `list` 的两格（按方法面判形，不保运行时必有）。 */
interface WorkspacesListLike {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

/** 读面探测的三态：`ok` 拿到形状对得上的 list；`absent` 服务还没到（可以 scoped 等）；`bad` 到了但形状不对。 */
type WorkspacesProbe =
  | { readonly kind: 'ok'; readonly list: WorkspacesListLike }
  | { readonly kind: 'absent' }
  | { readonly kind: 'bad' }

/** `getSnapshot()` 回的那格：`archivedSessionIds` 是字符串数组才算数；交回**副本**（宿主快照
 *  可能回活数组，拿引用比较会"自己跟自己相等"永远不戳）。 */
function archivedIdsOf(snapshot: unknown): string[] | undefined {
  if (typeof snapshot !== 'object' || snapshot === null) return undefined
  const ids = (snapshot as { archivedSessionIds?: unknown }).archivedSessionIds
  if (!Array.isArray(ids)) return undefined
  const out: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string') return undefined
    out.push(id)
  }
  return out
}

function probeWorkspaces(client: ClientContextLike): WorkspacesProbe {
  try {
    // `ctx.get` 抛错按服务缺席处理（`index.test.tsx` 的既有前提）：可选服务的读面不许拖垮激活。
    const service = client.get?.('workspaces') as { readonly list?: unknown } | null | undefined
    if (service === undefined || service === null || typeof service !== 'object') return { kind: 'absent' }
    const list = service.list as { getSnapshot?: unknown; subscribe?: unknown } | null | undefined
    if (list === undefined || list === null || typeof list !== 'object') return { kind: 'bad' }
    if (typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return { kind: 'bad' }
    return { kind: 'ok', list: list as unknown as WorkspacesListLike }
  } catch {
    return { kind: 'absent' }
  }
}

/**
 * 观察一个已经拿到手的 list：返回 disposer（交给 `client.effect` 的工厂收尾）。
 *
 * 退订函数缺席（宿主违约）时订阅已留在宿主的监听者表里、摘不掉——这一支**置失效标记**：
 * 之后宿主再派发也不戳已卸载的现场，并在 console.info 留因。
 */
function watchList(list: WorkspacesListLike): () => void {
  let active = true
  let unsubscribe: (() => void) | undefined
  try {
    let previous = archivedIdsOf(list.getSnapshot()) ?? []
    const off = list.subscribe(() => {
      if (!active) return
      try {
        const current = archivedIdsOf(list.getSnapshot())
        // 形状在订阅期间漂了 ⇒ 按降级处理（不再戳）。
        if (current === undefined) return
        const changed = current.length !== previous.length || current.some((id, index) => id !== previous[index])
        previous = current
        if (changed) invalidateArchive()
      } catch {
        // 订阅回调是宿主派发的收尾路径：抛错只许安静降级（不再戳），不许打进宿主的监听者。
      }
    })
    if (typeof off === 'function') unsubscribe = off
    else console.info('[dsh-session-delete] workspaces.list.subscribe 没有交回退订函数：退订只能置失效标记（安静降级）')
  } catch (error) {
    console.info(`[dsh-session-delete] workspaces 归档观察安装失败：A1 不可用（安静降级）：${String(error)}`)
    active = false
    return () => {}
  }
  return () => {
    active = false
    try {
      unsubscribe?.()
    } catch {
      // 退订是卸载收尾：宿主抛错也不许打进调用方。
    }
  }
}

/**
 * 服务迟到时的 scoped 等待：装在 child ctx 上，服务就绪才安装观察；条目卸载时 child 一起收，
 * 观察的 disposer 随 child.effect 撤销。`inject` 返回的摘除函数是第二道保险（宿主给了就交回去）。
 */
function waitForWorkspaces(client: ClientContextLike): (() => void) | undefined {
  if (typeof client.inject !== 'function') return undefined
  let off: unknown
  try {
    off = client.inject(['workspaces'], (child: ClientContextLike) => {
      // child 的生命周期 = 这次等待的生命周期：观察挂在 child.effect 上，服务再来一遍就重装。
      if (typeof child.effect === 'function') {
        child.effect(() => watchFor(child, false), 'session-delete: archive host watch (late)')
        return
      }
      watchFor(child, false)
    })
  } catch (error) {
    console.info(`[dsh-session-delete] 等待 workspaces 服务失败：A1 归档观察不可用（安静降级）：${String(error)}`)
    return undefined
  }
  return typeof off === 'function'
    ? () => {
      try {
        ;(off as () => void)()
      } catch {
        // 摘除等待是卸载收尾：宿主抛错也不许打进调用方。
      }
    }
    : () => {}
}

/** 一处安装入口：拿到 list 就挂；服务没到就 scoped 等一支；其余情形安静降级。 */
function watchFor(client: ClientContextLike, allowWait: boolean): () => void {
  const probe = probeWorkspaces(client)
  if (probe.kind === 'ok') return watchList(probe.list)
  if (probe.kind === 'absent' && allowWait) {
    const waiting = waitForWorkspaces(client)
    if (waiting !== undefined) return waiting
  }
  console.info('[dsh-session-delete] workspaces 服务缺席或形状不符：A1 归档观察不可用（安静降级）')
  return () => {}
}

/**
 * 安装观察：返回 disposer（交给 `client.effect` 的工厂收尾）。服务缺席/形状不符时安静降级；
 * 服务可能迟到的那一支走 `ctx.inject` 的 scoped 等待（见文件头注）。
 */
export function installArchiveHostWatch(client: ClientContextLike): () => void {
  return watchFor(client, true)
}
