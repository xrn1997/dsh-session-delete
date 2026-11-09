/**
 * `useMaintenanceSection` 的**赢票与一次判读**（段状态机自己的契约，不经 `useMaintenance` 的 glue）。
 *
 * 钉三件事：
 * - `afterClean` 一次判读、两处落地：`preset` 在重查起飞前摆，`plan` 在重查赢了之后摆；
 * - 第二回执的清除只由「赢下最新票」的那一趟检查触发。输家既不落地读数，也不得清掉赢家的回执
 *   ——清除若放在发请求之前，被顶掉的输家会把上一趟已经摆上屏的回执一起清掉；
 * - 开确认框先清旧失败、旧提示与第二回执（取消也不会把上一趟的回执留在屏上）。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  useMaintenanceSection,
  type MaintenanceScanOutcome,
  type MaintenanceSectionConfig,
} from '../../src/client/use-maintenance-section.js'

function config(
  over: Partial<MaintenanceSectionConfig<number, string>> = {},
): MaintenanceSectionConfig<number, string> {
  return {
    scan: async () => ({ ok: true, value: 1 }),
    clean: async () => ({ ok: true, value: 'done' }),
    afterClean: () => ({ plan: {} }),
    ...over,
  }
}

describe('useMaintenanceSection · 赢票与一次判读', () => {
  it('afterClean 一次判读、两处落地：preset 在重查飞着时已在，plan 等重查赢了才摆', async () => {
    let resolveRescan!: (outcome: MaintenanceScanOutcome<number>) => void
    const scan = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: 10 })
      .mockImplementationOnce(() => new Promise<MaintenanceScanOutcome<number>>((resolve) => {
        resolveRescan = resolve
      }))
    const afterClean = vi.fn(() => ({
      preset: 0,
      plan: { notice: 'cleaned', secondaryNotice: 'receipt' },
    }))
    const { result } = renderHook(() => useMaintenanceSection(config({ scan, afterClean })))

    await act(async () => { await result.current.scan() })
    expect(result.current.report).toBe(10)

    let pending!: Promise<void>
    act(() => { pending = result.current.clean() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(afterClean).toHaveBeenCalledTimes(1)
    expect(afterClean).toHaveBeenCalledWith({ ok: true, value: 'done' }, 10)
    expect(result.current.report).toBe(0)          // preset：重查还在飞时先摆
    expect(result.current.notice).toBeNull()       // plan：等重查赢了再摆

    await act(async () => { resolveRescan({ ok: true, value: 3 }); await pending })
    expect(result.current.report).toBe(3)
    expect(result.current.notice).toBe('cleaned')
    expect(result.current.secondaryNotice).toBe('receipt')
  })

  it('开确认框先清旧失败、旧提示与第二回执：取消也不会把上一趟的回执留在屏上', async () => {
    const { result } = renderHook(() => useMaintenanceSection(config({
      afterClean: () => ({ plan: { notice: 'cleaned', secondaryNotice: 'receipt' } }),
    })))

    await act(async () => { await result.current.scan() })
    await act(async () => { await result.current.clean() })
    expect(result.current.notice).toBe('cleaned')
    expect(result.current.secondaryNotice).toBe('receipt')

    act(() => { result.current.openPreview() })
    expect(result.current.confirm).toBe(true)
    expect(result.current.notice).toBeNull()
    expect(result.current.secondaryNotice).toBeNull()
    act(() => { result.current.cancel() })
    expect(result.current.secondaryNotice).toBeNull()
  })

  it('检查失败用 scan 落地面里的 text，不折成零条', async () => {
    const { result } = renderHook(() => useMaintenanceSection(config({
      scan: async () => ({ ok: false, text: '检查失败：读不出' }),
    })))
    await act(async () => { await result.current.scan() })
    expect(result.current.report).toBeNull()
    expect(result.current.failure).toBe('检查失败：读不出')
  })

  it('第二回执只由赢家清：被顶掉的检查不回调、也不落地读数', async () => {
    let resolveLoser!: (outcome: MaintenanceScanOutcome<number>) => void
    let resolveWinner!: (outcome: MaintenanceScanOutcome<number>) => void
    const scan = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: 1 })    // 首趟手动检查
      .mockResolvedValueOnce({ ok: true, value: 2 })    // clean 之后的必发重查
      .mockImplementationOnce(() => new Promise<MaintenanceScanOutcome<number>>((resolve) => {
        resolveLoser = resolve
      }))
      .mockImplementationOnce(() => new Promise<MaintenanceScanOutcome<number>>((resolve) => {
        resolveWinner = resolve
      }))
    const { result } = renderHook(() => useMaintenanceSection(config({
      scan,
      afterClean: () => ({ plan: { secondaryNotice: 'receipt' } }),
    })))

    await act(async () => { await result.current.scan() })
    await act(async () => { await result.current.clean() })
    expect(result.current.secondaryNotice).toBe('receipt')

    let loser!: Promise<void>
    act(() => { loser = result.current.scan() })     // 先发：将被顶掉
    let winner!: Promise<void>
    act(() => { winner = result.current.scan() })    // 后发：赢下最新票

    // 输家落地：回执仍在（清除若放在发请求之前，这里已经被清掉了）。
    await act(async () => { resolveLoser({ ok: true, value: 9 }); await loser })
    expect(result.current.secondaryNotice).toBe('receipt')
    expect(result.current.report).toBe(2)            // 也不落地读数

    await act(async () => { resolveWinner({ ok: true, value: 3 }); await winner })
    expect(result.current.secondaryNotice).toBeNull() // 只有赢家清
    expect(result.current.report).toBe(3)
  })
})
