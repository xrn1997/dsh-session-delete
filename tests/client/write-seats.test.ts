import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplyOutcome, ApplyValueByAction } from '../../src/shared/wire.js'
import { must, pick } from '../support/fixture.js'

const mocks = vi.hoisted(() => ({
  invalidateTrash: vi.fn(),
  publishUndoNotice: vi.fn(),
  publishUndoBatchNotice: vi.fn(),
  dismissUndoNotice: vi.fn(),
  failNotice: vi.fn(),
  clearUndoNotice: vi.fn(),
  forgetMainView: vi.fn(),
  afterDelete: vi.fn(),
  afterRestore: vi.fn(),
}))
vi.mock('../../src/client/trash-store.js', () => ({ invalidateTrash: mocks.invalidateTrash }))
// 通知台只套一层**调用记录**，实现仍是真品（`mockImplementation` 挂在下面那几个 hoisted spy 上）：
// `ownsNotice` 按引用比 store 里的那一条，连 store 一起替身掉的话，
// 「restoreFromUndo 拥有整趟」断言的就是替身自己（判据没被验过）。
vi.mock('../../src/client/undo-notices.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/client/undo-notices.js')>()
  mocks.publishUndoNotice.mockImplementation(actual.publishUndoNotice)
  mocks.publishUndoBatchNotice.mockImplementation(actual.publishUndoBatchNotice)
  mocks.dismissUndoNotice.mockImplementation(actual.dismissUndoNotice)
  mocks.failNotice.mockImplementation(actual.failNotice)
  mocks.clearUndoNotice.mockImplementation(actual.clearUndoNotice)
  return {
    ...actual,
    publishUndoNotice: mocks.publishUndoNotice,
    publishUndoBatchNotice: mocks.publishUndoBatchNotice,
    dismissUndoNotice: mocks.dismissUndoNotice,
    failNotice: mocks.failNotice,
    clearUndoNotice: mocks.clearUndoNotice,
  }
})
vi.mock('../../src/client/main-view.js', () => ({
  afterDelete: mocks.afterDelete,
  afterRestore: mocks.afterRestore,
  forgetMainView: mocks.forgetMainView,
}))

import type { BusyGate } from '../../src/client/busy-gate.js'
import { zhTranslate } from '../../src/client/copy.js'
import {
  publishUndoBatchNotice, publishUndoNotice, resetUndoNotice, useUndoNotice,
  type UndoNotice,
} from '../../src/client/undo-notices.js'
import { outcomes, trashRow } from './support/outcomes.js'
import {
  deleteSessionFromMenu, deleteSessionsFromBatch,
  purgeFromPanel, restoreFromPanel, restoreFromUndo,
} from '../../src/client/write-seats.js'

const valueOf = <A extends 'delete' | 'restore'>(action: A, id: string, v: ApplyValueByAction[A]): ApplyOutcome =>
  pick(outcomes(action, [id], { [id]: { value: v } }), 0)
/** 一枚不改变时序的闸：座位仍必须在里面跑，但用例不关心 busy 的中间态（那是 busy-gate 的测试）。 */
const gate = (): BusyGate => {
  // `vi.fn` 的 `Mock` 会把泛型签名塌成非泛型（`Promise<unknown>`），所以按 `BusyGate['around']` 收一次窄。
  const around = vi.fn(async <T,>(task: () => Promise<T>): Promise<T> => task()) as unknown as BusyGate['around']
  return { busy: false, around }
}

beforeEach(() => {
  vi.clearAllMocks()
  // 通知台是模块级 store：不清零会把上一条横幅（含 seq）带进下一个用例。
  resetUndoNotice()
})

describe('删除座位', () => {
  it('单删成功：失效 + 按落地条目发布撤销，失败为空', async () => {
    const g = gate()
    const deps = { applyOutcomes: vi.fn(async (): Promise<ApplyOutcome[]> => [valueOf('delete', 's1', trashRow('e1', 's1'))]) }
    const failure = await deleteSessionFromMenu(deps, { sessionId: 's1', title: '标题' }, g)
    expect(g.around).toHaveBeenCalledTimes(1)
    expect(mocks.invalidateTrash).toHaveBeenCalledTimes(1)
    expect(mocks.publishUndoNotice).toHaveBeenCalledWith({ entryId: 'e1', title: '标题' })
    expect(failure).toBeNull()
  })

  it('批量删除：撤销名单只收 ok 条目的 entryId，失败表按 id 回', async () => {
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<ApplyOutcome[]> => [
        valueOf('delete', 's1', trashRow('e1', 's1')),
        pick(outcomes('delete', ['s2'], { s2: { message: '删不动' } }), 0),
      ]),
    }
    const failures = await deleteSessionsFromBatch(deps, ['s1', 's2'], gate())
    expect(mocks.publishUndoBatchNotice).toHaveBeenCalledWith({ entryIds: ['e1'], n: 1 })
    // 这枚闸是新的、没被占 ⇒ 座位一定跑完并交出失败表（被挡回那一路见下面「闸在飞时」那条）。
    expect([...must(failures, '失败表').entries()]).toEqual([['s2', '删不动']])
  })

  it('一条都没落地：不发布没有落点的撤销横幅', async () => {
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<ApplyOutcome[]> => [
        pick(outcomes('delete', ['s1'], { s1: { message: '删不动' } }), 0),
      ]),
    }
    await deleteSessionsFromBatch(deps, ['s1'], gate())
    expect(mocks.publishUndoBatchNotice).not.toHaveBeenCalled()
  })
})

describe('restoreFromUndo 拥有整趟', () => {
  /** 一条手造的撤销现场（不在 store 里）：ids 早退这类不碰通知台的路径不需要真现场。 */
  const oneNotice = (entryId: string): UndoNotice => ({ seq: 1, kind: 'one', entryId, title: '标题' })

  it('顶层失败：failNotice 把原因换到同一条横幅（seq 递增归通知台，横幅不静默）', async () => {
    const view = renderHook(() => useUndoNotice())
    act(() => { publishUndoNotice({ entryId: 'e1', title: '标题' }) })
    const current = view.result.current
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<ApplyOutcome[]> => {
        throw Object.assign(new Error('原项目目录已不在'), { code: 'sessiondelete/io' })
      }),
    }
    await act(async () => { await restoreFromUndo(deps, must(current, '撤销横幅'), zhTranslate) })
    expect(deps.applyOutcomes).toHaveBeenCalledWith('restore', ['e1'])
    expect(mocks.failNotice).toHaveBeenCalledWith(current, '原项目目录已不在')
    expect(view.result.current).toMatchObject({ kind: 'one', entryId: 'e1', failure: '原项目目录已不在' })
  })

  it('单条失败（只一条）：原文上屏，不套条数句', async () => {
    const view = renderHook(() => useUndoNotice())
    act(() => { publishUndoNotice({ entryId: 'e1', title: '标题' }) })
    const current = view.result.current
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<ApplyOutcome[]> =>
        outcomes('restore', ['e1'], { e1: { message: '会话目录不在盘上' } })),
    }
    await act(async () => { await restoreFromUndo(deps, must(current, '撤销横幅'), zhTranslate) })
    expect(mocks.failNotice).toHaveBeenCalledWith(current, '会话目录不在盘上')
  })

  it('单条形走 single 读法：null 不冒充幂等成功，折成协议错上屏', async () => {
    const view = renderHook(() => useUndoNotice())
    act(() => { publishUndoNotice({ entryId: 'e1', title: '标题' }) })
    const current = view.result.current
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<ApplyOutcome[]> =>
        outcomes('restore', ['e1'], { e1: { value: null } })),
    }
    await act(async () => { await restoreFromUndo(deps, must(current, '撤销横幅'), zhTranslate) })
    expect(mocks.failNotice).toHaveBeenCalledWith(current, expect.stringContaining('单条动作回了幂等空值'))
  })

  it('逐条多败：横幅换 undo.failedBatch 句（条数 + 去重原因 join），不是只显第一条', async () => {
    const view = renderHook(() => useUndoNotice())
    const entryIds = ['e1', 'e2', 'e3']
    act(() => { publishUndoBatchNotice({ entryIds, n: 3 }) })
    const current = view.result.current
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<ApplyOutcome[]> => [
        pick(outcomes('restore', ['e1'], { e1: { message: '会话正在运行', code: 'sessiondelete/live' } }), 0),
        pick(outcomes('restore', ['e2'], { e2: { message: '项目目录不在', code: 'sessiondelete/project-missing' } }), 0),
        pick(outcomes('restore', ['e3'], { e3: { message: '会话正在运行', code: 'sessiondelete/live' } }), 0),
      ]),
    }
    await act(async () => { await restoreFromUndo(deps, must(current, '撤销横幅'), zhTranslate) })
    expect(deps.applyOutcomes).toHaveBeenCalledWith('restore', entryIds)
    expect(mocks.failNotice).toHaveBeenCalledWith(current, '3 条会话未能撤销：会话正在运行 · 项目目录不在')
  })

  it('成功且横幅仍是自己：invalidate + settlement 重开 + 收掉自己，不传 dismissUndo', async () => {
    const view = renderHook(() => useUndoNotice())
    act(() => { publishUndoNotice({ entryId: 'e1', title: '标题' }) })
    const current = view.result.current
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<ApplyOutcome[]> => [valueOf('restore', 'e1', trashRow('e1', 's1'))]),
    }
    await act(async () => { await restoreFromUndo(deps, must(current, '撤销横幅'), zhTranslate) })
    expect(mocks.invalidateTrash).toHaveBeenCalledTimes(1)
    // 主视图重开归 settlement（外部恢复座位不带 panelSeat）。
    expect(mocks.afterRestore).toHaveBeenCalledWith(['s1'])
    expect(mocks.forgetMainView).not.toHaveBeenCalled()
    // 座位不传 dismissUndo：部分失败的回滚要让失败原文留在同一条横幅上。
    expect(mocks.dismissUndoNotice).not.toHaveBeenCalled()
    expect(mocks.clearUndoNotice).toHaveBeenCalledTimes(1)
  })

  it('成功但期间被新删除覆盖：不动别人的横幅（ownsNotice 判据）', async () => {
    const view = renderHook(() => useUndoNotice())
    act(() => { publishUndoNotice({ entryId: 'e1', title: '标题' }) })
    const old = view.result.current
    let resolveApply!: (value: ApplyOutcome[]) => void
    const deps = {
      applyOutcomes: vi.fn(() => new Promise<ApplyOutcome[]>((resolve) => { resolveApply = resolve })),
    }
    let trip!: Promise<void>
    act(() => { trip = restoreFromUndo(deps, must(old, '撤销横幅（旧那一条）'), zhTranslate) })
    // 撤销在飞：来了新删除，通知台换成新横幅。
    act(() => { publishUndoNotice({ entryId: 'e2', title: '新标题' }) })
    const fresh = view.result.current
    await act(async () => { resolveApply([valueOf('restore', 'e1', trashRow('e1', 's1'))]); await trip })
    expect(mocks.clearUndoNotice).not.toHaveBeenCalled()
    expect(mocks.failNotice).not.toHaveBeenCalled()
    // store 里仍是新那条（同一引用 ⇒ 旧那一趟没有改写它）。
    expect(view.result.current).toBe(fresh)
  })

  it('单条形但落点是空串：早退——不发 /apply、不动横幅', async () => {
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [])
    await restoreFromUndo({ applyOutcomes }, oneNotice(''), zhTranslate)
    expect(applyOutcomes).not.toHaveBeenCalled()
    expect(mocks.failNotice).not.toHaveBeenCalled()
    expect(mocks.clearUndoNotice).not.toHaveBeenCalled()
  })
})

describe('面板座位', () => {
  it('恢复：闸包住整趟、dismiss/forget/cache/refresh 都接上，already-gone 从 entries 取 sessionId', async () => {
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<ApplyOutcome[]> => [
        valueOf('restore', 'e1', trashRow('e1', 's1')),
        pick(outcomes('restore', ['e2'], { e2: { value: null } }), 0),
      ]),
    }
    const g = gate()
    const refreshAfterWrite = vi.fn(async () => {})
    const clearDetailCache = vi.fn()
    const outcome = await restoreFromPanel({
      deps, ids: ['e1', 'e2'],
      entries: [trashRow('e1', 's1'), trashRow('e2', 's2')],
      gate: g, refreshAfterWrite, clearDetailCache,
    })
    expect(g.around).toHaveBeenCalledTimes(1)
    expect(mocks.dismissUndoNotice).toHaveBeenCalledWith(['e1', 'e2'])
    expect(mocks.forgetMainView).toHaveBeenCalledWith(['s1', 's2'])
    expect(mocks.afterRestore).not.toHaveBeenCalled()
    expect(clearDetailCache).toHaveBeenCalledWith(['e1', 'e2'])
    expect(refreshAfterWrite).toHaveBeenCalledWith(outcome)
  })

  it('彻底删除：anySuccess 时熄灭撤销横幅并清详情缓存（这条以前被静默忽略）', async () => {
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<ApplyOutcome[]> => [
        pick(outcomes('purge', ['e1'], { e1: { value: { removed: 1, freedBytes: 1 } } }), 0),
      ]),
    }
    const clearDetailCache = vi.fn()
    await purgeFromPanel({
      deps, ids: ['e1'], gate: gate(),
      refreshAfterWrite: vi.fn(async () => {}), clearDetailCache,
    })
    expect(mocks.dismissUndoNotice).toHaveBeenCalledWith(['e1'])
    expect(clearDetailCache).toHaveBeenCalledWith(['e1'])
    expect(mocks.forgetMainView).not.toHaveBeenCalled()
  })
})

// 连点时第二趟被同步挡回（真闸的判据住 `busy-gate.ts`）：这一趟**没跑**，座位就得交出「没跑」。
// 曾经挡回的是 `undefined as T`——调用方照 `outcome.failures` 读，连点反而当场 TypeError。
describe('座位 · 闸在飞时这一趟不跑', () => {
  /** 已被占住的闸：只注入真闸挡回时的那个形状（任务一次都不执行）。 */
  const flying = (): BusyGate => ({
    busy: true,
    around: vi.fn(async () => undefined),
  })

  it('三个交回 outcome 的座位都回 undefined，单删座位回「这一趟没跑」；一次都不发 /apply、不结算', async () => {
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [])
    const deps = { applyOutcomes }
    const g = flying()

    await expect(deleteSessionsFromBatch(deps, ['s1'], g)).resolves.toBeUndefined()
    await expect(purgeFromPanel({
      deps, ids: ['e1'], gate: g, refreshAfterWrite: vi.fn(async () => {}), clearDetailCache: vi.fn(),
    })).resolves.toBeUndefined()
    await expect(restoreFromPanel({
      deps, ids: ['e1'], entries: null, gate: g, refreshAfterWrite: vi.fn(async () => {}), clearDetailCache: vi.fn(),
    })).resolves.toBeUndefined()
    // 单删座位不许把「没跑」折成 `null`（那是「跑了、这条没有失败」，确认框会据此收框）。
    await expect(deleteSessionFromMenu(deps, { sessionId: 's1', title: 'T' }, g)).resolves.toBeUndefined()

    expect(applyOutcomes).not.toHaveBeenCalled()
    expect(mocks.invalidateTrash).not.toHaveBeenCalled()
    expect(mocks.publishUndoNotice).not.toHaveBeenCalled()
    expect(mocks.publishUndoBatchNotice).not.toHaveBeenCalled()
  })
})
