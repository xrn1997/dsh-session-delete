// 批量撤销横幅（2026-10-17）：「N 条会话已移入回收站 · 撤销」，撤销 = 一次批量 restore。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { afterDelete, bindMainView, resetMainView } from '../../src/client/main-view.js'
import type { ApplyOutcome } from '../../src/client/remote.js'
import { resetTrashStore, useTrashRevision } from '../../src/client/trash-store.js'
import { UndoToast } from '../../src/client/undo-toast.js'
import {
  dismissUndoNotice,
  publishUndoBatchNotice,
  publishUndoNotice,
  resetUndoNotice,
  useUndoNotice,
} from '../../src/client/undo-notices.js'
import { createFakeRemote } from './support/fake-remote.js'

beforeEach(() => {
  resetUndoNotice()
  resetTrashStore()
  resetMainView()
})

afterEach(() => {
  resetUndoNotice()
  resetMainView()
})

function restoreOutcomes(ids: readonly string[]): ApplyOutcome[] {
  return ids.map(
    (id) => ({ id, action: 'restore', ok: true, value: { id: `entry-${id}` } }) as ApplyOutcome,
  )
}

describe('通知台的 module 边界', () => {
  it('现场与发布住在 undo-notices，Toast 组件不在那里', async () => {
    const notices = await import('../../src/client/undo-notices.js')
    expect(typeof notices.publishUndoNotice).toBe('function')
    expect('UndoToast' in notices).toBe(false)
  })

  it('write-seats 与 use-trash-query 只依赖通知台，通知台不反向依赖 Toast 组件（ADR-0018 的环不再存在）', () => {
    // jsdom 下的 `import.meta.url` 不是 file:，按仓库根拼路径（Vitest 的 cwd 是仓库根）。
    const writeSeats = readFileSync(join(process.cwd(), 'src/client/write-seats.ts'), 'utf8')
    const notices = readFileSync(join(process.cwd(), 'src/client/undo-notices.ts'), 'utf8')
    // 两个数据 module 都曾从 `undo-toast.tsx` 取熄灭 / 发布入口；只扫其中一个会漏掉另一个的回归。
    const trashQuery = readFileSync(join(process.cwd(), 'src/client/use-trash-query.ts'), 'utf8')
    expect(writeSeats).not.toMatch(/from '\.\/undo-toast\.js'/)
    expect(notices).not.toMatch(/from '\.\/undo-toast\.js'/)
    expect(trashQuery).not.toMatch(/from '\.\/undo-toast\.js'/)
    // 通知台是无 JSX 的数据 module：不 import React，也不把现场交给组件层。
    expect(notices).not.toMatch(/from 'react'/)
  })
})

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
    render(<UndoToast deps={createFakeRemote({ applyOutcomes })} />)
    expect(view.result.current?.seq).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(view.result.current?.seq).toBe(2))
    expect(view.result.current?.failure).toBe('原项目目录已不在')
  })
})

describe('按条目熄灭撤销横幅', () => {
  it('单条命中就清；未命中保留', () => {
    const { result } = renderHook(() => useUndoNotice())
    act(() => { publishUndoNotice({ entryId: 'e1', title: 'T' }) })
    act(() => { dismissUndoNotice(['other']) })
    expect(result.current?.seq).toBe(1)
    act(() => { dismissUndoNotice(['e1']) })
    expect(result.current).toBeNull()
  })

  it('批量里任一命中就清整条：不留下计数已变的假动作', () => {
    const { result } = renderHook(() => useUndoNotice())
    act(() => { publishUndoBatchNotice({ entryIds: ['e1', 'e2'], n: 2 }) })
    act(() => { dismissUndoNotice(['e2']) })
    expect(result.current).toBeNull()
  })

  it('撤销在飞时条目已在别处恢复：旧撤销失败不把熄灭的横幅翻回来', async () => {
    let rejectApply!: (reason: unknown) => void
    const applyOutcomes = vi.fn(() => new Promise<ApplyOutcome[]>((_resolve, reject) => {
      rejectApply = reject
    }))
    publishUndoNotice({ entryId: 'e1', title: 'T' })
    const view = renderHook(() => useUndoNotice())
    render(<UndoToast deps={createFakeRemote({ applyOutcomes })} />)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))

    act(() => { dismissUndoNotice(['e1']) })
    expect(view.result.current).toBeNull()

    await act(async () => {
      rejectApply(Object.assign(new Error('回收站里没有这一条'), { code: 'sessiondelete/trash-empty' }))
    })
    expect(view.result.current).toBeNull()
  })

  it('撤销在飞时来了新删除：旧撤销成功不清掉新横幅', async () => {
    let resolveApply!: (value: ApplyOutcome[]) => void
    const applyOutcomes = vi.fn(() => new Promise<ApplyOutcome[]>((resolve) => {
      resolveApply = resolve
    }))
    publishUndoNotice({ entryId: 'e1', title: 'T' })
    const view = renderHook(() => useUndoNotice())
    render(<UndoToast deps={createFakeRemote({ applyOutcomes })} />)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))

    act(() => { publishUndoNotice({ entryId: 'e2', title: 'U' }) })
    await act(async () => { resolveApply(restoreOutcomes(['e1'])) })

    expect(view.result.current).toMatchObject({ kind: 'one', entryId: 'e2' })
  })
})

describe('批量撤销横幅', () => {
  it('报条数、撤销只发一次批量 restore', async () => {
    const applyOutcomes = vi.fn(async (_action: string, ids: readonly string[]) => restoreOutcomes(ids))
    const restore = vi.fn(async () => ({}))
    publishUndoBatchNotice({ entryIds: ['e1', 'e2'], n: 2 })
    render(<UndoToast deps={createFakeRemote({ applyOutcomes })} />)
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
    render(<UndoToast deps={createFakeRemote({ applyOutcomes })} />)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(await screen.findByText(/原项目目录已不在/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument()
  })

  it('批量撤销：信封成功但逐条全失败 ⇒ 横幅换成失败原文，不假装撤销成功', async () => {
    const applyOutcomes = vi.fn(async () => [
      { id: 'e1', action: 'restore' as const, ok: false as const, error: { code: 'sessiondelete/project-missing', message: '项目目录不在' } },
    ])
    publishUndoBatchNotice({ entryIds: ['e1'], n: 1 })
    const view = renderHook(() => useUndoNotice())
    render(<UndoToast deps={createFakeRemote({ applyOutcomes })} />)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(view.result.current?.failure).toBe('项目目录不在'))
    expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument()
  })

  it('批量撤销部分成功：横幅报失败原文，回收站面板照样收到失效通告', async () => {
    // 成功支给一行完整的线上条目（`TrashEntryWire`），失败支给 verb 码原文。
    const restored = {
      id: 'e1',
      sessionId: 'session-e1',
      projectDir: '--p--',
      workspaceId: 'ws',
      wasArchived: false,
      deletedAt: 1,
      title: '会话一',
      sizeBytes: 1,
    }
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [
      { id: 'e1', action: 'restore', ok: true, value: restored },
      {
        id: 'e2',
        action: 'restore',
        ok: false,
        error: { code: 'sessiondelete/project-missing', message: '项目目录不在' },
      },
    ])
    publishUndoBatchNotice({ entryIds: ['e1', 'e2'], n: 2 })
    const notice = renderHook(() => useUndoNotice())
    const revision = renderHook(() => useTrashRevision())
    render(<UndoToast deps={createFakeRemote({ applyOutcomes })} />)
    expect(revision.result.current).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(await screen.findByText('项目目录不在')).toBeInTheDocument()
    expect(notice.result.current?.failure).toBe('项目目录不在')
    // e1 已经回盘：正开着的清单面板必须重读，不能因为 e2 失败就继续列着已恢复的行。
    await waitFor(() => expect(revision.result.current).toBe(1))
  })

  it('批量撤销逐条全失败：横幅报失败原文，被关掉的会话一条都不重开', async () => {
    // 回执里的 id 与被关掉的会话同串：这条钉的是「失败名单绝不能被当成会话名单传下去」，
    // 两个 id 不同名时 afterRestore 本来就会过滤掉它，断言会空转。
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [
      {
        id: 'session-a',
        action: 'restore',
        ok: false,
        error: { code: 'sessiondelete/project-missing', message: '项目目录不在' },
      },
    ])
    let selected: { sessionId?: string } = { sessionId: 'session-a' }
    const openSession = vi.fn()
    const uiWorkspace = {
      selection: { getSnapshot: () => selected },
      sessions: { list: { getSnapshot: () => ({ byId: { 'session-a': {} } }) } },
      clearMain: () => { selected = {} },
      openSession,
    }
    bindMainView({
      slots: {} as never,
      get: (name: string) => (name === 'uiWorkspace' ? uiWorkspace : undefined),
    } as never)
    // 删除时关掉当前视图（main-view 由此记住 session-a）：全失败的撤销不许把它重开。
    afterDelete(['session-a'])
    publishUndoBatchNotice({ entryIds: ['session-a'], n: 1 })
    const revision = renderHook(() => useTrashRevision())
    render(<UndoToast deps={createFakeRemote({ applyOutcomes })} />)
    expect(revision.result.current).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(await screen.findByText('项目目录不在')).toBeInTheDocument()
    expect(openSession).not.toHaveBeenCalled()
    // 全失败也发失效通告：回滚失败可能留下半套，清单不能继续摆旧行。
    await waitFor(() => expect(revision.result.current).toBe(1))
  })

  it('批量撤销部分失败：成功回盘的那条仍会被重开（main-view 只认自己关过的会话）', async () => {
    const restored = {
      id: 'e1',
      sessionId: 'session-a',
      projectDir: '--p--',
      workspaceId: 'ws',
      wasArchived: false,
      deletedAt: 1,
      title: '会话一',
      sizeBytes: 1,
    }
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [
      { id: 'e1', action: 'restore', ok: true, value: restored },
      {
        id: 'e2',
        action: 'restore',
        ok: false,
        error: { code: 'sessiondelete/project-missing', message: '项目目录不在' },
      },
    ])
    let selected: { sessionId?: string } = { sessionId: 'session-a' }
    const openSession = vi.fn()
    const uiWorkspace = {
      selection: { getSnapshot: () => selected },
      sessions: { list: { getSnapshot: () => ({ byId: { 'session-a': {} } }) } },
      clearMain: () => { selected = {} },
      openSession,
    }
    bindMainView({
      slots: {} as never,
      get: (name: string) => (name === 'uiWorkspace' ? uiWorkspace : undefined),
    } as never)
    // 删除时关掉当前视图（main-view 由此记住 session-a）。
    afterDelete(['session-a'])
    publishUndoBatchNotice({ entryIds: ['e1', 'e2'], n: 2 })
    render(<UndoToast deps={createFakeRemote({ applyOutcomes })} />)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(await screen.findByText('项目目录不在')).toBeInTheDocument()
    // e2 失败不许连坐 e1 的重开：横幅报原文、主视图照样回到 e1。
    await waitFor(() => expect(openSession).toHaveBeenCalledWith('session-a'))
  })
})
