/**
 * 清册读数与孤儿扫描的**编排**（`use-trash-query.ts`）。
 *
 * 这一份直接测 hook，而不是绕过它去测面板：三条判据（到达序号、先清单后扫描、清理两种失败的分流）
 * 此前只能"整块渲染面板 + 造一个远程假件"才够得着，现在它们是这个 module 的 interface。
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useTrashQuery, type TrashQueryDeps } from '../../src/client/use-trash-query.js'
import { zhTranslate } from '../../src/client/copy.js'
import type { OrphanReportWire, TrashEntryLike } from '../../src/client/remote.js'
import type { ApplyOutcome } from '../../src/shared/wire.js'

const rows: TrashEntryLike[] = [
  { id: 'a', sessionId: 'session-a', projectDir: '--p--', workspaceId: 'ws', wasArchived: false, deletedAt: 1, sizeBytes: 10, releaseBytes: 10, title: 'A' },
]

const EMPTY: OrphanReportWire = { roots: [], totalSessions: 0, totalBytes: 0, missingParents: 0, groups: [] }
const REPORT: OrphanReportWire = {
  roots: ['session-root'], totalSessions: 2, totalBytes: 2048, missingParents: 1,
  groups: [{ projectDir: '--p--', sessions: 2, bytes: 2048 }],
}

function deps(over: Partial<TrashQueryDeps> & Partial<Record<'list' | 'scanOrphans' | 'applyOutcomes' | 'emptyTrash', unknown>> = {}): TrashQueryDeps {
  return {
    list: vi.fn(async () => rows),
    scanOrphans: vi.fn(async () => EMPTY),
    applyOutcomes: vi.fn(async (action: string, ids: readonly string[]) =>
      ids.map((id) => ({ id, action, ok: true as const, value: { removed: 1, freedBytes: 1 } })) as ApplyOutcome[]),
    emptyTrash: vi.fn(async () => ({ removed: 1, freedBytes: 1 })),
    ...over,
  } as TrashQueryDeps
}

/** 面板那枚 `busy` 闸的形状：把一次任务整个包进"这一趟还算忙"里。 */
type Around = <T>(task: () => Promise<T>) => Promise<T>

/** 这类编排测试不关心渲染期的禁用：替身直接放行。 */
const around: Around = <T,>(task: () => Promise<T>): Promise<T> => task()

function mount(over: Partial<TrashQueryDeps> = {}, wrap: Around = around) {
  const d = deps(over)
  const view = renderHook(() => useTrashQuery({ deps: d, t: zhTranslate, around: wrap }))
  return { d, ...view }
}

describe('取数编排 · 到达序号', () => {
  it('后发的读数先落地、先发的后落地 ⇒ 先发的那份不盖掉新的', async () => {
    const resolvers: Array<(value: TrashEntryLike[]) => void> = []
    const list = vi.fn(() => new Promise<readonly TrashEntryLike[]>((resolve) => {
      resolvers.push((value) => resolve(value))
    }))
    const { result } = mount({ list: list as never })
    let first: Promise<boolean> | undefined
    let second: Promise<boolean> | undefined
    act(() => {
      first = result.current.reload()
      second = result.current.reload()
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

  it('读不到 ⇒ entries 回 null、原文进 listFailure（"读不到"与"空的"是两件事）', async () => {
    const { result } = mount({
      list: vi.fn(async () => { throw Object.assign(new Error('清单损坏'), { code: 'sessiondelete/io' }) }) as never,
    })
    await act(async () => { await result.current.reload() })
    expect(result.current.entries).toBeNull()
    expect(result.current.listFailure).toBe('清单损坏')
  })
})

describe('取数编排 · 先清单后扫描', () => {
  it('清单读成了才扫；两件事按这个顺序发生', async () => {
    const order: string[] = []
    const { result } = mount({
      list: vi.fn(async () => { order.push('list'); return rows }) as never,
      scanOrphans: vi.fn(async () => { order.push('scan'); return EMPTY }) as never,
    })
    await act(async () => { await result.current.refresh() })
    expect(order).toEqual(['list', 'scan'])
    expect(result.current.orphanReport).toEqual(EMPTY)
  })

  it('清单没读成 ⇒ 一次扫描都不发，并清掉上一拍的残留报告', async () => {
    const { result } = mount()
    await act(async () => { await result.current.refresh() })
    expect(result.current.orphanReport).toEqual(EMPTY)
    // 另一份挂载：清单这一拍读失败
    const failing = mount({
      list: vi.fn(async () => { throw new Error('boom') }) as never,
    })
    await act(async () => { await failing.result.current.refresh() })
    expect(failing.d.scanOrphans).not.toHaveBeenCalled()
    expect(failing.result.current.orphanReport).toBeNull()
  })

  it('扫描读不到 ⇒ 不折成"零条残留"：报告回 null，原文上屏', async () => {
    const { result } = mount({
      scanOrphans: vi.fn(async () => { throw Object.assign(new Error('sessionQuery 不在'), { code: 'sessiondelete/io' }) }) as never,
    })
    await act(async () => { await result.current.refresh() })
    expect(result.current.orphanReport).toBeNull()
    expect(result.current.orphanFailure).toContain('sessionQuery 不在')
  })
})

describe('取数编排 · 清理那批无主子会话', () => {
  async function withReport(over: Partial<TrashQueryDeps>) {
    const mounted = mount({ scanOrphans: vi.fn(async () => REPORT) as never, ...over })
    await act(async () => { await mounted.result.current.refresh() })
    return mounted
  }

  it('走了同一段 apply 的第五个动作，并刷新一遍', async () => {
    const { d, result } = await withReport({})
    await act(async () => { await result.current.cleanOrphans() })
    expect(d.applyOutcomes).toHaveBeenCalledWith('orphan-clean', ['session-root'])
    expect(d.list).toHaveBeenCalledTimes(2) // 一次挂载、一次清理后重读
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
  it('emptyTrash 的请求与清单重读都在 around 里跑：先开闸、再发请求、最后关闸', async () => {
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
})
