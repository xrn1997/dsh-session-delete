/**
 * 归档清单查询（`use-archive-query.ts`）：四态（loading / ready / failure / corpus-missing）、
 * **唯一**重读入口 `reload`、失效合并与 latest-wins（旧响应不许盖新态）、M 的惰性读数、
 * 快照隔离（归档清单不写 `trash-snapshot`，卸载即丢）。
 *
 * 失效链的三个来源都只戳修订台（`trash-store` / `archive-store`），查询自己订阅两台；
 * active=false 只置脏不读（默认档是回收站，不为可能不打开的档付全语料读）。
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useArchiveQuery } from '../../src/client/use-archive-query.js'
import { invalidateArchive } from '../../src/client/archive-store.js'
import { invalidateTrash } from '../../src/client/trash-store.js'
import { readTrashSnapshot } from '../../src/client/trash-snapshot.js'
import { resetClientState } from '../../src/client/reset-client-state.js'
import type { ArchiveListWire, ArchiveRowWire } from '../../src/shared/wire.js'
import type { RemoteOutcome, SessionDeleteRemote } from '../../src/client/remote.js'

const row = (sessionId: string): ArchiveRowWire => ({
  sessionId, projectDir: '--p--', title: sessionId, updatedAt: 1, updatedAtSource: 'prompt', subagent: false,
})
const ready = (rows: readonly ArchiveRowWire[]): RemoteOutcome<ArchiveListWire> => ({
  ok: true, value: { available: true, rows: [...rows], totalBytes: 0, missingSizeCount: 0 },
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

type Fetch = SessionDeleteRemote['archiveList']

function mountQuery(archiveList: Fetch, active = true) {
  const initialProps = { deps: { archiveList }, active }
  const view = renderHook(
    (p: { deps: { archiveList: Fetch }; active: boolean }) => useArchiveQuery(p),
    { initialProps },
  )
  return { ...view, props: initialProps }
}

/** 微任务+effect 合并后的空拍（fetch 立即完成时用）：失效链路多一级调度，留足微任务轮次。 */
const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

describe('归档清单查询（use-archive-query）', () => {
  beforeEach(() => { resetClientState() })

  it('active=false 只置脏不读；切到 active 那一拍才读', async () => {
    const archiveList = vi.fn(async () => ready([]))
    const m = mountQuery(archiveList, false)
    await flush()
    expect(archiveList).not.toHaveBeenCalled()
    act(() => { invalidateArchive(); invalidateTrash() })
    await flush()
    expect(archiveList).not.toHaveBeenCalled()
    m.rerender({ ...m.props, active: true })
    await flush()
    expect(archiveList).toHaveBeenCalledTimes(1)
  })

  it('trash 修订 + 归档修订同拍 ⇒ 一次读（合并）；在飞期间只置脏、结算后一轮追补，旧响应不盖新态', async () => {
    const pending: Array<{ promise: Promise<RemoteOutcome<ArchiveListWire>>; resolve: (value: RemoteOutcome<ArchiveListWire>) => void }> = []
    const archiveList = vi.fn((): Promise<RemoteOutcome<ArchiveListWire>> => {
      const d = deferred<RemoteOutcome<ArchiveListWire>>()
      pending.push(d)
      return d.promise
    })
    const m = mountQuery(archiveList, true)
    // 挂载读经共用生命周期排到微任务：先让 fetch 发出去再结算它。
    await flush()
    await act(async () => { pending[0]?.resolve(ready([])); await pending[0]?.promise })
    expect(archiveList).toHaveBeenCalledTimes(1)

    // 同一拍的两个失效合并成一次读。
    act(() => { invalidateTrash(); invalidateArchive() })
    await flush()
    expect(archiveList).toHaveBeenCalledTimes(2)

    // 在飞期间的新失效只置脏：单飞，不并发第三条；结算后恰一轮追补。
    act(() => { invalidateArchive() })
    await flush()
    expect(archiveList).toHaveBeenCalledTimes(2)
    await act(async () => {
      pending[1]?.resolve(ready([row('old')]))
      await pending[1]?.promise
    })
    await flush()
    expect(archiveList).toHaveBeenCalledTimes(3)
    await act(async () => {
      pending[2]?.resolve(ready([row('new')]))
      await pending[2]?.promise
    })
    expect(m.result.current.list).toMatchObject({ status: 'ready', rows: [{ sessionId: 'new' }] })
  })

  it('latest-wins：旧响应不盖新态', async () => {
    const pending: Array<{ promise: Promise<RemoteOutcome<ArchiveListWire>>; resolve: (value: RemoteOutcome<ArchiveListWire>) => void }> = []
    const archiveList = vi.fn((): Promise<RemoteOutcome<ArchiveListWire>> => {
      const d = deferred<RemoteOutcome<ArchiveListWire>>()
      pending.push(d)
      return d.promise
    })
    const m = mountQuery(archiveList, true)
    // 挂载那读先发出去（不同拍的两次 reload 才是两读；同拍会被微任务合并）。
    await flush()
    act(() => { void m.result.current.reload() })
    await flush()
    expect(archiveList).toHaveBeenCalledTimes(2)
    // 后发的先落、先发的后落：先发那张票已经作废。
    await act(async () => {
      pending[1]?.resolve(ready([row('b')]))
      await pending[1]?.promise
    })
    await act(async () => {
      pending[0]?.resolve(ready([row('a')]))
      await pending[0]?.promise
    })
    expect(m.result.current.list).toMatchObject({ status: 'ready', rows: [{ sessionId: 'b' }] })
  })

  it('{available:false} 落 corpus-missing（不是 ready 空行）；reload 重试', async () => {
    const archiveList = vi.fn<Fetch>(async () => ({ ok: true, value: { available: false } }))
    const m = mountQuery(archiveList, true)
    await flush()
    expect(m.result.current.list).toEqual({ status: 'corpus-missing' })
    archiveList.mockResolvedValue(ready([row('a')]))
    await act(async () => { await m.result.current.reload() })
    expect(m.result.current.list).toMatchObject({ status: 'ready', rows: [{ sessionId: 'a' }] })
  })

  it('读失败落 failure（错误原文上屏 + 重试），不是空清单', async () => {
    const archiveList = vi.fn(async (): Promise<RemoteOutcome<ArchiveListWire>> =>
      ({ ok: false, failure: { code: 'sessiondelete/io', message: 'boom' } }))
    const m = mountQuery(archiveList, true)
    await flush()
    expect(m.result.current.list).toEqual({ status: 'failure', message: 'boom' })
  })

  it('count 首次成功前为 null，成功后 = 行数（M 惰性）', async () => {
    const archiveList = vi.fn(async () => ready([row('a'), row('b')]))
    const m = mountQuery(archiveList, true)
    expect(m.result.current.count).toBeNull()
    await flush()
    expect(m.result.current.count).toBe(2)
  })

  it('归档清单不写 trash-snapshot（卸载即丢）', async () => {
    const archiveList = vi.fn(async () => ready([row('a')]))
    const m = mountQuery(archiveList, true)
    await act(async () => { await m.result.current.reload() })
    expect(readTrashSnapshot()).toBeNull()
    m.unmount()
    expect(readTrashSnapshot()).toBeNull()
  })
})
