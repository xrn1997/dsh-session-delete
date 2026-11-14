/**
 * 归档档面板控制器（`use-archive-panel-controller.ts`）：选中/详情、解除归档、删除座位、
 * 清单换版清场，以及从面板搬回来的接线（活动行 / 下钻包装 / 孩子分派 / `detailNav`）与
 * 保持期的两支守卫。失效链的另一半（删除/撤销座位只戳 trash 修订，归档查询订阅它）归
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
import type { ApplyAction, ApplyOutcome } from '../../src/shared/wire.js'
import type { ArchiveDetailLike, RemoteOutcome, SessionDeleteRemote } from '../../src/client/remote.js'
import type { ArchiveRowWire } from '../../src/shared/wire.js'
import { resetClientState } from '../../src/client/reset-client-state.js'
import { remoteOk } from './support/fake-remote.js'
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

/** 一段可以手动决定何时落地的 detail 读数（保持期那两支守卫要的就是"悬着"）。 */
function deferOutcome<T>(): { promise: Promise<RemoteOutcome<T>>; resolve: (value: RemoteOutcome<T>) => void } {
  let resolve!: (value: RemoteOutcome<T>) => void
  const promise = new Promise<RemoteOutcome<T>>((inResolve) => { resolve = inResolve })
  return { promise, resolve }
}

function mountController(
  initialRows: readonly ArchiveRowWire[],
  over: {
    detailFails?: string
    /** 档位是否活动（读生命周期的门）；缺省 true = 面板正看着归档档。 */
    active?: boolean
    /** 分栏态（原住在面板的 `archiveSplit`）：`selectRow` 的「drill 或分栏才 select」要它。 */
    split?: boolean
    detailFor?: (sessionId: string) => ArchiveDetailLike | undefined
    /** 整段接管详情读（用来造「在飞」与风暴计数）。 */
    detailImpl?: (sessionId: string) => Promise<RemoteOutcome<ArchiveDetailLike>>
    /** 点名的主体把这一趟读数挂住（不落地），用来造保持期。 */
    detailDelay?: (sessionId: string) => Promise<RemoteOutcome<ArchiveDetailLike>> | undefined
    applyFailIds?: readonly string[]
  } = {},
) {
  const archiveDetail = vi.fn(async (sessionId: string, _before?: number, _rootSessionId?: string): Promise<RemoteOutcome<ArchiveDetailLike>> => {
    if (sessionId === over.detailFails) {
      return { ok: false, failure: { code: 'sessiondelete/io', message: '读归档日志失败：帧坏了' } }
    }
    if (over.detailImpl !== undefined) return over.detailImpl(sessionId)
    const delayed = over.detailDelay?.(sessionId)
    if (delayed !== undefined) return delayed
    return { ok: true, value: over.detailFor?.(sessionId) ?? detailOf(sessionId) }
  })
  const applyOutcomes = vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<RemoteOutcome<ApplyOutcome[]>> =>
    ({
      ok: true as const,
      value: ids.map((id) => (over.applyFailIds?.includes(id) === true
        ? failed(action, id, '解除归档失败')
        : ok('unarchive', id, 1))),
    }))
  const deps: Pick<SessionDeleteRemote, 'archiveDetail' | 'applyOutcomes'> = { archiveDetail, applyOutcomes }
  const view = renderHook(({ rows, active }: { rows: readonly ArchiveRowWire[]; active?: boolean }) => {
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
      active: active ?? over.active ?? true,
      split: over.split ?? false,
      t: zhTranslate,
    })
  }, { initialProps: { rows: initialRows, active: over.active ?? true } })
  const rerender = (next: { rows: readonly ArchiveRowWire[]; active?: boolean }): void => {
    view.rerender({ rows: next.rows, active: next.active ?? over.active ?? true })
  }
  return { ...view, rerender, archiveDetail, applyOutcomes }
}

describe('归档档控制器', () => {
  it('宽档自动选中：清单就绪后选第一条并读详情（与回收站同一条）', async () => {
    const m = mountController([row('session-a'), row('session-b')], { split: true })
    await waitFor(() => { expect(m.result.current.selected?.sessionId).toBe('session-a') })
    expect(m.archiveDetail).toHaveBeenCalledWith('session-a', undefined, undefined)
  })


  it('归档档不活动时归档修订不读详情；切回活动恰好一次', async () => {
    const m = mountController([row('session-a')], { split: true })
    await waitFor(() => { expect(m.result.current.selected?.sessionId).toBe('session-a') })
    expect(m.archiveDetail).toHaveBeenCalledTimes(1)

    m.rerender({ rows: [row('session-a')], active: false })
    act(() => { invalidateArchive() })
    await act(async () => { await Promise.resolve() })
    expect(m.archiveDetail).toHaveBeenCalledTimes(1)

    m.rerender({ rows: [row('session-a')], active: true })
    await waitFor(() => { expect(m.archiveDetail).toHaveBeenCalledTimes(2) })
    expect(m.archiveDetail).toHaveBeenLastCalledWith('session-a', undefined, undefined)
    // 合并窗过去也不许再补一条：切回只补那一次。
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)) })
    expect(m.archiveDetail).toHaveBeenCalledTimes(2)
  })


  it('归档修订跨 tick 风暴：窗口合并 + 单飞，兜底读不抢跑，结算后恰好一轮追补', async () => {
    const queued: Array<() => void> = []
    const calls: string[] = []
    const m = mountController([row('session-a')], {
      split: true,
      detailImpl: (sessionId) => {
        calls.push(sessionId)
        if (calls.length === 1) return Promise.resolve({ ok: true, value: detailOf(sessionId) })
        return new Promise((resolve) => { queued.push(() => resolve({ ok: true, value: detailOf(sessionId) })) })
      },
    })
    await waitFor(() => { expect(m.result.current.selected?.sessionId).toBe('session-a') })
    await waitFor(() => { expect(m.result.current.detail.kind).toBe('ready') })
    expect(calls.length).toBe(1)

    // 窗口未到：不立即读（读由合并窗到点后的 refresh 发起，兜底 effect 不抢跑）。
    act(() => { invalidateArchive() })
    await act(async () => { await Promise.resolve() })
    expect(calls.length).toBe(1)

    act(() => { invalidateArchive() })
    await waitFor(() => { expect(calls.length).toBe(2) })
    // 在飞期间再来两次修订：不许并发第三条（单飞）。
    act(() => { invalidateArchive() })
    act(() => { invalidateArchive() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 140)) })
    expect(calls.length).toBe(2)

    // 结算后追补恰好一轮。
    queued[0]?.()
    await waitFor(() => { expect(calls.length).toBe(3) })
    queued[1]?.()
    await act(async () => { await Promise.resolve() })
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
      split: true,
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

// 下面这一组钉的是**从面板搬回控制器的接线**（原住 `trash-panel.tsx` 的光标 / 下钻包装 /
// 活动行 / 孩子分派 / `detailNav` 装配）与「保持期拒绝导航/跳转」的两支守卫（Review Focus 3）。
describe('归档档控制器 · 接线与保持守卫', () => {
  it('selectRow：窄档方向键只移光标——activeId 落光标行，不选中也不读详情', async () => {
    const m = mountController([row('session-a'), row('session-b')])
    await act(async () => { await m.result.current.selectRow(row('session-b')) })
    expect(m.result.current.selected).toBeNull()
    expect(m.result.current.activeId).toBe('session-b')
    expect(m.archiveDetail).not.toHaveBeenCalled()
  })

  it('selectRow：分栏时方向键也真正选中并读详情（drill 或分栏才 select）', async () => {
    const m = mountController([row('session-a'), row('session-b')], { split: true })
    await act(async () => { await m.result.current.selectRow(row('session-b')) })
    expect(m.result.current.selected?.sessionId).toBe('session-b')
    expect(m.result.current.activeId).toBe('session-b')
    expect(m.archiveDetail).toHaveBeenCalledWith('session-b', undefined, undefined)
  })

  it('selectRow：窄档 drill（Enter/Space 那一下）选中并读详情', async () => {
    const m = mountController([row('session-a'), row('session-b')])
    await act(async () => { await m.result.current.selectRow(row('session-b'), { drill: true }) })
    expect(m.result.current.selected?.sessionId).toBe('session-b')
    expect(m.archiveDetail).toHaveBeenCalledWith('session-b', undefined, undefined)
  })

  it('activeId：选中优先于光标；选中让位且光标行被清单收走后落空', async () => {
    const m = mountController([row('session-a'), row('session-b')])
    await act(async () => { await m.result.current.select(row('session-a')) })
    await waitFor(() => { expect(m.result.current.detail.kind).toBe('ready') })
    // 窄档方向键只移光标：选中还在 A ⇒ activeId 仍说「详情正画着 A」。
    await act(async () => { await m.result.current.selectRow(row('session-b')) })
    expect(m.result.current.activeId).toBe('session-a')
    // 选中让位（窄档返回）⇒ 光标行接上；光标那行再被清单收走 ⇒ 落空（不拿旧行冒充）。
    act(() => { m.result.current.back() })
    expect(m.result.current.activeId).toBe('session-b')
    m.rerender({ rows: [row('session-a')] })
    await act(async () => {})
    expect(m.result.current.activeId).toBeNull()
  })

  it('openChild 分派（ADR-0061 寻址）：id 在清单 ⇒ 选那行，不进孩子视图', async () => {
    const m = mountController([row('session-a'), row('session-b')])
    await act(async () => { await m.result.current.select(row('session-a')) })
    await waitFor(() => { expect(m.result.current.detail.kind).toBe('ready') })

    await act(async () => { await m.result.current.openChild('session-b') })
    expect(m.result.current.selected?.sessionId).toBe('session-b')
    expect(m.result.current.childView).toBeNull()
    await waitFor(() => {
      expect(m.result.current.detail).toMatchObject({ kind: 'ready', subject: { sessionId: 'session-b' } })
    })
    expect(m.archiveDetail).toHaveBeenCalledWith('session-b', undefined, undefined)
  })

  it('detailNav 装配：父视图交开孩子/预取，孩子视图只交返回父（title 走显示名）', async () => {
    const m = mountController([row('session-a', { label: '子任务名' })], {
      detailFor: (sessionId) => sessionId === 'session-a'
        ? detailOf('session-a', {
            subagents: [{ sessionId: 'kid-1', archived: false, projectDir: '--p--', title: '孩子一' }],
          })
        : detailOf('kid-1', { archived: false }),
    })
    // 父视图：入口在场、parentContext 缺席（孩子视图里不再多一条读路）。
    expect(m.result.current.detailNav.onOpenChild).toBeDefined()
    expect(m.result.current.detailNav.onPrefetchChild).toBeDefined()
    expect(m.result.current.detailNav.parentContext).toBeUndefined()

    await act(async () => { await m.result.current.select(row('session-a', { label: '子任务名' })) })
    await waitFor(() => { expect(m.result.current.detail.kind).toBe('ready') })
    await act(async () => { await m.result.current.openChild('kid-1') })
    expect(m.result.current.childView?.child.sessionId).toBe('kid-1')

    // 孩子视图：只交返回父；title 是显示名原文（label 优先），返回收孩子视图。
    expect(m.result.current.detailNav.onOpenChild).toBeUndefined()
    expect(m.result.current.detailNav.onPrefetchChild).toBeUndefined()
    expect(m.result.current.detailNav.parentContext).toMatchObject({ title: '子任务名' })
    act(() => { m.result.current.detailNav.parentContext?.onBack() })
    expect(m.result.current.childView).toBeNull()
    expect(m.result.current.selected?.sessionId).toBe('session-a')
  })

  it('保持期拒导航（Review Focus 3）：openChild 不开孩子视图，canNavigate 落 false', async () => {
    const pendingB = deferOutcome<ArchiveDetailLike>()
    const m = mountController([row('session-a'), row('session-b')], {
      detailFor: (sessionId) => sessionId === 'session-a'
        ? detailOf('session-a', {
            subagents: [{ sessionId: 'kid-1', archived: false, projectDir: '--p--', title: '孩子一' }],
          })
        : undefined,
      detailDelay: (sessionId) => (sessionId === 'session-b' ? pendingB.promise : undefined),
    })
    await act(async () => { await m.result.current.select(row('session-a')) })
    await waitFor(() => { expect(m.result.current.detail.kind).toBe('ready') })
    expect(m.result.current.canNavigate).toBe(true)

    // 换到没读过的 B：读数悬着 ⇒ 保持 A 的那一帧（正文 inert），判据这一拍翻 false。
    act(() => { void m.result.current.select(row('session-b')) })
    expect(m.result.current.detail).toMatchObject({ kind: 'holding', subject: { sessionId: 'session-a' } })
    expect(m.result.current.canNavigate).toBe(false)

    // kid-1 不在清单 ⇒ 走孩子那一支；保持期这一支整个不接受导航。
    await act(async () => { await m.result.current.openChild('kid-1') })
    expect(m.result.current.childView).toBeNull()

    await act(async () => { pendingB.resolve(remoteOk(detailOf('session-b'))) })
    await waitFor(() => { expect(m.result.current.detail.kind).toBe('ready') })
    expect(m.result.current.canNavigate).toBe(true)
  })

  it('保持期拒分页（Review Focus 3）：loadOlder 一趟更早一页都不许发', async () => {
    const pendingB = deferOutcome<ArchiveDetailLike>()
    const m = mountController([row('session-a'), row('session-b')], {
      detailFor: (sessionId) => (sessionId === 'session-a'
        ? detailOf('session-a', { olderCursor: 5 })
        : detailOf(sessionId)),
      detailDelay: (sessionId) => (sessionId === 'session-b' ? pendingB.promise : undefined),
    })
    await act(async () => { await m.result.current.select(row('session-a')) })
    await waitFor(() => { expect(m.result.current.detail.kind).toBe('ready') })
    expect(m.archiveDetail).toHaveBeenCalledTimes(1)

    act(() => { void m.result.current.select(row('session-b')) })
    expect(m.result.current.detail).toMatchObject({ kind: 'holding', subject: { sessionId: 'session-a' } })
    // B 自己那一趟读数已在飞（A 的 1 趟 + 悬着的 B 这 1 趟）：保持期的分页不许再添第三趟。
    const readsWhileHolding = m.archiveDetail.mock.calls.length
    expect(readsWhileHolding).toBe(2)
    await act(async () => { await m.result.current.loadOlder() })
    // 保持那一帧画的是上一条的正文：不许把它的游标读进新主体（ADR-0049）。
    expect(m.archiveDetail.mock.calls.length).toBe(readsWhileHolding)

    await act(async () => { pendingB.resolve(remoteOk(detailOf('session-b'))) })
    await waitFor(() => { expect(m.result.current.detail.kind).toBe('ready') })
  })
})
