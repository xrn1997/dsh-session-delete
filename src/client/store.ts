/**
 * 客户端快照 store 的唯一实现：订阅/通告只住这一处；跨槽位共享靠 `scene.ts` 的同一实例（ADR-0066）。
 * 另有三件同源脚手架：`createLazyStore`（脏了才重读）、`createLatestWins`（并发异步读只有最新可落地）、`useLatest`（引用归一）。
 *
 * 语义：`set` / `update` 用 `Object.is` 判变；`publish` 递增本实例 seq 且总是通告（seq 是重挂载 key，不是版本号）；
 * `use()` 即 `useSyncExternalStore(subscribe, get, get)`；`reset()` 只给测试收场。
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'

export interface ClientStore<T> {
  get(): T
  set(next: T): void
  update(next: (current: T) => T): boolean
  /** 以本次递增的 seq 造新值并通告（值没变也通告）；`make` 回的值**必须把 seq 带上**，订阅方靠它重挂载。 */
  publish(make: (seq: number) => T): void
  subscribe(listener: () => void): () => void
  use(): T
  reset(): void
}

export function createStore<T>(initial: T): ClientStore<T> {
  let value = initial
  let seq = 0
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  const get = (): T => value
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  return {
    get,
    set(next: T): void {
      if (Object.is(next, value)) return
      value = next
      notify()
    },
    update(next: (current: T) => T): boolean {
      const candidate = next(value)
      if (Object.is(candidate, value)) return false
      value = candidate
      notify()
      return true
    },
    publish(make: (seq: number) => T): void {
      seq += 1
      value = make(seq)
      notify()
    },
    subscribe,
    use(): T {
      return useSyncExternalStore(subscribe, get, get)
    },
    reset(): void {
      seq = 0
      if (Object.is(initial, value)) return
      value = initial
      notify()
    },
  }
}

/** 懒读快照：`get()` 只在脏了时调用 `read()`，干净时回同一个引用（React snapshot 契约）。 */
export interface LazyStore<T> {
  /** 属性声明：`get` / `subscribe` 会被摘下来直接交给 `useSyncExternalStore`；方法简写会给隐式 `this`，触发 `unbound-method` 误报。 */
  get: () => T
  invalidate: () => void
  subscribe: (listener: () => void) => () => void
}

export function createLazyStore<T>(initial: T, read: () => T): LazyStore<T> {
  let cached = initial
  let dirty = true
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }

  return {
    get(): T {
      if (dirty) {
        cached = read()
        dirty = false
      }
      return cached
    },
    invalidate(): void {
      dirty = true
      notify()
    },
    subscribe(listener: () => void): () => void {
      // 只在从「无人订阅」重新挂上来时标脏：有订阅者在场时外部变更已由 `invalidate` 通告过，不然会白多一次重读。
      if (listeners.size === 0) dirty = true
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        // 没人订阅时缓存不再自证新鲜（外部源可能在无订阅期间变过）：下次挂载首帧先重读。
        if (listeners.size === 0) dirty = true
      }
    },
  }
}

/** 最新票句柄：异步读落地前问 `ticket.current`，旧读不会盖掉新状态；只拥有 compare-and-set，防抖/轮询/焦点策略仍归调用方。
 *  组件里取同一枚句柄用 `useState(createLatestWins)`，不要 `useMemo`：React 允许丢缓存，丢了就是两张各自记数的票台。 */
export interface LatestWinsTicket { readonly current: boolean }

export interface LatestWins {
  issue(): LatestWinsTicket
  invalidate(): void
}

export function createLatestWins(): LatestWins {
  let seq = 0
  return {
    issue(): LatestWinsTicket {
      const token = ++seq
      return {
        get current(): boolean {
          return token === seq
        },
      }
    },
    invalidate(): void {
      seq += 1
    },
  }
}

/** 引用归一：回调只经这份 ref 读最新值，身份恒稳、可进 effect 依赖（写回在 effect 里，与渲染期只读约定一致）。
 *  别在调用方再手写「useRef + 每渲染写回」（issue #8 第 3 条）。 */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value)
  useEffect(() => { ref.current = value })
  return ref
}
