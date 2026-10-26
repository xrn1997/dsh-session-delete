import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useIdleClose } from '../../src/client/confirm-close.js'
import { zhTranslate } from '../../src/client/copy.js'
import type { OrphanReportWire, TrashEntryLike } from '../../src/client/remote.js'
import { OrphanConfirm, TrashConfirm } from '../../src/client/trash-confirm.js'

const entry: TrashEntryLike = {
  id: 'a',
  sessionId: 'session-a',
  projectDir: '--p--',
  workspaceId: 'ws',
  wasArchived: false,
  deletedAt: 1,
  sizeBytes: 10,
  releaseBytes: 10,
  title: 'A',
}

const report: OrphanReportWire = {
  roots: ['session-root'],
  totalSessions: 1,
  totalBytes: 10,
  missingParents: 0,
  groups: [{ projectDir: '--p--', sessions: 1, bytes: 10 }],
}

const noop = (): void => {}

describe('确认框的关闭规则', () => {
  it('busy 时关闭无效且取消键置灰；空闲时才交回 onClose', () => {
    const close = vi.fn()
    const { result, rerender } = renderHook(
      ({ busy }: { busy: boolean }) => useIdleClose(busy, close),
      { initialProps: { busy: true } },
    )
    expect(result.current.closeDisabled).toBe(true)
    act(() => { result.current.close() })
    expect(close).not.toHaveBeenCalled()
    rerender({ busy: false })
    expect(result.current.closeDisabled).toBe(false)
    act(() => { result.current.close() })
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('四张确认框都走同一条关框规则', () => {
  it('回收站恢复框：busy 时取消与 Esc 都拦住，空闲才交回', () => {
    const onCancel = vi.fn()
    const view = render(
      <TrashConfirm
        pending={{ kind: 'restore', ids: ['a'] }}
        restoreEntries={[entry]}
        busy
        t={zhTranslate}
        onCancel={onCancel}
        onConfirmPurge={noop}
        onConfirmRestore={noop}
      />,
    )
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()

    view.rerender(
      <TrashConfirm
        pending={{ kind: 'restore', ids: ['a'] }}
        restoreEntries={[entry]}
        busy={false}
        t={zhTranslate}
        onCancel={onCancel}
        onConfirmPurge={noop}
        onConfirmRestore={noop}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('回收站彻底删除框：busy 时取消与 Esc 都拦住，空闲才交回', () => {
    const onCancel = vi.fn()
    const view = render(
      <TrashConfirm
        pending={{ kind: 'entry', entry }}
        restoreEntries={[]}
        busy
        t={zhTranslate}
        onCancel={onCancel}
        onConfirmPurge={noop}
        onConfirmRestore={noop}
      />,
    )
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()

    view.rerender(
      <TrashConfirm
        pending={{ kind: 'entry', entry }}
        restoreEntries={[]}
        busy={false}
        t={zhTranslate}
        onCancel={onCancel}
        onConfirmPurge={noop}
        onConfirmRestore={noop}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('无主子会话清理框：busy 时取消与 Esc 都拦住，空闲才交回', () => {
    const onCancel = vi.fn()
    const view = render(
      <OrphanConfirm
        report={report}
        busy
        t={zhTranslate}
        onCancel={onCancel}
        onConfirm={noop}
      />,
    )
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()

    view.rerender(
      <OrphanConfirm
        report={report}
        busy={false}
        t={zhTranslate}
        onCancel={onCancel}
        onConfirm={noop}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
