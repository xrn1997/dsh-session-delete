/**
 * 归档档面板控制器（`use-archive-panel-controller.ts`）：选中/详情、解除归档、删除座位、
 * 清单换版清场。失效链的另一半（删除/撤销座位只戳 trash 修订，归档查询订阅它）归
 * `write-seats.test.ts` 与 `use-archive-query.test.tsx` 的用例。
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useArchivePanelController } from '../../src/client/use-archive-panel-controller.js'
import { invalidateArchive, useArchiveRevision } from '../../src/client/archive-store.js'
import { useDeleteRequest } from '../../src/client/delete-confirm.js'
import { useDeleteBatchRequest } from '../../src/client/batch-confirm.js'
import { useUndoNotice } from '../../src/client/undo-notices.js'
import { useListSelection } from '../../src/client/use-list-selection.js'
import { groupByProject } from '../../src/client/trash-view.js'
import { zhTranslate } from '../../src/client/copy.js'
import type { BusyGate } from '../../src/client/busy-gate.js'
import type { ArchiveQuery } from '../../src/client/use-archive-query.js'
import type { ArchiveDetailLike, ApplyAction, ApplyOutcome, RemoteOutcome, SessionDeleteRemote } from '../../src/client/remote.js'
import type { ArchiveRowWire } from '../../src/shared/wire.js'
import { resetClientState } from '../../src/client/reset-client-state.js'
import { failed, ok } from './support/outcomes.js'

beforeEach(() => {
  resetClientState()
})

const row = (sessionId: string, over: Partial<ArchiveRowWire> = {}): ArchiveRowWire => ({
  sessionId, projectDir: '--p--', title: `${sessionId}-标题`, updatedAt: 1, updatedAtSource: 'prompt', subagent: false, ...over,
})

const detailOf = (sessionId: string, over: Partial<ArchiveDetailLike> = {}): ArchiveDetailLike => ({
  sessionId, archived: true, cwd: '', createdAt: 0, lastActivity: 0, logTitle: '', models: [],
  turnCount: 0, userMessageCount: 0, assistantMessageCount: 0, toolCallCount: 0,
  injectedCount: 0, blocks: [], olderCursor: null, ...over,
})

const gate = (): BusyGate => {
  const around = vi.fn(async <T,>(task: () => Promise<T>) => ({ kind: 'ran' as const, value: await task() })) as unknown as BusyGate['around']
  return { busy: false, around }
}

function mountController(
  initialRows: readonly ArchiveRowWire[],
  over: {
    detailFails?: string
    canAutoSelect?: boolean
    detailFor?: (sessionId: string) => ArchiveDetailLike | undefined
    applyFailIds?: readonly string[]
  } = {},
) {
  const archiveDetail = vi.fn(async (sessionId: string, _before?: number, _rootSessionId?: string): Promise<RemoteOutcome<ArchiveDetailLike>> =>
    (sessionId === over.detailFails
      ? { ok: false, failure: { code: 'sessiondelete/io', message: '读归档日志失败：帧坏了' } }
      : { ok: true, value: over.detailFor?.(sessionId) ?? detailOf(sessionId) }))
  const applyOutcomes = vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<RemoteOutcome<ApplyOutcome[]>> =>
    ({
      ok: true as const,
      value: ids.map((id) => (over.applyFailIds?.includes(id) === true
        ? failed(action, id, '解除归档失败')
        : ok('unarchive', id, 1))),
    }))
  const deps: Pick<SessionDeleteRemote, 'archiveDetail' | 'applyOutcomes'> = { archiveDetail, applyOutcomes }
  const view = renderHook(({ rows }: { rows: readonly ArchiveRowWire[] }) => {
    const groups = groupByProject(rows, zhTranslate, {
      timeOf: (r) => r.updatedAt ?? 0,
      projectDirOf: (r) => r.projectDir,
    })
    const selection = useListSelection({ rows, groups, idOf: (r) => r.sessionId })
    const query: ArchiveQuery = {
      list: { status: 'ready', rows, totalBytes: 0, missingSizeCount: 0 },
      refreshing: false,
      count: rows.length,
      reload: async () => {},
    }
    return useArchivePanelController({
      deps,
      gate: gate(),
      query,
      ordered: selection.ordered,
      canAutoSelect: over.canAutoSelect ?? false,
      t: zhTranslate,
    })
  }, { initialProps: { rows: initialRows } })
  return { ...view, archiveDetail, applyOutcomes }
}

describe('归档档控制器', () => {
  it('宽档自动选中：清单就绪后选第一条并读详情（与回收站同一条）', async () => {
    const m = mountController([row('session-a'), row('session-b')], { canAutoSelect: true })
    await waitFor(() => { expect(m.result.current.selected?.sessionId).toBe('session-a') })
    expect(m.archiveDetail).toHaveBeenCalledWith('session-a', undefined, undefined)
  })

  it('清单行首读不带根：选完 A 再选 B，B 的那一趟不许掺 A 做只读根（根判据认在不在清单）', async () => {
    // `pick` 与 `onPick` 同拍跑：若按「id 与选中不同」判根，那一刻的选中还停在 A，B 的首读就带上了旧根。
    const m = mountController([row('session-a'), row('session-b')])
    await act(async () => { await m.result.current.select(row('session-a')) })
    await act(async () => { await m.result.current.select(row('session-b')) })
    expect(m.archiveDetail).toHaveBeenLastCalledWith('session-b', undefined, undefined)
  })

  it('unarchive：逐 id 走 /apply，成功后 invalidateArchive（不发布撤销横幅）', async () => {
    const revision = renderHook(() => useArchiveRevision())
    const m = mountController([row('session-a')])
    await act(async () => { await m.result.current.unarchive(['session-a']) })
    expect(m.applyOutcomes).toHaveBeenCalledWith('unarchive', ['session-a'])
    expect(revision.result.current).toBe(1)
    // 解除归档没有撤销/回盘座位（landed: none）：横幅不出现。
    const notice = renderHook(() => useUndoNotice())
    expect(notice.result.current).toBeNull()
  })

  it('unarchive 部分失败：失败按行落，成功条照常落地并失效', async () => {
    const revision = renderHook(() => useArchiveRevision())
    const m = mountController([row('session-a'), row('session-b')], { applyFailIds: ['session-b'] })
    await act(async () => { await m.result.current.unarchive(['session-a', 'session-b']) })
    expect(m.result.current.actionFailure).toEqual({ 'session-b': '解除归档失败' })
    expect(revision.result.current).toBe(1)
  })

  it('归档修订变化 ⇒ 归档详情账本作废并重读当前主体（不拿旧快照冒充归档态）', async () => {
    const m = mountController([row('session-a')])
    await act(async () => { await m.result.current.select(row('session-a')) })
    await waitFor(() => { expect(m.result.current.detail.kind).toBe('ready') })
    expect(m.archiveDetail).toHaveBeenCalledTimes(1)

    act(() => { invalidateArchive() })
    await waitFor(() => { expect(m.archiveDetail).toHaveBeenCalledTimes(2) })
    expect(m.archiveDetail).toHaveBeenLastCalledWith('session-a', undefined, undefined)
  })

  it('孩子视图打开时归档修订变化 ⇒ 重读孩子（仍带已归档父根）', async () => {
    const m = mountController([row('session-a')], {
      detailFor: (sessionId) => sessionId === 'session-a'
        ? detailOf('session-a', {
            subagents: [{ sessionId: 'kid-1', archived: false, projectDir: '--p--', title: '孩子一' }],
          })
        : detailOf('kid-1', { archived: false }),
    })
    await act(async () => { await m.result.current.select(row('session-a')) })
    await waitFor(() => { expect(m.result.current.detail.kind).toBe('ready') })
    await act(async () => { await m.result.current.openChild('kid-1') })
    await waitFor(() => { expect(m.result.current.detail).toMatchObject({ kind: 'ready', subject: { sessionId: 'kid-1' } }) })

    act(() => { invalidateArchive() })
    await waitFor(() => {
      expect(m.archiveDetail).toHaveBeenLastCalledWith('kid-1', undefined, 'session-a')
    })
  })

  it('归档档删除：requestDelete/requestDeleteBatch 把显示名带给确认框（失效归座位用例）', () => {
    const m = mountController([row('session-a', { label: '子任务名' }), row('session-b')])
    act(() => { m.result.current.requestDeleteOne(row('session-a', { label: '子任务名' })) })
    const single = renderHook(() => useDeleteRequest())
    expect(single.result.current).toMatchObject({ sessionId: 'session-a', title: '子任务名' })

    act(() => { m.result.current.requestDeleteMany([{ sessionId: 'session-b', title: 'session-b-标题' }]) })
    const batch = renderHook(() => useDeleteBatchRequest())
    expect(batch.result.current?.items).toEqual([{ sessionId: 'session-b', title: 'session-b-标题' }])
  })

  it('清单重取后选中行消失 ⇒ 丢详情账本、清选中（再选要重新读）', async () => {
    const m = mountController([row('session-a')])
    await act(async () => { await m.result.current.select(row('session-a')) })
    expect(m.archiveDetail).toHaveBeenCalledTimes(1)
    expect(m.result.current.detail.kind).toBe('ready')

    // 清单换版把这行收走：清选中。
    m.rerender({ rows: [] })
    await act(async () => {})
    expect(m.result.current.selected).toBeNull()
    expect(m.result.current.detail.kind).toBe('idle')

    // 行回来了再选：账本已被丢弃 ⇒ 必须重新读（第 2 次）。
    m.rerender({ rows: [row('session-a')] })
    await act(async () => {})
    await act(async () => { await m.result.current.select(row('session-a')) })
    expect(m.archiveDetail).toHaveBeenCalledTimes(2)
  })

  it('详情读失败只坏该行详情，不冻结清单与动作', async () => {
    const m = mountController([row('session-a'), row('session-b')], { detailFails: 'session-b' })
    await act(async () => { await m.result.current.select(row('session-b')) })
    expect(m.result.current.detail).toMatchObject({ kind: 'failed', message: '读归档日志失败：帧坏了' })
    // 动作照跑：解除归档还能发出去。
    await act(async () => { await m.result.current.unarchive(['session-b']) })
    expect(m.applyOutcomes).toHaveBeenCalledWith('unarchive', ['session-b'])
  })

  it('未归档孩子：openChild 带父 id 做只读根；back 两程；父行消失即关', async () => {
    const m = mountController([row('session-a')], {
      detailFor: (sessionId) => sessionId === 'session-a'
        ? detailOf('session-a', {
            subagents: [{ sessionId: 'kid-1', archived: false, projectDir: '--p--', title: '孩子一' }],
          })
        : sessionId === 'kid-1' ? detailOf('kid-1', { archived: false }) : undefined,
    })
    await act(async () => { await m.result.current.select(row('session-a')) })
    await waitFor(() => { expect(m.result.current.detail.kind).toBe('ready') })

    await act(async () => { await m.result.current.openChild('kid-1') })
    expect(m.result.current.childView?.child.sessionId).toBe('kid-1')
    await waitFor(() => {
      expect(m.result.current.detail).toMatchObject({ kind: 'ready', subject: { sessionId: 'kid-1' } })
    })
    expect(m.archiveDetail).toHaveBeenLastCalledWith('kid-1', undefined, 'session-a')

    // 第一程返回父详情：选中不动；第二程才交还清单。
    act(() => { m.result.current.back() })
    expect(m.result.current.childView).toBeNull()
    expect(m.result.current.selected?.sessionId).toBe('session-a')
    expect(m.result.current.detail).toMatchObject({ kind: 'ready', subject: { sessionId: 'session-a' } })
    act(() => { m.result.current.back() })
    expect(m.result.current.selected).toBeNull()

    // 父行被清单收走（解除归档 / 删除）：孩子视图与账本一起清。
    await act(async () => { await m.result.current.select(row('session-a')) })
    await waitFor(() => { expect(m.result.current.detail.kind).toBe('ready') })
    await act(async () => { await m.result.current.openChild('kid-1') })
    m.rerender({ rows: [] })
    await act(async () => {})
    expect(m.result.current.childView).toBeNull()
    expect(m.result.current.selected).toBeNull()
  })

  it('宽档自动选中与父行消失同拍：孩子视图关掉、孩子账本一起丢（再开要重读）', async () => {
    const m = mountController([row('session-a'), row('session-b')], {
      canAutoSelect: true,
      detailFor: (sessionId) => sessionId === 'session-a'
        ? detailOf('session-a', {
            subagents: [{ sessionId: 'kid-1', archived: false, projectDir: '--p--', title: '孩子一' }],
          })
        : sessionId === 'kid-1' ? detailOf('kid-1', { archived: false }) : undefined,
    })
    await waitFor(() => { expect(m.result.current.selected?.sessionId).toBe('session-a') })
    await waitFor(() => { expect(m.result.current.detail.kind).toBe('ready') })
    await act(async () => { await m.result.current.openChild('kid-1') })
    expect(m.result.current.childView?.child.sessionId).toBe('kid-1')

    // 父行被清单收走，同一拍宽档自动选中 session-b：孩子视图不许留着（只读根已不在清单）。
    m.rerender({ rows: [row('session-b')] })
    await act(async () => {})
    expect(m.result.current.selected?.sessionId).toBe('session-b')
    expect(m.result.current.childView).toBeNull()

    // 父行回来再选再开孩子：账本已被丢 ⇒ 必须重读（第 2 次），不许拿旧账本冒充。
    m.rerender({ rows: [row('session-a'), row('session-b')] })
    await act(async () => {})
    await act(async () => { await m.result.current.select(row('session-a')) })
    await waitFor(() => { expect(m.result.current.detail.kind).toBe('ready') })
    await act(async () => { await m.result.current.openChild('kid-1') })
    const kidReads = m.archiveDetail.mock.calls.filter(([id]) => id === 'kid-1').length
    expect(kidReads).toBe(2)
  })
})
