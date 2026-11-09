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
import type { TrashDetailLike, TrashEntryLike } from '../../src/client/remote.js'
import { readCachedTrashDetail, readTrashSnapshot, reconcileTrashRows, writeTrashDetail } from '../../src/client/trash-snapshot.js'
import { publishUndoNotice, useUndoNotice } from '../../src/client/undo-notices.js'
import type { PurgeStatsWire } from '../../src/shared/wire.js'
import { createFakeRemote, type FakeRemote, type FakeRemoteMethods } from './support/fake-remote.js'
import { resetClientState } from '../../src/client/reset-client-state.js'
import { pick } from '../support/fixture.js'

const rows: TrashEntryLike[] = [
  { id: 'a', sessionId: 'session-a', projectDir: '--p--', workspaceId: 'ws', wasArchived: false, deletedAt: 1, sizeBytes: 10, releaseBytes: 10, title: 'A' },
]

const detailOf = (entryId: string): TrashDetailLike => ({
  entryId, cwd: '', createdAt: 0, lastActivity: 0, logTitle: '', models: [],
  turnCount: 0, userMessageCount: 0, assistantMessageCount: 0, toolCallCount: 0,
  injectedCount: 0, blocks: [], olderCursor: null,
})

// 模块级现场（跨用例存活）：一条复位口收全部，用例之间互不串味。
beforeEach(() => { resetClientState() })

function deps(over: Partial<FakeRemoteMethods> = {}): FakeRemote {
  return createFakeRemote({
    list: vi.fn(async () => rows),
    emptyTrash: vi.fn(async () => ({ removed: 1, freedBytes: 1 })),
    ...over,
  })
}

/** 闸的本体与形状住 `src/client/busy-gate.ts`；这里只借它的 `around` 签名搭替身。 */
type Around = BusyGate['around']

/** 这类编排测试不关心渲染期的禁用：替身直接放行。 */
const passThrough: Around = async <T,>(task: () => Promise<T>) => ({ kind: 'ran', value: await task() })

function mount(over: Partial<FakeRemoteMethods> = {}, around: Around = passThrough) {
  const d = deps(over)
  const view = renderHook(() => useTrashQuery({ deps: d, t: zhTranslate, gate: { busy: false, around } }))
  return { d, ...view }
}

describe('取数编排 · 清单状态的唯一解读', () => {
  it('loading / unknown / ready 一次交出 rows、failure、loading、空态与刷新中', () => {
    expect(listView({ status: 'loading' })).toEqual({
      rows: null, failure: null, loading: true, empty: false, refreshing: false,
    })
    expect(listView({ status: 'unknown', failure: '清单坏了' })).toEqual({
      rows: null, failure: '清单坏了', loading: false, empty: false, refreshing: false,
    })
    expect(listView({ status: 'ready', rows: [] })).toEqual({
      rows: [], failure: null, loading: false, empty: true, refreshing: false,
    })
    expect(listView({ status: 'ready', rows })).toEqual({
      rows, failure: null, loading: false, empty: false, refreshing: false,
    })
    // 已有行、重读还在飞：行照画，只是多一个"这行来自上一份成功读数"的信号（视图拿它挂 aria-busy，不画文字）。
    expect(listView({ status: 'ready', rows }, true)).toEqual({
      rows, failure: null, loading: false, empty: false, refreshing: true,
    })
  })
})

describe('取数编排 · 首帧快照', () => {
  it('没有快照 ⇒ 仍从 loading 起画，refreshing 为假', () => {
    const { result } = mount()
    expect(result.current.list).toEqual({ status: 'loading' })
    expect(result.current.refreshing).toBe(false)
  })

  it('挂载时有快照 ⇒ 首帧就是 ready 的旧行，并标 refreshing', () => {
    reconcileTrashRows(rows)
    const { result } = mount()
    expect(result.current.list).toEqual({ status: 'ready', rows })
    expect(result.current.refreshing).toBe(true)
  })

  it('重读成功写回快照并关 refreshing', async () => {
    reconcileTrashRows(rows)
    const { result } = mount()
    await act(async () => { await result.current.reload() })
    expect(result.current.refreshing).toBe(false)
    expect(readTrashSnapshot()?.rows).toEqual(rows)
  })

  it('重读失败丢掉快照并落 unknown', async () => {
    reconcileTrashRows(rows)
    const { result } = mount({
      list: vi.fn(async () => { throw Object.assign(new Error('清单坏了'), { code: 'sessiondelete/io' }) }),
    })
    await act(async () => { await result.current.reload() })
    expect(result.current.list).toEqual({ status: 'unknown', failure: '清单坏了' })
    expect(readTrashSnapshot()).toBeNull()
  })

  it('已有行时重读在飞也标 refreshing：不只在首帧快照那一次', async () => {
    const list = vi.fn(async () => rows)
    const { result } = mount({ list })
    await act(async () => { await result.current.reload() })
    expect(result.current.refreshing).toBe(false)

    let resolve!: (value: TrashEntryLike[]) => void
    const pending = new Promise<TrashEntryLike[]>((inResolve) => { resolve = inResolve })
    list.mockImplementationOnce(() => pending)
    act(() => { void result.current.reload() })
    expect(result.current.list).toEqual({ status: 'ready', rows })
    expect(result.current.refreshing).toBe(true)

    await act(async () => { resolve(rows) })
    expect(result.current.refreshing).toBe(false)
  })

  it('旧挂载晚到的读数不写快照：切走再回来时只有新挂载的读数作数', async () => {
    const row = (id: string): TrashEntryLike => ({
      id, sessionId: `session-${id}`, projectDir: '--p--', workspaceId: 'ws',
      wasArchived: false, deletedAt: 1, sizeBytes: 10, releaseBytes: 10, title: id,
    })
    let releaseOld!: (value: TrashEntryLike[]) => void
    const first = mount({
      list: vi.fn(() => new Promise<TrashEntryLike[]>((resolve) => { releaseOld = resolve })),
    })
    act(() => { void first.result.current.reload() })
    first.unmount()

    const freshRows = [row('fresh')]
    const second = mount({ list: vi.fn(async () => freshRows) })
    await act(async () => { await second.result.current.reload() })
    expect(readTrashSnapshot()?.rows).toEqual(freshRows)

    // 旧挂载的响应此刻才落地：它属于已经卸载的那一次界面，不许改模块级快照。
    await act(async () => { releaseOld([row('old')]) })
    expect(readTrashSnapshot()?.rows).toEqual(freshRows)
  })

  it('旧挂载晚到的失败也不清快照：新挂载刚写下的读数不许被上一代界面作废', async () => {
    let rejectOld!: (reason: unknown) => void
    const first = mount({
      list: vi.fn(() => new Promise<TrashEntryLike[]>((_resolve, reject) => { rejectOld = reject })),
    })
    act(() => { void first.result.current.reload() })
    first.unmount()

    const freshRows = [{
      id: 'fresh', sessionId: 'session-fresh', projectDir: '--p--', workspaceId: 'ws',
      wasArchived: false, deletedAt: 1, sizeBytes: 10, releaseBytes: 10, title: 'fresh',
    }]
    const second = mount({ list: vi.fn(async () => freshRows) })
    await act(async () => { await second.result.current.reload() })
    expect(readTrashSnapshot()?.rows).toEqual(freshRows)

    await act(async () => { rejectOld(new Error('旧读失败')) })
    expect(readTrashSnapshot()?.rows).toEqual(freshRows)
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
      first = result.current.reload()
      second = result.current.reload()
    })
    const fresh = [{ ...pick(rows, 0), id: 'fresh' }]
    await act(async () => {
      pick(resolvers, 1)(fresh)
      await second
    })
    await act(async () => {
      pick(resolvers, 0)(rows)
      await first
    })
    expect(result.current.list).toEqual({ status: 'ready', rows: fresh })
  })

  it('读不到 ⇒ 清单进 unknown、原文进 failure（"读不到"与"空的"是两件事）', async () => {
    const { result } = mount({
      list: vi.fn(async () => { throw Object.assign(new Error('清单损坏'), { code: 'sessiondelete/io' }) }),
    })
    await act(async () => { await result.current.reload() })
    expect(result.current.list).toEqual({ status: 'unknown', failure: '清单损坏' })
  })
})

// issue #8 第 3 条：刷新链曾经押在「deps 对象引用稳定」的隐式契约上——调用方逐渲染传新
// deps 字面量就会形成「refresh → setList → 重渲 → reload 身份变 → effect 再 refresh」的环。
// 契约根治：hook 内部 ref 归一，返回的回调身份恒稳、调用时读最新 deps。
describe('取数编排 · deps 引用不需稳定', () => {
  it('deps 每次渲染换新对象也不换回调身份，且调用时读的是最新 deps', async () => {
    const first = deps()
    const { result, rerender } = renderHook(
      (p: { d: FakeRemote }) => useTrashQuery({ deps: p.d, t: zhTranslate, gate: { busy: false, around: passThrough } }),
      { initialProps: { d: first } },
    )
    const stable = {
      reload: result.current.reload,
      emptyTrash: result.current.emptyTrash,
      noteAttachmentCleanup: result.current.noteAttachmentCleanup,
    }
    const second = deps()
    const third = deps()
    rerender({ d: second })
    rerender({ d: third })
    expect(result.current.reload).toBe(stable.reload)
    expect(result.current.emptyTrash).toBe(stable.emptyTrash)
    expect(result.current.noteAttachmentCleanup).toBe(stable.noteAttachmentCleanup)

    // 身份稳了还不够：回调必须读**最新**那一份 deps，不许把旧的冻进闭包。
    await act(async () => { await result.current.reload() })
    expect(third.list).toHaveBeenCalledTimes(1)
    expect(second.list).not.toHaveBeenCalled()
    expect(first.list).not.toHaveBeenCalled()
    await act(async () => { await result.current.emptyTrash() })
    expect(third.emptyTrash).toHaveBeenCalledTimes(1)
    expect(second.emptyTrash).not.toHaveBeenCalled()
    expect(first.emptyTrash).not.toHaveBeenCalled()
  })
})

// 孤儿会话的检查/清理 2026-10-27 搬进插件设置页的维护卡（手动触发）：面板不再自动扫，
// 也不再有自己的孤儿读面。这一条钉的是"面板这一侧真的不再开口"——任何一次挂载读、写后读或清空
// 都不许顺手打 `/orphans`（否则又回到"用户没点却在扫"的老状态）。
describe('取数编排 · 面板一次都不自动扫无主子会话', () => {
  it('挂载读、写后重读与清空都不发 /orphans', async () => {
    const { d, result } = mount()
    await act(async () => { await result.current.reload() })
    await act(async () => { await result.current.reload() })
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
    await act(async () => { expect(await result.current.emptyTrash()).toEqual({ kind: 'ran', value: false }) })
    expect(result.current.attachmentNotice).toBeNull()
  })
})

describe('取数编排 · 清空走注入的闸', () => {
  it('emptyTrash 的请求与清单重读都在闸里跑：先开闸、再发请求、最后关闸', async () => {
    const order: string[] = []
    const wrap: Around = async <T,>(task: () => Promise<T>) => {
      order.push('gate:enter')
      const value = await task().finally(() => { order.push('gate:leave') })
      return { kind: 'ran', value }
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
    await act(async () => { await result.current.reload() })
    expect(result.current.list.status).toBe('ready')
    await act(async () => { await result.current.emptyTrash() })
    expect(result.current.list).toEqual({ status: 'unknown', failure: '清空失败' })
  })

  it('闸挡回（这一趟没跑）⇒ 交回 blocked 而不是 false：不发 /empty，清单与附件提示都不动', async () => {
    // `false` 说的是「跑过、没清成」；挡回来的那趟什么都没跑，调用方要能把两者分开（否则会收框、丢账本）。
    const blocked: Around = async () => ({ kind: 'blocked' })
    const { d, result } = mount({}, blocked)
    await act(async () => { await result.current.reload() })
    const beforeList = result.current.list
    const beforeNotice = result.current.attachmentNotice
    await act(async () => { expect(await result.current.emptyTrash()).toEqual({ kind: 'blocked' }) })
    expect(d.emptyTrash).not.toHaveBeenCalled()
    expect(result.current.list).toBe(beforeList)
    expect(result.current.attachmentNotice).toBe(beforeNotice)
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
    act(() => { refreshing = result.current.reload() })
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
  beforeEach(() => { resetClientState() })

  it('清空成功：指向发起时在场条目的横幅收掉——落点全没了，留着就是一条注定失败的「撤销」', async () => {
    publishUndoNotice({ entryId: 'a', title: 'A' })
    const notice = renderHook(() => useUndoNotice())
    // 先确认现场真的挂着：否则「收掉了」可能只是从没挂上过。
    expect(notice.result.current?.kind).toBe('one')
    const { result } = mount()
    // 真实入口只在清单已读到时才给「清空」；先读一次，发起时名单才是 [a]。
    await act(async () => { await result.current.reload() })

    await act(async () => { expect(await result.current.emptyTrash()).toEqual({ kind: 'ran', value: true }) })
    expect(notice.result.current).toBeNull()
  })

  it('清空在飞期间新删除发布的横幅不被这次清空误熄', async () => {
    let releaseEmpty!: (value: PurgeStatsWire) => void
    const emptyTrash = vi.fn(() => new Promise<PurgeStatsWire>((resolve) => { releaseEmpty = resolve }))
    const { result } = mount({ emptyTrash })
    await act(async () => { await result.current.reload() })
    const notice = renderHook(() => useUndoNotice())

    let running!: Promise<unknown>
    act(() => { running = result.current.emptyTrash() })
    // 清空请求还在飞时，另一处删了一条并把新横幅顶上来：它不在发起时的名单里。
    act(() => { publishUndoNotice({ entryId: 'fresh', title: 'Fresh' }) })
    expect(notice.result.current).toMatchObject({ kind: 'one', entryId: 'fresh' })

    await act(async () => { releaseEmpty({ removed: 1, freedBytes: 1 }); await running })
    expect(notice.result.current).toMatchObject({ kind: 'one', entryId: 'fresh' })
  })

  it('卸载后晚到的清空成功：不重读、不清新挂载的账本，也不误熄新发布的横幅', async () => {
    writeTrashDetail('a', detailOf('a'))
    let releaseEmpty!: (value: PurgeStatsWire) => void
    const list = vi.fn(async () => rows)
    const first = mount({
      list,
      emptyTrash: vi.fn(() => new Promise<PurgeStatsWire>((resolve) => { releaseEmpty = resolve })),
    })
    let running!: Promise<unknown>
    act(() => { running = first.result.current.emptyTrash() })
    first.unmount()

    const notice = renderHook(() => useUndoNotice())
    act(() => { publishUndoNotice({ entryId: 'fresh', title: 'Fresh' }) })
    await act(async () => { releaseEmpty({ removed: 1, freedBytes: 1 }); await running })

    // 旧挂载的晚到结论只交付「清空成功」：重读、快照、账本与横幅都归后来那次挂载。
    expect(notice.result.current).toMatchObject({ kind: 'one', entryId: 'fresh' })
    expect(readCachedTrashDetail('a')?.entryId).toBe('a')
    expect(list).not.toHaveBeenCalled()
  })

  it('清空成功丢整份详情账本：孩子详情不随清单修剪，必须在这里作废', async () => {
    // 孩子详情从不在清单行里，`reconcileTrashRows` 不会按清单把它剪掉；清空成功必须整份作废。
    writeTrashDetail('kid', detailOf('kid'))
    const { result } = mount()

    await act(async () => { await result.current.emptyTrash() })
    expect(readCachedTrashDetail('kid')).toBeUndefined()
  })

  it('清空失败：横幅留着——回收站此刻还在，撤销仍是可做的动作', async () => {
    publishUndoNotice({ entryId: 'a', title: 'A' })
    const notice = renderHook(() => useUndoNotice())
    const { result } = mount({ emptyTrash: vi.fn(async () => { throw new Error('盘上忙') }) })

    await act(async () => { expect(await result.current.emptyTrash()).toEqual({ kind: 'ran', value: false }) })
    expect(notice.result.current?.kind).toBe('one')
  })
})
