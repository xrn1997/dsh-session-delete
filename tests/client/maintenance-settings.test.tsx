/**
 * 设置页「维护」卡（`maintenance-settings.tsx`）。
 *
 * 钉住设计里那几条用户可见的判据：
 * - 初始是「尚未检查」，挂载不发任何请求（手动触发，没有自动扫描）；
 * - 点「检查」才发请求，0 条显示「没有发现」；
 * - 106 / 27.8MiB 报告在横幅上念数量与体积；「查看并清理」过确认框，清完自动重查归零；
 * - 检查失败在原位摆原因 + 重试。
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MaintenanceSettings } from '../../src/client/maintenance-settings.js'
import type {
  AttachmentCleanupWire,
  AttachmentOrphanReportWire,
  OrphanReportWire,
} from '../../src/client/remote.js'
import type { ApplyAction, ApplyOutcome } from '../../src/shared/wire.js'
import { createFakeRemote, type FakeRemote } from './support/fake-remote.js'
import { ok, outcomes } from './support/outcomes.js'

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

function renderCard(over: Partial<FakeRemote> = {}) {
  const d = deps(over)
  const view = render(<MaintenanceSettings deps={d} />)
  const section = (slot: 'maintenance-orphans' | 'maintenance-attachments') => {
    const node = document.querySelector(`[data-dsh-session-delete="${slot}"]`)
    if (node === null) throw new Error(`没有维护段：${slot}`)
    return node as HTMLElement
  }
  return { d, section, ...view }
}

describe('维护卡 · 初始态', () => {
  it('两个维护段都从「尚未检查」起，挂载不发请求', () => {
    const { d, section } = renderCard()
    expect(screen.getByText('维护')).toBeInTheDocument()
    expect(within(section('maintenance-orphans')).getByText('孤儿会话')).toBeInTheDocument()
    expect(within(section('maintenance-attachments')).getByText('孤儿附件')).toBeInTheDocument()
    // 两段各一枚状态；不是一条整卡状态。
    expect(screen.getAllByText('尚未检查')).toHaveLength(2)
    expect(d.scanOrphans).not.toHaveBeenCalled()
    expect(d.scanAttachmentOrphans).not.toHaveBeenCalled()
  })

  it('「检查」在飞时状态是「检查中…」、按钮按住；落地 0 条显示「没有发现」', async () => {
    let resolveScan!: (value: OrphanReportWire) => void
    const scanOrphans = vi.fn(() => new Promise<OrphanReportWire>((resolve) => { resolveScan = resolve }))
    const { section } = renderCard({ scanOrphans })
    const orphans = section('maintenance-orphans')
    const check = within(orphans).getByRole('button', { name: '检查' })

    fireEvent.click(check)
    expect(within(orphans).getByText('检查中…')).toBeInTheDocument()
    expect(check).toBeDisabled()

    await act(async () => { resolveScan(EMPTY) })
    await waitFor(() => expect(within(orphans).getByText('没有发现')).toBeInTheDocument())
    expect(check).not.toBeDisabled()
  })
})

describe('维护卡 · 孤儿会话', () => {
  it('检查显示 N 条并复用既有横幅；清理后重查归零', async () => {
    const scanOrphans = vi.fn()
      .mockResolvedValueOnce(REPORT)
      .mockResolvedValueOnce(EMPTY)
    const applyOutcomes = vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]> =>
      ids.map((id) => ok(action, id, { removed: 1, freedBytes: 2048 })))
    const { d, section } = renderCard({ scanOrphans, applyOutcomes })
    const orphans = section('maintenance-orphans')

    fireEvent.click(within(orphans).getByRole('button', { name: '检查' }))
    expect(await within(orphans).findByText('回收站之外发现 2 个无主子会话')).toBeInTheDocument()
    expect(within(orphans).getByText('2 个')).toBeInTheDocument()

    fireEvent.click(within(orphans).getByRole('button', { name: '查看并清理' }))
    const dialog = await screen.findByRole('dialog', { name: '清理 2 个无主子会话？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '清理' }))

    await waitFor(() => expect(applyOutcomes).toHaveBeenCalledWith('orphan-clean', ['session-root']))
    await waitFor(() => expect(within(orphans).getByText('没有发现')).toBeInTheDocument())
    expect(scanOrphans).toHaveBeenCalledTimes(2)
    expect(d.scanAttachmentOrphans).not.toHaveBeenCalled()
  })

  it('检查失败：状态行是「检查失败」，不是「尚未检查」；另一段不受影响', async () => {
    const { section } = renderCard({
      scanOrphans: vi.fn(async () => {
        throw Object.assign(new Error('sessionQuery 不在'), { code: 'sessiondelete/io' })
      }),
    })
    const orphans = section('maintenance-orphans')

    fireEvent.click(within(orphans).getByRole('button', { name: '检查' }))
    expect(await within(orphans).findByText('残留检查/清理失败：sessionQuery 不在')).toBeInTheDocument()
    expect(within(orphans).getByText('检查失败')).toBeInTheDocument()
    expect(within(orphans).queryByText('尚未检查')).not.toBeInTheDocument()
    // 失败只属于出了事的那一段：另一段仍是「尚未检查」。
    expect(within(section('maintenance-attachments')).getByText('尚未检查')).toBeInTheDocument()
  })

  it('清理在飞时状态是「清理中…」；回执里的附件读数在孤儿段上屏', async () => {
    let resolveApply!: (value: ApplyOutcome[]) => void
    const scanOrphans = vi.fn()
      .mockResolvedValueOnce(REPORT)
      .mockResolvedValueOnce(EMPTY)
    const applyOutcomes = vi.fn(
      (_action: ApplyAction, _ids: readonly string[]) =>
        new Promise<ApplyOutcome[]>((resolve) => { resolveApply = resolve }),
    )
    const { section } = renderCard({ scanOrphans, applyOutcomes })
    const orphans = section('maintenance-orphans')

    fireEvent.click(within(orphans).getByRole('button', { name: '检查' }))
    await within(orphans).findByText('回收站之外发现 2 个无主子会话')
    fireEvent.click(within(orphans).getByRole('button', { name: '查看并清理' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '清理' }))

    // 清理与检查是两档：这里不许说「检查中…」。
    expect(within(orphans).getByText('清理中…')).toBeInTheDocument()
    expect(within(orphans).queryByText('检查中…')).not.toBeInTheDocument()

    await act(async () => {
      resolveApply(['session-root'].map((id) => ok('orphan-clean', id, {
        removed: 1,
        freedBytes: 2048,
        attachments: { removed: 2, freedBytes: 100, failed: 0, skipped: '剩余引用源读不出' },
      })))
    })
    expect(
      await within(orphans).findByText('部分附件未清理：剩余引用源读不出（已清理 2 个）'),
    ).toBeInTheDocument()
    expect(within(orphans).getByText('没有发现')).toBeInTheDocument()
  })
})

describe('维护卡 · 孤儿附件', () => {
  it('106 / 27.8MiB：检查显示数量与体积，确认后清理并重查归零', async () => {
    let report = ATT_106
    const scanAttachmentOrphans = vi.fn(async () => report)
    let resolveClean!: (value: AttachmentCleanupWire) => void
    const cleanAttachmentOrphans = vi.fn(
      () => new Promise<AttachmentCleanupWire>((resolve) => { resolveClean = resolve }),
    )
    const { d, section } = renderCard({ scanAttachmentOrphans, cleanAttachmentOrphans })
    const attachments = section('maintenance-attachments')

    fireEvent.click(within(attachments).getByRole('button', { name: '检查' }))
    await waitFor(() => expect(scanAttachmentOrphans).toHaveBeenCalledTimes(1))

    const banner = await waitFor(() => {
      const node = attachments.querySelector('[data-dsh-session-delete="attachment-banner"]')
      if (node === null) throw new Error('还没有附件横幅')
      return node as HTMLElement
    })
    // 数量与体积都在横幅上；`fileSizeText` 对 ≥10 的单位取整，27.8 MiB 念成 28MB。
    expect(banner).toHaveTextContent('106 个')
    expect(banner).toHaveTextContent('28MB')
    expect(within(attachments).getByText('106 个')).toBeInTheDocument()

    fireEvent.click(within(attachments).getByRole('button', { name: '查看并清理' }))
    const dialog = await screen.findByRole('dialog', { name: '查看并清理 106 个孤儿附件？' })
    expect(
      within(dialog).getByText('只清理 .dsh 内无引用的图片副本；源文件不受影响；共享引用保留。'),
    ).toBeInTheDocument()
    expect(within(dialog).getAllByRole('img')).toHaveLength(106)
    fireEvent.click(within(dialog).getByRole('button', { name: '清理这些附件' }))

    expect(within(attachments).getByText('清理中…')).toBeInTheDocument()
    expect(within(attachments).queryByText('检查中…')).not.toBeInTheDocument()

    await act(async () => {
      report = ATT_EMPTY
      resolveClean({ removed: 106, freedBytes: 29_150_413, failed: 0 })
    })
    await waitFor(() => expect(cleanAttachmentOrphans).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(scanAttachmentOrphans).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(within(attachments).getByText('没有发现')).toBeInTheDocument())
    expect(attachments.querySelector('[data-dsh-session-delete="attachment-banner"]')).toBeNull()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(attachments).getByText('已清理 106 个（28MB）')).toBeInTheDocument()
    expect(d.scanOrphans).not.toHaveBeenCalled()
  })

  it('预览清单超过上限：标题念全量，并明说只预览前 200 个', async () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      attachmentId: `sha256:${(i + 1).toString(16).padStart(64, '0')}`,
      bytes: 1,
    }))
    const report: AttachmentOrphanReportWire = { count: 205, totalBytes: 205, items }
    const scanAttachmentOrphans = vi.fn(async () => report)
    const { section } = renderCard({ scanAttachmentOrphans })
    const attachments = section('maintenance-attachments')

    fireEvent.click(within(attachments).getByRole('button', { name: '检查' }))
    await within(attachments).findByText('查看并清理')
    expect(within(attachments).getByText('205 个')).toBeInTheDocument()

    fireEvent.click(within(attachments).getByRole('button', { name: '查看并清理' }))
    const dialog = await screen.findByRole('dialog', { name: '查看并清理 205 个孤儿附件？' })
    expect(within(dialog).getAllByRole('img')).toHaveLength(200)
    expect(within(dialog).getByText('仅预览前 200 个；清理会处理全部 205 个。')).toBeInTheDocument()
  })

  it('检查失败：原因上屏，重试再发一次请求', async () => {
    const scanAttachmentOrphans = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('引用源读不出'), { code: 'sessiondelete/io' }))
      .mockResolvedValueOnce(ATT_EMPTY)
    const { section } = renderCard({ scanAttachmentOrphans })
    const attachments = section('maintenance-attachments')

    fireEvent.click(within(attachments).getByRole('button', { name: '检查' }))
    expect(await within(attachments).findByText('检查失败：引用源读不出')).toBeInTheDocument()
    // 失败不是「尚未检查」：状态行要在原位说「检查失败」。
    expect(within(attachments).getByText('检查失败')).toBeInTheDocument()
    expect(within(attachments).queryByText('尚未检查')).not.toBeInTheDocument()

    fireEvent.click(within(attachments).getByRole('button', { name: '重试' }))
    await waitFor(() => expect(within(attachments).getByText('没有发现')).toBeInTheDocument())
    expect(scanAttachmentOrphans).toHaveBeenCalledTimes(2)
  })

  it('skipped 回执在卡片上出提示，不冒充"没有发现"之外的成功', async () => {
    let report = ATT_106
    const scanAttachmentOrphans = vi.fn(async () => report)
    const cleanAttachmentOrphans = vi.fn(async () => {
      report = ATT_EMPTY
      return { removed: 0, freedBytes: 0, failed: 0, skipped: '引用源读不出' }
    })
    const { section } = renderCard({ scanAttachmentOrphans, cleanAttachmentOrphans })
    const attachments = section('maintenance-attachments')

    fireEvent.click(within(attachments).getByRole('button', { name: '检查' }))
    await within(attachments).findByText('查看并清理')
    fireEvent.click(within(attachments).getByRole('button', { name: '查看并清理' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '清理这些附件' }))

    // 一件都没清：整轮跳过句，不追加「（已清理 0 个）」。
    expect(await within(attachments).findByText('附件未清理：引用源读不出')).toBeInTheDocument()
  })

  it('清理顶层失败：本地化前缀 + 原文，状态行是「检查失败」', async () => {
    const scanAttachmentOrphans = vi.fn(async () => ATT_106)
    const { section } = renderCard({
      scanAttachmentOrphans,
      cleanAttachmentOrphans: vi.fn(async () => {
        throw Object.assign(new Error('盘上忙'), { code: 'sessiondelete/io' })
      }),
    })
    const attachments = section('maintenance-attachments')

    fireEvent.click(within(attachments).getByRole('button', { name: '检查' }))
    await within(attachments).findByText('查看并清理')
    fireEvent.click(within(attachments).getByRole('button', { name: '查看并清理' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '清理这些附件' }))

    expect(await within(attachments).findByText('附件清理失败：盘上忙')).toBeInTheDocument()
    expect(within(attachments).getByText('检查失败')).toBeInTheDocument()
    expect(within(attachments).queryByText('尚未检查')).not.toBeInTheDocument()
  })
})
