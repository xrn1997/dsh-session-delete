import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useBusyGate } from '../../src/client/busy-gate.js'

describe('busy 闸', () => {
  it('任务在飞时 busy 为真，落地后放回', async () => {
    const { result } = renderHook(() => useBusyGate())
    expect(result.current.busy).toBe(false)
    let release: () => void = () => {}
    const task = new Promise<void>((resolve) => { release = resolve })
    let running: Promise<void> | undefined
    act(() => { running = result.current.around(() => task) })
    expect(result.current.busy).toBe(true)
    await act(async () => { release(); await running })
    expect(result.current.busy).toBe(false)
  })

  it('任务抛错也放回 busy（否则面板永久锁死）', async () => {
    const { result } = renderHook(() => useBusyGate())
    await act(async () => {
      await expect(result.current.around(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    })
    expect(result.current.busy).toBe(false)
  })

  it('两枚闸互不影响', async () => {
    const one = renderHook(() => useBusyGate())
    const two = renderHook(() => useBusyGate())
    let release: () => void = () => {}
    const task = new Promise<void>((resolve) => { release = resolve })
    act(() => { void one.result.current.around(() => task) })
    expect(one.result.current.busy).toBe(true)
    expect(two.result.current.busy).toBe(false)
    await act(async () => { release() })
  })
})
