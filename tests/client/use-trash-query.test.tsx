/**
 * 清册读数的**编排**（`use-trash-query.ts`）。
 *
 * 这一份直接测 hook，而不是绕过它去测面板：最新票、读不到不折成空态、附件回执的拼句与清空的那枚闸，
 * 此前只能"整块渲染面板 + 造一个远程假件"才够得着，现在它们是这个 module 的 interface。
 *
 * 无主子会话的检查/清理**不在这一面**：那是插件设置页维护卡的手动动作（`use-maintenance.ts`）。
 * 这里只钉"面板这一侧一次都不自动扫"——挂载读、写后重读与清空都不碰 `/orphans`。
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listView, useTrashQuery } from '../../src/client/use-trash-query.js'
import type { BusyGate } from '../../src/client/busy-gate.js'
import { zhTranslate } from '../../src/client/copy.js'
import type { TrashEntryLike } from '../../src/client/remote.js'
import { publishUndoNotice, resetUndoNotice, useUndoNotice } from '../../src/client/undo-notices.js'
import { createFakeRemote, type FakeRemote } from './support/fake-remote.js'

const rows: TrashEntryLike[] = [
  { id: 'a', sessionId: 'session-a', projectDir: '--p--', workspaceId: 'ws', wasArchived: false, deletedAt: 1, sizeBytes: 10, releaseBytes: 10, title: 'A' },
]

function deps(over: Partial<FakeRemote> = {}): FakeRemote {
  return createFakeRemote({
    list: vi.fn(async () => rows),
    emptyTrash: vi.fn(async () => ({ removed: 1, freedBytes: 1 })),
    ...over,
  })
}

/** 闸的本体与形状住 `src/client/busy-gate.ts`；这里只借它的 `around` 签名搭替身。 */
type Around = BusyGate['around']

/** 这类编排测试不关心渲染期的禁用：替身直接放行。 */
const passThrough: Around = <T,>(task: () => Promise<T>): Promise<T> => task()

function mount(over: Partial<FakeRemote> = {}, around: Around = passThrough) {
  const d = deps(over)
  const view = renderHook(() => useTrashQuery({ deps: d, t: zhTranslate, gate: { busy: false, around } }))
  return { d, ...view }
}

describe('取数编排 · 清单状态的唯一解读', () => {
  it('loading / unknown / ready 一次交出 rows、failure、loading 与空态', () => {
    expect(listView({ status: 'loading' })).toEqual({
      rows: null, failure: null, loading: true, empty: false,
    })
    expect(listView({ status: 'unknown', failure: '清单坏了' })).toEqual({
      rows: null, failure: '清单坏了', loading: false, empty: false,
    })
    expect(listView({ status: 'ready', rows: [] })).toEqual({
      rows: [], failure: null, loading: false, empty: true,
    })
    expect(listView({ status: 'ready', rows })).toEqual({
      rows, failure: null, loading: false, empty: false,
    })
  })
})

describe('取数编排 · 最新票', () => {
  it('后发的读数先落地、先发的后落地 ⇒ 先发的那份不盖掉新的', async () => {
    const resolvers: Array<(value: TrashEntryLike[]) => void> = []
    const list = vi.fn(() => new Promise<TrashEntryLike[]>((resolve) => {
      resolvers.push((value) => resolve(value))
    }))
    const { result } = mount({ list: list })
    let first: Promise<void> | undefined
    let second: Promise<void> | undefined
    act(() => {
      first = result.current.refreshAll()
      second = result.current.refreshAll()
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
    expect(result.current.list).toEqual({ status: 'ready', rows: fresh })
  })

  it('读不到 ⇒ 清单进 unknown、原文进 failure（"读不到"与"空的"是两件事）', async () => {
    const { result } = mount({
      list: vi.fn(async () => { throw Object.assign(new Error('清单损坏'), { code: 'sessiondelete/io' }) }),
    })
    await act(async () => { await result.current.refreshAll() })
    expect(result.current.list).toEqual({ status: 'unknown', failure: '清单损坏' })
  })
})

// 孤儿会话的检查/清理 2026-10-27 搬进插件设置页的维护卡（手动触发）：面板不再自动扫，
// 也不再有自己的孤儿读面。这一条钉的是"面板这一侧真的不再开口"——任何一次挂载读、写后读或清空
// 都不许顺手打 `/orphans`（否则又回到"用户没点却在扫"的老状态）。
describe('取数编排 · 面板一次都不自动扫无主子会话', () => {
  it('挂载读、写后重读与清空都不发 /orphans', async () => {
    const { d, result } = mount()
    await act(async () => { await result.current.refreshAll() })
    await act(async () => { await result.current.refreshAfterWrite() })
    await act(async () => { await result.current.emptyTrash() })
    expect(d.list).toHaveBeenCalledTimes(3)
    expect(d.scanOrphans).not.toHaveBeenCalled()
  })
})

describe('取数编排 · 附件清理读数上屏', () => {
  // 附件清理是**上一趟写的后果**，不是清单状态：清单重读读不出它，只能从聚合回执里取。
  // 跳过（skipped）说的是"这一轮部分或整体没敢清"，与 failed（逐文件真出错）分开说。
  it('清空的聚合回执带 skipped ⇒ 原句上屏（removed=0 说整轮没清）', async () => {
    const { result } = mount({
      emptyTrash: vi.fn(async () => ({
        removed: 1, freedBytes: 1,
        attachments: { removed: 0, freedBytes: 0, failed: 0, skipped: '候选日志读不出' },
      })),
    })
    await act(async () => { await result.current.emptyTrash() })
    expect(result.current.attachmentNotice).toBe('附件未清理：候选日志读不出')
  })

  it('skipped 且已清掉一部分 ⇒ 说清"部分"，不冒充整轮失败', async () => {
    const { result } = mount({
      emptyTrash: vi.fn(async () => ({
        removed: 1, freedBytes: 1,
        attachments: { removed: 4, freedBytes: 40, failed: 0, skipped: '剩余引用源读不出' },
      })),
    })
    await act(async () => { await result.current.emptyTrash() })
    expect(result.current.attachmentNotice).toBe('部分附件未清理：剩余引用源读不出（已清理 4 个）')
  })

  it('skipped 与 failed 同时出现 ⇒ 原因在前、失败件数追加在句尾，不许被跳过吞掉', async () => {
    const { result } = mount({
      emptyTrash: vi.fn(async () => ({
        removed: 1, freedBytes: 1,
        attachments: { removed: 0, freedBytes: 0, failed: 2, skipped: '候选日志读不出' },
      })),
    })
    await act(async () => { await result.current.emptyTrash() })
    expect(result.current.attachmentNotice).toBe('附件未清理：候选日志读不出；另有 2 个附件删除失败')
  })

  it('部分清理的 skipped 与 failed 同时出现 ⇒ 已清数、原因、失败数三样都在', async () => {
    const { result } = mount({
      emptyTrash: vi.fn(async () => ({
        removed: 1, freedBytes: 1,
        attachments: { removed: 4, freedBytes: 40, failed: 1, skipped: '剩余引用源读不出' },
      })),
    })
    await act(async () => { await result.current.emptyTrash() })
    expect(result.current.attachmentNotice).toBe(
      '部分附件未清理：剩余引用源读不出（已清理 4 个）；另有 1 个附件删除失败',
    )
  })

  it('没有 skipped、有逐文件失败 ⇒ 报未清理的件数', async () => {
    const { result } = mount({
      emptyTrash: vi.fn(async () => ({
        removed: 1, freedBytes: 1,
        attachments: { removed: 3, freedBytes: 30, failed: 2 },
      })),
    })
    await act(async () => { await result.current.emptyTrash() })
    expect(result.current.attachmentNotice).toBe('已删除会话，但 2 个附件未能清理')
  })

  it('这一趟附件全清干净（或没有读数）⇒ 旧提示一起收掉', async () => {
    let stats: { removed: number; freedBytes: number; attachments?: { removed: number; freedBytes: number; failed: number; skipped?: string } } = {
      removed: 1, freedBytes: 1,
      attachments: { removed: 0, freedBytes: 0, failed: 3 },
    }
    const { result } = mount({ emptyTrash: vi.fn(async () => stats) })
    await act(async () => { await result.current.emptyTrash() })
    expect(result.current.attachmentNotice).toBe('已删除会话，但 3 个附件未能清理')

    stats = { removed: 1, freedBytes: 1 }
    await act(async () => { await result.current.emptyTrash() })
    expect(result.current.attachmentNotice).toBeNull()
  })

  it('顶层失败/没有附件读数时 noteAttachmentCleanup 清掉旧提示', async () => {
    const { result } = mount({
      emptyTrash: vi.fn(async () => ({
        removed: 1, freedBytes: 1,
        attachments: { removed: 0, freedBytes: 0, failed: 1 },
      })),
    })
    await act(async () => { await result.current.emptyTrash() })
    expect(result.current.attachmentNotice).not.toBeNull()

    act(() => { result.current.noteAttachmentCleanup(undefined) })
    expect(result.current.attachmentNotice).toBeNull()
  })

  // 写失败 = 这一趟没拿到回执：不能断言附件清没清，上一条的读数也不许继续顶着"最近一次写"的位置。
  it('清空失败 ⇒ 旧附件提示一起收掉（这一趟没拿到回执）', async () => {
    let fail = false
    const emptyTrash = vi.fn(async () => {
      if (fail) throw Object.assign(new Error('盘上忙'), { code: 'sessiondelete/io' })
      return { removed: 1, freedBytes: 1, attachments: { removed: 0, freedBytes: 0, failed: 3 } }
    })
    const { result } = mount({ emptyTrash })
    await act(async () => { await result.current.emptyTrash() })
    expect(result.current.attachmentNotice).toBe('已删除会话，但 3 个附件未能清理')

    fail = true
    await act(async () => { expect(await result.current.emptyTrash()).toBe(false) })
    expect(result.current.attachmentNotice).toBeNull()
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
      list: vi.fn(async () => { order.push('list'); return rows }),
      emptyTrash: vi.fn(async () => { order.push('empty'); return { removed: 1, freedBytes: 1 } }),
    }, wrap)

    await act(async () => { await result.current.emptyTrash() })
    // 若请求在 around 之外发、或重读没被包进去，这个序都会对不上。
    expect(order).toEqual(['gate:enter', 'empty', 'list', 'gate:leave'])
    expect(result.current.list).toEqual({ status: 'ready', rows })
  })

  it('emptyTrash 失败 ⇒ 清单置为未知，旧行不再留在 ready 里', async () => {
    const { result } = mount({
      emptyTrash: vi.fn(async () => {
        throw Object.assign(new Error('清空失败'), { code: 'sessiondelete/io' })
      }),
    })
    await act(async () => { await result.current.refreshAll() })
    expect(result.current.list.status).toBe('ready')
    await act(async () => { await result.current.emptyTrash() })
    expect(result.current.list).toEqual({ status: 'unknown', failure: '清空失败' })
  })

  it('emptyTrash 失败作废在飞的清单读：晚到的旧读不能把 unknown 盖回 ready', async () => {
    let release!: (value: TrashEntryLike[]) => void
    const list = vi.fn(() => new Promise<TrashEntryLike[]>((resolve) => { release = resolve }))
    const { result } = mount({
      list,
      emptyTrash: vi.fn(async () => {
        throw Object.assign(new Error('清空失败'), { code: 'sessiondelete/io' })
      }),
    })
    let refreshing!: Promise<void>
    act(() => { refreshing = result.current.refreshAll() })
    await act(async () => { await result.current.emptyTrash() })
    expect(result.current.list).toEqual({ status: 'unknown', failure: '清空失败' })
    await act(async () => {
      release(rows)
      await refreshing
    })
    expect(result.current.list).toEqual({ status: 'unknown', failure: '清空失败' })
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
    const { result } = mount({ emptyTrash: vi.fn(async () => { throw new Error('盘上忙') }) })

    await act(async () => { expect(await result.current.emptyTrash()).toBe(false) })
    expect(notice.result.current?.kind).toBe('one')
  })
})
