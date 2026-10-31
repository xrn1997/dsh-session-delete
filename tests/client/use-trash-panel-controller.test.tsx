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
 * 选中不见才让位、自动选中只认「尚未选中」、失效通告只戳一次重读、动作成功丢详情缓存、
 * 失败原文按条目留。
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ApplyOutcome,
  TrashDetailLike,
  TrashEntryLike,
} from '../../src/client/remote.js'
import type { TrashDetailBlockWire } from '../../src/shared/wire.js'
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

const userBlock = (text: string, id = text): TrashDetailBlockWire => ({
  kind: 'user', id, time: 0, text, truncated: false, attachments: [],
})

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
    blocks: [],
    olderCursor: null,
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
  // 附件读数上屏归 query（拼句子与清旧提示都在那一侧）；这里只钉"控制器把哪一份交过去"。
  const noteAttachmentCleanup = vi.fn((_a: unknown): void => {})
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
      noteAttachmentCleanup,
    },
    ordered: over.ordered ?? [],
    canAutoSelect: over.canAutoSelect ?? false,
  })
  return { deps, refreshAll, refreshAfterWrite, emptyTrash, noteAttachmentCleanup, input }
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

  it('同一条在飞时不重复发 /detail（宽档双击不会打两条）', async () => {
    const pending = deferred<TrashDetailLike>()
    const m = mount({ entries: [A] })
    m.deps.detail.mockImplementationOnce(() => pending.promise)

    let first!: Promise<void>
    act(() => {
      first = m.result.current.select(A)
      void m.result.current.select(A)
    })
    expect(m.deps.detail).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending.resolve(detailOf('a'))
      await first
    })
    expect(m.deps.detail).toHaveBeenCalledTimes(1)
    expect(m.result.current.detail).toEqual({ kind: 'ready', entry: A, detail: detailOf('a') })
  })

  it('在飞时切走再切回：回执落地后详情块是 ready（不会卡在 loading）', async () => {
    const pendingA = deferred<TrashDetailLike>()
    const pendingB = deferred<TrashDetailLike>()
    const m = mount({ entries: [A, B] })
    m.deps.detail
      .mockImplementationOnce(() => pendingA.promise)
      .mockImplementationOnce(() => pendingB.promise)

    // 选 A（在飞）→ 选 B → 再选 A：A 的回执落地时 loading 必须已经指着 A，
    // 否则那条回执带不动任何 state 变化，详情块永远停在 loading。
    act(() => {
      void m.result.current.select(A)
      void m.result.current.select(B)
      void m.result.current.select(A)
    })
    expect(m.deps.detail).toHaveBeenCalledTimes(2)

    await act(async () => {
      pendingB.resolve(detailOf('b'))
    })
    expect(m.result.current.detail).toEqual({ kind: 'loading', entry: A })

    await act(async () => {
      pendingA.resolve(detailOf('a'))
    })
    expect(m.deps.detail).toHaveBeenCalledTimes(2)
    expect(m.result.current.detail).toEqual({ kind: 'ready', entry: A, detail: detailOf('a') })
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

describe('面板控制器 · 详情分页', () => {
  it('loadOlder：按缓存里的 olderCursor 读更早一页，拼到前面并更新游标', async () => {
    const m = mount({ entries: [A] })
    const tail = { ...detailOf('a'), blocks: [userBlock('尾', '10')], olderCursor: 10 }
    const older = { ...detailOf('a'), blocks: [userBlock('早', '0')], olderCursor: null }
    m.deps.detail.mockResolvedValueOnce(tail)
    await act(async () => {
      await m.result.current.select(A)
    })

    m.deps.detail.mockResolvedValueOnce(older)
    await act(async () => {
      await m.result.current.loadOlder()
    })

    expect(m.deps.detail).toHaveBeenLastCalledWith('a', 10)
    expect(m.result.current.detail).toEqual({
      kind: 'ready',
      entry: A,
      detail: { ...tail, blocks: [userBlock('早', '0'), userBlock('尾', '10')], olderCursor: null },
    })
  })

  it('loadOlder 在飞时 loadingOlder 为真，重复调用不重复读', async () => {
    const m = mount({ entries: [A] })
    m.deps.detail.mockResolvedValueOnce({ ...detailOf('a'), blocks: [userBlock('尾', '5')], olderCursor: 5 })
    await act(async () => {
      await m.result.current.select(A)
    })

    const pending = deferred<TrashDetailLike>()
    m.deps.detail.mockImplementationOnce(() => pending.promise)
    act(() => {
      void m.result.current.loadOlder()
      void m.result.current.loadOlder()
    })
    expect(m.result.current.loadingOlder).toBe(true)
    expect(m.deps.detail).toHaveBeenCalledTimes(2)

    await act(async () => {
      pending.resolve({ ...detailOf('a'), blocks: [userBlock('早', '0')], olderCursor: null })
    })
    expect(m.result.current.loadingOlder).toBe(false)
  })

  it('loadOlder 还在飞时切走再切回，还在飞的那条不发第二条（第二条注定落不了屏，白打往返）', async () => {
    const m = mount({ entries: [A, B] })
    const tailA = { ...detailOf('a'), blocks: [userBlock('A尾', '7')], olderCursor: 7 }
    m.deps.detail.mockResolvedValueOnce(tailA)
    const slow = deferred<TrashDetailLike>()
    m.deps.detail.mockImplementationOnce(() => slow.promise)
    m.deps.detail.mockResolvedValueOnce(detailOf('b'))
    await act(async () => {
      await m.result.current.select(A)
    })

    let loading!: Promise<void>
    act(() => {
      loading = m.result.current.loadOlder()
    })
    await act(async () => {
      await m.result.current.select(B)
    })
    await act(async () => {
      await m.result.current.select(A)
    })
    await act(async () => {
      void m.result.current.loadOlder()
    })
    // 调用只有三条：A 详情、A 的更早页（在飞）、B 详情；切回 A 再点不再发。
    expect(m.deps.detail).toHaveBeenCalledTimes(3)
    expect(m.result.current.loadingOlder).toBe(true)

    await act(async () => {
      slow.resolve({ ...detailOf('a'), blocks: [userBlock('A早', '0')], olderCursor: null })
      await loading
    })
    expect(m.result.current.detail).toEqual({
      kind: 'ready',
      entry: A,
      detail: { ...tailA, blocks: [userBlock('A早', '0'), userBlock('A尾', '7')], olderCursor: null },
    })
    expect(m.result.current.loadingOlder).toBe(false)
  })

  // 渲染位只有一个槽：A 的分页在飞、B 又占过这个槽之后切回 A，A 点「加载更早」曾静默无动作
  // （当时 `begin` 判重放在 `show` 之前，界面看不出这一条其实已经在读）。点一下必须回到加载态，且仍不重发。
  it('两条各有更早页在飞时切回 A：点 A 的分页要回到加载态，不是静默 no-op', async () => {
    const m = mount({ entries: [A, B] })
    const tailA = { ...detailOf('a'), blocks: [userBlock('A尾', '7')], olderCursor: 7 }
    const tailB = { ...detailOf('b'), blocks: [userBlock('B尾', '9')], olderCursor: 9 }
    const slowA = deferred<TrashDetailLike>()
    const slowB = deferred<TrashDetailLike>()
    m.deps.detail
      .mockResolvedValueOnce(tailA) // 选 A
      .mockImplementationOnce(() => slowA.promise) // A 的更早页（在飞）
      .mockResolvedValueOnce(tailB) // 选 B
      .mockImplementationOnce(() => slowB.promise) // B 的更早页（在飞）
    await act(async () => { await m.result.current.select(A) })
    let loadA!: Promise<void>
    act(() => { loadA = m.result.current.loadOlder() })
    expect(m.result.current.loadingOlder).toBe(true)

    await act(async () => { await m.result.current.select(B) })
    let loadB!: Promise<void>
    act(() => { loadB = m.result.current.loadOlder() })
    expect(m.result.current.loadingOlder).toBe(true)

    await act(async () => { await m.result.current.select(A) })
    act(() => { void m.result.current.loadOlder() })
    // A 的请求还在飞：界面必须报「正在加载更早」，且不能再发第二条（第二条注定落不了屏）。
    expect(m.result.current.loadingOlder).toBe(true)
    expect(m.deps.detail).toHaveBeenCalledTimes(4)

    await act(async () => {
      slowA.resolve({ ...detailOf('a'), blocks: [userBlock('A早', '0')], olderCursor: null })
      slowB.resolve({ ...detailOf('b'), blocks: [userBlock('B早', '0')], olderCursor: null })
      await Promise.all([loadA, loadB])
    })
    expect(m.result.current.detail).toEqual({
      kind: 'ready',
      entry: A,
      detail: { ...tailA, blocks: [userBlock('A早', '0'), userBlock('A尾', '7')], olderCursor: null },
    })
    expect(m.result.current.loadingOlder).toBe(false)
  })

  it('loadOlder 失败：原文单独上屏，不把已读到的正文按成 failed；切走即清', async () => {
    const m = mount({ entries: [A, B] })
    const tail = { ...detailOf('a'), blocks: [userBlock('尾', '5')], olderCursor: 5 }
    m.deps.detail.mockResolvedValueOnce(tail)
    await act(async () => {
      await m.result.current.select(A)
    })

    m.deps.detail.mockRejectedValueOnce(new Error('更早的页读不出来'))
    await act(async () => {
      await m.result.current.loadOlder()
    })
    expect(m.result.current.detail).toEqual({ kind: 'ready', entry: A, detail: tail })
    expect(m.result.current.olderFailure).toBe('更早的页读不出来')
    expect(m.result.current.loadingOlder).toBe(false)

    await act(async () => {
      await m.result.current.select(B)
    })
    expect(m.result.current.olderFailure).toBeNull()
  })

  it('olderCursor 为 null 时 loadOlder 什么都不做', async () => {
    const m = mount({ entries: [A] })
    await act(async () => {
      await m.result.current.select(A)
    })
    await act(async () => {
      await m.result.current.loadOlder()
    })
    expect(m.deps.detail).toHaveBeenCalledTimes(1)
    expect(m.result.current.loadingOlder).toBe(false)
  })

  it('A 的更早页晚到不盖掉 B：选中切走后旧页结果不落屏', async () => {
    const m = mount({ entries: [A, B] })
    const tailA = { ...detailOf('a'), blocks: [userBlock('A尾', '7')], olderCursor: 7 }
    m.deps.detail.mockResolvedValueOnce(tailA)
    await act(async () => {
      await m.result.current.select(A)
    })

    const slow = deferred<TrashDetailLike>()
    m.deps.detail.mockImplementationOnce(() => slow.promise)
    let loading!: Promise<void>
    act(() => {
      loading = m.result.current.loadOlder()
    })
    await act(async () => {
      await m.result.current.select(B)
    })
    await act(async () => {
      slow.resolve({ ...detailOf('a'), blocks: [userBlock('A早', '0')], olderCursor: null })
      await loading
    })

    expect(m.result.current.selectedId).toBe('b')
    expect(m.result.current.detail).toEqual({ kind: 'ready', entry: B, detail: detailOf('b') })
    expect(m.result.current.olderFailure).toBeNull()
    expect(m.result.current.loadingOlder).toBe(false)
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

  it('选中的那条被清掉后，下一拍自动接住新清单第一条（自动选中只认「尚未选中」）', async () => {
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

  it('单条恢复后清单重读一次：控制器只交"重读"这个动作，不再把 outcome 交给 query 判重扫', async () => {
    const child = mount({ entries: [CHILD] })
    child.deps.applyOutcomes.mockResolvedValueOnce(restoreOutcomes(['child']))
    const refreshBefore = child.refreshAfterWrite.mock.calls.length
    await act(async () => {
      await child.result.current.restore(CHILD)
    })
    expect(child.refreshAfterWrite).toHaveBeenCalledTimes(refreshBefore + 1)
    // 孤儿重扫判据（`needsOrphanRescan`）2026-10-27 移出面板：孤儿检查是设置页维护卡的手动动作。
    expect(child.refreshAfterWrite.mock.calls.at(-1)).toEqual([])

    const root = mount({ entries: [A] })
    root.deps.applyOutcomes.mockResolvedValueOnce(restoreOutcomes(['a']))
    await act(async () => {
      await root.result.current.restore(A)
    })
    expect(root.refreshAfterWrite.mock.calls.at(-1)).toEqual([])
  })

  it('批量恢复后清单重读一次，同样不把 outcome 交给 query', async () => {
    const withChild = mount({ entries: [A, CHILD] })
    withChild.deps.applyOutcomes.mockResolvedValueOnce(restoreOutcomes(['a', 'child']))
    const refreshBefore = withChild.refreshAfterWrite.mock.calls.length
    await act(async () => {
      await withChild.result.current.confirmApply('restore', ['a', 'child'])
    })
    expect(withChild.refreshAfterWrite).toHaveBeenCalledTimes(refreshBefore + 1)
    expect(withChild.refreshAfterWrite.mock.calls.at(-1)).toEqual([])
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

  it('purge 结算把附件统计交给 query：成功交摘要那半，顶层失败交 undefined 清旧提示', async () => {
    const m = mount({ entries: [A] })
    m.deps.applyOutcomes.mockResolvedValueOnce([
      {
        id: 'a', action: 'purge', ok: true,
        value: { removed: 1, freedBytes: 1, attachments: { removed: 2, freedBytes: 20, failed: 1 } },
      },
    ])

    await act(async () => {
      await m.result.current.confirmApply('purge', ['a'])
    })
    expect(m.noteAttachmentCleanup).toHaveBeenCalledWith({ removed: 2, freedBytes: 20, failed: 1 })

    // 顶层失败 = 没拿到信封，不能断言这一趟清过附件 ⇒ 交 undefined，旧提示一起收掉。
    m.deps.applyOutcomes.mockRejectedValueOnce(new Error('路由自检失败'))
    await act(async () => {
      await m.result.current.confirmApply('purge', ['a'])
    })
    expect(m.noteAttachmentCleanup).toHaveBeenLastCalledWith(undefined)
  })

  it('restore 不碰附件提示：那一趟没有附件读数，旧提示归下一次 purge / 清空', async () => {
    const m = mount({ entries: [A] })
    m.deps.applyOutcomes.mockResolvedValueOnce(restoreOutcomes(['a']))

    await act(async () => {
      await m.result.current.confirmApply('restore', ['a'])
    })
    expect(m.noteAttachmentCleanup).not.toHaveBeenCalled()
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

  // 与单条 `restore` 同款：再点一次先清掉这一趟碰到的那几行旧失败，别让上一次原文挂着。
  it('confirmApply 再点一次先清这一趟的旧失败：重试成功就该没有那一行', async () => {
    const m = mount({ entries: [A, B] })
    m.deps.applyOutcomes.mockResolvedValueOnce(purgeOutcomes(['a', 'b'], ['b'], '第二条删不掉'))
    await act(async () => {
      await m.result.current.confirmApply('purge', ['a', 'b'])
    })
    expect(m.result.current.actionFailure).toEqual({ b: '第二条删不掉' })

    m.deps.applyOutcomes.mockResolvedValueOnce(purgeOutcomes(['a', 'b']))
    await act(async () => {
      await m.result.current.confirmApply('purge', ['a', 'b'])
    })
    expect(m.result.current.actionFailure).toEqual({})
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
  it('挂载读一次清单；失效通告只戳写后刷新', async () => {
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
