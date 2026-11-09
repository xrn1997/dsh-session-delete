/**
 * `useTrashDetailReader` —— 详情读路 module 自己的 interface。
 *
 * 这一份直接打 module（不经过控制器），钉的是它从控制器收过来的五条承重判据：
 * 账本命中不重读、在飞去重、失败不记账且重试会重读、保持（holding）只在顶层且上一条仍可见时成立、
 * 更早一页的合并/晚到丢弃/失败只坏分页。
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrashDetailLike } from '../../src/client/remote.js'
import type { TrashDetailBlockWire, TrashEntryWire } from '../../src/shared/wire.js'
import { readCachedTrashDetail, writeTrashDetail } from '../../src/client/trash-snapshot.js'
import { useTrashDetailReader, type TrashDetailReaderInput } from '../../src/client/use-trash-detail-reader.js'
import { channelOf, createBareFakeRemote, type FakeRemoteMethods } from './support/fake-remote.js'
import { resetClientState } from '../../src/client/reset-client-state.js'

beforeEach(() => {
  resetClientState()
})

const entry = (id: string): TrashEntryWire => ({
  id,
  sessionId: `session-${id}`,
  projectDir: '--p--',
  workspaceId: 'ws',
  wasArchived: false,
  deletedAt: 1,
  title: id,
  sizeBytes: 1,
})

const detailOf = (id: string, over: Partial<TrashDetailLike> = {}): TrashDetailLike => ({
  entryId: id,
  cwd: 'C:/p',
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
  ...over,
})

const block = (id: string, text: string): TrashDetailBlockWire => ({
  kind: 'user', id, time: 0, text, truncated: false, attachments: [],
})

const A = entry('a')
const B = entry('b')

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

interface MountOptions {
  subject?: TrashEntryWire | null
  topLevel?: boolean
  present?: (entryId: string) => boolean
  detail?: FakeRemoteMethods['detail']
}

function mount(options: MountOptions = {}) {
  const detail = options.detail ?? vi.fn(async (id: string) => detailOf(id))
  const deps = channelOf(createBareFakeRemote({ detail }))
  const initialProps: TrashDetailReaderInput = {
    deps,
    subject: options.subject ?? null,
    topLevel: options.topLevel ?? true,
    present: options.present ?? (() => true),
  }
  const view = renderHook(
    (props: TrashDetailReaderInput) => useTrashDetailReader(props),
    { initialProps },
  )
  return { detail, deps, ...view }
}

describe('详情读路 · 账本与在飞', () => {
  it('命中账本不重读；未命中才读一次，成功后写账本', async () => {
    writeTrashDetail('a', detailOf('a'))
    const m = mount({ subject: A })
    await act(async () => { await m.result.current.ensure('a') })
    expect(m.detail).not.toHaveBeenCalled()
    expect(m.result.current.detail).toEqual({ kind: 'ready', entry: A, detail: detailOf('a') })

    const m2 = mount({ subject: B })
    await act(async () => { await m2.result.current.ensure('b') })
    expect(m2.detail).toHaveBeenCalledWith('b')
    expect(readCachedTrashDetail('b')?.entryId).toBe('b')
    expect(m2.result.current.detail.kind).toBe('ready')
  })

  it('同一条在飞只发一次；loading 先摆到这一条', async () => {
    const pending = deferred<TrashDetailLike>()
    const detail = vi.fn(async () => pending.promise)
    const m = mount({ subject: A, detail })
    let first!: Promise<void>
    act(() => { first = m.result.current.ensure('a') })
    let second!: Promise<void>
    act(() => { second = m.result.current.ensure('a') })
    expect(detail).toHaveBeenCalledTimes(1)
    expect(m.result.current.detail).toEqual({ kind: 'loading', entry: A })

    await act(async () => { pending.resolve(detailOf('a')); await first; await second })
    expect(m.result.current.detail.kind).toBe('ready')
  })

  it('失败不记账本；重试会重读', async () => {
    const detail = vi.fn()
      .mockRejectedValueOnce(new Error('读不出来'))
      .mockResolvedValueOnce(detailOf('a'))
    const m = mount({ subject: A, detail })
    await act(async () => { await m.result.current.ensure('a') })
    expect(m.result.current.detail).toEqual({ kind: 'failed', entry: A, message: '读不出来' })
    expect(readCachedTrashDetail('a')).toBeUndefined()

    await act(async () => { m.result.current.retry() })
    await act(async () => { await Promise.resolve() })
    expect(detail).toHaveBeenCalledTimes(2)
    expect(m.result.current.detail.kind).toBe('ready')
  })

  it('prefetch 只热身：不把当前详情顶成 loading，之后选中它不再重读', async () => {
    writeTrashDetail('a', detailOf('a'))
    const pending = deferred<TrashDetailLike>()
    const detail = vi.fn(async (id: string) => (id === 'b' ? pending.promise : detailOf(id)))
    const m = mount({ subject: A, detail })
    expect(m.result.current.detail.kind).toBe('ready')

    act(() => { m.result.current.prefetch('b') })
    expect(m.result.current.detail).toEqual({ kind: 'ready', entry: A, detail: detailOf('a') })
    await act(async () => { pending.resolve(detailOf('b')) })
    await act(async () => { await Promise.resolve() })

    m.rerender({ deps: m.deps, subject: B, topLevel: true, present: () => true })
    await act(async () => { await m.result.current.ensure('b') })
    expect(detail).toHaveBeenCalledTimes(1)
    expect(m.result.current.detail).toEqual({ kind: 'ready', entry: B, detail: detailOf('b') })
  })

  it('prefetch 成功不清掉已上屏的失败块；换成正文要等显式重试', async () => {
    const detail = vi.fn()
      .mockRejectedValueOnce(new Error('读不出来'))
      .mockResolvedValueOnce(detailOf('a'))
    const m = mount({ subject: A, detail })
    await act(async () => { await m.result.current.ensure('a') })
    expect(m.result.current.detail).toEqual({ kind: 'failed', entry: A, message: '读不出来' })

    await act(async () => { m.result.current.prefetch('a') })
    await act(async () => { await Promise.resolve() })
    // 账本热了，但失败是用户已经看见的结论：预取不许替用户把它换成正文（ADR-0051）。
    expect(readCachedTrashDetail('a')?.entryId).toBe('a')
    expect(m.result.current.detail).toEqual({ kind: 'failed', entry: A, message: '读不出来' })

    await act(async () => { m.result.current.retry() })
    await act(async () => { await Promise.resolve() })
    expect(m.result.current.detail).toEqual({ kind: 'ready', entry: A, detail: detailOf('a') })
    expect(detail).toHaveBeenCalledTimes(2)
  })

  it('prefetch 失败不记账、也不把当前主体按成 failed', async () => {
    writeTrashDetail('a', detailOf('a'))
    const detail = vi.fn(async () => { throw new Error('b 读不出来') })
    const m = mount({ subject: A, detail })
    await act(async () => { m.result.current.prefetch('b') })
    await act(async () => { await Promise.resolve() })
    expect(readCachedTrashDetail('b')).toBeUndefined()
    expect(m.result.current.detail).toEqual({ kind: 'ready', entry: A, detail: detailOf('a') })
  })

  it('预取在飞时点中它：预取那次请求的失败落该条自己的失败块，不卡成永久 loading', async () => {
    // 点击常落在预取的 150ms 之后、读数回来之前：选中借的是预取那一次请求（在飞去重不发第二条），
    // 预取的失败就是选中的失败。再按 quiet 哑掉，这一条就只剩一个没有在飞、没有失败块、账本也没
    // 命中的 loading，没有任何东西再来推它（ADR-0051 决定 3）。
    writeTrashDetail('a', detailOf('a'))
    const pending = deferred<TrashDetailLike>()
    const detail = vi.fn(async (id: string) => (id === 'b' ? pending.promise : detailOf(id)))
    const m = mount({ subject: A, detail })
    act(() => { m.result.current.prefetch('b') })
    m.rerender({ deps: m.deps, subject: B, topLevel: true, present: () => true })
    await act(async () => { await m.result.current.ensure('b') })
    expect(detail).toHaveBeenCalledTimes(1)

    await act(async () => { pending.reject(new Error('读不出来')); await Promise.resolve() })
    expect(m.result.current.detail).toEqual({ kind: 'failed', entry: B, message: '读不出来' })
    expect(readCachedTrashDetail('b')).toBeUndefined()
  })

  it('卸载后晚到的详情读数不落账本（ADR-0048 边界）', async () => {
    const pending = deferred<TrashDetailLike>()
    const detail = vi.fn(async () => pending.promise)
    const m = mount({ subject: A, detail })
    act(() => { void m.result.current.ensure('a') })
    m.unmount()
    await act(async () => { pending.resolve(detailOf('a')); await Promise.resolve() })
    expect(readCachedTrashDetail('a')).toBeUndefined()
  })

  it('卸载后晚到的失败不碰账本：新挂载刚写下的那条还在', async () => {
    const pending = deferred<TrashDetailLike>()
    const detail = vi.fn(async () => pending.promise)
    const m = mount({ subject: A, detail })
    act(() => { void m.result.current.ensure('a') })
    m.unmount()
    // 新挂载（或清单对账）在这期间写下的同一条：旧挂载晚到的失败不许把它 forget 掉。
    writeTrashDetail('a', detailOf('a'))
    await act(async () => { pending.reject(new Error('读不出来')); await Promise.resolve() })
    expect(readCachedTrashDetail('a')?.entryId).toBe('a')
  })

  it('当前主体被账本淘汰（64 条上限）后自己补读，不留在没有在飞的骨架', async () => {
    // 账本按「最近写入」淘汰，意图预取与孩子详情都在写：选中那一条若不再有写入就会被挤出去。
    // 那一拍 memo 只能落 loading 兜底、而没有一次读在飞——详情块的 loading 面没有重试键，
    // 不补这一次，骨架会一直挂着，直到读者再点一次这一行。
    const detail = vi.fn(async (id: string) => detailOf(id))
    const m = mount({ subject: A, detail })
    await act(async () => { await m.result.current.ensure('a') })
    expect(m.result.current.detail.kind).toBe('ready')

    for (let i = 0; i < 70; i += 1) writeTrashDetail(`h${String(i)}`, detailOf(`h${String(i)}`))
    expect(readCachedTrashDetail('a')).toBeUndefined()

    // 账本是模块级 Map，让 memo 重算一次（真实路径上由另一次读数落地的版本信号 / 清单换版触发）。
    m.rerender({ deps: m.deps, subject: A, topLevel: true, present: () => true })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })

    expect(m.result.current.detail.kind).toBe('ready')
    expect(detail).toHaveBeenCalledTimes(2)
  })
})

describe('详情读路 · 保持（holding）', () => {
  it('顶层换到没读过的条目：上一条仍在清单里 ⇒ holding；读回来整帧换掉', async () => {
    writeTrashDetail('a', detailOf('a'))
    const pending = deferred<TrashDetailLike>()
    const detail = vi.fn(async (id: string) => (id === 'b' ? pending.promise : detailOf(id)))
    const m = mount({ subject: A, detail })
    expect(m.result.current.detail.kind).toBe('ready')

    m.rerender({ deps: m.deps, subject: B, topLevel: true, present: () => true })
    act(() => { void m.result.current.ensure('b') })
    expect(m.result.current.detail).toEqual({
      kind: 'holding', entry: A, detail: detailOf('a'),
    })

    await act(async () => { pending.resolve(detailOf('b')) })
    expect(m.result.current.detail).toEqual({ kind: 'ready', entry: B, detail: detailOf('b') })
  })

  it('上一条已不在清单里 ⇒ 不 holding，走 loading', () => {
    writeTrashDetail('a', detailOf('a'))
    const pending = deferred<TrashDetailLike>()
    const detail = vi.fn(async () => pending.promise)
    const m = mount({ subject: A, detail })
    m.rerender({ deps: m.deps, subject: B, topLevel: true, present: () => false })
    act(() => { void m.result.current.ensure('b') })
    expect(m.result.current.detail).toEqual({ kind: 'loading', entry: B })
  })

  it('孩子视图（topLevel=false）不 holding', () => {
    writeTrashDetail('a', detailOf('a'))
    const pending = deferred<TrashDetailLike>()
    const detail = vi.fn(async () => pending.promise)
    const m = mount({ subject: A, detail })
    m.rerender({ deps: m.deps, subject: B, topLevel: false, present: () => true })
    act(() => { void m.result.current.ensure('b') })
    expect(m.result.current.detail).toEqual({ kind: 'loading', entry: B })
  })
})

describe('详情读路 · 更早一页', () => {
  const tail = detailOf('a', { blocks: [block('10', '尾')], olderCursor: 10 })

  it('按账本游标读，拼到前面、更新游标并写回账本', async () => {
    writeTrashDetail('a', tail)
    const page = detailOf('a', { blocks: [block('0', '早')], olderCursor: null })
    const detail = vi.fn(async () => page)
    const m = mount({ subject: A, detail })
    await act(async () => { await m.result.current.loadOlder() })
    expect(detail).toHaveBeenCalledWith('a', 10)
    expect(m.result.current.detail).toEqual({
      kind: 'ready',
      entry: A,
      detail: { ...tail, blocks: [block('0', '早'), block('10', '尾')], olderCursor: null },
    })
    expect(readCachedTrashDetail('a')?.olderCursor).toBeNull()
  })

  it('在飞时 loadingOlder 为真，重复调用不重复读', async () => {
    writeTrashDetail('a', tail)
    const pending = deferred<TrashDetailLike>()
    const detail = vi.fn(async () => pending.promise)
    const m = mount({ subject: A, detail })
    act(() => { void m.result.current.loadOlder() })
    act(() => { void m.result.current.loadOlder() })
    expect(detail).toHaveBeenCalledTimes(1)
    expect(m.result.current.loadingOlder).toBe(true)

    await act(async () => { pending.resolve(detailOf('a')) })
    expect(m.result.current.loadingOlder).toBe(false)
  })

  it('晚到的页不落屏：主体已经切走', async () => {
    writeTrashDetail('a', tail)
    writeTrashDetail('b', detailOf('b'))
    const pending = deferred<TrashDetailLike>()
    const detail = vi.fn(async () => pending.promise)
    const m = mount({ subject: A, detail })
    act(() => { void m.result.current.loadOlder() })
    m.rerender({ deps: m.deps, subject: B, topLevel: true, present: () => true })
    await act(async () => { pending.resolve(detailOf('a', { blocks: [block('0', '早')] })) })
    expect(readCachedTrashDetail('a')).toBe(tail)
    expect(m.result.current.olderFailure).toBeNull()
  })

  it('失败只坏分页：正文仍是 ready，原文单独一格；reset 收掉', async () => {
    writeTrashDetail('a', tail)
    const detail = vi.fn(async () => { throw new Error('读不出更早的页') })
    const m = mount({ subject: A, detail })
    await act(async () => { await m.result.current.loadOlder() })
    expect(m.result.current.detail).toEqual({ kind: 'ready', entry: A, detail: tail })
    expect(m.result.current.olderFailure).toBe('读不出更早的页')

    act(() => { m.result.current.clearOlderFailure() })
    expect(m.result.current.olderFailure).toBeNull()
  })

  it('reset 收掉分页现场；不会把已合并的正文打回 loading', async () => {
    writeTrashDetail('a', tail)
    const detail = vi.fn(async () => { throw new Error('读不出') })
    const m = mount({ subject: A, detail })
    await act(async () => { await m.result.current.loadOlder() })
    expect(m.result.current.olderFailure).not.toBeNull()

    act(() => { m.result.current.reset('a') })
    expect(m.result.current.olderFailure).toBeNull()
    expect(m.result.current.detail.kind).toBe('ready')
  })

  // 选中行被清单收走时（彻底删除 / 恢复成功 / 别处动过），控制器先 `forgetTrashDetail` 再
  // `reset(entryId)`；这一条在飞的 `/detail` 若晚到成功，不许把它重新写回模块级账本
  // （账本跨挂载存活，孩子详情还不随清单修剪）。
  it('reset 作废这一条在飞的读数：晚到的成功不写回账本', async () => {
    const pending = deferred<TrashDetailLike>()
    const detail = vi.fn(async () => pending.promise)
    const m = mount({ subject: A, detail })
    let read!: Promise<void>
    act(() => { read = m.result.current.ensure('a') })
    act(() => { m.result.current.reset('a') })
    // 控制器的顺序：清单把选中行收走 ⇒ 这一帧主体已经没了（不会再触发自动补读）。
    m.rerender({ deps: m.deps, subject: null, topLevel: true, present: () => true })
    await act(async () => { pending.resolve(detailOf('a')); await read })
    expect(readCachedTrashDetail('a')).toBeUndefined()
  })

  // 行被清单收走时，150ms 的预取计时器可能正好还没落地：一次迟到的意图不许把 `reset` 的作废
  // 撤销掉（它没有发起新读数——同一条仍在飞），否则晚到的成功又把该条写回模块级账本。
  it('reset 之后迟到的预取不撤销作废：同一条在飞时晚到的成功仍不写账本', async () => {
    const pending = deferred<TrashDetailLike>()
    const detail = vi.fn(async () => pending.promise)
    const m = mount({ subject: A, detail })
    let read!: Promise<void>
    act(() => { read = m.result.current.ensure('a') })
    act(() => { m.result.current.reset('a') })
    act(() => { m.result.current.prefetch('a') })
    m.rerender({ deps: m.deps, subject: null, topLevel: true, present: () => true })
    await act(async () => { pending.resolve(detailOf('a')); await read })
    expect(detail).toHaveBeenCalledTimes(1)
    expect(readCachedTrashDetail('a')).toBeUndefined()
  })
})
