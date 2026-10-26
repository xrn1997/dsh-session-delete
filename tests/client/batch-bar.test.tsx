// 批量删除浮条（2026-10-17）：多选模式、计数、已选清单、行点击选择与确认框。
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchPickButton } from '../../src/client/batch-select.js'
import { BatchBar } from '../../src/client/batch-bar.js'
import { BatchConfirmHost, resetBatchConfirm } from '../../src/client/batch-confirm.js'
import { resetHostRows } from '../../src/client/host-rows.js'
import type { ApplyOutcome } from '../../src/client/remote.js'
import { resetTrashStore } from '../../src/client/trash-store.js'
import { resetUndoNotice } from '../../src/client/undo-notices.js'
import { createFakeRemote } from './support/fake-remote.js'
import {
  enterSelection,
  getPicks,
  isSelecting,
  resetSelection,
  togglePick,
} from '../../src/client/batch-selection-store.js'
import { countOutcomes } from './support/outcomes.js'

beforeEach(() => {
  resetSelection()
  resetHostRows()
  resetBatchConfirm()
  resetUndoNotice()
  resetTrashStore()
})

afterEach(() => {
  resetSelection()
  resetHostRows()
  resetBatchConfirm()
  resetUndoNotice()
  resetTrashStore()
  document.body.replaceChildren()
})

function countOnly(): { applyOutcomes: ReturnType<typeof vi.fn> } {
  const applyOutcomes = vi.fn(async (action: string, ids: readonly string[]) =>
    action === 'count' ? countOutcomes(ids) : [],
  )
  return { applyOutcomes }
}

/** 真宿主会话行替身：`data-row-key` 是守卫认行的唯一凭据，行自己的 onClick 模拟"切会话"。 */
function fakeRow(sessionId: string, titleText = 'A'): {
  row: HTMLDivElement
  title: HTMLSpanElement
  opened: () => number
} {
  const row = document.createElement('div')
  row.setAttribute('data-row-key', `session:${sessionId}`)
  const title = document.createElement('span')
  title.textContent = titleText
  row.appendChild(title)
  document.body.appendChild(row)
  let count = 0
  row.addEventListener('click', () => { count += 1 })
  return { row, title, opened: () => count }
}

describe('浮条', () => {
  it('不在多选态整个不渲染', () => {
    render(<BatchBar deps={createFakeRemote({ applyOutcomes: vi.fn() })} />)
    expect(screen.queryByText(/已选/)).not.toBeInTheDocument()
  })

  it('多选态 0 条也渲染：只剩提示、全选、禁用运行与退出', () => {
    enterSelection()
    render(<BatchBar deps={createFakeRemote({ applyOutcomes: vi.fn() })} />)
    expect(screen.queryByText(/已选 /)).not.toBeInTheDocument()
    expect(screen.getByText('点击会话行选择')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '移入回收站 0 条' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '全选' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '取消全选' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '查看已选' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '退出多选' }))
    expect(isSelecting()).toBe(false)
    expect(screen.queryByText('点击会话行选择')).not.toBeInTheDocument()
  })

  it('「全选」把可见行追加进名单：登记 effect 与全选的组合，切换口随即翻成「取消全选」', () => {
    enterSelection()
    fakeRow('s1')
    fakeRow('s2')
    // 不手动 registerHostRowInfo：标题与"可不可选"只能来自 BatchPickButton 的登记 effect。
    render(
      <>
        <BatchBar deps={createFakeRemote({ applyOutcomes: vi.fn() })} />
        <BatchPickButton sessionId="s1" title="A" />
        <BatchPickButton sessionId="s2" title="B" />
      </>,
    )

    fireEvent.click(screen.getByRole('button', { name: '全选' }))
    expect(getPicks()).toEqual([
      { sessionId: 's1', title: 'A' },
      { sessionId: 's2', title: 'B' },
    ])
    expect(screen.getByRole('button', { name: '取消全选' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '全选' })).not.toBeInTheDocument()

    // 同一个切换口反向：点「取消全选」只清名单、仍留在多选态
    fireEvent.click(screen.getByRole('button', { name: '取消全选' }))
    expect(getPicks()).toEqual([])
    expect(screen.getByRole('button', { name: '全选' })).toBeInTheDocument()
  })

  it('主行不再放汇总；条数与子会话数在「查看已选」列表头', async () => {
    const applyOutcomes = vi.fn(async (_action: string, ids: readonly string[]) =>
      countOutcomes(ids, { a: 2 }),
    )
    enterSelection()
    togglePick({ sessionId: 'a', title: 'A' })
    togglePick({ sessionId: 'b', title: 'B' })
    render(<BatchBar deps={createFakeRemote({ applyOutcomes })} />)
    expect(screen.getByRole('button', { name: '移入回收站 2 条' })).toBeInTheDocument()
    expect(screen.queryByText('已选 2 条')).not.toBeInTheDocument()
    expect(screen.queryByText(/跟着整组走/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '查看已选' }))
    expect(screen.getByText('已选 2 条')).toBeInTheDocument()
    expect(await screen.findByText('含 2 个子会话，跟着整组走')).toBeInTheDocument()
  })

  it('计数读不到就整句不说（不拿 0 冒充没有）', async () => {
    const applyOutcomes = vi.fn(async () => {
      throw Object.assign(new Error('读不到'), { code: 'sessiondelete/io' })
    })
    enterSelection()
    togglePick({ sessionId: 'a', title: 'A' })
    render(<BatchBar deps={createFakeRemote({ applyOutcomes })} />)
    fireEvent.click(screen.getByRole('button', { name: '查看已选' }))
    expect(screen.getByText('已选 1 条')).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(screen.queryByText(/子会话/)).not.toBeInTheDocument()
  })

  it('旧响应不落地：后发的勾选才是准的', async () => {
    const deferred: Array<(value: ApplyOutcome[]) => void> = []
    const applyOutcomes = vi.fn(
      (_action: string, _ids: readonly string[]) =>
        new Promise<ApplyOutcome[]>((resolve) => deferred.push(resolve)),
    )
    enterSelection()
    togglePick({ sessionId: 'a', title: 'A' })
    const view = render(<BatchBar deps={createFakeRemote({ applyOutcomes })} />)
    await waitFor(() => expect(applyOutcomes).toHaveBeenCalledTimes(1))
    togglePick({ sessionId: 'b', title: 'B' })
    await waitFor(() => expect(applyOutcomes).toHaveBeenCalledTimes(2))
    // 第二次的响应先回（a、b 都无子会话）……
    deferred[1](countOutcomes(['a', 'b']))
    await screen.findByRole('button', { name: '移入回收站 2 条' })
    fireEvent.click(screen.getByRole('button', { name: '查看已选' }))
    await screen.findByText('已选 2 条')
    // ……第一次的后回（a 带 2 个）——旧响应，不许把「含 2 个」盖回来
    deferred[0](countOutcomes(['a'], { a: 2 }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText(/子会话/)).not.toBeInTheDocument()
    view.unmount()
  })

  it('「查看已选」默认收起；展开后按勾选序列出标题，可逐条移除', async () => {
    const applyOutcomes = vi.fn(async (action: string, ids: readonly string[]) =>
      action === 'count' ? countOutcomes(ids, { a: 2 }) : [],
    )
    enterSelection()
    togglePick({ sessionId: 'a', title: 'A' })
    togglePick({ sessionId: 'b', title: 'B' })
    render(<BatchBar deps={createFakeRemote({ applyOutcomes })} />)

    expect(screen.queryByText('A')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看已选' }))
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
    // 有子会话数就标在它自己那行（与浮条的合计句各说各的）
    expect(await screen.findByText('含 2 个子会话')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '取消勾选「A」' }))
    expect(getPicks().map((p) => p.sessionId)).toEqual(['b'])
    expect(screen.queryByText('A')).not.toBeInTheDocument()
    expect(screen.getByText('已选 1 条')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '收起已选' }))
    expect(screen.queryByText('B')).not.toBeInTheDocument()
  })

  it('清单里移除最后一条：留在多选态，浮条显示 0 条', () => {
    enterSelection()
    togglePick({ sessionId: 'a', title: 'A' })
    render(<BatchBar deps={createFakeRemote({ applyOutcomes: vi.fn() })} />)
    fireEvent.click(screen.getByRole('button', { name: '查看已选' }))
    fireEvent.click(screen.getByRole('button', { name: '取消勾选「A」' }))
    expect(getPicks()).toEqual([])
    expect(screen.getByText('点击会话行选择')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '全选' })).toBeInTheDocument()
    expect(screen.queryByText(/已选 /)).not.toBeInTheDocument()
  })

  it('模式内点整行切换选中，并挡住行自己的 onClick（会话切换）', () => {
    enterSelection()
    const { applyOutcomes } = countOnly()
    render(
      <>
        <BatchBar deps={createFakeRemote({ applyOutcomes })} />
        <BatchPickButton sessionId="s1" title="A" />
      </>,
    )
    const { title, opened } = fakeRow('s1')

    fireEvent.click(title)
    expect(getPicks().map((p) => p.sessionId)).toEqual(['s1'])
    expect(opened()).toBe(0)

    fireEvent.click(title)
    expect(getPicks()).toEqual([])
    expect(opened()).toBe(0)
  })

  it('点「移入回收站 N 条」进确认框；取消后取消全选、退出多选', async () => {
    const { applyOutcomes } = countOnly()
    enterSelection()
    togglePick({ sessionId: 'a', title: 'A' })
    render(
      <>
        <BatchBar deps={createFakeRemote({ applyOutcomes })} />
        <BatchConfirmHost deps={createFakeRemote({ applyOutcomes })} />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: '移入回收站 1 条' }))
    expect(await screen.findByText('删除这个会话？')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByText('删除这个会话？')).not.toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '取消全选' }))
    expect(getPicks()).toEqual([])
    expect(screen.getByText('点击会话行选择')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '退出多选' }))
    expect(isSelecting()).toBe(false)
    expect(screen.queryByText('点击会话行选择')).not.toBeInTheDocument()
  })
})
