/**
 * 清册读数与孤儿扫描的**编排**（`use-trash-query.ts`）。
 *
 * 这一份直接测 hook，而不是绕过它去测面板：三条判据（最新票、先清单后扫描、清理两种失败的分流）
 * 此前只能"整块渲染面板 + 造一个远程假件"才够得着，现在它们是这个 module 的 interface。
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { useTrashQuery, type ReloadResult, type TrashQueryDeps } from '../../src/client/use-trash-query.js'
import type { BusyGate } from '../../src/client/busy-gate.js'
import { zhTranslate } from '../../src/client/copy.js'
import type { OrphanReportWire, TrashEntryLike } from '../../src/client/remote.js'
import { publishUndoNotice, resetUndoNotice, useUndoNotice } from '../../src/client/undo-toast.js'
import type { ApplyAction, ApplyOutcome } from '../../src/shared/wire.js'
import { outcomes, purgeOutcomes, restoreOutcomes, writeOutcome } from './support/outcomes.js'

const rows: TrashEntryLike[] = [
  { id: 'a', sessionId: 'session-a', projectDir: '--p--', workspaceId: 'ws', wasArchived: false, deletedAt: 1, sizeBytes: 10, releaseBytes: 10, title: 'A' },
]

/** 逐条 `/apply` 的默认回执：purge / restore 给各自"落地了"的那一支，其余动作按中性默认值。
 *  这个文件只读动作与请求 id（写后重扫的判据），回执细节不参与断言。 */
function applyReceipt(action: ApplyAction, ids: readonly string[]): ApplyOutcome[] {
  switch (action) {
    case 'purge': return purgeOutcomes(ids)
    case 'restore': return restoreOutcomes(ids)
    default: return outcomes(action, ids)
  }
}

const EMPTY: OrphanReportWire = { roots: [], totalSessions: 0, totalBytes: 0, missingParents: 0, groups: [] }
const REPORT: OrphanReportWire = {
  roots: ['session-root'], totalSessions: 2, totalBytes: 2048, missingParents: 1,
  groups: [{ projectDir: '--p--', sessions: 2, bytes: 2048 }],
}

function deps(over: Partial<TrashQueryDeps> & Partial<Record<'list' | 'scanOrphans' | 'applyOutcomes' | 'emptyTrash', unknown>> = {}): TrashQueryDeps {
  return {
    list: vi.fn(async () => rows),
    scanOrphans: vi.fn(async () => EMPTY),
    applyOutcomes: vi.fn(async (action: ApplyAction, ids: readonly string[]) => applyReceipt(action, ids)),
    emptyTrash: vi.fn(async () => ({ removed: 1, freedBytes: 1 })),
    ...over,
  } as TrashQueryDeps
}

/** 闸的本体与形状住 `src/client/busy-gate.ts`；这里只借它的 `around` 签名搭替身。 */
type Around = BusyGate['around']

/** 这类编排测试不关心渲染期的禁用：替身直接放行。 */
const passThrough: Around = <T,>(task: () => Promise<T>): Promise<T> => task()

function mount(over: Partial<TrashQueryDeps> = {}, around: Around = passThrough) {
  const d = deps(over)
  const view = renderHook(() => useTrashQuery({ deps: d, t: zhTranslate, gate: { busy: false, around } }))
  return { d, ...view }
}

describe('取数编排 · 最新票', () => {
  it('后发的读数先落地、先发的后落地 ⇒ 先发的那份不盖掉新的', async () => {
    const resolvers: Array<(value: TrashEntryLike[]) => void> = []
    const list = vi.fn(() => new Promise<readonly TrashEntryLike[]>((resolve) => {
      resolvers.push((value) => resolve(value))
    }))
    const { result } = mount({ list: list as never })
    let first: Promise<ReloadResult> | undefined
    let second: Promise<ReloadResult> | undefined
    act(() => {
      first = result.current.reloadRows()
      second = result.current.reloadRows()
    })
    const fresh = [{ ...rows[0]!, id: 'fresh' }]
    await act(async () => {
      resolvers[1]!(fresh)
      await second
    })
    await act(async () => {
      resolvers[0]!(rows)
      await first
    })
    expect(result.current.entries?.map((entry) => entry.id)).toEqual(['fresh'])
  })

  it('挂载全量刷新被后到的 reload 顶掉时，残留扫描不丢', async () => {
    const resolvers: Array<(value: readonly TrashEntryLike[]) => void> = []
    const list = vi.fn(() => new Promise<readonly TrashEntryLike[]>((resolve) => {
      resolvers.push((value) => resolve(value))
    }))
    const { d, result } = mount({ list: list as never })
    let mountRefresh!: Promise<void>
    let writeRefresh!: Promise<void>
    act(() => {
      mountRefresh = result.current.refreshAll()
      writeRefresh = result.current.refreshAfterWrite()
    })
    // 后到的 reload 先落地：它签到新票，挂载那次 reload 就作废了；报告仍未知，必须由它补扫。
    await act(async () => {
      resolvers[1]!(rows)
      await writeRefresh
    })
    await act(async () => {
      resolvers[0]!(rows)
      await mountRefresh
    })
    expect(d.scanOrphans).toHaveBeenCalledTimes(1)
    // 输掉序号的那次全量刷新不许在赢家扫描后再把报告清掉。
    expect(result.current.orphanReport).toEqual(EMPTY)
  })

  it('读不到 ⇒ entries 回 null、原文进 listFailure（"读不到"与"空的"是两件事）', async () => {
    const { result } = mount({
      list: vi.fn(async () => { throw Object.assign(new Error('清单损坏'), { code: 'sessiondelete/io' }) }) as never,
    })
    await act(async () => { await result.current.reloadRows() })
    expect(result.current.entries).toBeNull()
    expect(result.current.listFailure).toBe('清单损坏')
  })
})

describe('取数编排 · 先清单后扫描', () => {
  it('refreshAll：清单读成了才扫；两件事按这个顺序发生', async () => {
    const order: string[] = []
    const { result } = mount({
      list: vi.fn(async () => { order.push('list'); return rows }) as never,
      scanOrphans: vi.fn(async () => { order.push('scan'); return EMPTY }) as never,
    })
    await act(async () => { await result.current.refreshAll() })
    expect(order).toEqual(['list', 'scan'])
    expect(result.current.orphanReport).toEqual(EMPTY)
  })

  it('refreshAll：清单没读成 ⇒ 一次扫描都不发，并清掉上一拍的残留报告', async () => {
    let fail = false
    const list = vi.fn(async () => {
      if (fail) throw new Error('boom')
      return rows
    })
    const { d, result } = mount({ list: list as never })
    await act(async () => { await result.current.refreshAll() })
    expect(result.current.orphanReport).toEqual(EMPTY)
    expect(d.scanOrphans).toHaveBeenCalledTimes(1)

    fail = true
    await act(async () => { await result.current.refreshAll() })
    expect(d.scanOrphans).toHaveBeenCalledTimes(1)
    expect(result.current.orphanReport).toBeNull()
    expect(result.current.listFailure).toBe('boom')
  })

  it('refreshAll：扫描读不到 ⇒ 不折成"零条残留"：报告回 null，原文上屏', async () => {
    const { result } = mount({
      scanOrphans: vi.fn(async () => { throw Object.assign(new Error('sessionQuery 不在'), { code: 'sessiondelete/io' }) }) as never,
    })
    await act(async () => { await result.current.refreshAll() })
    expect(result.current.orphanReport).toBeNull()
    expect(result.current.orphanFailure).toContain('sessionQuery 不在')
  })
})

describe('取数编排 · 命名读', () => {
  it('reloadRows 只读清单，不扫残留', async () => {
    const { d, result } = mount()
    await act(async () => { await result.current.reloadRows() })
    expect(d.list).toHaveBeenCalledTimes(1)
    expect(d.scanOrphans).not.toHaveBeenCalled()
  })

  it('rescanOrphans 只扫残留，不读清单', async () => {
    const { d, result } = mount()
    await act(async () => { await result.current.rescanOrphans() })
    expect(d.scanOrphans).toHaveBeenCalledTimes(1)
    expect(d.list).not.toHaveBeenCalled()
  })

  it('refreshAfterWrite：报告为空时写后只重读清单', async () => {
    const { d, result } = mount()
    await act(async () => { await result.current.refreshAll() })
    expect(d.scanOrphans).toHaveBeenCalledTimes(1)
    await act(async () => { await result.current.refreshAfterWrite() })
    expect(d.list).toHaveBeenCalledTimes(2)
    expect(d.scanOrphans).toHaveBeenCalledTimes(1)
  })

  it('refreshAfterWrite：报告为 null（没扫到）时也重扫，不把"未知"当"空的"', async () => {
    let scans = 0
    const scanOrphans = vi.fn(async () => {
      scans += 1
      if (scans === 1) throw Object.assign(new Error('sessionQuery 不在'), { code: 'sessiondelete/io' })
      return EMPTY
    })
    const { d, result } = mount({ scanOrphans: scanOrphans as never })
    await act(async () => { await result.current.refreshAll() })
    expect(result.current.orphanReport).toBeNull()
    await act(async () => { await result.current.refreshAfterWrite() })
    expect(d.scanOrphans).toHaveBeenCalledTimes(2)
    expect(result.current.orphanReport).toEqual(EMPTY)
    expect(result.current.orphanFailure).toBeNull()
  })

  it('refreshAfterWrite(purge 回执)：报告为空也重扫（语料缺席时留下的盘上后代）', async () => {
    const { d, result } = mount()
    await act(async () => { await result.current.refreshAll() })
    expect(d.scanOrphans).toHaveBeenCalledTimes(1)
    await act(async () => { await result.current.refreshAfterWrite(writeOutcome('purge', ['e1'])) })
    expect(d.list).toHaveBeenCalledTimes(2)
    expect(d.scanOrphans).toHaveBeenCalledTimes(2)
  })

  it('refreshAfterWrite(purge 回执) 输给后到的读：强制重扫由赢家补上', async () => {
    const resolvers: Array<(value: readonly TrashEntryLike[]) => void> = []
    let deferred = false
    const list = vi.fn(() => {
      if (!deferred) return Promise.resolve(rows)
      return new Promise<readonly TrashEntryLike[]>((resolve) => { resolvers.push(resolve) })
    })
    const { d, result } = mount({ list: list as never })
    await act(async () => { await result.current.refreshAll() })
    expect(d.scanOrphans).toHaveBeenCalledTimes(1)

    deferred = true
    let forced!: Promise<void>
    let winner!: Promise<void>
    act(() => {
      forced = result.current.refreshAfterWrite(writeOutcome('purge', ['e1']))
      winner = result.current.refreshAfterWrite()
    })
    await act(async () => {
      resolvers[1]!(rows)
      await winner
    })
    // 赢家看到强制标记，替输掉的那次补扫；报告为空也不会省。
    expect(d.scanOrphans).toHaveBeenCalledTimes(2)
    await act(async () => {
      resolvers[0]!(rows)
      await forced
    })
    expect(d.scanOrphans).toHaveBeenCalledTimes(2)
  })

  it('清单读失败时，在飞的旧扫描晚到也不把报告写回来', async () => {
    let failList = false
    let resolveList!: (value: readonly TrashEntryLike[]) => void
    const list = vi.fn(() => {
      if (failList) return Promise.reject(new Error('清单坏了'))
      return new Promise<readonly TrashEntryLike[]>((resolve) => { resolveList = resolve })
    })
    let resolveScan!: (value: OrphanReportWire) => void
    const scanOrphans = vi.fn(() => new Promise<OrphanReportWire>((resolve) => { resolveScan = resolve }))
    const { result } = mount({ list: list as never, scanOrphans: scanOrphans as never })

    let refreshing!: Promise<void>
    act(() => { refreshing = result.current.refreshAll() })
    await act(async () => { resolveList(rows) })
    await waitFor(() => expect(scanOrphans).toHaveBeenCalledTimes(1))

    failList = true
    await act(async () => { await result.current.refreshAfterWrite() })
    expect(result.current.orphanReport).toBeNull()

    await act(async () => {
      resolveScan(REPORT)
      await refreshing
    })
    expect(result.current.orphanReport).toBeNull()
  })

  it('refreshAfterWrite：报告非空时写后重读清单并重扫', async () => {
    const { d, result } = mount({ scanOrphans: vi.fn(async () => REPORT) as never })
    await act(async () => { await result.current.refreshAll() })
    await act(async () => { await result.current.refreshAfterWrite() })
    expect(d.list).toHaveBeenCalledTimes(2)
    expect(d.scanOrphans).toHaveBeenCalledTimes(2)
  })

  it('refreshAfterWrite：清单读失败时清空报告与提示（这一拍不知道盘上长什么样）', async () => {
    let fail = false
    const list = vi.fn(async () => {
      if (fail) throw new Error('清单坏了')
      return rows
    })
    const { result } = mount({ list: list as never, scanOrphans: vi.fn(async () => REPORT) as never })
    await act(async () => { await result.current.refreshAll() })
    expect(result.current.orphanReport).toEqual(REPORT)
    act(() => { result.current.openOrphanPreview() })
    expect(result.current.orphanConfirm).toBe(true)
    fail = true
    await act(async () => { await result.current.refreshAfterWrite() })
    expect(result.current.entries).toBeNull()
    expect(result.current.listFailure).toBe('清单坏了')
    expect(result.current.orphanReport).toBeNull()
    expect(result.current.orphanConfirm).toBe(false)
  })
})

describe('取数编排 · 写后重扫由 outcome 派生', () => {
  it('restore 一条露面的孩子 ⇒ 写后强制重扫；组根 ⇒ 不强制', async () => {
    const entries = [
      { ...rows[0]!, id: 'root', sessionId: 's-root' },
      { ...rows[0]!, id: 'kid', sessionId: 's-kid', parentEntryId: 'root' },
    ]
    const { d, result } = mount({ list: vi.fn(async () => entries) as never })
    await act(async () => { await result.current.refreshAll() })
    expect(d.scanOrphans).toHaveBeenCalledTimes(1)

    await act(async () => { await result.current.refreshAfterWrite(writeOutcome('restore', ['kid'])) })
    expect(d.scanOrphans).toHaveBeenCalledTimes(2)

    await act(async () => { await result.current.refreshAfterWrite(writeOutcome('restore', ['root'])) })
    expect(d.scanOrphans).toHaveBeenCalledTimes(2)
  })

  it('purge / orphan-clean ⇒ 写后强制重扫', async () => {
    const { d, result } = mount()
    await act(async () => { await result.current.refreshAll() })
    await act(async () => { await result.current.refreshAfterWrite(writeOutcome('purge', ['e1'])) })
    expect(d.scanOrphans).toHaveBeenCalledTimes(2)
    await act(async () => { await result.current.refreshAfterWrite(writeOutcome('orphan-clean', ['r1'])) })
    expect(d.scanOrphans).toHaveBeenCalledTimes(3)
  })

  it('清单还未知时 restore 也强制重扫：未知不是"空的"', async () => {
    const { d, result } = mount()
    await act(async () => { await result.current.refreshAfterWrite(writeOutcome('restore', ['a'])) })
    expect(d.list).toHaveBeenCalledTimes(1)
    expect(d.scanOrphans).toHaveBeenCalledTimes(1)
  })

  it('restore 的 id 已不在清单里 ⇒ 保守重扫：这一拍不能断言它不是露面的孩子', async () => {
    const { d, result } = mount({ list: vi.fn(async () => []) as never })
    await act(async () => { await result.current.refreshAll() })
    expect(d.scanOrphans).toHaveBeenCalledTimes(1)
    await act(async () => { await result.current.refreshAfterWrite(writeOutcome('restore', ['gone'])) })
    expect(d.scanOrphans).toHaveBeenCalledTimes(2)
  })
})

describe('取数编排 · 清理那批无主子会话', () => {
  async function withReport(over: Partial<TrashQueryDeps>) {
    const mounted = mount({ scanOrphans: vi.fn(async () => REPORT) as never, ...over })
    await act(async () => { await mounted.result.current.refreshAll() })
    return mounted
  }

  it('走了同一段 apply 的第五个动作，并刷新一遍', async () => {
    const { d, result } = await withReport({})
    await act(async () => { await result.current.cleanOrphans() })
    expect(d.applyOutcomes).toHaveBeenCalledWith('orphan-clean', ['session-root'])
    expect(d.list).toHaveBeenCalledTimes(2) // 一次挂载、一次清理后重读
    expect(d.scanOrphans).toHaveBeenCalledTimes(2) // 清理会把盘上后代也带走 ⇒ 强制重扫一次
  })

  it('not-found ⇒ 中性提示，不计入失败', async () => {
    const { result } = await withReport({
      applyOutcomes: vi.fn(async (action: string, ids: readonly string[]) =>
        ids.map((id) => ({ id, action, ok: false as const, error: { code: 'sessiondelete/not-found', message: '不在了' } }))) as never,
    })
    await act(async () => { await result.current.cleanOrphans() })
    expect(result.current.orphanNotice).toContain('1')
    expect(result.current.orphanFailure).toBeNull()
  })

  it('请求里有 root 没回：落 missing 失败，不冒充已不在了', async () => {
    const { result } = await withReport({
      applyOutcomes: vi.fn(async () => [] as ApplyOutcome[]),
    })
    await act(async () => { await result.current.cleanOrphans() })
    expect(result.current.orphanNotice).toBeNull()
    expect(result.current.orphanFailure).toContain('批量通道没回这一条的结果：orphan-clean session-root')
  })

  it('顶层失败：关确认框、重扫、原文上屏（与其余写入面同一条生命周期）', async () => {
    const { d, result } = await withReport({
      applyOutcomes: vi.fn(async () => { throw new Error('路由自检失败') }) as never,
    })
    act(() => { result.current.openOrphanPreview() })
    await act(async () => { await result.current.cleanOrphans() })
    expect(result.current.orphanConfirm).toBe(false)
    expect(result.current.orphanFailure).toContain('路由自检失败')
    expect(d.list).toHaveBeenCalledTimes(2)
    expect(d.scanOrphans).toHaveBeenCalledTimes(2)
  })

  it('io ⇒ 失败上屏，并把服务端给的部分计数说出来', async () => {
    const { result } = await withReport({
      applyOutcomes: vi.fn(async (action: string, ids: readonly string[]) =>
        ids.map((id) => ({
          id, action, ok: false as const,
          error: { code: 'sessiondelete/io', message: '目录搬不动', details: { removed: 1, freedBytes: 2048 } },
        }))) as never,
    })
    await act(async () => { await result.current.cleanOrphans() })
    expect(result.current.orphanFailure).toContain('目录搬不动')
    expect(result.current.orphanFailure).toContain('1') // 已先删掉 1 个
    await waitFor(() => expect(result.current.orphanFailure).not.toBeNull())
  })
})

describe('取数编排 · 清空走注入的闸', () => {
  it('emptyTrash 的请求与清单重读都在闸里跑：先开闸、再发请求、最后关闸', async () => {
    const order: string[] = []
    const wrap: Around = <T,>(task: () => Promise<T>): Promise<T> => {
      order.push('gate:enter')
      return task().finally(() => { order.push('gate:leave') })
    }
    const { result } = mount({
      list: vi.fn(async () => { order.push('list'); return rows }) as never,
      emptyTrash: vi.fn(async () => { order.push('empty'); return { removed: 1, freedBytes: 1 } }) as never,
    }, wrap)

    await act(async () => { await result.current.emptyTrash() })
    // 若请求在 around 之外发、或重读没被包进去，这个序都会对不上。
    expect(order).toEqual(['gate:enter', 'empty', 'list', 'gate:leave'])
    expect(result.current.entries).toEqual(rows)
    expect(result.current.listFailure).toBeNull()
  })

  it('emptyTrash 报告为空也强制重扫：聚合回执没有 WriteOutcome，强制由内部决定', async () => {
    const { d, result } = mount()
    await act(async () => { await result.current.refreshAll() })
    expect(d.scanOrphans).toHaveBeenCalledTimes(1)
    await act(async () => { await result.current.emptyTrash() })
    expect(d.scanOrphans).toHaveBeenCalledTimes(2)
  })
})

describe('取数编排 · 清空与撤销横幅', () => {
  // 横幅的现场是模块级的：每个用例从干净的现场起，别让上一个用例的发布混进来。
  beforeEach(() => { resetUndoNotice() })

  it('清空成功：整条横幅一起收掉——落点全没了，留着就是一条注定失败的「撤销」', async () => {
    publishUndoNotice({ entryId: 'a', title: 'A' })
    const notice = renderHook(() => useUndoNotice())
    // 先确认现场真的挂着：否则「收掉了」可能只是从没挂上过。
    expect(notice.result.current?.kind).toBe('one')
    const { result } = mount()

    await act(async () => { expect(await result.current.emptyTrash()).toBe(true) })
    expect(notice.result.current).toBeNull()
  })

  it('清空失败：横幅留着——回收站此刻还在，撤销仍是可做的动作', async () => {
    publishUndoNotice({ entryId: 'a', title: 'A' })
    const notice = renderHook(() => useUndoNotice())
    const { result } = mount({ emptyTrash: vi.fn(async () => { throw new Error('盘上忙') }) as never })

    await act(async () => { expect(await result.current.emptyTrash()).toBe(false) })
    expect(notice.result.current?.kind).toBe('one')
  })
})
