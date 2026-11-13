import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplyAction, ApplyOutcome, ApplyValueByAction } from '../../src/shared/wire.js'
import { must, pick } from '../support/fixture.js'

const mocks = vi.hoisted(() => {
  /** 发生顺序：收尾钩子按发生先后落进这条——收尾顺序的断言是**一条序列**，不是散点断言。 */
  const order: string[] = []
  return {
    order,
    invalidateTrash: vi.fn(() => { order.push('invalidate') }),
    forgetMainView: vi.fn((ids: readonly string[]) => { order.push(`forget:${ids.join(',')}`) }),
    afterDelete: vi.fn((ids: readonly string[]) => { order.push(`afterDelete:${ids.join(',')}`) }),
    afterRestore: vi.fn((ids: readonly string[]) => { order.push(`afterRestore:${ids.join(',')}`) }),
    publishUndoNotice: vi.fn(),
    publishUndoBatchNotice: vi.fn(),
    dismissUndoNotice: vi.fn(),
    failNotice: vi.fn(),
    clearUndoNotice: vi.fn(),
  }
})
vi.mock('../../src/client/trash-store.js', () => ({
  invalidateTrash: mocks.invalidateTrash,
  // 复位册（`reset-client-state.ts`）会调它；这份用例不碰清单现场，给一个空实现即可。
  resetTrashStore: () => undefined,
}))
// 通知台只套一层**调用记录**，实现仍是真品（`mockImplementation` 挂在下面那几个 hoisted spy 上）：
// `ownsNotice` 按引用比 store 里的那一条，连 store 一起替身掉的话，
// 「restoreFromUndo 拥有整趟」断言的就是替身自己（判据没被验过）。
// 发布与熄灭同时落 `order`：收尾序列要知道它们排在跨槽位收尾之后的哪一格。
vi.mock('../../src/client/undo-notices.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/client/undo-notices.js')>()
  mocks.publishUndoNotice.mockImplementation((input: Parameters<typeof actual.publishUndoNotice>[0]) => {
    mocks.order.push(`publish:${input.entryId}`)
    return actual.publishUndoNotice(input)
  })
  mocks.publishUndoBatchNotice.mockImplementation((input: Parameters<typeof actual.publishUndoBatchNotice>[0]) => {
    mocks.order.push(`publishBatch:${input.entryIds.join(',')}:${input.n}`)
    return actual.publishUndoBatchNotice(input)
  })
  mocks.dismissUndoNotice.mockImplementation((ids: Parameters<typeof actual.dismissUndoNotice>[0]) => {
    mocks.order.push(`dismiss:${ids.join(',')}`)
    return actual.dismissUndoNotice(ids)
  })
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
  // 复位册（`reset-client-state.ts`）会调它；重开记忆不在这份用例的断言面里。
  resetMainView: () => undefined,
}))
// 详情账本的清理也只套一层调用记录、实现仍是真品（`writeTrashDetail` / `readCachedTrashDetail` /
// 复位册都照旧走真 store）：外部恢复座位交的是模块真品，收尾序列要知道账本清理排在哪一格。
vi.mock('../../src/client/trash-snapshot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/client/trash-snapshot.js')>()
  const writeSucceeded = (ids: readonly string[]): void => {
    mocks.order.push(`ledger:${ids.join(',')}`)
    actual.writeSucceeded(ids)
  }
  return { ...actual, writeSucceeded }
})

import type { BusyGate } from '../../src/client/busy-gate.js'
import { useArchiveRevision } from '../../src/client/archive-store.js'
import { zhTranslate } from '../../src/client/copy.js'
import { applyOne, type RemoteOutcome, type TrashDetailLike } from '../../src/client/remote.js'
import { readCachedTrashDetail, writeTrashDetail } from '../../src/client/trash-snapshot.js'
import {
  publishUndoBatchNotice, publishUndoNotice, useUndoNotice,
  type UndoNotice,
} from '../../src/client/undo-notices.js'
import { outcomes, trashRow } from './support/outcomes.js'
import { applyDeps, remoteFail, remoteOk } from './support/fake-remote.js'
import { resetClientState } from '../../src/client/reset-client-state.js'
import {
  deleteSessionFromMenu, deleteSessionsFromBatch,
  purgeFromPanel, restoreFromPanel, restoreFromUndo, unarchiveFromArchiveTab,
} from '../../src/client/write-seats.js'

const valueOf = <A extends 'delete' | 'restore'>(action: A, id: string, v: ApplyValueByAction[A]): ApplyOutcome =>
  pick(outcomes(action, [id], { [id]: { value: v } }), 0)
const detailOf = (entryId: string): TrashDetailLike => ({
  entryId, cwd: '', createdAt: 0, lastActivity: 0, logTitle: '', models: [],
  turnCount: 0, userMessageCount: 0, assistantMessageCount: 0, toolCallCount: 0,
  injectedCount: 0, blocks: [], olderCursor: null,
})
/** 一枚不改变时序的闸：座位仍必须在里面跑，但用例不关心 busy 的中间态（那是 busy-gate 的测试）。 */
const gate = (): BusyGate => {
  // 闸的落地面是判别联合（`blocked` / `ran`）；用例只关心"放行"，仍用 `vi.fn` 记调用次数。
  const around = vi.fn(async <T,>(task: () => Promise<T>) => ({ kind: 'ran' as const, value: await task() })) as unknown as BusyGate['around']
  return { busy: false, around }
}

beforeEach(() => {
  vi.clearAllMocks()
  // 通知台是模块级 store：不清零会把上一条横幅（含 seq）带进下一个用例。
  // 模块级现场（跨用例存活）：一条复位口收全部。
  resetClientState()
  // 顺序载体也归零：上一条用例的收尾序列不许混进本条的断言。
  mocks.order.length = 0
})

describe('删除座位', () => {
  it('单删成功：失效 + 按落地条目发布撤销，失败为空', async () => {
    const g = gate()
    const deps = { applyOutcomes: vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk([valueOf('delete', 's1', trashRow('e1', 's1'))])) }
    const failure = await deleteSessionFromMenu(applyDeps(deps.applyOutcomes), { sessionId: 's1', title: '标题' }, g)
    expect(g.around).toHaveBeenCalledTimes(1)
    expect(mocks.invalidateTrash).toHaveBeenCalledTimes(1)
    expect(mocks.publishUndoNotice).toHaveBeenCalledWith({ entryId: 'e1', title: '标题', archived: false })
    expect(failure).toEqual({ kind: 'ran', value: null })
  })

  it('批量删除：撤销名单只收 ok 条目的 entryId，失败表按 id 回', async () => {
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk([
        valueOf('delete', 's1', trashRow('e1', 's1')),
        pick(outcomes('delete', ['s2'], { s2: { message: '删不动' } }), 0),
      ])),
    }
    const result = await deleteSessionsFromBatch(applyDeps(deps.applyOutcomes), ['s1', 's2'], gate())
    expect(mocks.publishUndoBatchNotice).toHaveBeenCalledWith({ entryIds: ['e1'], n: 1, archived: false })
    // 这枚闸是新的、没被占 ⇒ 座位一定跑完并交出失败表（被挡回那一路见下面「闸在飞时」那条）。
    expect(result).toEqual({ kind: 'ran', value: new Map([['s2', '删不动']]) })
  })

  it('一条都没落地：不发布没有落点的撤销横幅', async () => {
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk([
        pick(outcomes('delete', ['s1'], { s1: { message: '删不动' } }), 0),
      ])),
    }
    await deleteSessionsFromBatch(applyDeps(deps.applyOutcomes), ['s1'], gate())
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
      applyOutcomes: vi.fn(async () => remoteFail({ code: 'sessiondelete/io', message: '原项目目录已不在' })),
    }
    await act(async () => { await restoreFromUndo(applyDeps(deps.applyOutcomes), must(current, '撤销横幅'), zhTranslate) })
    expect(deps.applyOutcomes).toHaveBeenCalledWith('restore', ['e1'])
    expect(mocks.failNotice).toHaveBeenCalledWith(current, '原项目目录已不在')
    expect(view.result.current).toMatchObject({ kind: 'one', entryId: 'e1', failure: '原项目目录已不在' })
  })

  it('单条失败（只一条）：原文上屏，不套条数句', async () => {
    const view = renderHook(() => useUndoNotice())
    act(() => { publishUndoNotice({ entryId: 'e1', title: '标题' }) })
    const current = view.result.current
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk(
        outcomes('restore', ['e1'], { e1: { message: '会话目录不在盘上' } }))),
    }
    await act(async () => { await restoreFromUndo(applyDeps(deps.applyOutcomes), must(current, '撤销横幅'), zhTranslate) })
    expect(mocks.failNotice).toHaveBeenCalledWith(current, '会话目录不在盘上')
  })

  it('单条形走 single 读法：null 不冒充幂等成功，折成协议错上屏', async () => {
    const view = renderHook(() => useUndoNotice())
    act(() => { publishUndoNotice({ entryId: 'e1', title: '标题' }) })
    const current = view.result.current
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk(
        outcomes('restore', ['e1'], { e1: { value: null } }))),
    }
    await act(async () => { await restoreFromUndo(applyDeps(deps.applyOutcomes), must(current, '撤销横幅'), zhTranslate) })
    expect(mocks.failNotice).toHaveBeenCalledWith(current, expect.stringContaining('单条动作回了幂等空值'))
  })

  it('逐条多败：横幅换 undo.failedBatch 句（条数 + 去重原因 join），不是只显第一条', async () => {
    const view = renderHook(() => useUndoNotice())
    const entryIds = ['e1', 'e2', 'e3']
    act(() => { publishUndoBatchNotice({ entryIds, n: 3 }) })
    const current = view.result.current
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk([
        pick(outcomes('restore', ['e1'], { e1: { message: '会话正在运行', code: 'sessiondelete/live' } }), 0),
        pick(outcomes('restore', ['e2'], { e2: { message: '项目目录不在', code: 'sessiondelete/project-missing' } }), 0),
        pick(outcomes('restore', ['e3'], { e3: { message: '会话正在运行', code: 'sessiondelete/live' } }), 0),
      ])),
    }
    await act(async () => { await restoreFromUndo(applyDeps(deps.applyOutcomes), must(current, '撤销横幅'), zhTranslate) })
    expect(deps.applyOutcomes).toHaveBeenCalledWith('restore', entryIds)
    expect(mocks.failNotice).toHaveBeenCalledWith(current, '3 条会话未能撤销：会话正在运行 · 项目目录不在')
  })

  it('成功且横幅仍是自己：invalidate + settlement 重开 + 收掉自己，不传 dismissUndo', async () => {
    const view = renderHook(() => useUndoNotice())
    act(() => { publishUndoNotice({ entryId: 'e1', title: '标题' }) })
    const current = view.result.current
    writeTrashDetail('e1', detailOf('e1'))
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk([valueOf('restore', 'e1', trashRow('e1', 's1'))])),
    }
    await act(async () => { await restoreFromUndo(applyDeps(deps.applyOutcomes), must(current, '撤销横幅'), zhTranslate) })
    expect(mocks.invalidateTrash).toHaveBeenCalledTimes(1)
    // 主视图重开归 settlement（外部恢复座位不带 panelSeat）。
    expect(mocks.afterRestore).toHaveBeenCalledWith(['s1'])
    expect(mocks.forgetMainView).not.toHaveBeenCalled()
    // 写成功即丢详情账本（ADR-0048 决定 4）：面板没挂载，这一趟也不许把已恢复条目的详情留在账本里。
    expect(readCachedTrashDetail('e1')).toBeUndefined()
    // 座位不传 dismissUndo：部分失败的回滚要让失败原文留在同一条横幅上。
    expect(mocks.dismissUndoNotice).not.toHaveBeenCalled()
    expect(mocks.clearUndoNotice).toHaveBeenCalledTimes(1)
  })

  it('部分失败：只丢成功条目的详情账本，失败那条留着（它还在回收站里）', async () => {
    const view = renderHook(() => useUndoNotice())
    act(() => { publishUndoBatchNotice({ entryIds: ['e1', 'e2'], n: 2 }) })
    const current = view.result.current
    writeTrashDetail('e1', detailOf('e1'))
    writeTrashDetail('e2', detailOf('e2'))
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk([
        valueOf('restore', 'e1', trashRow('e1', 's1')),
        pick(outcomes('restore', ['e2'], { e2: { message: '会话正在运行' } }), 0),
      ])),
    }
    await act(async () => { await restoreFromUndo(applyDeps(deps.applyOutcomes), must(current, '撤销横幅'), zhTranslate) })
    expect(readCachedTrashDetail('e1')).toBeUndefined()
    expect(readCachedTrashDetail('e2')).toBeDefined()
  })

  it('成功但期间被新删除覆盖：不动别人的横幅（ownsNotice 判据）', async () => {
    const view = renderHook(() => useUndoNotice())
    act(() => { publishUndoNotice({ entryId: 'e1', title: '标题' }) })
    const old = view.result.current
    let resolveApply!: (value: RemoteOutcome<ApplyOutcome[]>) => void
    const deps = {
      applyOutcomes: vi.fn(() => new Promise<RemoteOutcome<ApplyOutcome[]>>((resolve) => { resolveApply = resolve })),
    }
    let trip!: Promise<void>
    act(() => { trip = restoreFromUndo(applyDeps(deps.applyOutcomes), must(old, '撤销横幅（旧那一条）'), zhTranslate) })
    // 撤销在飞：来了新删除，通知台换成新横幅。
    act(() => { publishUndoNotice({ entryId: 'e2', title: '新标题' }) })
    const fresh = view.result.current
    await act(async () => { resolveApply(remoteOk([valueOf('restore', 'e1', trashRow('e1', 's1'))])); await trip })
    expect(mocks.clearUndoNotice).not.toHaveBeenCalled()
    expect(mocks.failNotice).not.toHaveBeenCalled()
    // store 里仍是新那条（同一引用 ⇒ 旧那一趟没有改写它）。
    expect(view.result.current).toBe(fresh)
  })

  it('单条形但落点是空串：早退——不发 /apply、不动横幅', async () => {
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk([]))
    await restoreFromUndo(applyDeps(applyOutcomes), oneNotice(''), zhTranslate)
    expect(applyOutcomes).not.toHaveBeenCalled()
    expect(mocks.failNotice).not.toHaveBeenCalled()
    expect(mocks.clearUndoNotice).not.toHaveBeenCalled()
  })
})

describe('面板座位', () => {
  it('恢复：闸包住整趟、dismiss/forget/账本/refresh 都接上，already-gone 从 entries 取 sessionId', async () => {
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk([
        valueOf('restore', 'e1', trashRow('e1', 's1')),
        pick(outcomes('restore', ['e2'], { e2: { value: null } }), 0),
      ])),
    }
    const g = gate()
    const refreshAfterWrite = vi.fn(async () => {})
    const writeSucceeded = vi.fn()
    const run = await restoreFromPanel({
      deps: applyDeps(deps.applyOutcomes), ids: ['e1', 'e2'],
      entries: [trashRow('e1', 's1'), trashRow('e2', 's2')],
      gate: g, refreshAfterWrite, writeSucceeded,
    })
    expect(g.around).toHaveBeenCalledTimes(1)
    expect(mocks.dismissUndoNotice).toHaveBeenCalledWith(['e1', 'e2'])
    expect(mocks.forgetMainView).toHaveBeenCalledWith(['s1', 's2'])
    expect(mocks.afterRestore).not.toHaveBeenCalled()
    expect(writeSucceeded).toHaveBeenCalledWith(['e1', 'e2'])
    expect(run.kind).toBe('ran')
    if (run.kind === 'ran') expect(refreshAfterWrite).toHaveBeenLastCalledWith(run.value)
  })

  it('彻底删除：anySuccess 时熄灭撤销横幅并清详情账本（这条以前被静默忽略）', async () => {
    const deps = {
      applyOutcomes: vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk([
        pick(outcomes('purge', ['e1'], { e1: { value: { removed: 1, freedBytes: 1 } } }), 0),
      ])),
    }
    const writeSucceeded = vi.fn()
    await purgeFromPanel({
      deps: applyDeps(deps.applyOutcomes), ids: ['e1'], gate: gate(),
      refreshAfterWrite: vi.fn(async () => {}), writeSucceeded,
    })
    expect(mocks.dismissUndoNotice).toHaveBeenCalledWith(['e1'])
    expect(writeSucceeded).toHaveBeenCalledWith(['e1'])
    expect(mocks.forgetMainView).not.toHaveBeenCalled()
  })
})

// 连点时第二趟被同步挡回（真闸的判据住 `busy-gate.ts`）：这一趟**没跑**，座位就得交出「没跑」。
// 曾经挡回的是 `undefined as T`——调用方照 `outcome.failures` 读，连点反而当场 TypeError。
describe('座位 · 闸在飞时这一趟不跑', () => {
  /** 已被占住的闸：只注入真闸挡回时的那个形状（任务一次都不执行）。 */
  const flying = (): BusyGate => ({
    busy: true,
    around: async () => ({ kind: 'blocked' }),
  })

  it('四个交回 outcome 的座位都回 blocked，单删座位也回 blocked；一次都不发 /apply、不结算', async () => {
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk([]))
    const deps = { applyOutcomes }
    const g = flying()
    const refresh = vi.fn()

    await expect(deleteSessionsFromBatch(applyDeps(deps.applyOutcomes), ['s1'], g)).resolves.toEqual({ kind: 'blocked' })
    await expect(purgeFromPanel({
      deps: applyDeps(deps.applyOutcomes), ids: ['e1'], gate: g, refreshAfterWrite: vi.fn(async () => {}), writeSucceeded: vi.fn(),
    })).resolves.toEqual({ kind: 'blocked' })
    await expect(restoreFromPanel({
      deps: applyDeps(deps.applyOutcomes), ids: ['e1'], entries: null, gate: g, refreshAfterWrite: vi.fn(async () => {}), writeSucceeded: vi.fn(),
    })).resolves.toEqual({ kind: 'blocked' })
    await expect(unarchiveFromArchiveTab({
      deps: applyDeps(deps.applyOutcomes), ids: ['s1'], gate: g, refresh,
    })).resolves.toEqual({ kind: 'blocked' })
    // 单删座位不许把「没跑」折成「跑了、这条没有失败」（那会让确认框据此收框）。
    await expect(deleteSessionFromMenu(applyDeps(deps.applyOutcomes), { sessionId: 's1', title: 'T' }, g)).resolves.toEqual({ kind: 'blocked' })

    expect(applyOutcomes).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(mocks.invalidateTrash).not.toHaveBeenCalled()
    expect(mocks.publishUndoNotice).not.toHaveBeenCalled()
    expect(mocks.publishUndoBatchNotice).not.toHaveBeenCalled()
  })
})

describe('删除/撤销座位 · 归档档的接线', () => {
  it('撤销横幅带 archived 事实：已归档会话删除后，文案说「回到归档」', async () => {
    const g = gate()
    const archivedRow = { ...trashRow('e1', 's1'), wasArchived: true }
    const deps = { applyOutcomes: vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk([valueOf('delete', 's1', archivedRow)])) }
    await deleteSessionFromMenu(applyDeps(deps.applyOutcomes), { sessionId: 's1', title: '标题' }, g)
    expect(mocks.publishUndoNotice).toHaveBeenCalledWith({ entryId: 'e1', title: '标题', archived: true })
  })

  it('restoreFromUndo 成功只戳回收站修订；归档档经同一条订阅失效（不做第二路直戳）', async () => {
    const revision = renderHook(() => useArchiveRevision())
    const deps = { applyOutcomes: vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk([valueOf('restore', 'e1', trashRow('e1', 's1'))])) }
    const notice: UndoNotice = { seq: 1, kind: 'one', entryId: 'e1', title: '标题' }
    await restoreFromUndo(applyDeps(deps.applyOutcomes), notice, zhTranslate)
    expect(mocks.invalidateTrash).toHaveBeenCalledTimes(1)
    // 归档可见性随该修订经 `useArchiveQuery` 的订阅重读；座位不再直戳 archive 修订。
    expect(revision.result.current).toBe(0)
  })
})

/**
 * 一次逐条 `/apply` 写入的生命周期经座位钉：apply → 解信封 → 判读 → 收尾 → refresh。
 * `ok` 只说**信封**成不成；逐条成败住在 `failures` 里，上屏归各写入面（这里是座位与它接的钩子）。
 * 收尾在 `refresh` 之前：列表重读看得到收尾后的现场——先后是一条顺序断言，不是两处散点。
 */
describe('写入生命周期（apply → 判读 → 收尾 → refresh）', () => {
  it('顶层失败：同一句原文铺到每个 id，不结算；refresh 交到失败 outcome', async () => {
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> =>
      remoteFail({ code: 'sessiondelete/io', message: '通道断了' }))
    const refreshAfterWrite = vi.fn(async () => {})
    const run = await restoreFromPanel({
      deps: applyDeps(applyOutcomes), ids: ['a', 'b'], entries: null, gate: gate(),
      refreshAfterWrite, writeSucceeded: vi.fn(),
    })
    expect(run.kind).toBe('ran')
    if (run.kind !== 'ran') return
    expect(run.value.ok).toBe(false)
    expect(run.value.action).toBe('restore')
    expect(run.value.ids).toEqual(['a', 'b'])
    expect([...run.value.failures.entries()]).toEqual([['a', '通道断了'], ['b', '通道断了']])
    // 顶层失败不结算：呈现钩子一次都不碰（信封成功支才交 settlement）。
    expect(mocks.dismissUndoNotice).not.toHaveBeenCalled()
    expect(mocks.afterRestore).not.toHaveBeenCalled()
    expect(refreshAfterWrite).toHaveBeenCalledTimes(1)
    expect(refreshAfterWrite).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })

  it('信封成功 + 逐条混合：settlement 先跑（交出落地名单），refresh 后跑——顺序 settle → refresh', async () => {
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk(
      outcomes('restore', ['a', 'b'], { a: { value: trashRow('a', 's1') }, b: { message: '删不动' } })))
    const refreshAfterWrite = vi.fn(async () => { mocks.order.push('refresh') })
    const writeSucceeded = vi.fn((ids: readonly string[]) => { mocks.order.push(`ledger:${ids.join(',')}`) })
    const run = await restoreFromPanel({
      deps: applyDeps(applyOutcomes), ids: ['a', 'b'], entries: null, gate: gate(),
      refreshAfterWrite, writeSucceeded,
    })
    expect(run.kind).toBe('ran')
    if (run.kind !== 'ran') return
    expect(run.value.ok).toBe(true)
    expect(run.value.action).toBe('restore')
    expect(run.value.ids).toEqual(['a', 'b'])
    expect(run.value.ok && run.value.summary.anySuccess).toBe(true)
    expect([...run.value.failures.entries()]).toEqual([['b', '删不动']])
    // settlement 从摘要算好落地名单再交座位：座位不自己读回执。
    expect(mocks.dismissUndoNotice).toHaveBeenCalledTimes(1)
    expect(mocks.dismissUndoNotice).toHaveBeenCalledWith(['a'])
    expect(refreshAfterWrite).toHaveBeenCalledTimes(1)
    expect(mocks.order).toEqual(['dismiss:a', 'forget:s1', 'ledger:a', 'refresh'])
  })

  it('请求了但没回：missing 原文进失败表，不当成功', async () => {
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk([]))
    const run = await restoreFromPanel({
      deps: applyDeps(applyOutcomes), ids: ['e1'], entries: null, gate: gate(),
      refreshAfterWrite: vi.fn(async () => {}), writeSucceeded: vi.fn(),
    })
    expect(run.kind).toBe('ran')
    if (run.kind !== 'ran') return
    expect(run.value.ok).toBe(true)
    expect(run.value.failures.get('e1')).toContain('批量通道没回这一条的结果：restore e1')
    // 一条都没落地 ⇒ 呈现钩子不跑。
    expect(mocks.dismissUndoNotice).not.toHaveBeenCalled()
  })

  it('全失败：跨槽位收尾仍跑（afterDelete → invalidate），不发布没有落点的撤销', async () => {
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk(
      outcomes('delete', ['e1'], { e1: { message: '删不动' } })))
    await deleteSessionsFromBatch(applyDeps(applyOutcomes), ['e1'], gate())
    // 信封成功 ⇒ 跨槽位照跑：批量删除的失效通告不能漏；空成功名单是合法输入。
    expect(mocks.order).toEqual(['afterDelete:', 'invalidate'])
    // 呈现钩子按 anySuccess 门拦住：一条都没落地时不发布撤销。
    expect(mocks.publishUndoBatchNotice).not.toHaveBeenCalled()
  })

  it('全失败也照样交 refresh：信封成功就走完整趟，呈现钩子被 anySuccess 拦住', async () => {
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk(
      outcomes('restore', ['e1'], { e1: { message: '删不动' } })))
    const refreshAfterWrite = vi.fn(async () => {})
    const run = await restoreFromPanel({
      deps: applyDeps(applyOutcomes), ids: ['e1'], entries: null, gate: gate(),
      refreshAfterWrite, writeSucceeded: vi.fn(),
    })
    expect(run.kind).toBe('ran')
    if (run.kind !== 'ran') return
    expect(run.value.ok).toBe(true)
    expect(run.value.ok && run.value.summary.anySuccess).toBe(false)
    expect(mocks.dismissUndoNotice).not.toHaveBeenCalled()
    expect(mocks.forgetMainView).not.toHaveBeenCalled()
    expect(refreshAfterWrite).toHaveBeenCalledTimes(1)
  })

  it('撤销名单只收落地行，条数含幂等带走——两个数可以不等', async () => {
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk(
      outcomes('delete', ['a', 'b'], { a: { value: trashRow('entry-a', 'session-a') }, b: { value: null } })))
    await deleteSessionsFromBatch(applyDeps(applyOutcomes), ['a', 'b'], gate())
    // `b` 被同批前一条带走（幂等 null）：算条数、不算撤销落点。
    expect(mocks.publishUndoBatchNotice).toHaveBeenCalledWith({ entryIds: ['entry-a'], n: 2, archived: false })
  })

  it('全部被同批前一条带走：不发布没有落点的撤销横幅（successIds 非空、落点为空）', async () => {
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk(
      outcomes('delete', ['a', 'b'])))
    await deleteSessionsFromBatch(applyDeps(applyOutcomes), ['a', 'b'], gate())
    // afterDelete 收到的正是 successIds：非空 ⇒ anySuccess 成立；没有 publish ⇒ 是落点为空被拦，
    // 不是被 anySuccess 门拦（那一路的序列见上一条用例）。
    expect(mocks.order).toEqual(['afterDelete:a,b', 'invalidate'])
    expect(mocks.publishUndoBatchNotice).not.toHaveBeenCalled()
  })

  it('single：N=1 的 null 是协议错，不静默当成功；不发布撤销', async () => {
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk([valueOf('delete', 'a', null)]))
    const run = await deleteSessionFromMenu(applyDeps(applyOutcomes), { sessionId: 'a', title: 'T' }, gate())
    expect(run.kind).toBe('ran')
    if (run.kind !== 'ran') return
    expect(run.value).toContain('单条动作回了幂等空值')
    expect(mocks.publishUndoNotice).not.toHaveBeenCalled()
  })

  it('single 只在 N=1 时生效：多 id 的 null 仍是批量幂等', async () => {
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk(
      outcomes('restore', ['a', 'b'], { b: { value: trashRow('b', 's2') } })))
    const run = await restoreFromPanel({
      deps: applyDeps(applyOutcomes), ids: ['a', 'b'], single: true, entries: null, gate: gate(),
      refreshAfterWrite: vi.fn(async () => {}), writeSucceeded: vi.fn(),
    })
    expect(run.kind).toBe('ran')
    if (run.kind !== 'ran') return
    expect(run.value.ok && run.value.summary.anySuccess).toBe(true)
    expect(run.value.failures.has('a')).toBe(false)
  })

  it('id 去重保序：同一 id 只请求一次、只判一条', async () => {
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk(
      outcomes('restore', ['a'], { a: { value: trashRow('a', 's1') } })))
    const run = await restoreFromPanel({
      deps: applyDeps(applyOutcomes), ids: ['a', 'a'], entries: null, gate: gate(),
      refreshAfterWrite: vi.fn(async () => {}), writeSucceeded: vi.fn(),
    })
    expect(applyOutcomes).toHaveBeenCalledWith('restore', ['a'])
    expect(run.kind).toBe('ran')
    if (run.kind !== 'ran') return
    expect(run.value.ids).toEqual(['a'])
    expect(run.value.ok && run.value.summary.successIds).toHaveLength(1)
  })

  it('全失败的组合（等价面）：delete 座位门住 publish；失败支交 refresh 恰好一回、呈现钩子一个不碰', async () => {
    // 半一（运行期 · delete 材质）：单删座位全失败 ⇒ 跨槽位照跑、publish 被 anySuccess 门拦住。
    const menu = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk(
      outcomes('delete', ['s1'], { s1: { message: '删不动' } })))
    const run = await deleteSessionFromMenu(applyDeps(menu), { sessionId: 's1', title: 'T' }, gate())
    expect(mocks.order).toEqual(['afterDelete:', 'invalidate'])
    expect(mocks.publishUndoNotice).not.toHaveBeenCalled()
    expect(run).toEqual({ kind: 'ran', value: '删不动' })

    // 半二（运行期 · refresh 半）：接 refresh 的座位全失败 ⇒ refresh 恰好交一回、呈现钩子一个不碰。
    // delete 座位不接 refresh 回调——生产 delete 的重读走 invalidate → 修订订阅，batch-confirm 只传
    // deps / ids / gate；「delete 材质 + refresh」同一趟在公开座位面上构造不出来，故分两半钉。
    const panel = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk(
      outcomes('purge', ['e1'], { e1: { message: '删不动' } })))
    const refreshAfterWrite = vi.fn(async () => {})
    const writeSucceeded = vi.fn()
    await purgeFromPanel({
      deps: applyDeps(panel), ids: ['e1'], gate: gate(), refreshAfterWrite, writeSucceeded,
    })
    expect(refreshAfterWrite).toHaveBeenCalledTimes(1)
    expect(mocks.dismissUndoNotice).not.toHaveBeenCalled()
    expect(writeSucceeded).not.toHaveBeenCalled()

    // 顶层失败（信封都没成）也交 refresh 一次：那一趟没有逐条回执，失败原文已铺进 failures。
    const down = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> =>
      remoteFail({ code: 'sessiondelete/io', message: '通道断' }))
    const refreshFailed = vi.fn(async () => {})
    const failed = await purgeFromPanel({
      deps: applyDeps(down), ids: ['e1'], gate: gate(), refreshAfterWrite: refreshFailed, writeSucceeded,
    })
    expect(refreshFailed).toHaveBeenCalledTimes(1)
    expect(mocks.dismissUndoNotice).not.toHaveBeenCalled()
    expect(writeSucceeded).not.toHaveBeenCalled()
    expect(failed.kind === 'ran' && failed.value.ok).toBe(false)
  })
})

/**
 * 收尾顺序按 action 各一条、一条序列断言：跨槽位（main-view 收尾、回收站失效）在信封成功时就跑，
 * 逐条全失败也跑；呈现钩子（撤销发布 / 熄灭、遗忘主视图、清详情账本）只在 `anySuccess` 时跑，
 * delete 的撤销另要求落点非空。恢复有两个座位：外部恢复不带 `panelSeat` ⇒ 重开主视图；
 * 面板带 `panelSeat: true` ⇒ 只遗忘、不重开（判据住 `main-view.ts`）。
 */
describe('收尾顺序（按 action 各一条）', () => {
  it('delete：afterDelete → invalidate → 撤销发布；只在 anySuccess 时发布', async () => {
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk([]))
    applyOutcomes.mockResolvedValueOnce(remoteOk([valueOf('delete', 's1', trashRow('e1', 's1'))]))
    await deleteSessionsFromBatch(applyDeps(applyOutcomes), ['s1'], gate())
    expect(mocks.order).toEqual(['afterDelete:s1', 'invalidate', 'publishBatch:e1:1'])

    // 逐条全 missing：跨槽位照跑（空成功名单合法），呈现钩子不跑。
    mocks.order.length = 0
    await deleteSessionsFromBatch(applyDeps(applyOutcomes), ['s1'], gate())
    expect(mocks.order).toEqual(['afterDelete:', 'invalidate'])
    expect(mocks.publishUndoBatchNotice).toHaveBeenCalledTimes(1)
  })

  it('restore（外部座位）全序列：afterRestore → invalidate → 清账本；外部座位不传 dismiss', async () => {
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk(
      outcomes('restore', ['e1', 'e2'], {
        e1: { value: trashRow('e1', 's1') },
        e2: { value: trashRow('e2', 's2') },
      })))
    await restoreFromUndo(applyDeps(applyOutcomes), { seq: 1, kind: 'batch', entryIds: ['e1', 'e2'], n: 2 }, zhTranslate)
    // 外部座位不带 panelSeat ⇒ 主视图重开先跑；invalidate 随后；账本清理收尾。
    expect(mocks.order).toEqual(['afterRestore:s1,s2', 'invalidate', 'ledger:e1,e2'])
    // 熄灭缺席是座位设计（外部座位不传 `dismissUndo`：部分失败的回滚会先熄灭横幅、随后失败原文
    // 无处可落）；面板座位那条序列由下一条用例钉。
    expect(mocks.dismissUndoNotice).not.toHaveBeenCalled()
  })

  it('restore（面板座位）：dismiss → 遗忘主视图 → 清账本；不重开主视图', async () => {
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk(
      outcomes('restore', ['e1', 'e2'], { e1: { value: trashRow('e1', 's1') }, e2: { value: null } })))
    const writeSucceeded = vi.fn((ids: readonly string[]) => { mocks.order.push(`ledger:${ids.join(',')}`) })
    const refreshAfterWrite = vi.fn(async () => { mocks.order.push('refresh') })
    const run = await restoreFromPanel({
      deps: applyDeps(applyOutcomes), ids: ['e1', 'e2'],
      entries: [trashRow('e1', 's1'), trashRow('e2', 's2')],
      gate: gate(), refreshAfterWrite, writeSucceeded,
    })
    expect(run.kind).toBe('ran')
    // already-gone 的 e2 没有回执行：它的 sessionId 从面板清单兜底——回盘名单是会话 id 域。
    // refresh 排在 settlement 之后：重读看得到收尾后的现场。
    expect(mocks.order).toEqual(['dismiss:e1,e2', 'forget:s1,s2', 'ledger:e1,e2', 'refresh'])
    expect(mocks.afterRestore).not.toHaveBeenCalled()
  })

  it('restore 全失败：外部座位仍失效回收站（跨槽位），但不碰呈现钩子', async () => {
    writeTrashDetail('e1', detailOf('e1'))
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk(
      outcomes('restore', ['e1'], { e1: { message: '删不动' } })))
    await restoreFromUndo(applyDeps(applyOutcomes), { seq: 1, kind: 'one', entryId: 'e1', title: '标题' }, zhTranslate)
    expect(mocks.order).toEqual(['afterRestore:', 'invalidate'])
    // 详情账本不动：失败那条还在回收站里，清了只会让下一次详情白读。
    expect(readCachedTrashDetail('e1')).toBeDefined()
  })

  it('purge：anySuccess 时熄灭撤销 → 清详情账本；全失败不碰呈现钩子', async () => {
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk([]))
    applyOutcomes.mockResolvedValueOnce(remoteOk(
      outcomes('purge', ['e1'], { e1: { value: { removed: 1, freedBytes: 1 } } })))
    const writeSucceeded = vi.fn((ids: readonly string[]) => { mocks.order.push(`ledger:${ids.join(',')}`) })
    const refreshAfterWrite = vi.fn(async () => { mocks.order.push('refresh') })
    await purgeFromPanel({
      deps: applyDeps(applyOutcomes), ids: ['e1'], gate: gate(),
      refreshAfterWrite, writeSucceeded,
    })
    // refresh 排在 settlement 之后：重读看得到收尾后的现场。
    expect(mocks.order).toEqual(['dismiss:e1', 'ledger:e1', 'refresh'])
    expect(mocks.forgetMainView).not.toHaveBeenCalled()

    // 逐条全失败：撤销横幅与详情账本都不许动——没有落点，清账本只会让下一次详情白读。
    mocks.order.length = 0
    await purgeFromPanel({
      deps: applyDeps(applyOutcomes), ids: ['e1'], gate: gate(),
      refreshAfterWrite: vi.fn(async () => {}), writeSucceeded,
    })
    expect(mocks.order).toEqual([])
  })

  it('unarchive：没有跨槽位收尾（穷尽分支在场），refresh 照交', async () => {
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk(
      outcomes('unarchive', ['s1'])))
    const refresh = vi.fn(async () => {})
    const run = await unarchiveFromArchiveTab({
      deps: applyDeps(applyOutcomes), ids: ['s1'], gate: gate(), refresh,
    })
    expect(mocks.order).toEqual([])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(run.kind).toBe('ran')
    if (run.kind !== 'ran') return
    expect(run.value.ok).toBe(true)
    expect(run.value.failures.size).toBe(0)
  })

  it('delete 支的撤销发布带 archived：落地条目里有 wasArchived ⇒ true', async () => {
    const archivedRow = { ...trashRow('e1', 's1'), wasArchived: true }
    const applyOutcomes = vi.fn(async (): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk(
      [valueOf('delete', 's1', archivedRow)]))
    await deleteSessionsFromBatch(applyDeps(applyOutcomes), ['s1'], gate())
    expect(mocks.publishUndoBatchNotice).toHaveBeenCalledWith({ entryIds: ['e1'], n: 1, archived: true })
  })

  it('count / orphan-clean 不走写入座位：真实路径不触发任何跨槽位收尾', async () => {
    // 结构面由类型闸把守：`SeatedAction = Exclude<ApplyAction, 'count' | 'orphan-clean'>`，这两个动作
    // 进不了 runWrite / settleWrite。这里只证明它们各自的真实路径也不碰跨槽位钩子。
    const applyOutcomes = vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<RemoteOutcome<ApplyOutcome[]>> =>
      remoteOk(outcomes(action, ids)))
    const count = await applyOne(applyDeps(applyOutcomes), 'count', 's1')
    expect(count.ok).toBe(true)
    expect(mocks.order).toEqual([])

    const orphan = await applyDeps(applyOutcomes).applyOutcomes('orphan-clean', ['r1'])
    expect(orphan.ok).toBe(true)
    expect(mocks.order).toEqual([])
  })
})
