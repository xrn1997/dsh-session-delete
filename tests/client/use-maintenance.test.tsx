/**
 * 维护卡的手动编排（`use-maintenance.ts` 的两段 glue + `use-maintenance-section.ts` 的泛型段 module）。
 *
 * 这一份直接测 hook，钉四件事：
 * ① **没有自动扫描**：挂载只交初始态，一次请求都不发（没有 effect、没有定时器）；
 * ② 检查失败是可见的失败：报告回 `null` + 原文，不折成"零条"；
 * ③ 清理后必重查：孤儿会话走 `/apply` 的 `orphan-clean`，孤儿附件走 `/attachment-clean`；
 *    中性 / 失败 / 部分计数与附件跳过按回执说，重查结果覆盖报告，重查成功后才摆这一趟后果；
 * ④ 段的不变量由构造保证：开门只有 `openPreview`（先清旧失败与旧提示）、收框只有 `cancel`
 *    （不碰提示 / 失败）、`busy` 由段自己给（不靠外部传入）、最新票的输家不落地。
 *
 * 两段共用同一台状态机，所以每条判据都各钉两段（或在段层面钉一次、两段各走一遍）。
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
import { pick } from '../support/fixture.js'
import { createFakeRemote, type FakeRemote, type FakeRemoteMethods } from './support/fake-remote.js'
import { failed, ok, outcomes } from './support/outcomes.js'

const EMPTY: OrphanReportWire = { roots: [], totalSessions: 0, totalBytes: 0, missingParents: 0, groups: [] }
const REPORT: OrphanReportWire = {
  roots: ['session-root'], totalSessions: 2, totalBytes: 2048, missingParents: 1,
  groups: [{ projectDir: '--p--', sessions: 2, bytes: 2048 }],
}
/** 两组根：同一趟回执里"有组已不在"（中性）与"有组没清成"（失败）可以同时在场。 */
const TWO_ROOTS: OrphanReportWire = {
  roots: ['root-a', 'root-b'], totalSessions: 2, totalBytes: 2048, missingParents: 1,
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

function deps(over: Partial<FakeRemoteMethods> = {}): FakeRemote {
  return createFakeRemote({
    scanOrphans: vi.fn(async () => EMPTY),
    applyOutcomes: vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]> =>
      outcomes(action, ids)),
    scanAttachmentOrphans: vi.fn(async () => ATT_EMPTY),
    cleanAttachmentOrphans: vi.fn(async () => ({ removed: 0, freedBytes: 0, failed: 0 })),
    ...over,
  })
}

function mount(over: Partial<FakeRemoteMethods> = {}) {
  const d = deps(over)
  const view = renderHook(() => useMaintenance({ deps: d, t: zhTranslate }))
  return { d, ...view }
}

function current(result: { readonly current: Maintenance }): Maintenance {
  return result.current
}

describe('维护编排 · 手动触发', () => {
  it('挂载不发请求：两份报告都是"还没检查"的 null，两段都空闲', () => {
    const { d, result } = mount()
    const m = current(result)
    expect(m.orphans.report).toBeNull()
    expect(m.orphans.failure).toBeNull()
    expect(m.orphans.notice).toBeNull()
    expect(m.orphans.secondaryNotice).toBeNull()
    expect(m.orphans.confirm).toBe(false)
    expect(m.orphans.busy).toBe(false)
    expect(m.orphans.phase).toBeNull()
    expect(m.attachments.report).toBeNull()
    expect(m.attachments.failure).toBeNull()
    expect(m.attachments.notice).toBeNull()
    expect(m.attachments.confirm).toBe(false)
    expect(m.attachments.busy).toBe(false)
    expect(m.attachments.phase).toBeNull()
    // 没有 effect / 定时器：挂载这一拍与下一拍都不该有扫描。
    expect(d.scanOrphans).not.toHaveBeenCalled()
    expect(d.scanAttachmentOrphans).not.toHaveBeenCalled()
  })

})

describe('维护编排 · 孤儿会话检查', () => {
  it('手动检查：在飞时 busy 且 phase 是 scanning，落地 0 条', async () => {
    const { result } = mount()
    let pending!: Promise<void>
    act(() => { pending = current(result).orphans.scan() })
    expect(current(result).orphans.busy).toBe(true)
    expect(current(result).orphans.phase).toBe('scanning')
    await act(async () => { await pending })
    expect(current(result).orphans.busy).toBe(false)
    expect(current(result).orphans.phase).toBeNull()
    expect(current(result).orphans.report).toEqual(EMPTY)
    expect(current(result).orphans.failure).toBeNull()
  })

  it('手动检查：落地 N 条，报告原样交给界面（计数不重算）', async () => {
    const { result } = mount({ scanOrphans: vi.fn(async () => REPORT) })
    await act(async () => { await current(result).orphans.scan() })
    expect(current(result).orphans.report).toEqual(REPORT)
  })

  it('检查读不到：报告回 null、原文上屏，不折成"零条"', async () => {
    const { result } = mount({
      scanOrphans: vi.fn(async () => {
        throw Object.assign(new Error('sessionQuery 不在'), { code: 'sessiondelete/io' })
      }),
    })
    await act(async () => { await current(result).orphans.scan() })
    expect(current(result).orphans.report).toBeNull()
    expect(current(result).orphans.failure).toContain('sessionQuery 不在')
  })
})

describe('维护编排 · 段的不变量（构造保证）', () => {
  it('busy 由段自己给：一段在飞时另一段仍空闲，不靠外部传入', async () => {
    let resolveScan!: (value: OrphanReportWire) => void
    const scanOrphans = vi.fn(() => new Promise<OrphanReportWire>((resolve) => { resolveScan = resolve }))
    const { result } = mount({ scanOrphans })
    let pending!: Promise<void>
    act(() => { pending = current(result).orphans.scan() })
    expect(current(result).orphans.busy).toBe(true)
    // 另一段没在飞：忙碌是每段自己的读数，不跨段、也不需要谁替它传进来。
    expect(current(result).attachments.busy).toBe(false)
    expect(current(result).attachments.phase).toBeNull()
    await act(async () => { resolveScan(EMPTY); await pending })
    expect(current(result).orphans.busy).toBe(false)
  })

  it('openPreview 是唯一开门：先清旧失败与旧提示再开框', async () => {
    const { result } = mount({
      scanOrphans: vi.fn(async () => {
        throw Object.assign(new Error('sessionQuery 不在'), { code: 'sessiondelete/io' })
      }),
      scanAttachmentOrphans: vi.fn(async () => {
        throw Object.assign(new Error('引用源读不出'), { code: 'sessiondelete/io' })
      }),
    })
    await act(async () => { await current(result).orphans.scan() })
    await act(async () => { await current(result).attachments.scan() })
    expect(current(result).orphans.failure).not.toBeNull()
    expect(current(result).attachments.failure).not.toBeNull()

    act(() => { current(result).orphans.openPreview() })
    act(() => { current(result).attachments.openPreview() })
    expect(current(result).orphans.confirm).toBe(true)
    expect(current(result).orphans.failure).toBeNull()
    expect(current(result).attachments.confirm).toBe(true)
    expect(current(result).attachments.failure).toBeNull()
  })

  it('openPreview 连旧的中性提示一起收', async () => {
    const { result } = mount({
      scanOrphans: vi.fn(async () => REPORT),
      applyOutcomes: vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]> =>
        ids.map((id) => failed(action, id, '不在了', 'sessiondelete/not-found'))),
    })
    await act(async () => { await current(result).orphans.scan() })
    await act(async () => { await current(result).orphans.clean() })
    expect(current(result).orphans.notice).not.toBeNull()

    act(() => { current(result).orphans.openPreview() })
    expect(current(result).orphans.notice).toBeNull()
    expect(current(result).orphans.confirm).toBe(true)
  })

  it('cancel 只收框：提示与失败一个都不碰', async () => {
    // 一趟"有一组没清成（失败）+ 有一组已不在（中性）"的清理：两种句子同时在场。
    const { result } = mount({
      scanOrphans: vi.fn(async () => TWO_ROOTS),
      applyOutcomes: vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]> => [
        {
          id: pick(ids, 0), action, ok: false as const,
          error: { code: 'sessiondelete/io', message: '目录搬不动', details: { removed: 1, freedBytes: 2048 } },
        },
        failed(action, pick(ids, 1), '不在了', 'sessiondelete/not-found'),
      ]),
    })
    await act(async () => { await current(result).orphans.scan() })
    await act(async () => { await current(result).orphans.clean() })
    const failure = current(result).orphans.failure
    const notice = current(result).orphans.notice
    expect(failure).not.toBeNull()
    expect(notice).not.toBeNull()

    act(() => { current(result).orphans.cancel() })
    expect(current(result).orphans.confirm).toBe(false)
    expect(current(result).orphans.failure).toBe(failure)
    expect(current(result).orphans.notice).toBe(notice)
  })

  it('附件段也走同一台机器：cancel 不碰提示，openPreview 连它一起收', async () => {
    const { result } = mount({
      scanAttachmentOrphans: vi.fn(async () => ATT_106),
      cleanAttachmentOrphans: vi.fn(async () => ({
        removed: 3, freedBytes: 300, failed: 0, skipped: '剩余引用源读不出',
      })),
    })
    await act(async () => { await current(result).attachments.scan() })
    await act(async () => { await current(result).attachments.clean() })
    const notice = current(result).attachments.notice
    expect(notice).not.toBeNull()

    act(() => { current(result).attachments.cancel() })
    expect(current(result).attachments.confirm).toBe(false)
    expect(current(result).attachments.notice).toBe(notice)

    act(() => { current(result).attachments.openPreview() })
    expect(current(result).attachments.confirm).toBe(true)
    expect(current(result).attachments.notice).toBeNull()
  })

  it('最新票输家不落地：后发的检查先落地，先发的那份不盖掉它', async () => {
    const LATER: OrphanReportWire = { ...REPORT, totalSessions: 7, totalBytes: 7000 }
    let resolveSlow!: (value: OrphanReportWire) => void
    const scanOrphans = vi.fn()
      .mockImplementationOnce(() => new Promise<OrphanReportWire>((resolve) => { resolveSlow = resolve }))
      .mockResolvedValueOnce(LATER)
    const { result } = mount({ scanOrphans })

    let slow!: Promise<void>
    act(() => { slow = current(result).orphans.scan() })   // 先发：慢
    let fast!: Promise<void>
    act(() => { fast = current(result).orphans.scan() })   // 后发：快，赢下最新票
    await act(async () => { await fast })
    expect(current(result).orphans.report).toEqual(LATER)
    expect(current(result).orphans.busy).toBe(false)        // 赢家已经收尾

    await act(async () => { resolveSlow(EMPTY); await slow })
    expect(current(result).orphans.report).toEqual(LATER)   // 输家什么都不落地
    expect(current(result).orphans.busy).toBe(false)         // 也不替赢家清 phase
  })

  it('输家清不掉附件回执：清除只发生在赢家落地之后', async () => {
    let resolveLoser!: (value: OrphanReportWire) => void
    let resolveWinner!: (value: OrphanReportWire) => void
    const scanOrphans = vi.fn()
      .mockResolvedValueOnce(REPORT)                        // 首趟手动检查
      .mockResolvedValueOnce(REPORT)                        // clean 之后的必发重查
      .mockImplementationOnce(() => new Promise<OrphanReportWire>((resolve) => { resolveLoser = resolve }))
      .mockImplementationOnce(() => new Promise<OrphanReportWire>((resolve) => { resolveWinner = resolve }))
    const { result } = mount({
      scanOrphans,
      applyOutcomes: vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]> =>
        ids.map((id) => ok(action, id, {
          removed: 1,
          freedBytes: 2048,
          attachments: { removed: 2, freedBytes: 100, failed: 1, skipped: '剩余引用源读不出' },
        }))),
    })
    await act(async () => { await current(result).orphans.scan() })
    await act(async () => { await current(result).orphans.clean() })
    expect(current(result).orphans.secondaryNotice).not.toBeNull()

    let loser!: Promise<void>
    act(() => { loser = current(result).orphans.scan() })     // 先发：将被顶掉
    let winner!: Promise<void>
    act(() => { winner = current(result).orphans.scan() })    // 后发：赢下最新票

    // 输家落地：回执仍在（清除若放在发请求之前，这里已经被清掉了）。
    await act(async () => { resolveLoser(REPORT); await loser })
    expect(current(result).orphans.secondaryNotice).not.toBeNull()

    await act(async () => { resolveWinner(REPORT); await winner })
    expect(current(result).orphans.secondaryNotice).toBeNull()   // 只有赢家清
  })
})

describe('维护编排 · 孤儿会话清理', () => {
  it('openPreview 先收掉旧提示再开确认框；cancel 能关', async () => {
    const { result } = mount({ scanOrphans: vi.fn(async () => REPORT) })
    await act(async () => { await current(result).orphans.scan() })
    act(() => { current(result).orphans.openPreview() })
    expect(current(result).orphans.confirm).toBe(true)
    act(() => { current(result).orphans.cancel() })
    expect(current(result).orphans.confirm).toBe(false)
  })

  it('清理走 /apply 的 orphan-clean，发报告的 roots，清完自动重查', async () => {
    const scanOrphans = vi.fn()
      .mockResolvedValueOnce(REPORT)
      .mockResolvedValueOnce(EMPTY)
    const applyOutcomes = vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]> =>
      ids.map((id) => ok(action, id, { removed: 1, freedBytes: 2048 })))
    const { result } = mount({ scanOrphans, applyOutcomes })
    await act(async () => { await current(result).orphans.scan() })
    act(() => { current(result).orphans.openPreview() })

    let pending!: Promise<void>
    act(() => { pending = current(result).orphans.clean() })
    // 清理在飞是另一档：状态行靠 phase 说「清理中…」，不说「检查中…」。
    expect(current(result).orphans.phase).toBe('cleaning')
    expect(current(result).orphans.busy).toBe(true)
    await act(async () => { await pending })

    expect(applyOutcomes).toHaveBeenCalledWith('orphan-clean', ['session-root'])
    expect(scanOrphans).toHaveBeenCalledTimes(2)
    expect(current(result).orphans.report).toEqual(EMPTY)
    expect(current(result).orphans.confirm).toBe(false)
    expect(current(result).orphans.failure).toBeNull()
    expect(current(result).orphans.busy).toBe(false)
    expect(current(result).orphans.phase).toBeNull()
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
    await act(async () => { await current(result).orphans.scan() })
    await act(async () => { await current(result).orphans.clean() })
    expect(current(result).orphans.failure).toBeNull()
    expect(current(result).orphans.secondaryNotice).toBe(
      '部分附件未清理：剩余引用源读不出（已清理 2 个）；另有 1 个附件删除失败',
    )
    // 下一次手动检查是新的只读快照：上一趟的回执收掉，不冒充这一次的读数。
    await act(async () => { await current(result).orphans.scan() })
    expect(current(result).orphans.secondaryNotice).toBeNull()
  })

  it('not-found 是中性提示，不是失败；报告为空时也不冒充清理过', async () => {
    const { result } = mount({
      scanOrphans: vi.fn(async () => REPORT),
      applyOutcomes: vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]> =>
        ids.map((id) => failed(action, id, '不在了', 'sessiondelete/not-found'))),
    })
    await act(async () => { await current(result).orphans.scan() })
    await act(async () => { await current(result).orphans.clean() })
    expect(current(result).orphans.notice).toContain('1')
    expect(current(result).orphans.failure).toBeNull()
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
    await act(async () => { await current(result).orphans.scan() })
    await act(async () => { await current(result).orphans.clean() })
    expect(current(result).orphans.failure).toContain('目录搬不动')
    expect(current(result).orphans.failure).toContain('1')
    expect(current(result).orphans.report).toEqual(REPORT) // 重查读到的仍是这一份（fake 恒回 REPORT）
  })

  it('顶层失败：确认框关掉、原文上屏、仍然重查（旧报告不再可信）', async () => {
    const scanOrphans = vi.fn(async () => REPORT)
    const { result } = mount({
      scanOrphans,
      applyOutcomes: vi.fn(async () => { throw new Error('路由自检失败') }),
    })
    await act(async () => { await current(result).orphans.scan() })
    act(() => { current(result).orphans.openPreview() })
    await act(async () => { await current(result).orphans.clean() })
    expect(current(result).orphans.confirm).toBe(false)
    expect(current(result).orphans.failure).toContain('路由自检失败')
    expect(scanOrphans).toHaveBeenCalledTimes(2)
    expect(current(result).orphans.busy).toBe(false)
  })
})

describe('维护编排 · 孤儿附件检查', () => {
  it('手动检查：106 / 27.8MiB 原样交给界面；0 条也原样', async () => {
    const scanAttachmentOrphans = vi.fn()
      .mockResolvedValueOnce(ATT_106)
      .mockResolvedValueOnce(ATT_EMPTY)
    const { result } = mount({ scanAttachmentOrphans })
    await act(async () => { await current(result).attachments.scan() })
    expect(current(result).attachments.report).toEqual(ATT_106)
    expect(current(result).attachments.busy).toBe(false)
    await act(async () => { await current(result).attachments.scan() })
    expect(current(result).attachments.report).toEqual(ATT_EMPTY)
  })

  it('检查读不到：报告回 null、包装成"检查失败"上屏', async () => {
    const { result } = mount({
      scanAttachmentOrphans: vi.fn(async () => {
        throw Object.assign(new Error('引用源读不出'), { code: 'sessiondelete/io' })
      }),
    })
    await act(async () => { await current(result).attachments.scan() })
    expect(current(result).attachments.report).toBeNull()
    expect(current(result).attachments.failure).toBe('检查失败：引用源读不出')
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
    await act(async () => { await current(result).attachments.scan() })
    act(() => { current(result).attachments.openPreview() })
    expect(current(result).attachments.confirm).toBe(true)

    let pending!: Promise<void>
    act(() => { pending = current(result).attachments.clean() })
    expect(current(result).attachments.phase).toBe('cleaning')
    expect(current(result).attachments.busy).toBe(true)
    await act(async () => { await pending })

    expect(cleanAttachmentOrphans).toHaveBeenCalledTimes(1)
    expect(scanAttachmentOrphans).toHaveBeenCalledTimes(2)
    expect(current(result).attachments.confirm).toBe(false)
    expect(current(result).attachments.report).toEqual(ATT_EMPTY)
    expect(current(result).attachments.notice).toBe('已清理 106 个（28MB）')
    expect(current(result).attachments.busy).toBe(false)
    expect(current(result).attachments.phase).toBeNull()
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
    await act(async () => { await current(result).attachments.scan() })
    act(() => { current(result).attachments.openPreview() })

    let pending!: Promise<void>
    act(() => { pending = current(result).attachments.clean() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(cleanAttachmentOrphans).toHaveBeenCalledTimes(1)
    expect(current(result).attachments.report).toEqual(ATT_EMPTY)
    expect(current(result).attachments.phase).toBe('cleaning')
    expect(current(result).attachments.busy).toBe(true)

    await act(async () => { resolveScan(ATT_EMPTY); await pending })
    expect(current(result).attachments.report).toEqual(ATT_EMPTY)
    expect(current(result).attachments.notice).toBe('已清理 106 个（28MB）')
    expect(current(result).attachments.busy).toBe(false)
  })

  it('skipped 且一件未清 ⇒ 只说整轮跳过，不念「已清理 0 个」', async () => {
    const { result } = mount({
      scanAttachmentOrphans: vi.fn(async () => ATT_106),
      cleanAttachmentOrphans: vi.fn(async () => ({
        removed: 0, freedBytes: 0, failed: 0, skipped: '引用源读不出',
      })),
    })
    await act(async () => { await current(result).attachments.scan() })
    await act(async () => { await current(result).attachments.clean() })
    expect(current(result).attachments.notice).toBe('附件未清理：引用源读不出')
    expect(current(result).attachments.failure).toBeNull()
  })

  it('skipped 但已清一部分 ⇒ 说「部分」与已清件数（与面板同一对句子）', async () => {
    const { result } = mount({
      scanAttachmentOrphans: vi.fn(async () => ATT_106),
      cleanAttachmentOrphans: vi.fn(async () => ({
        removed: 3, freedBytes: 300, failed: 0, skipped: '剩余引用源读不出',
      })),
    })
    await act(async () => { await current(result).attachments.scan() })
    await act(async () => { await current(result).attachments.clean() })
    expect(current(result).attachments.notice).toBe(
      '部分附件未清理：剩余引用源读不出（已清理 3 个）',
    )
  })

  it('逐文件失败 ⇒ 未清理件数与已清件数都上屏', async () => {
    const { result } = mount({
      scanAttachmentOrphans: vi.fn(async () => ATT_106),
      cleanAttachmentOrphans: vi.fn(async () => ({ removed: 3, freedBytes: 30, failed: 2 })),
    })
    await act(async () => { await current(result).attachments.scan() })
    await act(async () => { await current(result).attachments.clean() })
    expect(current(result).attachments.notice).toBe('2 个附件未能清理（已清理 3 个）')
  })

  it('skipped 与 failed 同时出现：跳过原因在前，失败件数追加在句尾', async () => {
    const { result } = mount({
      scanAttachmentOrphans: vi.fn(async () => ATT_106),
      cleanAttachmentOrphans: vi.fn(async () => ({
        removed: 4, freedBytes: 40, failed: 2, skipped: '剩余引用源读不出',
      })),
    })
    await act(async () => { await current(result).attachments.scan() })
    await act(async () => { await current(result).attachments.clean() })
    expect(current(result).attachments.notice).toBe(
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
    await act(async () => { await current(result).attachments.scan() })
    act(() => { current(result).attachments.openPreview() })
    await act(async () => { await current(result).attachments.clean() })
    expect(current(result).attachments.confirm).toBe(false)
    expect(current(result).attachments.failure).toBe('附件清理失败：盘上忙')
    expect(scanAttachmentOrphans).toHaveBeenCalledTimes(2)
    expect(current(result).attachments.busy).toBe(false)
    expect(current(result).attachments.phase).toBeNull()
  })

  it('报告为空时清理是 no-op：不发请求，只把确认框关掉（phase 一档都没进）', async () => {
    const cleanAttachmentOrphans = vi.fn(async () => ({ removed: 0, freedBytes: 0, failed: 0 }))
    const { d, result } = mount({ cleanAttachmentOrphans })
    await act(async () => { await current(result).attachments.scan() })
    expect(current(result).attachments.report).toEqual(ATT_EMPTY)
    act(() => { current(result).attachments.openPreview() })
    await act(async () => { await current(result).attachments.clean() })
    expect(cleanAttachmentOrphans).not.toHaveBeenCalled()
    // 也不该顺手重查：no-op 一次请求都不发。
    expect(d.scanAttachmentOrphans).toHaveBeenCalledTimes(1)
    expect(current(result).attachments.confirm).toBe(false)
    expect(current(result).attachments.phase).toBeNull()
  })
})
