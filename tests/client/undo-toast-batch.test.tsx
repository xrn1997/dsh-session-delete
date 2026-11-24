// 批量撤销横幅（2026-10-17）：「N 条会话已移入回收站 · 撤销」，撤销 = 一次批量 restore。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { afterDelete, bindMainView } from '../../src/client/main-view.js'
import type { RemoteOutcome } from '../../src/client/remote.js'
import type { ApplyOutcome, WriteProgressWire } from '../../src/shared/wire.js'
import { useTrashRevision } from '../../src/client/trash-store.js'
import { UndoToast } from '../../src/client/undo-toast.js'
import {
  dismissUndoNotice,
  publishUndoBatchNotice,
  publishUndoNotice,
  UNDO_HOLD_MS,
  useUndoFailure,
  useUndoNotice,
} from '../../src/client/undo-notices.js'
import { createFakeRemote, remoteFail, remoteOk } from './support/fake-remote.js'



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
    const applyOutcomes = vi.fn(async () => remoteFail({ code: 'sessiondelete/io', message: '原项目目录已不在' }))
    publishUndoBatchNotice({ entryIds: ['e1'], n: 1 })
    const view = renderHook(() => useUndoNotice())
    render(<UndoToast deps={createFakeRemote({ applyOutcomes })} />)
    expect(view.result.current?.seq).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(view.result.current?.seq).toBe(2))
    expect(view.result.current?.failure).toBe('原项目目录已不在')
  })

  // 横幅到点自动熄灭与撤销在飞是两件事：先熄灭再失败，失败原文就没有落点了（只有面板 invalidate），
  // 直接违反「失败不吞」。在飞期间 timer 与淡出都暂停。
  it('撤销在飞时横幅到点也不熄灭：慢失败原文仍能上屏', async () => {
    vi.useFakeTimers()
    try {
      let failApply!: (value: RemoteOutcome<ApplyOutcome[]>) => void
      const applyOutcomes = vi.fn(() => new Promise<RemoteOutcome<ApplyOutcome[]>>((resolve) => {
        failApply = resolve
      }))
      publishUndoBatchNotice({ entryIds: ['e1'], n: 1 })
      const view = renderHook(() => useUndoNotice())
      render(<UndoToast deps={createFakeRemote({ applyOutcomes })} />)
      fireEvent.click(screen.getByRole('button', { name: '撤销' }))

      act(() => { vi.advanceTimersByTime(7000) })
      expect(view.result.current).not.toBeNull()

      await act(async () => {
        failApply(remoteFail({ code: 'sessiondelete/io', message: '原项目目录已不在' }))
      })
      expect(view.result.current?.failure).toBe('原项目目录已不在')
    } finally {
      vi.useRealTimers()
    }
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
    let failApply!: (value: RemoteOutcome<ApplyOutcome[]>) => void
    const applyOutcomes = vi.fn(() => new Promise<RemoteOutcome<ApplyOutcome[]>>((resolve) => {
      failApply = resolve
    }))
    publishUndoNotice({ entryId: 'e1', title: 'T' })
    const view = renderHook(() => useUndoNotice())
    render(<UndoToast deps={createFakeRemote({ applyOutcomes })} />)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))

    act(() => { dismissUndoNotice(['e1']) })
    expect(view.result.current).toBeNull()

    await act(async () => {
      failApply(remoteFail({ code: 'sessiondelete/trash-empty', message: '回收站里没有这一条' }))
    })
    expect(view.result.current).toBeNull()
  })

  it('撤销在飞时来了新删除：旧撤销成功不清掉新横幅', async () => {
    let resolveApply!: (value: RemoteOutcome<ApplyOutcome[]>) => void
    const applyOutcomes = vi.fn(() => new Promise<RemoteOutcome<ApplyOutcome[]>>((resolve) => {
      resolveApply = resolve
    }))
    publishUndoNotice({ entryId: 'e1', title: 'T' })
    const view = renderHook(() => useUndoNotice())
    render(<UndoToast deps={createFakeRemote({ applyOutcomes })} />)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))

    act(() => { publishUndoNotice({ entryId: 'e2', title: 'U' }) })
    await act(async () => { resolveApply(remoteOk(restoreOutcomes(['e1']))) })

    expect(view.result.current).toMatchObject({ kind: 'one', entryId: 'e2' })
  })
})

describe('撤销失败不静默（横幅先走一步）', () => {
  // 撤销在飞时横幅可能先没了：面板里恢复 / 彻底删除某条会熄灭指向它的横幅，新删除会覆盖它。
  // 那一刻失败再 `failNotice` 已经没有落点——旧实现直接 return，失败被吞。现在留一条待显示。
  it('横幅在飞期间被熄灭：失败另起一条待显示，到时自动清掉', async () => {
    vi.useFakeTimers()
    try {
      let failApply!: (value: RemoteOutcome<ApplyOutcome[]>) => void
      const applyOutcomes = vi.fn(() => new Promise<RemoteOutcome<ApplyOutcome[]>>((resolve) => {
        failApply = resolve
      }))
      publishUndoNotice({ entryId: 'e1', title: 'T' })
      const failureView = renderHook(() => useUndoFailure())
      render(<UndoToast deps={createFakeRemote({ applyOutcomes })} />)
      fireEvent.click(screen.getByRole('button', { name: '撤销' }))

      // 面板把这条恢复了 ⇒ 横幅熄灭（整条清掉），撤销那一趟还在飞。
      act(() => { dismissUndoNotice(['e1']) })
      expect(failureView.result.current).toBeNull()

      await act(async () => {
        failApply(remoteFail({ code: 'sessiondelete/trash-empty', message: '回收站里没有这一条' }))
      })
      // 横幅没了，失败原文仍要上屏（另起一条待显示），且只等停留时长就清掉。
      expect(screen.getByText('回收站里没有这一条')).toBeInTheDocument()
      expect(failureView.result.current?.failure).toBe('回收站里没有这一条')

      act(() => { vi.advanceTimersByTime(UNDO_HOLD_MS + 1100) })
      expect(failureView.result.current).toBeNull()
      expect(screen.queryByText('回收站里没有这一条')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('当前有横幅时不抢戏：待显示失败让位给横幅；横幅收掉后再顶上', async () => {
    let failApply!: (value: RemoteOutcome<ApplyOutcome[]>) => void
    const applyOutcomes = vi.fn(() => new Promise<RemoteOutcome<ApplyOutcome[]>>((resolve) => {
      failApply = resolve
    }))
    publishUndoNotice({ entryId: 'e1', title: 'T' })
    render(<UndoToast deps={createFakeRemote({ applyOutcomes })} />)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))

    // 在飞期间来了新删除：新横幅覆盖现场；旧撤销随后失败 ⇒ 落待显示队，不盖新横幅。
    act(() => { publishUndoNotice({ entryId: 'e2', title: 'U' }) })
    await act(async () => {
      failApply(remoteFail({ code: 'sessiondelete/io', message: '旧撤销失败的原因' }))
    })
    expect(screen.queryByText('旧撤销失败的原因')).not.toBeInTheDocument()
    expect(screen.getByText(/U 已移入回收站/)).toBeInTheDocument()

    // 新横幅收掉后，旧失败顶上（它是用户仍该知道的结论）。
    act(() => { dismissUndoNotice(['e2']) })
    expect(await screen.findByText('旧撤销失败的原因')).toBeInTheDocument()
  })
})

describe('批量撤销横幅', () => {
  it('报条数、撤销只发一次批量 restore', async () => {
    const applyOutcomes = vi.fn(async (_action: string, ids: readonly string[]) => remoteOk(restoreOutcomes(ids)))
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
    const applyOutcomes = vi.fn(async () => remoteFail({ code: 'sessiondelete/io', message: '原项目目录已不在' }))
    publishUndoBatchNotice({ entryIds: ['e1'], n: 1 })
    render(<UndoToast deps={createFakeRemote({ applyOutcomes })} />)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(await screen.findByText(/原项目目录已不在/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument()
  })

  it('批量撤销：信封成功但逐条全失败 ⇒ 横幅换成失败原文，不假装撤销成功', async () => {
    const applyOutcomes = vi.fn(async () => remoteOk([
      { id: 'e1', action: 'restore' as const, ok: false as const, error: { code: 'sessiondelete/project-missing', message: '项目目录不在' } },
    ]))
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
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk([
      { id: 'e1', action: 'restore', ok: true, value: restored },
      {
        id: 'e2',
        action: 'restore',
        ok: false,
        error: { code: 'sessiondelete/project-missing', message: '项目目录不在' },
      },
    ]))
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
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk([
      {
        id: 'session-a',
        action: 'restore',
        ok: false,
        error: { code: 'sessiondelete/project-missing', message: '项目目录不在' },
      },
    ]))
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
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk([
      { id: 'e1', action: 'restore', ok: true, value: restored },
      {
        id: 'e2',
        action: 'restore',
        ok: false,
        error: { code: 'sessiondelete/project-missing', message: '项目目录不在' },
      },
    ]))
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

  it('批量撤销多条逐条失败：横幅说清失败条数与各条原因（去重），不许只显第一条', async () => {
    // issue #8 第 5 条：`failures.values().next().value` 把多条不同原因折成一句，条数与其余原因全没了。
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk([
      { id: 'e1', action: 'restore', ok: false, error: { code: 'sessiondelete/live', message: '会话正在运行' } },
      { id: 'e2', action: 'restore', ok: false, error: { code: 'sessiondelete/project-missing', message: '项目目录不在' } },
      { id: 'e3', action: 'restore', ok: false, error: { code: 'sessiondelete/live', message: '会话正在运行' } },
    ]))
    publishUndoBatchNotice({ entryIds: ['e1', 'e2', 'e3'], n: 3 })
    render(<UndoToast deps={createFakeRemote({ applyOutcomes })} />)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    // 三条失败、两种原因：条数 3、两条原因都在、同一原因去重只出一次。
    await waitFor(() => expect(screen.getByText('3 条会话未能撤销：会话正在运行 · 项目目录不在')).toBeInTheDocument())
  })

  it('撤销在飞时来了新删除：新横幅的撤销不被旧那一趟按灰（闸按通知隔离）', async () => {
    let resolveOld!: (value: RemoteOutcome<ApplyOutcome[]>) => void
    const applyOutcomes = vi.fn((_action: string, ids: readonly string[]) => {
      if (ids[0] === 'e1') return new Promise<RemoteOutcome<ApplyOutcome[]>>((resolve) => { resolveOld = resolve })
      return Promise.resolve(remoteOk(restoreOutcomes(ids)))
    })
    publishUndoNotice({ entryId: 'e1', title: 'T' })
    render(<UndoToast deps={createFakeRemote({ applyOutcomes })} />)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(screen.getByRole('button', { name: '撤销' })).toBeDisabled()

    // 旧撤销还在飞：新删除发布新横幅（seq 递增 ⇒ 重挂载、另一枚闸）。
    act(() => { publishUndoNotice({ entryId: 'e2', title: 'U' }) })
    const fresh = screen.getByRole('button', { name: '撤销' })
    expect(fresh).not.toBeDisabled()
    fireEvent.click(fresh)
    await waitFor(() => expect(applyOutcomes).toHaveBeenCalledTimes(2))
    expect(applyOutcomes).toHaveBeenLastCalledWith('restore', ['e2'])
    await act(async () => { resolveOld(remoteOk(restoreOutcomes(['e1']))) })
  })

  it('撤销在飞时连点只发一条 /apply，按钮在飞期间禁用（issue #8 第 8 条）', async () => {
    let resolveApply!: (value: RemoteOutcome<ApplyOutcome[]>) => void
    const applyOutcomes = vi.fn(() => new Promise<RemoteOutcome<ApplyOutcome[]>>((resolve) => { resolveApply = resolve }))
    publishUndoNotice({ entryId: 'e1', title: 'T' })
    render(<UndoToast deps={createFakeRemote({ applyOutcomes })} />)
    const button = screen.getByRole('button', { name: '撤销' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(applyOutcomes).toHaveBeenCalledTimes(1)
    expect(button).toBeDisabled()
    await act(async () => { resolveApply(remoteOk(restoreOutcomes(['e1']))) })
    await waitFor(() => expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument())
  })
})

describe('撤销横幅 · archived 句', () => {
  it('已归档会话删除后撤销回到「归档」：横幅追加 archived 句，不提会话列表', () => {
    publishUndoNotice({ entryId: 'e1', title: '标题', archived: true })
    render(<UndoToast deps={createFakeRemote()} />)
    // 单条形的主语就是那一条：整句直说「撤销后回到『归档』」，不用「其中」。
    expect(screen.getByText(/撤销后回到「归档」/)).toBeInTheDocument()
    expect(screen.queryByText(/会话列表/)).not.toBeInTheDocument()
  })

  it('批量删除含已归档会话：批量句保留「其中已归档的」', () => {
    publishUndoBatchNotice({ entryIds: ['e1', 'e2'], n: 2, archived: true })
    render(<UndoToast deps={createFakeRemote()} />)
    expect(screen.getByText(/2 条会话已移入回收站；其中已归档的，撤销后回到「归档」/)).toBeInTheDocument()
  })

  it('非归档删除不带这句', () => {
    publishUndoNotice({ entryId: 'e1', title: '标题' })
    render(<UndoToast deps={createFakeRemote()} />)
    expect(screen.queryByText(/撤销后回到「归档」/)).not.toBeInTheDocument()
  })
})

// 无框恢复也要看得见进度（`docs/ui-spec.md` §2）：进度行进横幅副行，认领不上只说排队中。
describe('撤销横幅 · 撤销在飞的进度行', () => {
  it('撤销在飞时横幅出进度行且排在「撤销」按钮之后（不把按钮挤到第三行）', async () => {
    let release!: (value: RemoteOutcome<ApplyOutcome[]>) => void
    const applyOutcomes = vi.fn(() => new Promise<RemoteOutcome<ApplyOutcome[]>>((resolve) => { release = resolve }))
    const progress = vi.fn(async (): Promise<RemoteOutcome<WriteProgressWire>> => remoteOk({
      status: 'running', action: 'restore', ids: ['e1'], done: 0, total: 1, step: 'moving', startedAt: Date.now(),
    }))
    publishUndoNotice({ entryId: 'e1', title: '标题' })
    render(<UndoToast deps={createFakeRemote({ applyOutcomes, progress })} />)
    const button = screen.getByRole('button', { name: '撤销' })
    fireEvent.click(button)
    const line = await screen.findByText(/正在恢复 0\/1 · 移动中/)
    expect(line).toBeInTheDocument()
    expect(button.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 秒数在单独的 `aria-hidden` 节点里（不逐秒播报）：整行文本被拆成两段，分开断言。
    expect(screen.getByText(/已用 \d+ 秒/)).toBeInTheDocument()
    release(remoteOk(restoreOutcomes(['e1'])))
    await waitFor(() => expect(screen.queryByText(/正在恢复/)).not.toBeInTheDocument())
  })

  it('认领不上出「排队中」：另一趟写在飞时横幅不冒领它的 k/N', async () => {
    let release!: (value: RemoteOutcome<ApplyOutcome[]>) => void
    const applyOutcomes = vi.fn(() => new Promise<RemoteOutcome<ApplyOutcome[]>>((resolve) => { release = resolve }))
    const progress = vi.fn(async (): Promise<RemoteOutcome<WriteProgressWire>> => remoteOk({
      status: 'running', action: 'delete', ids: ['zzz'], done: 3, total: 9, step: 'deleting', startedAt: Date.now(),
    }))
    publishUndoNotice({ entryId: 'e1', title: '标题' })
    render(<UndoToast deps={createFakeRemote({ applyOutcomes, progress })} />)
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(await screen.findByText('排队中：另一写入进行中…')).toBeInTheDocument()
    // 别人的 k/N 一个字都不许上屏。
    expect(screen.queryByText(/3\/9/)).not.toBeInTheDocument()
    release(remoteOk(restoreOutcomes(['e1'])))
    await waitFor(() => expect(screen.queryByText(/排队中/)).not.toBeInTheDocument())
  })
})
