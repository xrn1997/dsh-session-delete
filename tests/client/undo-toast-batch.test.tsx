// 批量撤销横幅（2026-10-17）：「N 条会话已移入回收站 · 撤销」，撤销 = 一次批量 restore。
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplyOutcome } from '../../src/client/remote.js'
import {
  UndoToast,
  publishUndoBatchNotice,
  publishUndoNotice,
  resetUndoNotice,
  useUndoNotice,
} from '../../src/client/undo-toast.js'

beforeEach(() => {
  resetUndoNotice()
})

afterEach(() => {
  resetUndoNotice()
})

function restoreOutcomes(ids: readonly string[]): ApplyOutcome[] {
  return ids.map(
    (id) => ({ id, action: 'restore', ok: true, value: { id: `entry-${id}` } }) as ApplyOutcome,
  )
}

describe('通知台 seq', () => {
  it('单条与批量共用一个逐次递增的 seq（Toast 靠它重挂载、重新计停留）', () => {
    const { result } = renderHook(() => useUndoNotice())
    act(() => {
      publishUndoNotice({ entryId: 'e1', title: 'T' })
    })
    expect(result.current).toMatchObject({ seq: 1, kind: 'one', entryId: 'e1' })
    act(() => {
      publishUndoBatchNotice({ entryIds: ['e1'], n: 1 })
    })
    expect(result.current).toMatchObject({ seq: 2, kind: 'batch', entryIds: ['e1'], n: 1 })
  })

  it('撤销失败把原因换到同一条横幅上：seq 也递增（换 key ⇒ 停留重新计）', async () => {
    const applyOutcomes = vi.fn(async () => {
      throw Object.assign(new Error('原项目目录已不在'), { code: 'sessiondelete/io' })
    })
    publishUndoBatchNotice({ entryIds: ['e1'], n: 1 })
    const view = renderHook(() => useUndoNotice())
    render(<UndoToast deps={{ applyOutcomes } as never} />)
    expect(view.result.current?.seq).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(view.result.current?.seq).toBe(2))
    expect(view.result.current?.failure).toBe('原项目目录已不在')
  })
})

describe('批量撤销横幅', () => {
  it('报条数、撤销只发一次批量 restore', async () => {
    const applyOutcomes = vi.fn(async (_action: string, ids: readonly string[]) => restoreOutcomes(ids))
    const restore = vi.fn(async () => ({}))
    publishUndoBatchNotice({ entryIds: ['e1', 'e2'], n: 2 })
    render(<UndoToast deps={{ applyOutcomes, restore } as never} />)
    expect(screen.getByText('2 条会话已移入回收站')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(applyOutcomes).toHaveBeenCalledTimes(1))
    expect(applyOutcomes).toHaveBeenCalledWith('restore', ['e1', 'e2'])
    expect(restore).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('2 条会话已移入回收站')).not.toBeInTheDocument())
  })

  it('撤销失败只剩原文，不再有撤销按钮', async () => {
    const applyOutcomes = vi.fn(async () => {
      throw Object.assign(new Error('原项目目录已不在'), { code: 'sessiondelete/io' })
    })
    publishUndoBatchNotice({ entryIds: ['e1'], n: 1 })
    render(<UndoToast deps={{ applyOutcomes } as never} />)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(await screen.findByText(/原项目目录已不在/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument()
  })
})
