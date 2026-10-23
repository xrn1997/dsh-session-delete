/**
 * 客户端**模块级快照 store** 的唯一实现（2026-10-20）。
 *
 * 为什么要有它：浏览器半有一批"跨卸载的现场"——回收站修订号（`trash-store.ts`）、单删请求
 * （`delete-confirm.tsx`）、批量删除请求（`batch-confirm.tsx`）、撤销提示（`undo-toast.tsx`）、
 * 批量选中集（`batch-selection-store.ts`）等。它们都挂在 `shell.overlay` / `main` / 菜单行这些
 * 互不相邻的座位上，模块级是唯一的共同点。
 * 在这之前每个文件各写一遍「`let` 现场 + `Set<() => void>` + `notify` + `useSyncExternalStore`」，
 * 各自的 seq / revision 也在分头维护。现在订阅/通告只住这一处。
 *
 * 另有一个**懒读快照**变体（`createLazyStore`）：值由组件树之外的事实源（宿主 DOM）现读，
 * 脏了才重读；订阅脚手架仍住这里，观察者生命周期由调用方挂 `onFirstSubscribe` / `onLastUnsubscribe`。
 *
 * 语义（四条，别在调用方另算一遍）：
 * - `set` / `update` 用 `Object.is` 判"变过"：同一个引用不重渲染（React 的 snapshot 契约要求）。
 * - `publish(make)` 递增**本实例**的 seq（从 1 起）并**总是**通告——seq 是组件重挂载的 key
 *   （同一段文案连续出现两次也要重新计一次停留），不是版本号。
 * - `subscribe` 回退订函数；`use()` 就是 `useSyncExternalStore(subscribe, get, get)`。
 * - `reset()` 只给测试收场：回最初那份引用、seq 清零，值没变就不通告。
 */
import { useSyncExternalStore } from 'react'

export interface ClientStore<T> {
  get(): T
  set(next: T): void
  /** 回调回同一引用 ⇒ `false`（不发通告）；新值 ⇒ `true`。 */
  update(next: (current: T) => T): boolean
  /**
   * 以本次递增的 seq（从 1 起）造新值并通告，值没变也通告。
   * **`make` 回的值必须把 seq 带上**（放进快照字段，如 `{ seq, items }`）：订阅方拿它当 React key
   * 才会在"同一段文案连续出现两次"时重挂载；丢了 seq，重挂载语义会静默消失。
   */
  publish(make: (seq: number) => T): void
  subscribe(listener: () => void): () => void
  use(): T
  /** 测试专用：回初值并清零 seq。 */
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
  get(): T
  /** 标脏并通告；下一次 `get()` 重读。 */
  invalidate(): void
  subscribe(listener: () => void): () => void
}

export interface LazyStoreLifecycle {
  /** 第一个订阅者到来时跑（观察者在这里接上）。 */
  onFirstSubscribe?(): void
  /** 最后一个订阅者退订时跑（观察者在这里断开）。 */
  onLastUnsubscribe?(): void
}

export function createLazyStore<T>(
  initial: T,
  read: () => T,
  lifecycle: LazyStoreLifecycle = {},
): LazyStore<T> {
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
      // 只在从「无人订阅」重新挂上来时标脏：有观察者在场时外部变更已由 `invalidate` 通告过，
      // 每次订阅都标脏会让 React 订阅后的快照复查拿到一个新引用，白多一次重读与重渲染。
      const reattaching = listeners.size === 0
      listeners.add(listener)
      if (reattaching) {
        dirty = true
        lifecycle.onFirstSubscribe?.()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        lifecycle.onLastUnsubscribe?.()
        // 没人订阅时缓存不再自证新鲜（外部源可能在无观察期间变过）：下次挂载首帧先重读。
        dirty = true
      }
    },
  }
}
