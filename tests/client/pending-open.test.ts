// 重开等待句柄（ADR-0036）：票、订阅、放弃 timer 与 settle 都关在 createPendingOpen 里。
// main-view 的集成行为住 main-view.test.ts；这里只钉这个句柄自己的生命周期。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPendingOpen } from '../../src/client/pending-open.js'

function makeStore(initialReady: boolean) {
  const listeners = new Set<() => void>()
  let ready = initialReady
  return {
    isReady: () => ready,
    setReady: (next: boolean) => { ready = next },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    notify: () => { for (const listener of [...listeners]) listener() },
    listenerCount: () => listeners.size,
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('createPendingOpen', () => {
  it('已经出现 ⇒ 立即打开，不订阅', () => {
    const store = makeStore(true)
    const open = vi.fn()
    const pending = createPendingOpen()

    pending.schedule({ subscribe: store.subscribe, isReady: store.isReady, canOpen: () => true, open })

    expect(open).toHaveBeenCalledTimes(1)
    expect(store.listenerCount()).toBe(0)
  })

  it('还没出现 ⇒ 等通知；出现即打开并退订', () => {
    const store = makeStore(false)
    const open = vi.fn()
    const pending = createPendingOpen()
    pending.schedule({ subscribe: store.subscribe, isReady: store.isReady, canOpen: () => true, open })

    expect(open).not.toHaveBeenCalled()
    expect(store.listenerCount()).toBe(1)

    store.setReady(true)
    store.notify()

    expect(open).toHaveBeenCalledTimes(1)
    expect(store.listenerCount()).toBe(0)
    vi.advanceTimersByTime(10_000)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('放弃边界到点 ⇒ 退订且之后现身也不再开', () => {
    const store = makeStore(false)
    const open = vi.fn()
    const pending = createPendingOpen()
    pending.schedule({ subscribe: store.subscribe, isReady: store.isReady, canOpen: () => true, open })

    vi.advanceTimersByTime(1999)
    expect(open).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(store.listenerCount()).toBe(0)

    store.setReady(true)
    store.notify()
    expect(open).not.toHaveBeenCalled()
  })

  it('新一次 schedule 取消旧等待：只开最新那条', () => {
    const store = makeStore(false)
    const oldOpen = vi.fn()
    const newOpen = vi.fn()
    const pending = createPendingOpen()
    pending.schedule({ subscribe: store.subscribe, isReady: store.isReady, canOpen: () => true, open: oldOpen })
    pending.schedule({ subscribe: store.subscribe, isReady: store.isReady, canOpen: () => true, open: newOpen })

    store.setReady(true)
    store.notify()
    expect(oldOpen).not.toHaveBeenCalled()
    expect(newOpen).toHaveBeenCalledTimes(1)
    expect(store.listenerCount()).toBe(0)
  })

  it('cancel 可重复调用；取消后通知不再打开', () => {
    const store = makeStore(false)
    const open = vi.fn()
    const pending = createPendingOpen()
    pending.schedule({ subscribe: store.subscribe, isReady: store.isReady, canOpen: () => true, open })

    pending.cancel()
    pending.cancel()
    expect(store.listenerCount()).toBe(0)

    store.setReady(true)
    store.notify()
    expect(open).not.toHaveBeenCalled()
  })

  it('出现时已不该抢焦点 ⇒ 不打开，等待收场', () => {
    const store = makeStore(false)
    const open = vi.fn()
    const pending = createPendingOpen()
    pending.schedule({ subscribe: store.subscribe, isReady: store.isReady, canOpen: () => false, open })

    store.setReady(true)
    store.notify()
    expect(open).not.toHaveBeenCalled()
    expect(store.listenerCount()).toBe(0)
  })

  it('旧 store 没有 subscribe：没出现就放弃，不偷跑定时器', () => {
    const store = makeStore(false)
    const open = vi.fn()
    const pending = createPendingOpen()
    pending.schedule({ isReady: store.isReady, canOpen: () => true, open })

    vi.advanceTimersByTime(60_000)
    expect(open).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('subscribe 抛错 ⇒ 这次等待安静作废，cancel 仍安全', () => {
    const open = vi.fn()
    const pending = createPendingOpen()
    expect(() => pending.schedule({
      subscribe: () => { throw new Error('宿主 store 换代') },
      isReady: () => false,
      canOpen: () => true,
      open,
    })).not.toThrow()
    expect(open).not.toHaveBeenCalled()
    expect(() => pending.cancel()).not.toThrow()
  })

  it('subscribe 同步回调且已出现 ⇒ 打开一次，返回后补退订', () => {
    let ready = false
    const listeners = new Set<() => void>()
    const open = vi.fn()
    const pending = createPendingOpen()
    pending.schedule({
      subscribe: (listener) => {
        listeners.add(listener)
        ready = true
        listener()
        return () => { listeners.delete(listener) }
      },
      isReady: () => ready,
      canOpen: () => true,
      open,
    })

    expect(open).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(0)
  })
})
