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
import type { RemoteOutcome } from '../../src/client/remote.js'
import type { AttachmentCleanupWire, AttachmentOrphanReportWire, OrphanReportWire } from '../../src/shared/wire.js'
import type { ApplyAction, ApplyOutcome } from '../../src/shared/wire.js'
import { createFakeRemote, remoteFail, remoteOk, type FakeRemote } from './support/fake-remote.js'
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
const PROJ_3 = { count: 3 }
const PROJ_EMPTY = { count: 0 }

function deps(over: Partial<FakeRemote> = {}): FakeRemote {
  return createFakeRemote({
    scanOrphans: vi.fn(async () => remoteOk(EMPTY)),
    applyOutcomes: vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<RemoteOutcome<ApplyOutcome[]>> =>
      remoteOk(outcomes(action, ids))),
    scanAttachmentOrphans: vi.fn(async () => remoteOk(ATT_EMPTY)),
    cleanAttachmentOrphans: vi.fn(async () => remoteOk({ removed: 0, freedBytes: 0, failed: 0 })),
    scanProjectionCacheOrphans: vi.fn(async () => remoteOk(PROJ_EMPTY)),
    cleanProjectionCacheOrphans: vi.fn(async () => remoteOk({ removed: 0, failed: 0 })),
    ...over,
  })
}

function renderCard(over: Partial<FakeRemote> = {}) {
  const d = deps(over)
  const view = render(<MaintenanceSettings deps={d} />)
  const section = (slot: 'maintenance-orphans' | 'maintenance-attachments' | 'maintenance-projection') => {
    const node = document.querySelector(`[data-dsh-session-delete="${slot}"]`)
    if (node === null) throw new Error(`没有维护段：${slot}`)
    return node as HTMLElement
  }
  return { d, section, ...view }
}

describe('维护卡 · 初始态', () => {
  it('三个维护段都从「尚未检查」起，挂载不发请求', () => {
    const { d, section } = renderCard()
    expect(screen.getByText('维护')).toBeInTheDocument()
    expect(within(section('maintenance-orphans')).getByText('孤儿会话')).toBeInTheDocument()
    expect(within(section('maintenance-attachments')).getByText('孤儿附件')).toBeInTheDocument()
    expect(within(section('maintenance-projection')).getByText('投影缓存')).toBeInTheDocument()
    // 三段各一枚状态；不是一条整卡状态。
    expect(screen.getAllByText('尚未检查')).toHaveLength(3)
    expect(d.scanOrphans).not.toHaveBeenCalled()
    expect(d.scanAttachmentOrphans).not.toHaveBeenCalled()
    expect(d.scanProjectionCacheOrphans).not.toHaveBeenCalled()
  })

  it('「检查」在飞时状态是「检查中…」、按钮按住；落地 0 条显示「没有发现」', async () => {
    let resolveScan!: (value: RemoteOutcome<OrphanReportWire>) => void
    const scanOrphans = vi.fn(() => new Promise<RemoteOutcome<OrphanReportWire>>((resolve) => { resolveScan = resolve }))
    const { section } = renderCard({ scanOrphans })
    const orphans = section('maintenance-orphans')
    const check = within(orphans).getByRole('button', { name: '检查' })

    fireEvent.click(check)
    expect(within(orphans).getByText('检查中…')).toBeInTheDocument()
    expect(check).toBeDisabled()

    await act(async () => { resolveScan(remoteOk(EMPTY)) })
    await waitFor(() => expect(within(orphans).getByText('没有发现')).toBeInTheDocument())
    expect(check).not.toBeDisabled()
  })
})

describe('维护卡 · 孤儿会话', () => {
  it('检查显示 N 条并复用既有横幅；清理后重查归零', async () => {
    const scanOrphans = vi.fn()
      .mockResolvedValueOnce(remoteOk(REPORT))
      .mockResolvedValueOnce(remoteOk(EMPTY))
    const applyOutcomes = vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<RemoteOutcome<ApplyOutcome[]>> =>
      remoteOk(ids.map((id) => ok(action, id, { removed: 1, freedBytes: 2048 }))))
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
      scanOrphans: vi.fn(async () => remoteFail({ code: 'sessiondelete/io', message: 'sessionQuery 不在' })),
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
    let resolveApply!: (value: RemoteOutcome<ApplyOutcome[]>) => void
    const scanOrphans = vi.fn()
      .mockResolvedValueOnce(remoteOk(REPORT))
      .mockResolvedValueOnce(remoteOk(EMPTY))
    const applyOutcomes = vi.fn(
      () => new Promise<RemoteOutcome<ApplyOutcome[]>>((resolve) => { resolveApply = resolve }),
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
    // 段的忙碌自己按住头行的「检查」（busy 从段对象取，不再当 prop 传进来）；另一段不受影响。
    expect(within(orphans).getByRole('button', { name: '检查' })).toBeDisabled()
    expect(within(section('maintenance-attachments')).getByRole('button', { name: '检查' })).not.toBeDisabled()

    await act(async () => {
      resolveApply(remoteOk(['session-root'].map((id) => ok('orphan-clean', id, {
        removed: 1,
        freedBytes: 2048,
        attachments: { removed: 2, freedBytes: 100, failed: 0, skipped: '剩余引用源读不出' },
      }))))
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
    const scanAttachmentOrphans = vi.fn(async () => remoteOk(report))
    let resolveClean!: (value: RemoteOutcome<AttachmentCleanupWire>) => void
    const cleanAttachmentOrphans = vi.fn(
      () => new Promise<RemoteOutcome<AttachmentCleanupWire>>((resolve) => { resolveClean = resolve }),
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
    // 危险层级跟动作走（ADR-0052）：孤儿附件是**不可恢复**的删除 ⇒ 实心红主按钮。
    expect(
      within(dialog).getByRole('button', { name: '清理这些附件' })
        .style.getPropertyValue('--sd-button-primary-fill'),
    ).toBe('var(--dsw-alias-state-error-primary)')
    expect(within(dialog).getAllByRole('img')).toHaveLength(106)
    fireEvent.click(within(dialog).getByRole('button', { name: '清理这些附件' }))

    expect(within(attachments).getByText('清理中…')).toBeInTheDocument()
    expect(within(attachments).queryByText('检查中…')).not.toBeInTheDocument()

    await act(async () => {
      report = ATT_EMPTY
      resolveClean(remoteOk({ removed: 106, freedBytes: 29_150_413, failed: 0 }))
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
    const scanAttachmentOrphans = vi.fn(async () => remoteOk(report))
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
      .mockResolvedValueOnce(remoteFail({ code: 'sessiondelete/io', message: '引用源读不出' }))
      .mockResolvedValueOnce(remoteOk(ATT_EMPTY))
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
    const scanAttachmentOrphans = vi.fn(async () => remoteOk(report))
    const cleanAttachmentOrphans = vi.fn(async () => {
      report = ATT_EMPTY
      return remoteOk({ removed: 0, freedBytes: 0, failed: 0, skipped: '引用源读不出' })
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
    const scanAttachmentOrphans = vi.fn(async () => remoteOk(ATT_106))
    const { section } = renderCard({
      scanAttachmentOrphans,
      cleanAttachmentOrphans: vi.fn(async () => remoteFail({ code: 'sessiondelete/io', message: '盘上忙' })),
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

describe('维护卡 · 投影缓存', () => {
  it('检查显示条数；确认后清理并重查归零，回执单独一行', async () => {
    let report = PROJ_3
    const scanProjectionCacheOrphans = vi.fn(async () => remoteOk(report))
    const cleanProjectionCacheOrphans = vi.fn(async () => {
      report = PROJ_EMPTY
      return remoteOk({ removed: 3, failed: 0 })
    })
    const { d, section } = renderCard({ scanProjectionCacheOrphans, cleanProjectionCacheOrphans })
    const projection = section('maintenance-projection')

    fireEvent.click(within(projection).getByRole('button', { name: '检查' }))
    expect(await within(projection).findByText('发现 3 条没有对应会话的投影缓存记录')).toBeInTheDocument()
    expect(within(projection).getByText('3 条')).toBeInTheDocument()

    fireEvent.click(within(projection).getByRole('button', { name: '查看并清理' }))
    const dialog = await screen.findByRole('dialog', { name: '清理 3 条投影缓存记录？' })
    expect(
      within(dialog).getByText('这些是宿主会话投影的派生缓存；清理不会动会话本体、清册或附件。'),
    ).toBeInTheDocument()
    // 派生数据可重建、不是不可恢复的删除 ⇒ 普通主按钮，不传 `danger`（ADR-0062 / ui-spec §5.2）。
    expect(
      within(dialog).getByRole('button', { name: '清理这些记录' })
        .style.getPropertyValue('--sd-button-primary-fill'),
    ).toBe('')
    fireEvent.click(within(dialog).getByRole('button', { name: '清理这些记录' }))

    expect(within(projection).getByText('清理中…')).toBeInTheDocument()
    await waitFor(() => expect(cleanProjectionCacheOrphans).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(scanProjectionCacheOrphans).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(within(projection).getByText('没有发现')).toBeInTheDocument())
    expect(within(projection).getByText('已清理 3 条投影缓存记录')).toBeInTheDocument()
    // 另两段各扫各的，不被这段的清理带着走。
    expect(d.scanOrphans).not.toHaveBeenCalled()
    expect(d.scanAttachmentOrphans).not.toHaveBeenCalled()
  })

  it('检查失败：原因上屏、状态是「检查失败」，不退回「尚未检查」', async () => {
    const scanProjectionCacheOrphans = vi.fn(async () =>
      remoteFail({ code: 'sessiondelete/io', message: '投影缓存读面不可用' }))
    const { section } = renderCard({ scanProjectionCacheOrphans })
    const projection = section('maintenance-projection')

    fireEvent.click(within(projection).getByRole('button', { name: '检查' }))
    expect(await within(projection).findByText('检查失败：投影缓存读面不可用')).toBeInTheDocument()
    expect(within(projection).getByText('检查失败')).toBeInTheDocument()
    expect(within(projection).queryByText('尚未检查')).not.toBeInTheDocument()
  })

  it('清理部分失败：未清条数与已清条数都在句里，状态行是「检查失败」', async () => {
    const scanProjectionCacheOrphans = vi.fn(async () => remoteOk(PROJ_3))
    const cleanProjectionCacheOrphans = vi.fn(async () => remoteOk({ removed: 1, failed: 2 }))
    const { section } = renderCard({ scanProjectionCacheOrphans, cleanProjectionCacheOrphans })
    const projection = section('maintenance-projection')

    fireEvent.click(within(projection).getByRole('button', { name: '检查' }))
    await within(projection).findByText('发现 3 条没有对应会话的投影缓存记录')
    fireEvent.click(within(projection).getByRole('button', { name: '查看并清理' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '清理这些记录' }))

    expect(await within(projection).findByText('2 条投影缓存记录未能清理（已清理 1 条）')).toBeInTheDocument()
    expect(within(projection).getByText('检查失败')).toBeInTheDocument()
  })
})
