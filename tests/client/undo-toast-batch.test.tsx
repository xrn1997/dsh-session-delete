// 批量撤销横幅（第十三批②）：「N 条会话已移入回收站 · 撤销」，撤销 = 一次批量 restore。
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplyOutcome } from '../../src/client/remote.js'
import {
  UndoToast,
  clearUndoNotice,
  publishUndoBatchNotice,
} from '../../src/client/undo-toast.js'

beforeEach(() => {
  clearUndoNotice()
})

function restoreOutcomes(ids: readonly string[]): ApplyOutcome[] {
  return ids.map(
    (id) => ({ id, action: 'restore', ok: true, value: { id: `entry-${id}` } }) as ApplyOutcome,
  )
}

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
