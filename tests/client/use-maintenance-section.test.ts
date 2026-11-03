/**
 * `useMaintenanceSection` 的**赢票语义**（段状态机自己的契约，不经 `useMaintenance` 的 glue）。
 *
 * 钉一件事：`onScanWon` 只由「赢下最新票」的那一趟检查触发。输家既不落地读数，也不得
 * 触发赢家之后才该发生的副作用——附件回执就是这样被误清的：清除若放在发请求之前，
 * 被顶掉的输家会把上一趟已经摆上屏的回执一起清掉。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RemoteOutcome } from '../../src/client/remote.js'
import {
  useMaintenanceSection,
  type MaintenanceSectionConfig,
} from '../../src/client/use-maintenance-section.js'
import { pick } from '../support/fixture.js'

describe('useMaintenanceSection · 赢票语义', () => {
  it('onScanWon 只由赢家触发：被顶掉的检查不回调、也不落地读数', async () => {
    const pending: Array<(outcome: RemoteOutcome<number>) => void> = []
    const onScanWon = vi.fn()
    const config: MaintenanceSectionConfig<number, null> = {
      scan: () => new Promise<RemoteOutcome<number>>((resolve) => { pending.push(resolve) }),
      clean: () => null,
      scanFailureText: (message) => message,
      settle: () => ({}),
      onScanWon,
    }
    const { result } = renderHook(() => useMaintenanceSection(config))

    let first!: Promise<void>
    act(() => { first = result.current.scan() })      // 先发：将成为输家
    let second!: Promise<void>
    act(() => { second = result.current.scan() })     // 后发：赢下最新票

    await act(async () => {
      pick(pending, 0)({ ok: true, value: 1 })
      await first
    })
    expect(onScanWon).not.toHaveBeenCalled()          // 输家不回调
    expect(result.current.report).toBeNull()          // 也不落地

    await act(async () => {
      pick(pending, 1)({ ok: true, value: 2 })
      await second
    })
    expect(onScanWon).toHaveBeenCalledTimes(1)
    expect(result.current.report).toBe(2)
  })
})
