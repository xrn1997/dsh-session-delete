import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { RefObject } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArchiveFooter, ArchiveList } from '../../src/client/archive-pane.js'
import { zhTranslate } from '../../src/client/copy.js'
import { groupByProject } from '../../src/client/trash-view.js'
import type { TrashNav } from '../../src/client/trash-nav.js'
import type { ArchiveQuery } from '../../src/client/use-archive-query.js'
import type { ListSelection } from '../../src/client/use-list-selection.js'
import type { DelayedPrefetch } from '../../src/client/use-prefetch.js'
import type { ArchiveRowWire } from '../../src/shared/wire.js'

afterEach(() => { vi.restoreAllMocks() })

const row = (sessionId: string): ArchiveRowWire => ({
  sessionId,
  projectDir: '--p--',
  title: sessionId,
  updatedAt: 1,
  updatedAtSource: 'prompt',
  subagent: false,
})

function makeSelection(over: Partial<ListSelection<ArchiveRowWire>> = {}): ListSelection<ArchiveRowWire> {
  return {
    selectMode: true,
    checked: new Set(['session-a']),
    checkedRows: [row('session-a')],
    checkedIds: ['session-a'],
    ordered: [row('session-a')],
    allCollapsed: false,
    isCollapsed: () => false,
    enterSelect: vi.fn(),
    exitSelect: vi.fn(),
    toggleGroup: vi.fn(),
    toggleAllGroups: vi.fn(),
    toggleCheck: vi.fn(),
    rangeCheck: vi.fn(),
    toggleGroupCheck: vi.fn(),
    groupFullyChecked: () => true,
    groupPartiallyChecked: () => false,
    ...over,
  }
}

describe('ArchiveFooter', () => {
  it('非多选态不渲染页脚', () => {
    const { container } = render(
      <ArchiveFooter
        selection={makeSelection({ selectMode: false })}
        controller={{ unarchive: vi.fn(), deleteMany: vi.fn(), busy: false }}
        t={zhTranslate}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('点击移入回收站所选期间显示 spinner 与进行中文案，结算（含抛错）后恢复常态', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let resolveRun!: () => void
    let rejectRun!: (reason?: unknown) => void
    const deleteMany = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveRun = resolve }))
      .mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectRun = reject }))
    const controller = { unarchive: vi.fn(async () => {}), deleteMany, busy: false }
    const selection = makeSelection()

    const { container, rerender } = render(
      <ArchiveFooter selection={selection} controller={controller} t={zhTranslate} />,
    )
    const moveBtn = screen.getByRole('button', { name: '移入回收站所选 1 条' })
    expect(container.querySelector('.sd-spinner')).toBeNull()
    expect(container.querySelector('.sd-button-icon')).not.toBeNull()

    fireEvent.click(moveBtn)
    expect(deleteMany).toHaveBeenCalledWith(['session-a'])
    expect(container.querySelector('.sd-spinner')).not.toBeNull()
    expect(container.querySelector('.sd-button-icon')).toBeNull()
    expect(screen.getByRole('button', { name: '正在移入回收站' })).toBeInTheDocument()

    // controller.busy=true 时两个动作按钮均置灰
    rerender(<ArchiveFooter selection={selection} controller={{ ...controller, busy: true }} t={zhTranslate} />)
    expect(screen.getByRole('button', { name: '解除所选 1 条' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '正在移入回收站' })).toBeDisabled()

    await act(async () => {
      resolveRun()
      await Promise.resolve()
    })
    rerender(<ArchiveFooter selection={selection} controller={{ ...controller, busy: false }} t={zhTranslate} />)
    await waitFor(() => {
      expect(container.querySelector('.sd-spinner')).toBeNull()
      expect(container.querySelector('.sd-button-icon')).not.toBeNull()
      expect(screen.getByRole('button', { name: '移入回收站所选 1 条' })).toBeEnabled()
    })

    // 第二次抛错也要恢复常态，不卡死在 spinner（捕获 rejection 防止测试进程报 unhandled rejection）
    fireEvent.click(screen.getByRole('button', { name: '移入回收站所选 1 条' }))
    expect(container.querySelector('.sd-spinner')).not.toBeNull()
    await act(async () => {
      rejectRun(new Error('boom'))
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(container.querySelector('.sd-spinner')).toBeNull()
      expect(container.querySelector('.sd-button-icon')).not.toBeNull()
      expect(screen.getByRole('button', { name: '移入回收站所选 1 条' })).toBeInTheDocument()
    })
    // 收尾异常只记录不上屏：用户可见成败早已由座位落过，日志是唯一出口。
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('归档写收尾异常'), expect.any(Error))
  })

  it('点击解除所选抛错：记录归档写收尾异常日志且不冒出未捕获异常', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const unarchive = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('unarchive boom'))
    const controller = { unarchive, deleteMany: vi.fn(async () => {}), busy: false }
    render(<ArchiveFooter selection={makeSelection()} controller={controller} t={zhTranslate} />)

    fireEvent.click(screen.getByRole('button', { name: '解除所选 1 条' }))
    expect(unarchive).toHaveBeenCalledWith(['session-a'])
    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('归档写收尾异常'), expect.any(Error))
    })
  })
})

describe('ArchiveList', () => {
  it('行级解除归档与移入回收站按钮抛错：均记录归档写收尾异常日志且不冒出未捕获异常', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const target = row('session-a')
    const rows = [target]
    const query: ArchiveQuery = {
      list: { status: 'ready', rows, totalBytes: 0, missingSizeCount: 0 },
      refreshing: false,
      count: 1,
      reload: vi.fn(async () => {}),
    }
    const groups = groupByProject(rows, zhTranslate, {
      timeOf: (r) => r.updatedAt ?? 0,
      projectDirOf: (r) => r.projectDir,
    })
    const unarchive = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('row unarchive boom'))
    const deleteOne = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('row delete boom'))
    const listRef: RefObject<HTMLDivElement> = { current: null }
    const nav: TrashNav = { activeDescendantId: null, tabStopId: null, onListKeyDown: vi.fn() }
    const prefetch: DelayedPrefetch<ArchiveRowWire> = { schedule: vi.fn(), cancel: vi.fn() }

    render(
      <ArchiveList
        query={query}
        selection={makeSelection({ selectMode: false })}
        groups={groups}
        controller={{ selectRow: vi.fn(async () => {}), unarchive, deleteOne, actionFailure: {}, busy: false }}
        prefetch={prefetch}
        listRef={listRef}
        nav={nav}
        activeId={null}
        onRetry={vi.fn()}
        t={zhTranslate}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: zhTranslate('archive.row.unarchive') }))
    expect(unarchive).toHaveBeenCalledWith(['session-a'])
    await waitFor(() => {
      expect(warn).toHaveBeenCalledTimes(1)
    })
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('归档写收尾异常'), expect.objectContaining({ message: 'row unarchive boom' }))

    fireEvent.click(screen.getByRole('button', { name: zhTranslate('archive.row.delete') }))
    expect(deleteOne).toHaveBeenCalledWith(target)
    await waitFor(() => {
      expect(warn).toHaveBeenCalledTimes(2)
    })
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('归档写收尾异常'), expect.objectContaining({ message: 'row delete boom' }))
  })
})
