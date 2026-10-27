/**
 * 维护卡的手动编排（`use-maintenance.ts`）。
 *
 * 这一份直接测 hook，钉三件事：
 * ① **没有自动扫描**：挂载只交初始态，一次请求都不发（没有 effect、没有定时器）；
 * ② 检查失败是可见的失败：报告回 `null` + 原文，不折成"零条"；
 * ③ 清理后必重查：孤儿会话走 `/apply` 的 `orphan-clean`，孤儿附件走 `/attachment-clean`；
 *    中性 / 失败 / 部分计数与附件跳过按回执说，重查结果覆盖报告。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { zhTranslate } from '../../src/client/copy.js'
import type {
  AttachmentOrphanReportWire,
  OrphanReportWire,
} from '../../src/client/remote.js'
import { useMaintenance, type Maintenance } from '../../src/client/use-maintenance.js'
import type { ApplyAction, ApplyOutcome } from '../../src/shared/wire.js'
import { createFakeRemote, type FakeRemote } from './support/fake-remote.js'
import { failed, ok, outcomes } from './support/outcomes.js'

const EMPTY: OrphanReportWire = { roots: [], totalSessions: 0, totalBytes: 0, missingParents: 0, groups: [] }
const REPORT: OrphanReportWire = {
  roots: ['session-root'], totalSessions: 2, totalBytes: 2048, missingParents: 1,
  groups: [{ projectDir: '--p--', sessions: 2, bytes: 2048 }],
}

const orphanItem = (i: number) => ({
  attachmentId: `sha256:${i.toString(16).padStart(64, '0')}`,
  bytes: 100 + i,
})
const ATT_EMPTY: AttachmentOrphanReportWire = { count: 0, totalBytes: 0, items: [] }
/** 真机读数那一路：106 张 / 27.8 MiB（`fileSizeText` 对 ≥10 的单位取整，念作 `28MB`）。 */
const ATT_106: AttachmentOrphanReportWire = {
  count: 106,
  totalBytes: 29_150_413,
  items: Array.from({ length: 106 }, (_, i) => orphanItem(i)),
}

function deps(over: Partial<FakeRemote> = {}): FakeRemote {
  return createFakeRemote({
    scanOrphans: vi.fn(async () => EMPTY),
    applyOutcomes: vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]> =>
      outcomes(action, ids)),
    scanAttachmentOrphans: vi.fn(async () => ATT_EMPTY),
    cleanAttachmentOrphans: vi.fn(async () => ({ removed: 0, freedBytes: 0, failed: 0 })),
    ...over,
  })
}

function mount(over: Partial<FakeRemote> = {}) {
  const d = deps(over)
  const view = renderHook(() => useMaintenance({ deps: d, t: zhTranslate }))
  return { d, ...view }
}

function current(result: { readonly current: Maintenance }): Maintenance {
  return result.current
}

describe('维护编排 · 手动触发', () => {
  it('挂载不发请求：两份报告都是"还没检查"的 null，busy 都关着', () => {
    const { d, result } = mount()
    const m = current(result)
    expect(m.orphanReport).toBeNull()
    expect(m.orphanFailure).toBeNull()
    expect(m.orphanNotice).toBeNull()
    expect(m.orphanAttachmentNotice).toBeNull()
    expect(m.orphanConfirm).toBe(false)
    expect(m.orphanBusy).toBe(false)
    expect(m.orphanPhase).toBeNull()
    expect(m.attachmentReport).toBeNull()
    expect(m.attachmentFailure).toBeNull()
    expect(m.attachmentNotice).toBeNull()
    expect(m.attachmentConfirm).toBe(false)
    expect(m.attachmentBusy).toBe(false)
    expect(m.attachmentPhase).toBeNull()
    // 没有 effect / 定时器：挂载这一拍与下一拍都不该有扫描。
    expect(d.scanOrphans).not.toHaveBeenCalled()
    expect(d.scanAttachmentOrphans).not.toHaveBeenCalled()
  })

})

describe('维护编排 · 孤儿会话检查', () => {
  it('手动检查：在飞时 busy 且 phase 是 scanning，落地 0 条', async () => {
    const { result } = mount()
    let pending!: Promise<void>
    act(() => { pending = current(result).scanOrphans() })
    expect(current(result).orphanBusy).toBe(true)
    expect(current(result).orphanPhase).toBe('scanning')
    await act(async () => { await pending })
    expect(current(result).orphanBusy).toBe(false)
    expect(current(result).orphanPhase).toBeNull()
    expect(current(result).orphanReport).toEqual(EMPTY)
    expect(current(result).orphanFailure).toBeNull()
  })

  it('手动检查：落地 N 条，报告原样交给界面（计数不重算）', async () => {
    const { result } = mount({ scanOrphans: vi.fn(async () => REPORT) })
    await act(async () => { await current(result).scanOrphans() })
    expect(current(result).orphanReport).toEqual(REPORT)
  })

  it('检查读不到：报告回 null、原文上屏，不折成"零条"', async () => {
    const { result } = mount({
      scanOrphans: vi.fn(async () => {
        throw Object.assign(new Error('sessionQuery 不在'), { code: 'sessiondelete/io' })
      }),
    })
    await act(async () => { await current(result).scanOrphans() })
    expect(current(result).orphanReport).toBeNull()
    expect(current(result).orphanFailure).toContain('sessionQuery 不在')
  })
})

describe('维护编排 · 孤儿会话清理', () => {
  it('openOrphanPreview 先收掉旧提示再开确认框；setOrphanConfirm 能关', async () => {
    const { result } = mount({ scanOrphans: vi.fn(async () => REPORT) })
    await act(async () => { await current(result).scanOrphans() })
    act(() => { current(result).openOrphanPreview() })
    expect(current(result).orphanConfirm).toBe(true)
    act(() => { current(result).setOrphanConfirm(false) })
    expect(current(result).orphanConfirm).toBe(false)
  })

  it('清理走 /apply 的 orphan-clean，发报告的 roots，清完自动重查', async () => {
    const scanOrphans = vi.fn()
      .mockResolvedValueOnce(REPORT)
      .mockResolvedValueOnce(EMPTY)
    const applyOutcomes = vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]> =>
      ids.map((id) => ok(action, id, { removed: 1, freedBytes: 2048 })))
    const { result } = mount({ scanOrphans, applyOutcomes })
    await act(async () => { await current(result).scanOrphans() })
    act(() => { current(result).openOrphanPreview() })

    let pending!: Promise<void>
    act(() => { pending = current(result).cleanOrphans() })
    // 清理在飞是另一档：状态行靠 phase 说「清理中…」，不说「检查中…」。
    expect(current(result).orphanPhase).toBe('cleaning')
    expect(current(result).orphanBusy).toBe(true)
    await act(async () => { await pending })

    expect(applyOutcomes).toHaveBeenCalledWith('orphan-clean', ['session-root'])
    expect(scanOrphans).toHaveBeenCalledTimes(2)
    expect(current(result).orphanReport).toEqual(EMPTY)
    expect(current(result).orphanConfirm).toBe(false)
    expect(current(result).orphanFailure).toBeNull()
    expect(current(result).orphanBusy).toBe(false)
    expect(current(result).orphanPhase).toBeNull()
  })

  it('清理回执里的附件读数也上屏：跳过 + 逐文件失败按面板同一套句子', async () => {
    const { result } = mount({
      scanOrphans: vi.fn(async () => REPORT),
      applyOutcomes: vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]> =>
        ids.map((id) => ok(action, id, {
          removed: 1,
          freedBytes: 2048,
          attachments: { removed: 2, freedBytes: 100, failed: 1, skipped: '剩余引用源读不出' },
        }))),
    })
    await act(async () => { await current(result).scanOrphans() })
    await act(async () => { await current(result).cleanOrphans() })
    expect(current(result).orphanFailure).toBeNull()
    expect(current(result).orphanAttachmentNotice).toBe(
      '部分附件未清理：剩余引用源读不出（已清理 2 个）；另有 1 个附件删除失败',
    )
    // 下一次手动检查是新的只读快照：上一趟的回执收掉，不冒充这一次的读数。
    await act(async () => { await current(result).scanOrphans() })
    expect(current(result).orphanAttachmentNotice).toBeNull()
  })

  it('not-found 是中性提示，不是失败；报告为空时也不冒充清理过', async () => {
    const { result } = mount({
      scanOrphans: vi.fn(async () => REPORT),
      applyOutcomes: vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]> =>
        ids.map((id) => failed(action, id, '不在了', 'sessiondelete/not-found'))),
    })
    await act(async () => { await current(result).scanOrphans() })
    await act(async () => { await current(result).cleanOrphans() })
    expect(current(result).orphanNotice).toContain('1')
    expect(current(result).orphanFailure).toBeNull()
  })

  it('部分失败：原文 + 服务端给的部分计数一起说，重查不吞掉这两句', async () => {
    const { result } = mount({
      scanOrphans: vi.fn(async () => REPORT),
      applyOutcomes: vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]> =>
        ids.map((id) => ({
          id,
          action,
          ok: false as const,
          error: {
            code: 'sessiondelete/io',
            message: '目录搬不动',
            details: { removed: 1, freedBytes: 2048 },
          },
        }))),
    })
    await act(async () => { await current(result).scanOrphans() })
    await act(async () => { await current(result).cleanOrphans() })
    expect(current(result).orphanFailure).toContain('目录搬不动')
    expect(current(result).orphanFailure).toContain('1')
    expect(current(result).orphanReport).toEqual(REPORT) // 重查读到的仍是这一份（fake 恒回 REPORT）
  })

  it('顶层失败：确认框关掉、原文上屏、仍然重查（旧报告不再可信）', async () => {
    const scanOrphans = vi.fn(async () => REPORT)
    const { result } = mount({
      scanOrphans,
      applyOutcomes: vi.fn(async () => { throw new Error('路由自检失败') }),
    })
    await act(async () => { await current(result).scanOrphans() })
    act(() => { current(result).openOrphanPreview() })
    await act(async () => { await current(result).cleanOrphans() })
    expect(current(result).orphanConfirm).toBe(false)
    expect(current(result).orphanFailure).toContain('路由自检失败')
    expect(scanOrphans).toHaveBeenCalledTimes(2)
    expect(current(result).orphanBusy).toBe(false)
  })
})

describe('维护编排 · 孤儿附件检查', () => {
  it('手动检查：106 / 27.8MiB 原样交给界面；0 条也原样', async () => {
    const scanAttachmentOrphans = vi.fn()
      .mockResolvedValueOnce(ATT_106)
      .mockResolvedValueOnce(ATT_EMPTY)
    const { result } = mount({ scanAttachmentOrphans })
    await act(async () => { await current(result).scanAttachmentOrphans() })
    expect(current(result).attachmentReport).toEqual(ATT_106)
    expect(current(result).attachmentBusy).toBe(false)
    await act(async () => { await current(result).scanAttachmentOrphans() })
    expect(current(result).attachmentReport).toEqual(ATT_EMPTY)
  })

  it('检查读不到：报告回 null、包装成"检查失败"上屏', async () => {
    const { result } = mount({
      scanAttachmentOrphans: vi.fn(async () => {
        throw Object.assign(new Error('引用源读不出'), { code: 'sessiondelete/io' })
      }),
    })
    await act(async () => { await current(result).scanAttachmentOrphans() })
    expect(current(result).attachmentReport).toBeNull()
    expect(current(result).attachmentFailure).toBe('检查失败：引用源读不出')
  })
})

describe('维护编排 · 孤儿附件清理', () => {
  it('清理后自动重查，已清件数与体积上屏；确认框收起', async () => {
    const scanAttachmentOrphans = vi.fn()
      .mockResolvedValueOnce(ATT_106)
      .mockResolvedValueOnce(ATT_EMPTY)
    const cleanAttachmentOrphans = vi.fn(async () => ({
      removed: 106, freedBytes: 29_150_413, failed: 0,
    }))
    const { result } = mount({ scanAttachmentOrphans, cleanAttachmentOrphans })
    await act(async () => { await current(result).scanAttachmentOrphans() })
    act(() => { current(result).openAttachmentPreview() })
    expect(current(result).attachmentConfirm).toBe(true)

    let pending!: Promise<void>
    act(() => { pending = current(result).cleanAttachmentOrphans() })
    expect(current(result).attachmentPhase).toBe('cleaning')
    expect(current(result).attachmentBusy).toBe(true)
    await act(async () => { await pending })

    expect(cleanAttachmentOrphans).toHaveBeenCalledTimes(1)
    expect(scanAttachmentOrphans).toHaveBeenCalledTimes(2)
    expect(current(result).attachmentConfirm).toBe(false)
    expect(current(result).attachmentReport).toEqual(ATT_EMPTY)
    expect(current(result).attachmentNotice).toBe('已清理 106 个（28MB）')
    expect(current(result).attachmentBusy).toBe(false)
    expect(current(result).attachmentPhase).toBeNull()
  })

  it('清理成功先收旧报告：重查还在飞时横幅数据是 0，状态仍是清理中', async () => {
    let resolveScan!: (value: AttachmentOrphanReportWire) => void
    const scanAttachmentOrphans = vi.fn()
      .mockResolvedValueOnce(ATT_106)
      .mockImplementationOnce(() => new Promise<AttachmentOrphanReportWire>((resolve) => { resolveScan = resolve }))
    const cleanAttachmentOrphans = vi.fn(async () => ({
      removed: 106, freedBytes: 29_150_413, failed: 0,
    }))
    const { result } = mount({ scanAttachmentOrphans, cleanAttachmentOrphans })
    await act(async () => { await current(result).scanAttachmentOrphans() })
    act(() => { current(result).openAttachmentPreview() })

    let pending!: Promise<void>
    act(() => { pending = current(result).cleanAttachmentOrphans() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(cleanAttachmentOrphans).toHaveBeenCalledTimes(1)
    expect(current(result).attachmentReport).toEqual(ATT_EMPTY)
    expect(current(result).attachmentPhase).toBe('cleaning')
    expect(current(result).attachmentBusy).toBe(true)

    await act(async () => { resolveScan(ATT_EMPTY); await pending })
    expect(current(result).attachmentReport).toEqual(ATT_EMPTY)
    expect(current(result).attachmentNotice).toBe('已清理 106 个（28MB）')
    expect(current(result).attachmentBusy).toBe(false)
  })

  it('skipped 且一件未清 ⇒ 只说整轮跳过，不念「已清理 0 个」', async () => {
    const { result } = mount({
      scanAttachmentOrphans: vi.fn(async () => ATT_106),
      cleanAttachmentOrphans: vi.fn(async () => ({
        removed: 0, freedBytes: 0, failed: 0, skipped: '引用源读不出',
      })),
    })
    await act(async () => { await current(result).scanAttachmentOrphans() })
    await act(async () => { await current(result).cleanAttachmentOrphans() })
    expect(current(result).attachmentNotice).toBe('附件未清理：引用源读不出')
    expect(current(result).attachmentFailure).toBeNull()
  })

  it('skipped 但已清一部分 ⇒ 说「部分」与已清件数（与面板同一对句子）', async () => {
    const { result } = mount({
      scanAttachmentOrphans: vi.fn(async () => ATT_106),
      cleanAttachmentOrphans: vi.fn(async () => ({
        removed: 3, freedBytes: 300, failed: 0, skipped: '剩余引用源读不出',
      })),
    })
    await act(async () => { await current(result).scanAttachmentOrphans() })
    await act(async () => { await current(result).cleanAttachmentOrphans() })
    expect(current(result).attachmentNotice).toBe(
      '部分附件未清理：剩余引用源读不出（已清理 3 个）',
    )
  })

  it('逐文件失败 ⇒ 未清理件数与已清件数都上屏', async () => {
    const { result } = mount({
      scanAttachmentOrphans: vi.fn(async () => ATT_106),
      cleanAttachmentOrphans: vi.fn(async () => ({ removed: 3, freedBytes: 30, failed: 2 })),
    })
    await act(async () => { await current(result).scanAttachmentOrphans() })
    await act(async () => { await current(result).cleanAttachmentOrphans() })
    expect(current(result).attachmentNotice).toBe('2 个附件未能清理（已清理 3 个）')
  })

  it('skipped 与 failed 同时出现：跳过原因在前，失败件数追加在句尾', async () => {
    const { result } = mount({
      scanAttachmentOrphans: vi.fn(async () => ATT_106),
      cleanAttachmentOrphans: vi.fn(async () => ({
        removed: 4, freedBytes: 40, failed: 2, skipped: '剩余引用源读不出',
      })),
    })
    await act(async () => { await current(result).scanAttachmentOrphans() })
    await act(async () => { await current(result).cleanAttachmentOrphans() })
    expect(current(result).attachmentNotice).toBe(
      '部分附件未清理：剩余引用源读不出（已清理 4 个）；另有 2 个附件删除失败',
    )
  })

  it('顶层失败：确认框关掉、本地化前缀 + 原文上屏，并重查一次', async () => {
    const scanAttachmentOrphans = vi.fn(async () => ATT_106)
    const { result } = mount({
      scanAttachmentOrphans,
      cleanAttachmentOrphans: vi.fn(async () => {
        throw Object.assign(new Error('盘上忙'), { code: 'sessiondelete/io' })
      }),
    })
    await act(async () => { await current(result).scanAttachmentOrphans() })
    act(() => { current(result).openAttachmentPreview() })
    await act(async () => { await current(result).cleanAttachmentOrphans() })
    expect(current(result).attachmentConfirm).toBe(false)
    expect(current(result).attachmentFailure).toBe('附件清理失败：盘上忙')
    expect(scanAttachmentOrphans).toHaveBeenCalledTimes(2)
    expect(current(result).attachmentBusy).toBe(false)
    expect(current(result).attachmentPhase).toBeNull()
  })

  it('报告为空时清理是 no-op：不发请求，只把确认框关掉', async () => {
    const cleanAttachmentOrphans = vi.fn(async () => ({ removed: 0, freedBytes: 0, failed: 0 }))
    const { result } = mount({ cleanAttachmentOrphans })
    await act(async () => { await current(result).scanAttachmentOrphans() })
    act(() => { current(result).setAttachmentConfirm(true) })
    await act(async () => { await current(result).cleanAttachmentOrphans() })
    expect(cleanAttachmentOrphans).not.toHaveBeenCalled()
    expect(current(result).attachmentConfirm).toBe(false)
  })
})
