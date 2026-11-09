import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useIdleClose } from '../../src/client/confirm-close.js'
import { ConfirmDialog } from '../../src/client/confirm-dialog.js'
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

describe('各张确认框都走同一条关框规则', () => {
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

// 壳只共这一层（ADR-0052）：四件文案 + 两颗键的材质 + 关框规则。各框的正文与状态机不在这里判。
describe('共用的确认框页脚壳', () => {
  function shell(props: {
    readonly danger?: boolean
    readonly busy?: boolean
    readonly onCancel?: () => void
  } = {}): ReactElement {
    return (
      <ConfirmDialog
        title="壳的标题"
        closeLabel="关闭对话框"
        cancelLabel="取消这一次"
        confirmLabel="确认这一次"
        busy={props.busy ?? false}
        onCancel={props.onCancel ?? noop}
        onConfirm={noop}
        {...(props.danger === undefined ? {} : { danger: props.danger })}
      >
        <p>壳里的正文</p>
      </ConfirmDialog>
    )
  }

  it('标题、关闭钮、两颗页脚键与正文都来自调用方，两颗键各走自己的回调', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog
        title="壳的标题"
        closeLabel="关闭对话框"
        cancelLabel="取消这一次"
        confirmLabel="确认这一次"
        busy={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      >
        <p>壳里的正文</p>
      </ConfirmDialog>,
    )
    expect(screen.getByRole('dialog')).toHaveTextContent('壳的标题')
    expect(screen.getByRole('dialog')).toHaveTextContent('壳里的正文')
    fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '取消这一次' }))
    expect(onCancel).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: '确认这一次' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('危险层级是一个旋钮：给了才换主按钮的材质，没给是普通 primary', () => {
    const plain = render(shell())
    const normal = screen.getByRole('button', { name: '确认这一次' })
    expect(normal.getAttribute('style') ?? '').not.toContain('--sd-button-primary-fill')
    plain.unmount()

    render(shell({ danger: true }))
    const danger = screen.getByRole('button', { name: '确认这一次' })
    expect(danger.getAttribute('style') ?? '').toContain('--sd-button-primary-fill')
  })

  it('busy 时两颗键一起按住（关框规则仍只有 `useIdleClose` 一个调用点）', () => {
    render(shell({ busy: true }))
    expect(screen.getByRole('button', { name: '取消这一次' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '确认这一次' })).toBeDisabled()
  })

  it('busy 时遮罩点击也关不掉框；非 busy 时遮罩照常关框', () => {
    // `Modal` 的遮罩 / 关闭钮 / Esc 都走同一个 `onClose`（`useIdleClose` 交出的 `close`）；
    // 只钉两颗键的 disabled 证明不了这条——遮罩是另一条入口。
    const onCancel = vi.fn()
    const view = render(shell({ busy: true, onCancel }))
    fireEvent.click(document.querySelector('.sd-modal-mask') as Element)
    expect(onCancel).not.toHaveBeenCalled()

    view.rerender(shell({ busy: false, onCancel }))
    fireEvent.click(document.querySelector('.sd-modal-mask') as Element)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
