/**
 * 意图预取的延时器（`use-prefetch.ts`）：只钉「150ms 后才跑、cancel / 卸载清掉、连续划过只认最后一次」。
 * 读什么归调用方（详情读路的 `prefetch` / `ensure` 已有在飞去重），这里不测远程面。
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDelayedPrefetch } from '../../src/client/use-prefetch.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('意图预取 · 延时与取消', () => {
  it('schedule 后满 150ms 才跑；提前 cancel 不跑', () => {
    const run = vi.fn()
    const { result } = renderHook(() => useDelayedPrefetch(run))

    act(() => { result.current.schedule('b') })
    act(() => { vi.advanceTimersByTime(149) })
    expect(run).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(run).toHaveBeenCalledWith('b')

    act(() => { result.current.schedule('c') })
    act(() => { result.current.cancel() })
    act(() => { vi.advanceTimersByTime(150) })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('连续 schedule 只跑最后一次；卸载清掉未落地的计时器', () => {
    const run = vi.fn()
    const { result, unmount } = renderHook(() => useDelayedPrefetch(run))

    act(() => { result.current.schedule('a') })
    act(() => { result.current.schedule('b') })
    act(() => { vi.advanceTimersByTime(150) })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenLastCalledWith('b')

    act(() => { result.current.schedule('c') })
    unmount()
    act(() => { vi.advanceTimersByTime(150) })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('计时落地时调用最新那一次 render 的 run（内联箭头每拍换身份也认最新）', () => {
    // 调用点的 `run` 常是内联箭头：身份每拍都变。没有 `useLatest` 时计时器会拿调度那一刻的旧闭包，
    // 把选中 / 清单的旧读数发出去——这条钉的是那个归一。
    const first = vi.fn()
    const second = vi.fn()
    const { result, rerender } = renderHook(
      ({ run }: { run: (value: string) => void }) => useDelayedPrefetch(run),
      { initialProps: { run: first } },
    )

    act(() => { result.current.schedule('a') })
    rerender({ run: second })
    act(() => { vi.advanceTimersByTime(150) })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('a')
  })
})
