/**
 * A1：宿主归档集的**旁路观察**——浏览器半可选读宿主客户端服务
 * `ctx.get('workspaces').list`（`getSnapshot().archivedSessionIds` / `subscribe`），
 * 归档集一变就 `invalidateArchive()`。零新增宿主↔Node 面（ADR-0036「订阅不轮询」的路子）。
 *
 * 纪律（AGENTS 红线 + ADR-0060 决定第 4 条）：
 * - 窄镜像**只声明这两格**、按方法面判形；不 import 宿主包、不做 `declare module`。
 * - 可选服务走 `ctx.get`，**不进条目 `inject`**（写进去 = 这一代没有它就整条 pending）。
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

function listOf(client: ClientContextLike): WorkspacesListLike | undefined {
  try {
    // `ctx.get` 抛错按服务缺席处理（index.test.tsx 的既有前提）：可选服务的读面不许拖垮激活。
    const service = client.get?.('workspaces') as { readonly list?: unknown } | null | undefined
    if (service === undefined || service === null || typeof service !== 'object') return undefined
    const list = service.list as { getSnapshot?: unknown; subscribe?: unknown } | null | undefined
    if (list === undefined || list === null || typeof list !== 'object') return undefined
    if (typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return undefined
    return service.list as WorkspacesListLike
  } catch {
    return undefined
  }
}

/**
 * 安装观察：返回 disposer（交给 `client.effect` 的工厂收尾）。缺席/形状不符时安静降级，
 * 返回的 disposer 仍是无害 no-op。
 */
export function installArchiveHostWatch(client: ClientContextLike): () => void {
  const list = listOf(client)
  if (list === undefined) {
    console.info('[dsh-session-delete] workspaces 服务缺席或形状不符：A1 归档观察不可用（安静降级）')
    return () => {}
  }
  // 安装期的读面是可选服务的运行时面：`getSnapshot` / `subscribe` 可能抛（lazy 代理、启动期
  // 未就绪）。抛错只许折成 no-op，不许把整个条目激活一起打掉（AGENTS 红线：可选服务不进 inject）。
  let unsubscribe: (() => void) | undefined
  try {
    let previous = archivedIdsOf(list.getSnapshot()) ?? []
    const off = list.subscribe(() => {
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
    if (typeof off !== 'function') {
      console.info('[dsh-session-delete] workspaces.list.subscribe 没有交回退订函数：A1 归档观察不可用（安静降级）')
      return () => {}
    }
    unsubscribe = off
  } catch (error) {
    console.info(`[dsh-session-delete] workspaces 归档观察安装失败：A1 不可用（安静降级）：${String(error)}`)
    return () => {}
  }
  return () => {
    try {
      unsubscribe()
    } catch {
      // 退订是卸载收尾：宿主抛错也不许打进调用方。
    }
  }
}
