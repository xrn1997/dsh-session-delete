/**
 * A1：宿主归档集的旁路观察（`host-archive-watch.ts`）。
 *
 * 窄镜像只认两格（`workspaces.list.getSnapshot().archivedSessionIds` / `list.subscribe`）；
 * 服务缺席、形状不符、安装期读面抛错一律**安静降级**（不抛、不戳）——可选服务不许拖垮激活。
 * 归档集数组变化（逐元素比较）才 `invalidateArchive()`；无关的 workspace 变更不戳。
 * 不 import 宿主包、不进条目 `inject`（AGENTS 红线）。
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateArchive, resetArchiveStore, useArchiveRevision } from '../../src/client/archive-store.js'
import { installArchiveHostWatch } from '../../src/client/host-archive-watch.js'
import type { ClientContextLike } from '../../src/client/context.js'
interface FakeWorkspaces {
  list: {
    getSnapshot: () => { archivedSessionIds: string[] }
    subscribe: (listener: () => void) => () => void
  }
}

/** 假 ctx：`get` 投影一个可变的 workspaces 服务；`effect` 收下 disposer。 */
function fakeClient(workspaces: unknown): { client: ClientContextLike; disposers: Array<() => void> } {
  const disposers: Array<() => void> = []
  const client = {
    slots: { inject: () => {}, register: () => {} },
    get: (name: string) => (name === 'workspaces' ? workspaces : undefined),
    effect: (execute: () => unknown) => { disposers.push(execute() as () => void) },
  } as unknown as ClientContextLike
  return { client, disposers }
}

function workspacesWith(ids: string[]): FakeWorkspaces & { emit: () => void } {
  const current = [...ids]
  let listener: (() => void) | undefined
  return {
    list: {
      getSnapshot: () => ({ archivedSessionIds: current }),
      subscribe: (cb: () => void) => {
        listener = cb
        return () => { listener = undefined }
      },
    },
    emit: () => { listener?.() },
  }
}

describe('A1 · host-archive-watch', () => {
  beforeEach(() => {
    resetArchiveStore()
    // 降级路径会 console.info 留因；用例只看行为，别把提示刷进输出。
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
  })

  it('归档集数组变化（增/删 id）⇒ invalidateArchive；无关变更（同内容）不戳', () => {
    const { result } = renderHook(() => useArchiveRevision())
    const workspaces = workspacesWith(['session-a'])
    installArchiveHostWatch(fakeClient(workspaces).client)

    // 同内容的再通知：不是变化，不戳。
    act(() => { workspaces.emit() })
    expect(result.current).toBe(0)

    // 新增一个 id ⇒ 变化。
    act(() => {
      workspaces.list.getSnapshot().archivedSessionIds.push('session-b')
      workspaces.emit()
    })
    expect(result.current).toBe(1)

    // 删掉一个 id ⇒ 变化。
    act(() => {
      workspaces.list.getSnapshot().archivedSessionIds.splice(1, 1)
      workspaces.emit()
    })
    expect(result.current).toBe(2)

    // 再次同内容 ⇒ 不戳。
    act(() => { workspaces.emit() })
    expect(result.current).toBe(2)
  })

  it('服务缺席 / list 形状不符 ⇒ 安静降级：不抛、不戳', () => {
    const { result } = renderHook(() => useArchiveRevision())
    // 服务缺席（旧宿主没有 workspaces）。
    expect(() => installArchiveHostWatch(fakeClient(undefined).client)).not.toThrow()
    // list 缺 getSnapshot / subscribe。
    expect(() => { installArchiveHostWatch(fakeClient({ list: {} }).client)() }).not.toThrow()
    // getSnapshot 回的不是数组。
    const odd = { list: { getSnapshot: () => ({ archivedSessionIds: '不是数组' }), subscribe: () => () => {} } }
    expect(() => installArchiveHostWatch(fakeClient(odd).client)).not.toThrow()
    // ctx.get 本身缺席（更老的宿主）。
    const noGet = { slots: { inject: () => {}, register: () => {} }, effect: () => {} } as unknown as ClientContextLike
    expect(() => installArchiveHostWatch(noGet)).not.toThrow()
    act(() => { invalidateArchive() })
    expect(result.current).toBe(1) // 只有刚才那一次手动戳：降级路径一次都没戳过
  })

  it('安装期读面抛错 / 退订函数缺席 ⇒ 安静降级：不抛、不戳、disposer 无害', () => {
    const { result } = renderHook(() => useArchiveRevision())
    // getSnapshot 在安装期抛（lazy 代理、启动期未就绪）。
    const snapshotThrows = { list: { getSnapshot: () => { throw new Error('boom') }, subscribe: () => () => {} } }
    expect(() => installArchiveHostWatch(fakeClient(snapshotThrows).client)()).not.toThrow()
    // subscribe 在安装期抛。
    const subscribeThrows = { list: { getSnapshot: () => ({ archivedSessionIds: [] }), subscribe: () => { throw new Error('boom') } } }
    expect(() => installArchiveHostWatch(fakeClient(subscribeThrows).client)()).not.toThrow()
    // subscribe 没交回退订函数：订阅装上了也没法退，按不可用处理。
    const badUnsubscribe = { list: { getSnapshot: () => ({ archivedSessionIds: [] }), subscribe: () => undefined } }
    expect(() => installArchiveHostWatch(fakeClient(badUnsubscribe).client)()).not.toThrow()
    act(() => { invalidateArchive() })
    expect(result.current).toBe(1) // 只有刚才那一次手动戳：降级路径一次都没戳过
  })

  it('服务迟到 ⇒ ctx.inject 的 scoped 等待切过去；就绪后观察生效、收尾后不再戳', () => {
    const { result } = renderHook(() => useArchiveRevision())
    const workspaces = workspacesWith(['session-a'])
    let arrive: ((child: ClientContextLike) => unknown) | undefined
    const listen = vi.fn((_deps: readonly string[], callback: (child: ClientContextLike) => unknown) => {
      arrive = callback
      return () => { arrive = undefined }
    })
    const childDisposers: Array<() => void> = []
    const child = {
      slots: { inject: () => {}, register: () => {} },
      get: (name: string) => (name === 'workspaces' ? workspaces : undefined),
      effect: (execute: () => unknown) => { childDisposers.push(execute() as () => void) },
    } as unknown as ClientContextLike
    // 宿主这一拍还没提供 workspaces：`get` 落空、`inject` 就是 scoped 等待面。
    const client = {
      slots: { inject: () => {}, register: () => {} },
      get: () => undefined,
      inject: listen,
      effect: (execute: () => unknown) => execute(),
    } as unknown as ClientContextLike

    const dispose = installArchiveHostWatch(client)
    expect(listen).toHaveBeenCalledTimes(1)
    expect(listen.mock.calls[0]?.[0]).toEqual(['workspaces'])

    // 服务就绪：child ctx 上装出观察（disposer 收进 child.effect）。
    act(() => { arrive?.(child) })
    expect(childDisposers).toHaveLength(1)

    act(() => {
      workspaces.list.getSnapshot().archivedSessionIds.push('session-b')
      workspaces.emit()
    })
    expect(result.current).toBe(1)

    // 等待的摘除函数与 child 的收尾各管一边：卸掉后不再戳。
    act(() => { dispose() })
    act(() => { childDisposers[0]?.() })
    act(() => {
      workspaces.list.getSnapshot().archivedSessionIds.push('session-c')
      workspaces.emit()
    })
    expect(result.current).toBe(1)
  })

  it('服务已就绪 ⇒ 不装 scoped 等待（inject 零调用）', () => {
    const workspaces = workspacesWith(['session-a'])
    const listen = vi.fn()
    const client = {
      slots: { inject: () => {}, register: () => {} },
      get: (name: string) => (name === 'workspaces' ? workspaces : undefined),
      inject: listen,
      effect: () => {},
    } as unknown as ClientContextLike
    expect(() => installArchiveHostWatch(client)()).not.toThrow()
    expect(listen).not.toHaveBeenCalled()
  })

  it('disposer 退订：摘掉之后归档集再变也不戳', () => {
    const { result } = renderHook(() => useArchiveRevision())
    const workspaces = workspacesWith(['session-a'])
    // 生产由 `client.effect` 收这条 disposer（index.tsx）；这里直接拿回来验退订语义。
    const dispose = installArchiveHostWatch(fakeClient(workspaces).client)
    act(() => { dispose() })
    act(() => {
      workspaces.list.getSnapshot().archivedSessionIds.push('session-b')
      workspaces.emit()
    })
    expect(result.current).toBe(0)
  })
})
