/**
 * 面板控制器（`use-trash-panel-controller.ts`）的状态机。
 *
 * 这一份直接测 hook，不经过面板：闸（`useBusyGate`，判据住 `busy-gate.test.tsx`）、选中/详情缓存、清场/自动选中/
 * 失效重读、下钻与写动作派发这几组判据此前只能"整块渲染面板 + 造一个远程假件"才够得着，
 * 现在它们是这个 module 的 interface。替身只有三样：假的 query（`list` + `refreshAll` /
 * `refreshAfterWrite` 计数 + emptyTrash）、假的闸、可控落地的 deferred。
 * Esc 交还焦点那条判据住 `trash-nav.test.tsx`：控制器只管 `back()` 这一个入口，不查 DOM。
 *
 * 行为口径与 `trash-panel.tsx` 现有的函数体逐条对齐：命中缓存不重读、失败不缓存、清单换版时
 * 选中不见才让位、自动选中只认 `selectedId === null`、失效通告只戳一次重读、动作成功丢详情缓存、
 * 失败原文按条目留。
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ApplyOutcome,
  TrashDetailLike,
  TrashEntryLike,
} from '../../src/client/remote.js'
import { afterDelete, afterRestore, bindMainView, resetMainView } from '../../src/client/main-view.js'
import { invalidateTrash, resetTrashStore } from '../../src/client/trash-store.js'
import {
  publishUndoBatchNotice,
  publishUndoNotice,
  resetUndoNotice,
  useUndoNotice,
} from '../../src/client/undo-notices.js'
import { useBusyGate, type BusyGate } from '../../src/client/busy-gate.js'
import {
  useTrashPanelController,
  type TrashPanelControllerInput,
} from '../../src/client/use-trash-panel-controller.js'
import type { TrashListState } from '../../src/client/use-trash-query.js'
import { createFakeRemote } from './support/fake-remote.js'
import { outcomes, purgeOutcomes, restoreOutcomes } from './support/outcomes.js'

// 模块级现场（跨用例存活）：每个用例前复位，用例之间互不串味。
beforeEach(() => {
  resetTrashStore()
  resetUndoNotice()
  resetMainView()
})

const A: TrashEntryLike = {
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

const B: TrashEntryLike = {
  ...A,
  id: 'b',
  sessionId: 'session-b',
  deletedAt: 2,
  title: 'B',
}

/** 父行已摘、自己露面的孩子（`visibleGroups` 允许的那种单独一行）。 */
const CHILD: TrashEntryLike = {
  ...A,
  id: 'child',
  sessionId: 'session-child',
  parentEntryId: 'missing-parent',
  deletedAt: 3,
  title: 'Child',
}

function detailOf(id: string): TrashDetailLike {
  return {
    entryId: id,
    cwd: '',
    createdAt: 0,
    lastActivity: 0,
    logTitle: '',
    models: [],
    turnCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolCallCount: 0,
    injectedCount: 0,
    omittedByPayloadCap: 0,
    messages: [],
  }
}

/** 一段可以手动决定何时落地的 promise（测 loading 与到达顺序用）。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((inResolve, inReject) => {
    resolve = inResolve
    reject = inReject
  })
  return { promise, resolve, reject }
}

/** 面板那枚闸的替身：放行、不占 busy（控制器用例不关心渲染期的禁用）。 */
const openGate: BusyGate = {
  busy: false,
  around: <T,>(task: () => Promise<T>): Promise<T> => task(),
}

interface Over {
  entries?: readonly TrashEntryLike[] | null
  /** 直接给清单状态（要表达 `unknown` 时用它；`entries` 只够表达 ready / loading）。 */
  list?: TrashListState
  ordered?: readonly TrashEntryLike[]
  canAutoSelect?: boolean
  busy?: boolean
  /** 需要观察闸 / 真实 busy 时换一枚自己的闸（缺省放行）。 */
  gate?: BusyGate
}

function harness() {
  const deps = createFakeRemote({
    detail: vi.fn(async (id: string) => detailOf(id)),
    applyOutcomes: vi.fn(async () => [] as ApplyOutcome[]),
  })
  const refreshAll = vi.fn(async (): Promise<void> => {})
  const refreshAfterWrite = vi.fn(async (): Promise<void> => {})
  // `TrashQuery.emptyTrash` 交回的是"这一趟是否落地"，不是聚合回执（回执在 use-trash-query 里）。
  // 真实实现自己会套 `around` + `refreshAfterWrite`，所以控制器对 `kind:'all'` 不再补第二层。
  const emptyTrash = vi.fn(async (): Promise<boolean> => true)
  const input = (over: Over = {}): TrashPanelControllerInput => ({
    // 控制器只读这两条：`detail` 给读详情，`applyOutcomes` 给恢复/批量的那一段 `/apply`。
    deps,
    gate: over.gate ?? (over.busy === true ? { ...openGate, busy: true } : openGate),
    query: {
      list: over.list ?? (over.entries === null || over.entries === undefined
        ? { status: 'loading' as const }
        : { status: 'ready' as const, rows: over.entries }),
      refreshAll,
      refreshAfterWrite,
      emptyTrash,
    },
    ordered: over.ordered ?? [],
    canAutoSelect: over.canAutoSelect ?? false,
  })
  return { deps, refreshAll, refreshAfterWrite, emptyTrash, input }
}

function mount(over: Over = {}) {
  const h = harness()
  const view = renderHook(
    (props: TrashPanelControllerInput) => useTrashPanelController(props),
    { initialProps: h.input(over) },
  )
  const update = (next: Over): void => {
    view.rerender(h.input(next))
  }
  return { ...h, ...view, update }
}

describe('面板控制器 · 选中与详情缓存', () => {
  it('busy 跟着面板那枚闸走', () => {
    const m = mount({ entries: [A], busy: true })
    expect(m.result.current.busy).toBe(true)
  })

  it('清单还没读到（entries=null）时详情是 idle，不假装选中', () => {
    const m = mount({ entries: null })
    expect(m.result.current.detail).toEqual({ kind: 'idle' })
    expect(m.result.current.selected).toBeNull()
    expect(m.result.current.selectedId).toBeNull()
    expect(m.deps.detail).not.toHaveBeenCalled()
  })

  it('未命中缓存：先 loading，读到后 ready，按条目 id 读一次', async () => {
    const detailA = detailOf('a')
    const pending = deferred<TrashDetailLike>()
    const m = mount({ entries: [A, B] })
    m.deps.detail.mockImplementationOnce(() => pending.promise)

    act(() => {
      void m.result.current.select(A)
    })
    expect(m.deps.detail).toHaveBeenCalledWith('a')
    expect(m.result.current.selectedId).toBe('a')
    expect(m.result.current.selected).toEqual(A)
    expect(m.result.current.detail).toEqual({ kind: 'loading', entry: A })

    await act(async () => {
      pending.resolve(detailA)
    })
    expect(m.result.current.detail).toEqual({ kind: 'ready', entry: A, detail: detailA })
  })

  it('命中缓存：切走再切回不重读，也不经过 loading', async () => {
    const m = mount({ entries: [A, B] })
    await act(async () => {
      await m.result.current.select(A)
    })
    await act(async () => {
      await m.result.current.select(B)
    })
    expect(m.deps.detail).toHaveBeenCalledTimes(2)

    act(() => {
      void m.result.current.select(A)
    })
    expect(m.deps.detail).toHaveBeenCalledTimes(2)
    expect(m.result.current.detail).toEqual({ kind: 'ready', entry: A, detail: detailOf('a') })
  })

  it('A 的读数晚到不盖掉 B（成功支也不抢）', async () => {
    const m = mount({ entries: [A, B] })
    const slowA = deferred<TrashDetailLike>()
    m.deps.detail.mockImplementationOnce(() => slowA.promise)
    let readA!: Promise<void>
    act(() => {
      readA = m.result.current.select(A)
    })
    await act(async () => {
      await m.result.current.select(B)
    })
    expect(m.result.current.detail).toEqual({ kind: 'ready', entry: B, detail: detailOf('b') })

    await act(async () => {
      slowA.resolve(detailOf('a'))
      await readA
    })
    expect(m.result.current.selectedId).toBe('b')
    expect(m.result.current.detail).toEqual({ kind: 'ready', entry: B, detail: detailOf('b') })
  })

  it('A 的读数晚到失败也不把 B 按成 failed', async () => {
    const m = mount({ entries: [A, B] })
    const slowA = deferred<TrashDetailLike>()
    m.deps.detail.mockImplementationOnce(() => slowA.promise)
    let readA!: Promise<void>
    act(() => {
      readA = m.result.current.select(A)
    })
    await act(async () => {
      await m.result.current.select(B)
    })

    await act(async () => {
      slowA.reject(new Error('A 的日志读失败'))
      await readA
    })
    expect(m.result.current.selectedId).toBe('b')
    expect(m.result.current.detail).toEqual({ kind: 'ready', entry: B, detail: detailOf('b') })
  })

  it('命中缓存再下钻：直接进 drilled，不重读也不经过 loading', async () => {
    const m = mount({ entries: [A] })
    await act(async () => {
      await m.result.current.select(A)
    })
    act(() => {
      void m.result.current.select(A, { drill: true })
    })
    expect(m.result.current.drilled).toBe(true)
    expect(m.deps.detail).toHaveBeenCalledTimes(1)
    expect(m.result.current.detail).toEqual({ kind: 'ready', entry: A, detail: detailOf('a') })
  })

  it('读失败：原文进 failed；失败不缓存，切走再回来会重读', async () => {
    const m = mount({ entries: [A, B] })
    m.deps.detail.mockRejectedValueOnce(new Error('读会话日志失败：第 2 帧解压失败'))

    await act(async () => {
      await m.result.current.select(A)
    })
    expect(m.result.current.detail).toEqual({
      kind: 'failed',
      entry: A,
      message: '读会话日志失败：第 2 帧解压失败',
    })

    await act(async () => {
      await m.result.current.select(B)
    })
    await act(async () => {
      await m.result.current.select(A)
    })
    expect(m.deps.detail).toHaveBeenCalledTimes(3)
    expect(m.result.current.detail.kind).toBe('ready')
  })

  it('retry 只重读这一条：不动清单，失败态先回 loading', async () => {
    const m = mount({ entries: [A] })
    m.deps.detail.mockRejectedValueOnce(new Error('第 2 帧解压失败'))
    await act(async () => {
      await m.result.current.select(A)
    })
    expect(m.result.current.detail.kind).toBe('failed')
    const refreshBefore = m.refreshAfterWrite.mock.calls.length

    const pending = deferred<TrashDetailLike>()
    m.deps.detail.mockImplementationOnce(() => pending.promise)
    act(() => {
      m.result.current.retry()
    })
    expect(m.result.current.detail).toEqual({ kind: 'loading', entry: A })
    expect(m.deps.detail).toHaveBeenCalledTimes(2)
    expect(m.refreshAfterWrite).toHaveBeenCalledTimes(refreshBefore)

    await act(async () => {
      pending.resolve(detailOf('a'))
    })
    expect(m.result.current.detail.kind).toBe('ready')
  })
})

describe('面板控制器 · 清单换版后的清场', () => {
  it('选中那条从清单消失：清掉缓存、选中与下钻；再回来要重读', async () => {
    const m = mount({ entries: [A, B] })
    await act(async () => {
      await m.result.current.select(A, { drill: true })
    })
    expect(m.result.current.detail.kind).toBe('ready')

    act(() => {
      m.update({ entries: [B], ordered: [B] })
    })
    expect(m.result.current.selectedId).toBeNull()
    expect(m.result.current.selected).toBeNull()
    expect(m.result.current.drilled).toBe(false)
    expect(m.result.current.detail).toEqual({ kind: 'idle' })

    act(() => {
      m.update({ entries: [A, B], ordered: [A, B] })
    })
    await act(async () => {
      await m.result.current.select(A)
    })
    expect(m.deps.detail).toHaveBeenCalledTimes(2)
  })

  it('清单换了一版但选中那条还在：选中、下钻与详情都不动', async () => {
    const m = mount({ entries: [A, B] })
    await act(async () => {
      await m.result.current.select(A, { drill: true })
    })
    const freshA = { ...A, title: 'A 改过' }

    act(() => {
      m.update({ entries: [freshA], ordered: [freshA] })
    })
    expect(m.result.current.selectedId).toBe('a')
    expect(m.result.current.drilled).toBe(true)
    expect(m.result.current.detail).toEqual({ kind: 'ready', entry: freshA, detail: detailOf('a') })
    expect(m.deps.detail).toHaveBeenCalledTimes(1)
  })

  it('清单读不到（entries=null）不算"选中没了"：选中 id 留着，详情回 idle', async () => {
    const m = mount({ entries: [A] })
    await act(async () => {
      await m.result.current.select(A)
    })
    act(() => {
      m.update({ entries: null })
    })
    expect(m.result.current.selectedId).toBe('a')
    expect(m.result.current.detail).toEqual({ kind: 'idle' })
  })

  it('清单读不到再回来：已读缓存还在，选中不重读', async () => {
    const m = mount({ entries: [A] })
    await act(async () => {
      await m.result.current.select(A)
    })
    act(() => {
      m.update({ entries: null })
    })
    act(() => {
      m.update({ entries: [A] })
    })
    act(() => {
      void m.result.current.select(A)
    })
    expect(m.deps.detail).toHaveBeenCalledTimes(1)
    expect(m.result.current.detail).toEqual({ kind: 'ready', entry: A, detail: detailOf('a') })
  })
})

describe('面板控制器 · 自动选中', () => {
  it('canAutoSelect 且还没有选中：读 ordered 的第一条', async () => {
    const m = mount({ entries: [A, B], ordered: [A, B], canAutoSelect: true })
    await waitFor(() => expect(m.result.current.detail.kind).toBe('ready'))
    expect(m.deps.detail).toHaveBeenCalledWith('a')
    expect(m.result.current.selectedId).toBe('a')
  })

  it('canAutoSelect 为假（窄档）时一条都不自动读', async () => {
    const m = mount({ entries: [A, B], ordered: [A, B], canAutoSelect: false })
    await act(async () => {})
    expect(m.deps.detail).not.toHaveBeenCalled()
    expect(m.result.current.selectedId).toBeNull()
  })

  it('已经有选中：自动选中不抢走它', async () => {
    const m = mount({ entries: [A, B], ordered: [A, B] })
    await act(async () => {
      await m.result.current.select(B)
    })

    m.update({ entries: [A, B], ordered: [A, B], canAutoSelect: true })
    await act(async () => {})
    expect(m.result.current.selectedId).toBe('b')
    expect(m.deps.detail).toHaveBeenCalledTimes(1)
    expect(m.deps.detail).toHaveBeenCalledWith('b')
  })

  it('清单里没有可走的第一条（全部折叠）时不读', async () => {
    const m = mount({ entries: [A], ordered: [], canAutoSelect: true })
    await act(async () => {})
    expect(m.deps.detail).not.toHaveBeenCalled()
  })

  it('选中的那条被清掉后，下一拍自动接住新清单第一条（自动选中只认 selectedId === null）', async () => {
    const m = mount({ entries: [A, B], ordered: [A, B], canAutoSelect: true })
    await waitFor(() => expect(m.result.current.detail.kind).toBe('ready'))
    expect(m.result.current.selectedId).toBe('a')

    act(() => {
      m.update({ entries: [B], ordered: [B], canAutoSelect: true })
    })
    await waitFor(() => expect(m.result.current.selectedId).toBe('b'))
    expect(m.deps.detail).toHaveBeenCalledWith('b')
    expect(m.result.current.drilled).toBe(false)
  })
})

describe('面板控制器 · 下钻', () => {
  // Esc 那条（下钻期间挂 document 监听、退回后把焦点交还那一行一次）已随 `trash-nav.ts` 一起搬走，
  // 用例住 `trash-nav.test.tsx`；控制器这一侧只剩「← 返回清单」这一个入口。
  it('back 退出下钻：选中与详情都留着', async () => {
    const m = mount({ entries: [A] })
    await act(async () => {
      await m.result.current.select(A, { drill: true })
    })
    expect(m.result.current.drilled).toBe(true)

    act(() => {
      m.result.current.back()
    })
    expect(m.result.current.drilled).toBe(false)
    expect(m.result.current.selectedId).toBe('a')
    expect(m.result.current.detail.kind).toBe('ready')
  })

  it('从窄档拖宽：残留的下钻状态收掉，选中与详情不动', async () => {
    const m = mount({ entries: [A] })
    await act(async () => {
      await m.result.current.select(A, { drill: true })
    })
    expect(m.result.current.drilled).toBe(true)

    m.update({ entries: [A], ordered: [A], canAutoSelect: true })

    expect(m.result.current.drilled).toBe(false)
    expect(m.result.current.selectedId).toBe('a')
    expect(m.result.current.detail.kind).toBe('ready')
  })
})

describe('面板控制器 · 恢复与确认动作', () => {
  it('restore 失败：原文落在这条的行上，清单照样重读（回滚失败可能留下半套）', async () => {
    const m = mount({ entries: [A, B] })
    m.deps.applyOutcomes.mockResolvedValueOnce(restoreOutcomes(['a'], ['a'], '恢复失败：项目目录不存在'))
    const refreshBefore = m.refreshAfterWrite.mock.calls.length

    await act(async () => {
      await m.result.current.restore(A)
    })
    expect(m.deps.applyOutcomes).toHaveBeenCalledWith('restore', ['a'])
    expect(m.result.current.actionFailure).toEqual({ a: '恢复失败：项目目录不存在' })
    expect(m.refreshAfterWrite).toHaveBeenCalledTimes(refreshBefore + 1)
  })

  // 与 `confirmApply 顶层失败` 同一条判据：失败只说"这一次调用没办成"，不说"盘上没动"——
  // 写可能已经成了、响应断在路上；逐条失败也可能是组回滚留下的半套，只有重读能定。
  it('restore 顶层失败：原文落在这条的行上，清单照样重读', async () => {
    const m = mount({ entries: [A, B] })
    m.deps.applyOutcomes.mockRejectedValueOnce(new Error('路由自检失败'))
    const refreshBefore = m.refreshAfterWrite.mock.calls.length

    await act(async () => {
      await m.result.current.restore(A)
    })
    expect(m.result.current.actionFailure).toEqual({ a: '路由自检失败' })
    expect(m.refreshAfterWrite).toHaveBeenCalledTimes(refreshBefore + 1)
  })

  it('restore 再点一次先清旧失败：成功后就该没有那一行', async () => {
    const m = mount({ entries: [A] })
    m.deps.applyOutcomes.mockResolvedValueOnce(restoreOutcomes(['a'], ['a'], '第一次失败'))
    await act(async () => {
      await m.result.current.restore(A)
    })
    expect(m.result.current.actionFailure).toEqual({ a: '第一次失败' })

    m.deps.applyOutcomes.mockResolvedValueOnce(restoreOutcomes(['a']))
    const refreshBefore = m.refreshAfterWrite.mock.calls.length
    await act(async () => {
      await m.result.current.restore(A)
    })
    expect(m.result.current.actionFailure).toEqual({})
    expect(m.refreshAfterWrite).toHaveBeenCalledTimes(refreshBefore + 1)
  })

  it('restore 成功丢缓存：同一条再被删回来要重读，不摆旧详情', async () => {
    const m = mount({ entries: [A] })
    await act(async () => {
      await m.result.current.select(A)
    })
    expect(m.result.current.detail.kind).toBe('ready')

    m.deps.applyOutcomes.mockResolvedValueOnce(restoreOutcomes(['a']))
    await act(async () => {
      await m.result.current.restore(A)
    })

    const fresh = deferred<TrashDetailLike>()
    m.deps.detail.mockImplementationOnce(() => fresh.promise)
    act(() => {
      void m.result.current.select(A)
    })
    expect(m.deps.detail).toHaveBeenCalledTimes(2)
    expect(m.result.current.detail).toEqual({ kind: 'loading', entry: A })

    await act(async () => {
      fresh.resolve({ ...detailOf('a'), turnCount: 7 })
    })
    expect(m.result.current.detail).toEqual({
      kind: 'ready',
      entry: A,
      detail: { ...detailOf('a'), turnCount: 7 },
    })
  })

  it('单条恢复把 outcome 交给 query：孩子与组根的差异由 query 判，控制器只转交', async () => {
    const child = mount({ entries: [CHILD] })
    child.deps.applyOutcomes.mockResolvedValueOnce(restoreOutcomes(['child']))
    await act(async () => {
      await child.result.current.restore(CHILD)
    })
    expect(child.refreshAfterWrite).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'restore', ids: ['child'] }))

    const root = mount({ entries: [A] })
    root.deps.applyOutcomes.mockResolvedValueOnce(restoreOutcomes(['a']))
    await act(async () => {
      await root.result.current.restore(A)
    })
    expect(root.refreshAfterWrite).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'restore', ids: ['a'] }))
  })

  it('批量恢复把 outcome 交给 query：孩子与组根的差异由 query 判，控制器只转交', async () => {
    const withChild = mount({ entries: [A, CHILD] })
    withChild.deps.applyOutcomes.mockResolvedValueOnce(restoreOutcomes(['a', 'child']))
    await act(async () => {
      await withChild.result.current.confirmApply('restore', ['a', 'child'])
    })
    expect(withChild.refreshAfterWrite).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'restore', ids: ['a', 'child'] }))

    const roots = mount({ entries: [A] })
    roots.deps.applyOutcomes.mockResolvedValueOnce(restoreOutcomes(['a']))
    await act(async () => {
      await roots.result.current.confirmApply('restore', ['a'])
    })
    expect(roots.refreshAfterWrite).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'restore', ids: ['a'] }))
  })

  it('面板恢复结算跨槽位：熄灭撤销横幅，并忘掉 main-view 的 closedByUs', async () => {
    const openSession = vi.fn()
    let selected: { sessionId?: string } = { sessionId: 'session-a' }
    bindMainView({
      slots: {} as never,
      get: (name: string) => name === 'uiWorkspace' ? {
        selection: { getSnapshot: () => selected },
        sessions: { list: { getSnapshot: () => ({ byId: { 'session-a': {} } }) } },
        clearMain: () => { selected = {} },
        openSession,
      } : undefined,
    } as never)
    afterDelete(['session-a'])
    publishUndoNotice({ entryId: 'a', title: 'A' })
    const notice = renderHook(() => useUndoNotice())
    const m = mount({ entries: [A] })
    m.deps.applyOutcomes.mockResolvedValueOnce(restoreOutcomes(['a']))

    await act(async () => {
      await m.result.current.restore(A)
    })

    expect(notice.result.current).toBeNull()
    afterRestore(['session-a'])
    expect(openSession).not.toHaveBeenCalled()
  })

  it('restore 失败不结算跨槽位：撤销横幅留着，main-view 仍记得自己关过它', async () => {
    const openSession = vi.fn()
    let selected: { sessionId?: string } = { sessionId: 'session-a' }
    bindMainView({
      slots: {} as never,
      get: (name: string) => name === 'uiWorkspace' ? {
        selection: { getSnapshot: () => selected },
        sessions: { list: { getSnapshot: () => ({ byId: { 'session-a': {} } }) } },
        clearMain: () => { selected = {} },
        openSession,
      } : undefined,
    } as never)
    afterDelete(['session-a'])
    publishUndoNotice({ entryId: 'a', title: 'A' })
    const notice = renderHook(() => useUndoNotice())
    const m = mount({ entries: [A] })
    m.deps.applyOutcomes.mockResolvedValueOnce(restoreOutcomes(['a'], ['a'], '恢复失败'))

    await act(async () => {
      await m.result.current.restore(A)
    })

    expect(m.result.current.actionFailure).toEqual({ a: '恢复失败' })
    // 没落地就不许熄灭指向它的横幅，也不许把 main-view 的记录当成功结算掉。
    expect(notice.result.current).not.toBeNull()
    afterRestore(['session-a'])
    expect(openSession).toHaveBeenCalledWith('session-a')
  })

  it('批量恢复也结算跨槽位：ok 与 already-gone 都熄灭整批撤销横幅', async () => {
    const openSession = vi.fn()
    let selected: { sessionId?: string } = { sessionId: 'session-a' }
    bindMainView({
      slots: {} as never,
      get: (name: string) => name === 'uiWorkspace' ? {
        selection: { getSnapshot: () => selected },
        sessions: { list: { getSnapshot: () => ({ byId: { 'session-a': {}, 'session-b': {} } }) } },
        clearMain: () => { selected = {} },
        openSession,
      } : undefined,
    } as never)
    afterDelete(['session-a'])
    publishUndoBatchNotice({ entryIds: ['a', 'b'], n: 2 })
    const notice = renderHook(() => useUndoNotice())
    const m = mount({ entries: [A, B] })
    // `b` 的 `null` = 已被同批前一条带走（批量幂等 no-op），它同样算落地、同样要熄灭横幅。
    m.deps.applyOutcomes.mockResolvedValueOnce([...restoreOutcomes(['a']), ...outcomes('restore', ['b'])])

    await act(async () => {
      await m.result.current.confirmApply('restore', ['a', 'b'])
    })

    expect(notice.result.current).toBeNull()
    afterRestore(['session-a', 'session-b'])
    expect(openSession).not.toHaveBeenCalled()
  })

  it('purge 结算撤销横幅：永久删除后指向这些条目的横幅熄灭（settlement 的 purge 支）', async () => {
    publishUndoNotice({ entryId: 'a', title: 'A' })
    const notice = renderHook(() => useUndoNotice())
    const m = mount({ entries: [A] })
    m.deps.applyOutcomes.mockResolvedValueOnce(purgeOutcomes(['a']))

    await act(async () => {
      await m.result.current.confirmApply('purge', ['a'])
    })

    // 留着就是一条注定失败的「撤销」：这条以前被静默忽略（见 write-settlement 的 purge 支）。
    expect(notice.result.current).toBeNull()
  })

  it('pending 归控制器：request 构造待确认，setPending 不再出现在 interface', () => {
    const m = mount({ entries: [A, B] })
    act(() => { m.result.current.request({ kind: 'restore', ids: ['b', 'a'] }) })
    expect(m.result.current.pending).toEqual({ kind: 'restore', ids: ['b', 'a'] })
    expect(m.result.current.pendingEntries.map((entry) => entry.id)).toEqual(['b', 'a'])
    // 只有恢复框要摆条目：彻底删除框只念条数/单条自带的那一格。
    act(() => { m.result.current.request({ kind: 'entries', ids: ['a', 'b'] }) })
    expect(m.result.current.pendingEntries).toEqual([])
    expect('setPending' in m.result.current).toBe(false)
    act(() => { m.result.current.cancelPending() })
    expect(m.result.current.pending).toBeNull()
  })

  it('清单 unknown 时收起 pending：看不见的行不许继续确认', () => {
    const m = mount({ entries: [A] })
    act(() => { m.result.current.request({ kind: 'restore', ids: ['a'] }) })
    act(() => {
      m.update({ list: { status: 'unknown', failure: '清单坏了' }, entries: null })
    })
    expect(m.result.current.pending).toBeNull()
  })

  it('清单已经 unknown 时再请求确认也不会留下 pending（状态级判据，不靠迁移那一次）', () => {
    const m = mount({ list: { status: 'unknown', failure: '清单坏了' }, entries: null })
    act(() => { m.result.current.request({ kind: 'restore', ids: ['a'] }) })
    expect(m.result.current.pending).toBeNull()
  })

  it('清单 unknown 但写入在飞：pending 先留着，忙完再收', () => {
    const m = mount({ entries: [A] })
    act(() => { m.result.current.request({ kind: 'restore', ids: ['a'] }) })
    act(() => {
      m.update({ list: { status: 'unknown', failure: '清单坏了' }, entries: null, busy: true })
    })
    expect(m.result.current.pending).not.toBeNull()
    act(() => {
      m.update({ list: { status: 'unknown', failure: '清单坏了' }, entries: null, busy: false })
    })
    expect(m.result.current.pending).toBeNull()
  })

  it('confirmApply 成功：成功条目丢缓存、失败留行、pending 收起、清单只重读一次', async () => {
    const m = mount({ entries: [A, B] })
    await act(async () => {
      await m.result.current.select(A)
    })
    act(() => {
      m.result.current.request({ kind: 'entries', ids: ['a', 'b'] })
    })
    expect(m.result.current.pending).toEqual({ kind: 'entries', ids: ['a', 'b'] })

    m.deps.applyOutcomes.mockResolvedValueOnce(purgeOutcomes(['a', 'b'], ['b'], '第二条删不掉'))
    const refreshBefore = m.refreshAfterWrite.mock.calls.length
    await act(async () => {
      await m.result.current.confirmApply('purge', ['a', 'b'])
    })
    expect(m.deps.applyOutcomes).toHaveBeenCalledWith('purge', ['a', 'b'])
    expect(m.result.current.pending).toBeNull()
    expect(m.result.current.actionFailure).toEqual({ b: '第二条删不掉' })
    expect(m.refreshAfterWrite).toHaveBeenCalledTimes(refreshBefore + 1)
    expect(m.refreshAfterWrite).toHaveBeenCalledWith(expect.objectContaining({ action: 'purge' }))

    // 成功的那条缓存已丢：再选它必须重读，否则会摆着已经被删掉的那一世的详情。
    const fresh = deferred<TrashDetailLike>()
    m.deps.detail.mockImplementationOnce(() => fresh.promise)
    act(() => {
      void m.result.current.select(A)
    })
    expect(m.deps.detail).toHaveBeenCalledTimes(2)
    expect(m.result.current.detail).toEqual({ kind: 'loading', entry: A })
  })

  it('confirmApply 请求里的 id 没回：那条落 missing 原文，不静默', async () => {
    const m = mount({ entries: [A, B] })
    m.deps.applyOutcomes.mockResolvedValueOnce(purgeOutcomes(['a']))
    const refreshBefore = m.refreshAfterWrite.mock.calls.length
    await act(async () => {
      await m.result.current.confirmApply('purge', ['a', 'b'])
    })
    expect(m.result.current.actionFailure).toEqual({ b: '批量通道没回这一条的结果：purge b' })
    expect(m.refreshAfterWrite).toHaveBeenCalledTimes(refreshBefore + 1)
  })

  it('confirmApply 顶层失败：每个 id 落同一句原文，pending 收起，清单照样重读', async () => {
    const m = mount({ entries: [A, B] })
    act(() => {
      m.result.current.request({ kind: 'entries', ids: ['a', 'b'] })
    })
    m.deps.applyOutcomes.mockRejectedValueOnce(new Error('路由自检失败'))
    const refreshBefore = m.refreshAfterWrite.mock.calls.length

    await act(async () => {
      await m.result.current.confirmApply('purge', ['a', 'b'])
    })
    expect(m.result.current.actionFailure).toEqual({ a: '路由自检失败', b: '路由自检失败' })
    expect(m.result.current.pending).toBeNull()
    expect(m.refreshAfterWrite).toHaveBeenCalledTimes(refreshBefore + 1)
  })

  it('失败原文按条目留着：切走再回来还在，别条的成败不串台', async () => {
    const m = mount({ entries: [A, B] })
    m.deps.applyOutcomes.mockResolvedValueOnce(purgeOutcomes(['a', 'b'], ['b'], '第二条删不掉'))
    await act(async () => {
      await m.result.current.confirmApply('purge', ['a', 'b'])
    })

    await act(async () => {
      await m.result.current.select(A)
    })
    expect(m.result.current.actionFailure).toEqual({ b: '第二条删不掉' })
    await act(async () => {
      await m.result.current.select(B)
    })
    expect(m.result.current.actionFailure).toEqual({ b: '第二条删不掉' })
    expect(m.result.current.detail.kind).toBe('ready')
  })

  it('confirmPurge 按条目标：单条 / 多选 / 批量恢复都委托 confirmApply', async () => {
    const m = mount({ entries: [A, B] })
    m.deps.applyOutcomes
      .mockResolvedValueOnce(purgeOutcomes(['a']))
      .mockResolvedValueOnce(purgeOutcomes(['a', 'b']))
      .mockResolvedValueOnce(restoreOutcomes(['b']))

    act(() => {
      m.result.current.request({ kind: 'entry', entry: A })
    })
    await act(async () => {
      await m.result.current.confirmPurge()
    })
    expect(m.deps.applyOutcomes).toHaveBeenLastCalledWith('purge', ['a'])
    expect(m.result.current.pending).toBeNull()

    act(() => {
      m.result.current.request({ kind: 'entries', ids: ['a', 'b'] })
    })
    await act(async () => {
      await m.result.current.confirmPurge()
    })
    expect(m.deps.applyOutcomes).toHaveBeenLastCalledWith('purge', ['a', 'b'])
    expect(m.result.current.pending).toBeNull()

    act(() => {
      m.result.current.request({ kind: 'restore', ids: ['b'] })
    })
    await act(async () => {
      await m.result.current.confirmPurge()
    })
    expect(m.deps.applyOutcomes).toHaveBeenLastCalledWith('restore', ['b'])
    expect(m.result.current.pending).toBeNull()
    expect(m.emptyTrash).not.toHaveBeenCalled()
  })

  it('confirmPurge 清空：走 emptyTrash、不套第二层 around，成功清掉全部详情缓存', async () => {
    /** 只数"套了几层闸"：清空自己已经包了同一枚闸，控制器不该再套第二层。 */
    const aroundCalls: Array<() => Promise<unknown>> = []
    const around = <T,>(task: () => Promise<T>): Promise<T> => {
      aroundCalls.push(task)
      return task()
    }
    const m = mount({ entries: [A], gate: { busy: false, around } })
    await act(async () => {
      await m.result.current.select(A)
    })
    act(() => {
      m.result.current.request({ kind: 'all' })
    })
    const refreshBefore = m.refreshAfterWrite.mock.calls.length

    await act(async () => {
      await m.result.current.confirmPurge()
    })
    expect(m.emptyTrash).toHaveBeenCalledTimes(1)
    expect(m.deps.applyOutcomes).not.toHaveBeenCalled()
    // 清空自己已经包了同一枚闸与重读，控制器再套一层会让外层 busy 提前落下。
    expect(aroundCalls).toHaveLength(0)
    expect(m.result.current.pending).toBeNull()
    expect(m.refreshAfterWrite).toHaveBeenCalledTimes(refreshBefore)

    const fresh = deferred<TrashDetailLike>()
    m.deps.detail.mockImplementationOnce(() => fresh.promise)
    act(() => {
      void m.result.current.select(A)
    })
    expect(m.deps.detail).toHaveBeenCalledTimes(2)
    expect(m.result.current.detail).toEqual({ kind: 'loading', entry: A })
  })

  it('confirmPurge 清空失败：pending 照样收起，缓存保留', async () => {
    const m = mount({ entries: [A] })
    await act(async () => {
      await m.result.current.select(A)
    })
    m.emptyTrash.mockResolvedValueOnce(false)
    act(() => {
      m.result.current.request({ kind: 'all' })
    })

    await act(async () => {
      await m.result.current.confirmPurge()
    })
    expect(m.result.current.pending).toBeNull()
    expect(m.result.current.actionFailure).toEqual({})
    // 没清成 ⇒ 那条详情的“仍在盘上”这一事实没变，缓存照用。
    act(() => {
      void m.result.current.select(A)
    })
    expect(m.deps.detail).toHaveBeenCalledTimes(1)
    expect(m.result.current.detail.kind).toBe('ready')
  })

  it('没有 pending 时 confirmPurge 什么都不做', async () => {
    const m = mount({ entries: [A] })
    await act(async () => {
      await m.result.current.confirmPurge()
    })
    expect(m.deps.applyOutcomes).not.toHaveBeenCalled()
    expect(m.emptyTrash).not.toHaveBeenCalled()
    expect(m.result.current.pending).toBeNull()
  })
})

describe('面板控制器 · 动作期间 busy', () => {
  it('busy 罩到清单重读落地：恢复的闸在 refreshAfterWrite 完成前不落', async () => {
    const h = harness()
    const view = renderHook(() => {
      const gate = useBusyGate()
      return useTrashPanelController({ ...h.input({ entries: [A] }), gate })
    })
    await act(async () => {})

    h.deps.applyOutcomes.mockResolvedValueOnce(restoreOutcomes(['a']))
    const refreshSettles = deferred<void>()
    h.refreshAfterWrite.mockImplementationOnce(() => refreshSettles.promise)

    let task!: Promise<void>
    act(() => {
      task = view.result.current.restore(A)
    })
    await waitFor(() => expect(h.refreshAfterWrite).toHaveBeenCalledTimes(1))
    expect(view.result.current.busy).toBe(true)

    await act(async () => {
      refreshSettles.resolve()
      await task
    })
    expect(view.result.current.busy).toBe(false)
  })

  it('busy 罩到清单重读落地：批量的闸在 refreshAfterWrite 完成前不落', async () => {
    const h = harness()
    const view = renderHook(() => {
      const gate = useBusyGate()
      return useTrashPanelController({ ...h.input({ entries: [A, B] }), gate })
    })
    await act(async () => {})

    h.deps.applyOutcomes.mockResolvedValueOnce(purgeOutcomes(['a', 'b']))
    const refreshSettles = deferred<void>()
    h.refreshAfterWrite.mockImplementationOnce(() => refreshSettles.promise)

    act(() => {
      view.result.current.request({ kind: 'entries', ids: ['a', 'b'] })
    })
    let task!: Promise<void>
    act(() => {
      task = view.result.current.confirmApply('purge', ['a', 'b'])
    })
    await waitFor(() => expect(h.refreshAfterWrite).toHaveBeenCalledTimes(1))
    expect(view.result.current.busy).toBe(true)
    expect(view.result.current.pending).toBeNull()

    await act(async () => {
      refreshSettles.resolve()
      await task
    })
    expect(view.result.current.busy).toBe(false)
  })
})

describe('面板控制器 · 失效通告', () => {
  it('挂载走完整刷新；失效通告只戳写后刷新（不再付一次全量扫描）', async () => {
    const m = mount({ entries: [A] })
    await act(async () => {
      await m.result.current.select(A)
    })
    expect(m.refreshAll).toHaveBeenCalledTimes(1)
    const refreshBefore = m.refreshAfterWrite.mock.calls.length

    act(() => {
      invalidateTrash()
    })
    await waitFor(() => expect(m.refreshAfterWrite.mock.calls.length).toBe(refreshBefore + 1))
    expect(m.refreshAll).toHaveBeenCalledTimes(1)
    expect(m.result.current.selectedId).toBe('a')
    expect(m.result.current.detail.kind).toBe('ready')
    expect(m.deps.detail).toHaveBeenCalledTimes(1)
  })
})
