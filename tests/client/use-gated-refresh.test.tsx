/**
 * 读路径生命周期 `useGatedRefresh`（Task 2A，机制层，未接线）：钉读路径加固设计第 2 节的
 * 迁移表与不变量——P1 不活动零读、P2 修订必先作废、P3 dirty 不丢、P4 single-flight、
 * P5 风暴有界、P6 卸载安全。
 *
 * 「latest 语义由调用方的 refresh 自持」不在这里测——hook 只保证单飞与追补的节奏。
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_REFRESH_COALESCE_MS,
  useGatedRefresh,
  type GatedRefreshPolicy,
} from '../../src/client/use-gated-refresh.js'

interface Input {
  active: boolean
  demand?: boolean
  revisions: number[]
  onInvalidate?: () => void
  refresh: () => Promise<void>
  policy?: GatedRefreshPolicy
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (reason?: unknown) => void } {
  let resolve!: () => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

type RefreshFn = () => Promise<void>

/** 受控 refresh：每次调用登记一张可结算的票，测试自己决定何时落地。 */
function controllableRefresh() {
  const calls: ReturnType<typeof deferred>[] = []
  const refresh: RefreshFn = () => {
    const d = deferred()
    calls.push(d)
    return d.promise
  }
  return { refresh, calls }
}

/**
 * 挂载并给出 `set()`：它按**整份新输入**重挂（一次说清这一拍的全部档位），不拿旧现场做增量
 * ——增量展开曾把上一拍的修订号悄悄带回来，测出来的节奏是假的。
 * `refresh` 走可变 holder：hook 经 `useLatest` 读最新那一份，测试换回调只换 holder 指向。
 */
function mountGated(initialRefresh: RefreshFn, initial: Omit<Input, 'refresh'>) {
  const base: Omit<Input, 'refresh'> = { ...initial }
  let current = initialRefresh
  const stable: RefreshFn = () => current()
  const view = renderHook((p: Input) => useGatedRefresh(p), { initialProps: { ...base, refresh: stable } })
  return {
    ...view,
    set(next: Partial<Omit<Input, 'refresh'>>, refresh?: RefreshFn): void {
      Object.assign(base, next)
      if (refresh !== undefined) current = refresh
      view.rerender({ ...base, refresh: stable })
    },
  }
}

/** 推进假时钟并把挂起的微任务全部跑完（timer 回调里同步启动了 refresh）。 */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

/**
 * 空转到静止：一拍的「effect → queueMicrotask → start → refresh 结算 → 追补调度」是微任务与
 * React commit 交替的链，一次 `act` 只推一环，所以让出到计数不再变化为止。
 * 传 settle 时先手动结算最早那张在飞的票，再等追补那一步出现。
 */
async function flush(calls: readonly unknown[], settleFirst = false): Promise<void> {
  if (settleFirst) (calls as ReturnType<typeof deferred>[])[0]?.resolve()
  for (let round = 0; round < 12; round++) {
    const before = calls.length
    await act(async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
    if (!settleFirst && calls.length === before) return
    if (settleFirst && calls.length > before) return
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('useGatedRefresh · 档位门与合并', () => {
  it('常量口径：默认合并窗 120ms，policy 缺省合并窗为 0', () => {
    expect(DEFAULT_REFRESH_COALESCE_MS).toBe(120)
  })

  it('(a) active=false 修订 0 次读；置 active 后恰好 1 次（dirty 不丢）', async () => {
    const { refresh, calls } = controllableRefresh()
    const m = mountGated(refresh, { active: false, revisions: [0] })

    m.set({ revisions: [1] })
    await flush(calls)
    await tick(1000)
    expect(calls.length).toBe(0)

    m.set({ active: true })
    await flush(calls)
    expect(calls.length).toBe(1)
    calls[0]?.resolve()
    await flush(calls)
  })

  it('(b) 同一提交里两台修订各进一位 → 1 次读（不并发第二次）', async () => {
    const { refresh, calls } = controllableRefresh()
    // initialDirty 让挂载读一次；先结算并追平，随后的一次 rerender 同时推进两台修订号。
    const m = mountGated(refresh, {
      active: true,
      revisions: [0, 0],
      policy: { initialDirty: true },
    })
    await flush(calls)
    expect(calls.length).toBe(1)
    calls[0]?.resolve()
    await flush(calls)

    m.set({ revisions: [1, 1] })
    await flush(calls)
    expect(calls.length).toBe(2)

    // 结算后没有第三轮：合并的是同一拍，不是把两台修订串成两读。
    calls[1]?.resolve()
    await flush(calls)
    await tick(1000)
    expect(calls.length).toBe(2)
  })

  it('(c) coalesceMs=120：50ms 间隔 5 次修订合并为 1 次（trailing，窗口重置）', async () => {
    const { refresh, calls } = controllableRefresh()
    const m = mountGated(refresh, {
      active: true,
      revisions: [0],
      policy: { coalesceMs: 120 },
    })

    for (let i = 1; i <= 5; i++) {
      m.set({ revisions: [i] })
      if (i < 5) await tick(50)
    }
    // 最后一次修订之后不足窗口：还在等，一次都没读。
    expect(calls.length).toBe(0)

    await tick(119)
    expect(calls.length).toBe(0)
    await tick(1)
    expect(calls.length).toBe(1)
    calls[0]?.resolve()
    await flush(calls)
  })

  it('(d) 在飞期间修订只置脏；结算后恰好 1 次追补（单飞，不并发）', async () => {
    const { refresh, calls } = controllableRefresh()
    const m = mountGated(refresh, { active: true, revisions: [0], policy: { initialDirty: true } })
    // 挂载读排在微任务上（initialDirty），deferred 让它停在飞。
    await flush(calls)
    expect(calls.length).toBe(1)

    // 第一张票还没落地时来两次修订：不排第二次并发读，也不立刻再读。
    m.set({ revisions: [1] })
    await flush(calls)
    m.set({ revisions: [2] })
    await flush(calls)
    expect(calls.length).toBe(1)

    // 结算后恰好一轮追补。
    await flush(calls, true)
    expect(calls.length).toBe(2)

    // 追补也消费干净：没有第三轮。
    calls[1]?.resolve()
    await flush(calls)
    await tick(1000)
    expect(calls.length).toBe(2)
  })

  it('(e) demand false→true 且 dirty → 1 次；干净时翻上来不读', async () => {
    const { refresh, calls } = controllableRefresh()
    const m = mountGated(refresh, { active: true, demand: false, revisions: [0] })

    m.set({ revisions: [1] })
    await flush(calls)
    expect(calls.length).toBe(0)

    m.set({ demand: true })
    await flush(calls)
    expect(calls.length).toBe(1)
    calls[0]?.resolve()
    await flush(calls)

    // 已追平：demand 再翻一次不该白读。
    m.set({ demand: false })
    await flush(calls)
    m.set({ demand: true })
    await flush(calls)
    expect(calls.length).toBe(1)
  })

  it('(f) 卸载后推进时间 → 0 次、无残留 timer', async () => {
    const { refresh, calls } = controllableRefresh()
    const m = mountGated(refresh, {
      active: true,
      revisions: [0],
      policy: { coalesceMs: 120, initialDirty: true },
    })
    await flush(calls)
    expect(calls.length).toBe(0) // 窗口还开着，没读

    m.unmount()
    await tick(1000)
    expect(calls.length).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('(g) refreshOnActivate：true 时激活必读；false 时不 dirty 不读', async () => {
    const forced = controllableRefresh()
    const mForced = mountGated(forced.refresh, {
      active: false,
      revisions: [0],
      policy: { refreshOnActivate: true },
    })
    mForced.set({ active: true })
    await flush(forced.calls)
    expect(forced.calls.length).toBe(1)
    forced.calls[0]?.resolve()
    await flush(forced.calls)
    // 追平之后切走再切回：refreshOnActivate 仍强制读——「即使不 dirty 激活也读」。
    mForced.set({ active: false })
    await flush(forced.calls)
    mForced.set({ active: true })
    await flush(forced.calls)
    expect(forced.calls.length).toBe(2)
    forced.calls[1]?.resolve()
    await flush(forced.calls)
    mForced.unmount()

    const gatedAgain = controllableRefresh()
    const mClean = mountGated(gatedAgain.refresh, {
      active: false,
      revisions: [0],
      policy: { refreshOnActivate: false },
    })
    // 挂载本身不再算一次修订：不活动挂载干净，激活也不读。
    await flush(gatedAgain.calls)
    mClean.set({ active: true })
    await flush(gatedAgain.calls)
    await tick(1000)
    expect(gatedAgain.calls.length).toBe(0)
  })
})

describe('useGatedRefresh · 挂载策略与作废回调', () => {
  it('initialDirty：active 挂载即读；不活动挂载不读，激活那一拍才读', async () => {
    const withList = controllableRefresh()
    const mList = mountGated(withList.refresh, {
      active: true,
      revisions: [0],
      policy: { initialDirty: true },
    })
    await flush(withList.calls)
    expect(withList.calls.length).toBe(1)
    withList.calls[0]?.resolve()
    await flush(withList.calls)
    mList.unmount()

    const inactive = controllableRefresh()
    const mInactive = mountGated(inactive.refresh, {
      active: false,
      revisions: [0],
      policy: { initialDirty: true },
    })
    await flush(inactive.calls)
    await tick(1000)
    expect(inactive.calls.length).toBe(0)

    mInactive.set({ active: true })
    await flush(inactive.calls)
    expect(inactive.calls.length).toBe(1)
    inactive.calls[0]?.resolve()
    await flush(inactive.calls)
  })

  it('后续修订换票重排：旧微任务认输，只落地最新那一趟读', async () => {
    const { refresh, calls } = controllableRefresh()
    const m = mountGated(refresh, { active: true, revisions: [0], policy: { initialDirty: true } })
    await flush(calls)
    expect(calls.length).toBe(1)
    calls[0]?.resolve()
    await flush(calls)

    // 两次 `set` 各是一次提交（RTL rerender 不批处理）：两趟都换票，旧票认输，
    // 最终只落地最新那一趟读。（跨提交的连续修订不丢读，由结算后的追补兜住——见下一条。）
    m.set({ revisions: [1] })
    m.set({ revisions: [2] })
    await flush(calls)
    expect(calls.length).toBe(2)
    calls[1]?.resolve()
    await flush(calls)
  })

  it('跨提交的连续修订不丢读：前一趟结算后恰好一轮追补', async () => {
    const { refresh, calls } = controllableRefresh()
    const m = mountGated(refresh, { active: true, revisions: [0], policy: { initialDirty: true } })
    await flush(calls)
    expect(calls.length).toBe(1)

    // 第一读在飞时来第二次修订：只置脏；结算后追补一次（P4 + P5）。
    m.set({ revisions: [1] })
    await flush(calls)
    m.set({ revisions: [2] })
    await flush(calls)
    expect(calls.length).toBe(1)
    calls[0]?.resolve()
    await flush(calls)
    expect(calls.length).toBe(2)
    calls[1]?.resolve()
    await flush(calls)
    await tick(1000)
    expect(calls.length).toBe(2)
  })

  it('onInvalidate 同步先于任何读；每次修订都跑，包括不活动时', async () => {
    const order: string[] = []
    const invalidateSpy = vi.fn(() => { order.push('invalidate') })
    const m = mountGated(async () => { order.push('refresh') }, {
      active: true,
      revisions: [0],
      onInvalidate: invalidateSpy,
    })

    // 挂载不是一次修订：不动作废、不排读。
    expect(order).toEqual([])
    await flush([])
    expect(order).toEqual([])

    // 一次真实修订：作废在 commit 里同步跑，读排在它之后的微任务。
    m.set({ revisions: [1] })
    expect(order).toEqual(['invalidate'])
    await flush([])
    expect(order).toEqual(['invalidate', 'refresh'])

    // 不活动照样作废，只是不读。
    m.set({ active: false, revisions: [2] })
    expect(order.at(-1)).toBe('invalidate')
    await flush([])
    await tick(1000)
    expect(order.filter((x) => x === 'refresh').length).toBe(1)
    expect(invalidateSpy).toHaveBeenCalledTimes(2)
  })

  it('refresh 失败不隐式重试：reject 后不再排读，脏已被启动时消费', async () => {
    const { refresh, calls } = controllableRefresh()
    const m = mountGated(refresh, { active: true, revisions: [0], policy: { initialDirty: true } })
    await flush(calls)
    expect(calls.length).toBe(1)

    calls[0]?.reject(new Error('boom'))
    await flush(calls)
    await tick(1000)
    expect(calls.length).toBe(1)

    // 失败面仍归调用方上屏；后续修订照常走节奏。
    m.set({ revisions: [1] })
    await flush(calls)
    expect(calls.length).toBe(2)
    calls[1]?.resolve()
    await flush(calls)
  })

  it('回调逐渲染换新身份也认最新那一份（内联闭包经 useLatest 归一）', async () => {
    const seen: string[] = []
    const first = async (): Promise<void> => { seen.push('first') }
    const second = async (): Promise<void> => { seen.push('second') }
    const m = mountGated(first, { active: true, revisions: [0], policy: { initialDirty: true } })

    m.set({ revisions: [1] })
    await flush([])
    expect(seen).toEqual(['first'])

    // 同一拍里换 refresh + 进修订：落地的那趟读用的是最新那份回调，不是调度那一刻的旧闭包。
    m.set({ revisions: [2] }, second)
    await flush([])
    expect(seen).toEqual(['first', 'second'])
  })
})

describe('useGatedRefresh · 门与单飞的边界（review C1/I1/I2 回归）', () => {
  it('已排的读在档位关闭后不得落地：关档撤票、重开恰好 1 次（合窗）', async () => {
    const { refresh, calls } = controllableRefresh()
    const m = mountGated(refresh, {
      active: true,
      revisions: [0],
      policy: { initialDirty: true, coalesceMs: 120 },
    })
    await flush(calls)
    expect(calls.length).toBe(0) // 窗口未落地

    m.set({ active: false })
    await tick(1000)
    expect(calls.length).toBe(0)

    m.set({ active: true })
    await tick(120)
    await flush(calls)
    expect(calls.length).toBe(1)
    calls[0]?.resolve()
    await flush(calls)
    m.unmount()
  })

  it('已排的微任务票在档位关闭后不得落地（coalesceMs=0）', async () => {
    const { refresh, calls } = controllableRefresh()
    const m = mountGated(refresh, {
      active: true,
      revisions: [0],
      policy: { initialDirty: true },
    })
    // 不让出微任务：挂载排的票还在队列里，先关档。
    m.set({ active: false })
    await flush(calls)
    await tick(1000)
    expect(calls.length).toBe(0)

    m.set({ active: true })
    await flush(calls)
    expect(calls.length).toBe(1)
    calls[0]?.resolve()
    await flush(calls)
    m.unmount()
  })

  it('demand 关闭后已排的读不得落地；重开 demand 恰好 1 次', async () => {
    const { refresh, calls } = controllableRefresh()
    const m = mountGated(refresh, {
      active: true,
      revisions: [0],
      policy: { initialDirty: true, coalesceMs: 120 },
    })
    await flush(calls)
    expect(calls.length).toBe(0)

    m.set({ demand: false })
    await tick(1000)
    expect(calls.length).toBe(0)

    m.set({ demand: true })
    await tick(120)
    await flush(calls)
    expect(calls.length).toBe(1)
    calls[0]?.resolve()
    await flush(calls)
    m.unmount()
  })

  it('refreshOnActivate 在飞时不并发第二条：结算后至多一轮追补（单飞）', async () => {
    const { refresh, calls } = controllableRefresh()
    const m = mountGated(refresh, {
      active: false,
      revisions: [0],
      policy: { refreshOnActivate: true },
    })
    m.set({ active: true })
    await flush(calls)
    expect(calls.length).toBe(1)

    // 在飞中切走再切回：强制激活只置脏，不起第二条并发读。
    m.set({ active: false })
    m.set({ active: true })
    await flush(calls)
    expect(calls.length).toBe(1)

    calls[0]?.resolve()
    await flush(calls)
    expect(calls.length).toBe(2)
    calls[1]?.resolve()
    await flush(calls)
    await tick(1000)
    expect(calls.length).toBe(2)
    m.unmount()
  })

  it('refreshOnActivate 也吃 demand 门：无需求激活不读，需求翻上来才读', async () => {
    const { refresh, calls } = controllableRefresh()
    const m = mountGated(refresh, {
      active: false,
      demand: false,
      revisions: [0],
      policy: { refreshOnActivate: true },
    })
    m.set({ active: true })
    await flush(calls)
    expect(calls.length).toBe(0)

    m.set({ demand: true })
    await flush(calls)
    expect(calls.length).toBe(1)
    calls[0]?.resolve()
    await flush(calls)
    m.unmount()
  })

  it('挂载不是一次修订：默认策略下干净挂载不 invalidate 也不读', async () => {
    const invalidateSpy = vi.fn()
    const { refresh, calls } = controllableRefresh()
    const m = mountGated(refresh, {
      active: true,
      revisions: [0],
      onInvalidate: invalidateSpy,
    })
    await flush(calls)
    await tick(1000)
    expect(invalidateSpy).not.toHaveBeenCalled()
    expect(calls.length).toBe(0)
    m.unmount()
  })

  it('initialDirty 真实区分：true 挂载读一次；false 挂载不读，等真实修订', async () => {
    const dirty = controllableRefresh()
    const mDirty = mountGated(dirty.refresh, {
      active: true,
      revisions: [0],
      policy: { initialDirty: true },
    })
    await flush(dirty.calls)
    expect(dirty.calls.length).toBe(1)

    const clean = controllableRefresh()
    const mClean = mountGated(clean.refresh, {
      active: true,
      revisions: [0],
      policy: { initialDirty: false },
    })
    await flush(clean.calls)
    expect(clean.calls.length).toBe(0)

    mClean.set({ revisions: [1] })
    await flush(clean.calls)
    expect(clean.calls.length).toBe(1)
    clean.calls[0]?.resolve()
    await flush(clean.calls)

    dirty.calls[0]?.resolve()
    await flush(dirty.calls)
    mDirty.unmount()
    mClean.unmount()
  })

  it('卸载后在飞 refresh 晚到结算不得再排读（P6 另一半）', async () => {
    const { refresh, calls } = controllableRefresh()
    const m = mountGated(refresh, {
      active: true,
      revisions: [0],
      policy: { initialDirty: true },
    })
    await flush(calls)
    expect(calls.length).toBe(1)

    // 在飞期间来一次修订：dirty=true；随后卸载，结算到点也不许再排追补。
    m.set({ revisions: [1] })
    await flush(calls)
    expect(calls.length).toBe(1)

    m.unmount()
    calls[0]?.resolve()
    await flush(calls)
    await tick(1000)
    expect(calls.length).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('revisions 换新数组但内容不变：不算修订、不 invalidate', async () => {
    const invalidateSpy = vi.fn()
    const { refresh, calls } = controllableRefresh()
    const m = mountGated(refresh, {
      active: true,
      revisions: [0],
      onInvalidate: invalidateSpy,
      policy: { initialDirty: true },
    })
    await flush(calls)
    expect(calls.length).toBe(1)
    calls[0]?.resolve()
    await flush(calls)

    m.set({ revisions: [0] })
    await flush(calls)
    expect(invalidateSpy).not.toHaveBeenCalled()
    expect(calls.length).toBe(1)
    m.unmount()
  })

  it('refresh 同步抛错不把 hook 卡死：结算后后续修订仍能读', async () => {
    const calls: number[] = []
    let throwOnce = true
    // 刻意不用 async：这里要的是「调用当场 throw」，不是返回 rejected promise。
    const refresh = ((): Promise<void> => {
      calls.push(calls.length + 1)
      if (throwOnce) {
        throwOnce = false
        throw new Error('sync boom')
      }
      return Promise.resolve()
    }) as () => Promise<void>
    const m = mountGated(refresh, {
      active: true,
      revisions: [0],
      policy: { initialDirty: true },
    })
    await flush([])
    expect(calls.length).toBe(1)

    m.set({ revisions: [1] })
    await flush([])
    expect(calls.length).toBe(2)
    m.unmount()
  })
})
