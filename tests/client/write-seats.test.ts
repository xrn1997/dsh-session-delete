import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplyOutcome, ApplyValueByAction } from '../../src/shared/wire.js'

const mocks = vi.hoisted(() => ({
  invalidateTrash: vi.fn(),
  publishUndoNotice: vi.fn(),
  publishUndoBatchNotice: vi.fn(),
  dismissUndoNotice: vi.fn(),
  forgetMainView: vi.fn(),
  afterDelete: vi.fn(),
  afterRestore: vi.fn(),
}))
vi.mock('../../src/client/trash-store.js', () => ({ invalidateTrash: mocks.invalidateTrash }))
vi.mock('../../src/client/undo-toast.js', () => ({
  publishUndoNotice: mocks.publishUndoNotice,
  publishUndoBatchNotice: mocks.publishUndoBatchNotice,
  dismissUndoNotice: mocks.dismissUndoNotice,
}))
vi.mock('../../src/client/main-view.js', () => ({
  afterDelete: mocks.afterDelete,
  afterRestore: mocks.afterRestore,
  forgetMainView: mocks.forgetMainView,
}))

import type { BusyGate } from '../../src/client/busy-gate.js'
import { outcomes, trashRow } from './support/outcomes.js'
import {
  cleanOrphansFromPanel, deleteSessionFromMenu, deleteSessionsFromBatch,
  purgeFromPanel, restoreFromPanel, restoreFromUndo,
} from '../../src/client/write-seats.js'

const valueOf = <A extends 'delete' | 'restore'>(action: A, id: string, v: ApplyValueByAction[A]): ApplyOutcome =>
  outcomes(action, [id], { [id]: { value: v } })[0]!
/** 一枚不改变时序的闸：座位仍必须在里面跑，但用例不关心 busy 的中间态（那是 busy-gate 的测试）。 */
const gate = (): BusyGate => {
  // `vi.fn` 的 `Mock` 会把泛型签名塌成非泛型（`Promise<unknown>`），所以按 `BusyGate['around']` 收一次窄。
  const around = vi.fn(async <T,>(task: () => Promise<T>): Promise<T> => task()) as unknown as BusyGate['around']
  return { busy: false, around }
}

beforeEach(() => vi.clearAllMocks())

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
        outcomes('delete', ['s2'], { s2: { message: '删不动' } })[0]!,
      ]),
    }
    const failures = await deleteSessionsFromBatch(deps, ['s1', 's2'], gate())
    expect(mocks.publishUndoBatchNotice).toHaveBeenCalledWith({ entryIds: ['e1'], n: 1 })
    expect([...failures.entries()]).toEqual([['s2', '删不动']])
  })

  it('一条都没落地：不发布没有落点的撤销横幅', async () => {
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<ApplyOutcome[]> => [
        outcomes('delete', ['s1'], { s1: { message: '删不动' } })[0]!,
      ]),
    }
    await deleteSessionsFromBatch(deps, ['s1'], gate())
    expect(mocks.publishUndoBatchNotice).not.toHaveBeenCalled()
  })
})

describe('外部恢复座位', () => {
  it('只交 invalidate；主视图重开归 settlement', async () => {
    const deps = { applyOutcomes: vi.fn(async (): Promise<ApplyOutcome[]> => [valueOf('restore', 'e1', trashRow('e1', 's1'))]) }
    await restoreFromUndo(deps, { ids: ['e1'], single: true })
    expect(mocks.invalidateTrash).toHaveBeenCalledTimes(1)
    expect(mocks.afterRestore).toHaveBeenCalledWith(['s1'])
    expect(mocks.forgetMainView).not.toHaveBeenCalled()
    // 外部撤销座位**不交** dismissUndo：部分失败的回滚要让失败原文留在同一条横幅上。
    expect(mocks.dismissUndoNotice).not.toHaveBeenCalled()
  })
})

describe('面板座位', () => {
  it('恢复：闸包住整趟、dismiss/forget/cache/refresh 都接上，already-gone 从 entries 取 sessionId', async () => {
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<ApplyOutcome[]> => [
        valueOf('restore', 'e1', trashRow('e1', 's1')),
        outcomes('restore', ['e2'], { e2: { value: null } })[0]!,
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
        outcomes('purge', ['e1'], { e1: { value: { removed: 1, freedBytes: 1 } } })[0]!,
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

  it('无主子会话清理：闸 + refresh，不碰回收站失效/撤销', async () => {
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<ApplyOutcome[]> => [
        outcomes('orphan-clean', ['r1'], { r1: { value: { removed: 1, freedBytes: 1 } } })[0]!,
      ]),
    }
    const g = gate()
    const refreshAfterWrite = vi.fn(async () => {})
    await cleanOrphansFromPanel({ deps, ids: ['r1'], gate: g, refreshAfterWrite })
    expect(g.around).toHaveBeenCalledTimes(1)
    expect(mocks.invalidateTrash).not.toHaveBeenCalled()
    expect(mocks.dismissUndoNotice).not.toHaveBeenCalled()
    expect(refreshAfterWrite).toHaveBeenCalledTimes(1)
  })
})
