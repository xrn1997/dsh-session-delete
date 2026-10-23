// 模块级快照 store 的最小核心（2026-10-20）：客户端各现场共用同一套订阅语义。
//
// 语义只有三条：同引用不发通告（`Object.is`）、`publish` 每次递增**本实例**的 seq、
// `reset` 只给测试收场（回初值 + seq 清零）。`use()` 走 React 自带的 `useSyncExternalStore`。
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createLazyStore, createStore } from '../../src/client/store.js'

describe('createStore', () => {
  it('get() 回最初那一份引用（不是拷贝）', () => {
    const initial = { n: 1 }
    const store = createStore(initial)
    expect(store.get()).toBe(initial)
  })

  it('set：换了值通告一次；同一个引用一次都不通告', () => {
    const store = createStore({ n: 1 })
    const listener = vi.fn()
    store.subscribe(listener)
    store.set(store.get())
    expect(listener).not.toHaveBeenCalled()
    const next = { n: 2 }
    store.set(next)
    expect(store.get()).toBe(next)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('subscribe：每个订阅者都收到通告；退订之后只剩没退的那个', () => {
    const store = createStore(0)
    const one = vi.fn()
    const two = vi.fn()
    const offOne = store.subscribe(one)
    const offTwo = store.subscribe(two)
    store.set(1)
    expect(one).toHaveBeenCalledTimes(1)
    expect(two).toHaveBeenCalledTimes(1)
    offOne()
    store.set(2)
    expect(one).toHaveBeenCalledTimes(1)
    expect(two).toHaveBeenCalledTimes(2)
    offTwo()
    store.set(3)
    expect(two).toHaveBeenCalledTimes(2)
  })

  it('update：回调回同一引用 ⇒ false 且不发通告；回新值 ⇒ true 并发通告', () => {
    const store = createStore({ n: 1 })
    const listener = vi.fn()
    store.subscribe(listener)
    expect(store.update((current) => current)).toBe(false)
    expect(listener).not.toHaveBeenCalled()
    expect(store.update((current) => ({ n: current.n + 1 }))).toBe(true)
    expect(store.get().n).toBe(2)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('publish：seq 从 1 起逐次递增，每次都发通告（即使值没变）', () => {
    const store = createStore(0)
    const seen: number[] = []
    const listener = vi.fn(() => {
      seen.push(store.get())
    })
    store.subscribe(listener)
    store.publish((seq) => seq)
    store.publish((seq) => seq)
    store.publish((seq) => seq)
    expect(seen).toEqual([1, 2, 3])
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('publish 不按 Object.is 去重：连发两次同值也通告两次', () => {
    // seq 是重挂载的 key，不是"值变了没有"的版本号：同一段提示连续出现两次也要算两次停留。
    const store = createStore(0)
    const listener = vi.fn()
    store.subscribe(listener)
    store.publish(() => 0)
    expect(listener).toHaveBeenCalledTimes(1)
    store.publish(() => 0)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.get()).toBe(0)
  })

  it('set / update 不占 seq：publish 之间插队，下一次 publish 的 seq 仍连续', () => {
    const store = createStore(0)
    const seqs: number[] = []
    store.publish((seq) => {
      seqs.push(seq)
      return seq
    })
    store.set(10)
    expect(store.update((current) => current + 1)).toBe(true)
    store.publish((seq) => {
      seqs.push(seq)
      return seq
    })
    expect(seqs).toEqual([1, 2])
    expect(store.get()).toBe(2)
  })

  it('reset：回最初那份引用并通告一次；本来就在初值 ⇒ 不通告', () => {
    const initial = { n: 1 }
    const store = createStore(initial)
    const listener = vi.fn()
    store.subscribe(listener)
    store.publish(() => ({ n: 2 }))
    expect(listener).toHaveBeenCalledTimes(1)
    store.reset()
    expect(store.get()).toBe(initial)
    expect(listener).toHaveBeenCalledTimes(2)
    store.reset()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('reset 把 seq 清零：下一个 publish 又从 1 数', () => {
    const store = createStore<number | null>(null)
    const seqs: number[] = []
    store.publish((seq) => {
      seqs.push(seq)
      return seq
    })
    store.publish((seq) => {
      seqs.push(seq)
      return seq
    })
    store.reset()
    store.publish((seq) => {
      seqs.push(seq)
      return seq
    })
    expect(seqs).toEqual([1, 2, 1])
  })

  it('use()：组件读到当前值，set 与 reset 都会触发重渲染', () => {
    const store = createStore(1)
    const { result } = renderHook(() => store.use())
    expect(result.current).toBe(1)
    act(() => {
      store.set(2)
    })
    expect(result.current).toBe(2)
    act(() => {
      store.reset()
    })
    expect(result.current).toBe(1)
  })
})

describe('createLazyStore', () => {
  it('脏了才 read；干净时回同一个引用，invalidate 后重读并通告', () => {
    const read = vi.fn((): readonly string[] => ['a'])
    const store = createLazyStore<readonly string[]>([], read)
    expect(read).not.toHaveBeenCalled()

    const first = store.get()
    expect(first).toEqual(['a'])
    expect(read).toHaveBeenCalledTimes(1)
    expect(store.get()).toBe(first)
    expect(read).toHaveBeenCalledTimes(1)

    const listener = vi.fn()
    store.subscribe(listener)
    store.invalidate()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.get()).toEqual(['a'])
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('首个订阅者接上观察者，最后一个退订时断开；退订后下一次 get 重读', () => {
    const read = vi.fn((): readonly string[] => ['a'])
    const onFirstSubscribe = vi.fn()
    const onLastUnsubscribe = vi.fn()
    const store = createLazyStore<readonly string[]>([], read, { onFirstSubscribe, onLastUnsubscribe })

    const offOne = store.subscribe(() => {})
    const offTwo = store.subscribe(() => {})
    expect(onFirstSubscribe).toHaveBeenCalledTimes(1)
    store.get()
    expect(read).toHaveBeenCalledTimes(1)

    offOne()
    expect(onLastUnsubscribe).not.toHaveBeenCalled()
    offTwo()
    expect(onLastUnsubscribe).toHaveBeenCalledTimes(1)
    store.get()
    expect(read).toHaveBeenCalledTimes(2)
  })
})
