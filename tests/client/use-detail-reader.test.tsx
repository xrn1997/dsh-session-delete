/**
 * 通用详情读路（`use-detail-reader.ts`）的机制判据：在飞去重、保持（holding）、晚到页丢弃、
 * `reset` 作废，以及**账本是注入的**——回收站与归档两档各带各的账本，互不读写。
 *
 * 这里只抽代表用例跑在内存账本 + 假 fetch 上；回收站实例的全量行为仍钉在
 * `tests/client/use-trash-detail-reader.test.tsx`（重构后必须全绿）。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DETAIL_LEDGER_LIMIT, writeDetail, type DetailLedger } from '../../src/client/detail-ledger.js'
import {
  useDetailReader,
  type DetailReaderInput,
} from '../../src/client/use-detail-reader.js'
import type { RemoteOutcome } from '../../src/client/remote.js'
import type { TrashDetailBlockWire, TrashDetailWire } from '../../src/shared/wire.js'

type D = TrashDetailWire
/** 主体只承诺有 id：通用层的 `idOf` 说了算（回收站给 entry.id，归档给 sessionId）。 */
interface Row { readonly id: string }

const row = (id: string): Row => ({ id })

const detailOf = (id: string, over: Partial<D> = {}): D => ({
  entryId: id, cwd: '', createdAt: 0, lastActivity: 0, logTitle: '', models: [],
  turnCount: 0, userMessageCount: 0, assistantMessageCount: 0, toolCallCount: 0,
  injectedCount: 0, blocks: [], olderCursor: null, ...over,
})

const block = (id: string, text: string): TrashDetailBlockWire => ({
  kind: 'user', id, time: 1, text, truncated: false, attachments: [],
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

/** 内存账本：写入口直接交 `writeDetail`——归档那本就是这份实现，测试不再另抄一遍挪队尾与淘汰。 */
function memoryLedger(): DetailLedger<D> & { map: Map<string, D> } {
  const map = new Map<string, D>()
  return {
    map,
    read: (id) => map.get(id),
    write: (id, detail) => { writeDetail(map, id, detail) },
    forget: (id) => { map.delete(id) },
    clear: () => { map.clear() },
  }
}

const ok = (value: D): RemoteOutcome<D> => ({ ok: true, value })

function mount(options: {
  fetch: (id: string, before?: number) => Promise<RemoteOutcome<D>>
  ledger: DetailLedger<D>
  subject?: Row | null
  topLevel?: boolean
  present?: (id: string) => boolean
}) {
  const initialProps: DetailReaderInput<Row, D> = {
    fetch: options.fetch,
    ledger: options.ledger,
    subject: options.subject ?? null,
    idOf: (s) => s.id,
    topLevel: options.topLevel ?? true,
    present: options.present ?? (() => true),
  }
  const view = renderHook(
    (props: DetailReaderInput<Row, D>) => useDetailReader(props),
    { initialProps },
  )
  return { ...view, props: initialProps }
}

describe('通用详情读路 · 机制（内存账本 + 假 fetch）', () => {
  it('同一条在飞只发一次；loading 先摆到这一条', async () => {
    const pending = deferred<RemoteOutcome<D>>()
    const fetch = vi.fn(() => pending.promise)
    const m = mount({ fetch, ledger: memoryLedger(), subject: row('a') })
    act(() => { void m.result.current.ensure('a') })
    act(() => { void m.result.current.ensure('a') })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(m.result.current.detail).toMatchObject({ kind: 'loading' })
    await act(async () => { pending.resolve(ok(detailOf('a'))); await pending.promise })
    expect(m.result.current.detail.kind).toBe('ready')
  })

  it('顶层换到没读过的条目：上一条仍在清单里 ⇒ holding；读回来整帧换掉', async () => {
    const pending = deferred<RemoteOutcome<D>>()
    const fetch = vi.fn(async (id: string) => (id === 'b' ? pending.promise : ok(detailOf(id))))
    const m = mount({ fetch, ledger: memoryLedger(), subject: row('a') })
    await act(async () => { await m.result.current.ensure('a') })
    expect(m.result.current.detail).toMatchObject({ kind: 'ready', detail: detailOf('a') })

    m.rerender({ ...m.props, subject: row('b') })
    act(() => { void m.result.current.ensure('b') })
    // b 还在读：上一条 a 的 ready 顶住画面（正文 inert），不闪骨架。
    expect(m.result.current.detail).toMatchObject({ kind: 'holding', detail: detailOf('a') })
    await act(async () => { pending.resolve(ok(detailOf('b'))); await pending.promise })
    expect(m.result.current.detail).toMatchObject({ kind: 'ready', detail: detailOf('b') })
  })

  it('晚到的页不落屏：主体已经切走 ⇒ 不合并、账本不被旧页改写', async () => {
    const late = deferred<RemoteOutcome<D>>()
    const fetch = vi.fn(async (id: string, before?: number) =>
      (id === 'a' && before !== undefined ? late.promise : ok(detailOf(id, {
        blocks: [block('1', '新块')], olderCursor: 1,
      }))))
    const ledger = memoryLedger()
    const m = mount({ fetch, ledger, subject: row('a') })
    await act(async () => { await m.result.current.ensure('a') })
    act(() => { void m.result.current.loadOlder() })
    m.rerender({ ...m.props, subject: row('b') })
    await act(async () => { await m.result.current.ensure('b') })
    await act(async () => {
      late.resolve(ok(detailOf('a', { blocks: [block('0', '更早一页')], olderCursor: null })))
      await late.promise
    })
    // 旧页没有落回 a 的账本：a 那份仍是首读的形状。
    expect(ledger.read('a')?.olderCursor).toBe(1)
    expect(m.result.current.detail).toMatchObject({ kind: 'ready', detail: detailOf('b', { blocks: [block('1', '新块')], olderCursor: 1 }) })
  })

  it('reset 作废在飞读数：行被清单收走（reset + 清主体同拍）后，晚到成功不写账本', async () => {
    const pending = deferred<RemoteOutcome<D>>()
    const ledger = memoryLedger()
    const m = mount({ fetch: vi.fn(() => pending.promise), ledger, subject: row('a') })
    act(() => { void m.result.current.ensure('a') })
    // 真实用法里 reset 与清主体同拍（行被清单换版收走）：晚到的读数既不落屏也不落账本。
    act(() => { m.result.current.reset('a') })
    m.rerender({ ...m.props, subject: null })
    await act(async () => { pending.resolve(ok(detailOf('a'))); await pending.promise })
    expect(ledger.read('a')).toBeUndefined()
    expect(m.result.current.detail.kind).toBe('idle')
  })

  it('clearAll 作废在飞读数：作废前发出、作废后才回来的一拍不写回账本（代次闸）', async () => {
    const first = deferred<RemoteOutcome<D>>()
    const second = deferred<RemoteOutcome<D>>()
    let calls = 0
    const fetch = vi.fn(() => {
      calls += 1
      return calls === 1 ? first.promise : second.promise
    })
    const ledger = memoryLedger()
    const m = mount({ fetch, ledger, subject: row('a') })
    act(() => { void m.result.current.ensure('a') })
    expect(fetch).toHaveBeenCalledTimes(1)

    // 整本作废（归档集变更）：账本 / 在飞 / 保持一起清；orphaned effect 补一拍新读。
    act(() => { m.result.current.clearAll() })
    await act(async () => { await Promise.resolve() })
    expect(fetch).toHaveBeenCalledTimes(2)

    // 旧那一拍最后才回来：代次对不上 ⇒ 不写账本、也不按掉新那一拍的在飞。
    await act(async () => { first.resolve(ok(detailOf('a', { logTitle: '旧' }))); await first.promise })
    expect(ledger.read('a')).toBeUndefined()
    expect(m.result.current.detail).toMatchObject({ kind: 'loading' })

    await act(async () => { second.resolve(ok(detailOf('a', { logTitle: '新' }))); await second.promise })
    expect(ledger.read('a')?.logTitle).toBe('新')
  })

  it('账本是注入的：两台实例的账本互不读写', async () => {
    const ledgerA = memoryLedger()
    const ledgerB = memoryLedger()
    const fetch = vi.fn(async (id: string) => ok(detailOf(id)))
    const a = mount({ fetch, ledger: ledgerA, subject: null })
    const b = mount({ fetch, ledger: ledgerB, subject: null })
    await act(async () => { await a.result.current.ensure('x') })
    expect(ledgerA.map.has('x')).toBe(true)
    expect(ledgerB.map.has('x')).toBe(false)
    // b 那台要自己读一次：A 的账本不是它的。
    await act(async () => { await b.result.current.ensure('x') })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(ledgerB.map.has('x')).toBe(true)
  })

  it('账本按最近写入淘汰到上限（两档同一条口径，住 detail-ledger.ts）', async () => {
    const ledger = memoryLedger()
    const fetch = vi.fn(async (id: string) => ok(detailOf(id)))
    const m = mount({ fetch, ledger, subject: null })
    for (let i = 0; i <= DETAIL_LEDGER_LIMIT; i += 1) {
      const id = `s${String(i)}`
      await act(async () => { await m.result.current.ensure(id) })
    }
    // 挤掉的是最久没写的那一条，不是最新选中的那一条。
    expect(ledger.map.size).toBe(DETAIL_LEDGER_LIMIT)
    expect(ledger.read('s0')).toBeUndefined()
    expect(ledger.read(`s${String(DETAIL_LEDGER_LIMIT)}`)).toBeDefined()
  })
})
