// 批量删除确认框（第十三批②）：数说清自己的、失败原文落行、重试只发失败 id。
// 假 adapter 驱动真组件（与 delete-menu-item.test.tsx 同款）：现场是模块级的，每个用例前清一次。
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearPicks, getPicks, togglePick } from '../../src/client/batch-select.js'
import {
  BatchConfirmHost,
  clearDeleteBatchRequest,
  requestDeleteBatch,
} from '../../src/client/batch-confirm.js'
import type { ApplyOutcome } from '../../src/client/remote.js'
import { UndoToast, clearUndoNotice } from '../../src/client/undo-toast.js'

beforeEach(() => {
  clearDeleteBatchRequest()
  clearPicks()
  clearUndoNotice()
})

function countOutcomes(ids: readonly string[], kids: Record<string, number> = {}): ApplyOutcome[] {
  return ids.map(
    (id) => ({ id, action: 'count', ok: true, value: kids[id] ?? 0 }) as ApplyOutcome,
  )
}

function deleteOutcomes(ids: readonly string[], failIds: readonly string[] = []): ApplyOutcome[] {
  return ids.map((id) =>
    failIds.includes(id)
      ? ({
          id,
          action: 'delete',
          ok: false,
          error: { code: 'sessiondelete/io', message: '会话目录不在盘上' },
        } as ApplyOutcome)
      : ({ id, action: 'delete', ok: true, value: { id: `entry-${id}` } } as ApplyOutcome),
  )
}

describe('批量确认框', () => {
  it('标题随条数：1 条是单删那句，多条是「删除这些 N 个会话？」', async () => {
    const applyOutcomes = vi.fn(async (action: string, ids: readonly string[]) =>
      action === 'count' ? countOutcomes(ids) : deleteOutcomes(ids),
    )
    requestDeleteBatch([{ sessionId: 'a', title: 'A' }])
    render(<BatchConfirmHost deps={{ applyOutcomes } as never} />)
    expect(await screen.findByRole('heading', { name: '删除这个会话？' })).toBeInTheDocument()
  })

  it('子会话两句只在有数时说：chip 有才标、汇总句 K>0 才出；读不到整句不说且主按钮照常可点', async () => {
    const applyOutcomes = vi.fn(async (_action: string, ids: readonly string[]) =>
      countOutcomes(ids, { a: 2 }),
    )
    requestDeleteBatch([
      { sessionId: 'a', title: 'A' },
      { sessionId: 'b', title: 'B' },
    ])
    const first = render(<BatchConfirmHost deps={{ applyOutcomes } as never} />)
    expect(await screen.findByText('删除这些 2 个会话？')).toBeInTheDocument()
    expect(screen.getByText('含 2 个子会话')).toBeInTheDocument()
    expect(screen.queryByText('含 0 个子会话')).not.toBeInTheDocument()
    expect(screen.getByText('含 2 个子会话，将一起移入回收站。')).toBeInTheDocument()
    // 同一个 document 里先收掉上一幕，否则两个框同屏、按名查会撞
    first.unmount()

    clearDeleteBatchRequest()
    const failing = vi.fn(async () => {
      throw Object.assign(new Error('读不到'), { code: 'sessiondelete/io' })
    })
    requestDeleteBatch([{ sessionId: 'c', title: 'C' }])
    render(<BatchConfirmHost deps={{ applyOutcomes: failing } as never} />)
    expect(await screen.findByText('删除这个会话？')).toBeInTheDocument()
    expect(screen.queryByText(/将一起移入回收站/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '移入回收站 1 条' })).toBeEnabled()
  })

  it('目标列表限高滚动：几十条也不会把标题和底部按钮顶出弹框', async () => {
    const applyOutcomes = vi.fn(async (_action: string, ids: readonly string[]) => countOutcomes(ids))
    const items = Array.from({ length: 80 }, (_, i) => ({ sessionId: `s${i}`, title: `S${i}` }))
    requestDeleteBatch(items)
    render(<BatchConfirmHost deps={{ applyOutcomes } as never} />)

    const card = document.querySelector('[data-dsh-session-delete="batch-target-card"]')
    expect(card).not.toBeNull()
    expect(card).toHaveStyle({ maxHeight: '280px', overflow: 'auto' })
    // 标题与底部动作还在（列表只在卡片内部滚）
    expect(screen.getByRole('heading', { name: '删除这些 80 个会话？' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '移入回收站 80 条' })).toBeInTheDocument()
  })

  it('成功路径：一次 applyOutcomes、框收工、发批量撤销横幅、选中集清空', async () => {
    const applyOutcomes = vi.fn(async (action: string, ids: readonly string[]) =>
      action === 'count' ? countOutcomes(ids) : deleteOutcomes(ids),
    )
    togglePick({ sessionId: 'a', title: 'A' })
    togglePick({ sessionId: 'b', title: 'B' })
    requestDeleteBatch()
    render(
      <>
        <BatchConfirmHost deps={{ applyOutcomes } as never} />
        <UndoToast deps={{ applyOutcomes } as never} />
      </>,
    )
    fireEvent.click(await screen.findByRole('button', { name: '移入回收站 2 条' }))
    await waitFor(() => expect(screen.getByText('2 条会话已移入回收站')).toBeInTheDocument())
    expect(applyOutcomes).toHaveBeenCalledWith('delete', ['a', 'b'])
    expect(screen.queryByRole('button', { name: '移入回收站 2 条' })).not.toBeInTheDocument()
    expect(getPicks()).toEqual([])
  })

  it('部分失败：原文落它自己那行、按钮变「重试这 1 条」、重试只发失败 id', async () => {
    const applyOutcomes = vi.fn(async (action: string, ids: readonly string[]) =>
      action === 'count' ? countOutcomes(ids) : deleteOutcomes(ids, ['b']),
    )
    togglePick({ sessionId: 'a', title: 'A' })
    togglePick({ sessionId: 'b', title: 'B' })
    requestDeleteBatch()
    render(
      <>
        <BatchConfirmHost deps={{ applyOutcomes } as never} />
        <UndoToast deps={{ applyOutcomes } as never} />
      </>,
    )
    fireEvent.click(await screen.findByRole('button', { name: '移入回收站 2 条' }))
    expect(await screen.findByText(/会话目录不在盘上/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试这 1 条' })).toBeInTheDocument()
    expect(screen.getByText('1 条会话已移入回收站')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试这 1 条' }))
    await waitFor(() => expect(applyOutcomes).toHaveBeenLastCalledWith('delete', ['b']))
    expect(applyOutcomes).toHaveBeenCalledTimes(3)
  })
})
