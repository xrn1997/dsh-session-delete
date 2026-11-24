/**
 * 写入进度的轮询与写身份认领（`use-write-progress.ts`）：钉认领判据四分支与轮询节奏。
 * 认领上才出 `own`（k/N 才是这一趟写的），running 认领不上只出 `queued`——**不许冒领另一趟写的
 * k/N**（假进度是反目标，ADR-0069 决定 4）；`idle` 或未在飞出 `null`，兜底忙碌文案归调用方。
 * 假 adapter 驱动真实 hook：`progress` 每一拍何时回、回什么由用例掌握，这里不 mock hook 自己。
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WriteProgressWire } from '../../src/shared/wire.js'
import { PROGRESS_POLL_MS, useWriteProgress } from '../../src/client/use-write-progress.js'
import type { RemoteOutcome } from '../../src/client/remote.js'
import { createFakeRemote, remoteOk } from './support/fake-remote.js'

/** 认领得上的那一趟：own 只给 `s2`，wire 的 ids 是超集——交集即可，不比整份名单。 */
const RUNNING_OURS: WriteProgressWire = {
  status: 'running',
  action: 'delete',
  ids: ['s1', 's2'],
  done: 1,
  total: 3,
  step: 'moving',
  startedAt: 1234,
}

const IDLE: WriteProgressWire = { status: 'idle' }

function deferredOutcome(): {
  promise: Promise<RemoteOutcome<WriteProgressWire>>
  resolve: (outcome: RemoteOutcome<WriteProgressWire>) => void
} {
  let resolve!: (outcome: RemoteOutcome<WriteProgressWire>) => void
  const promise = new Promise<RemoteOutcome<WriteProgressWire>>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

type Ticket = ReturnType<typeof deferredOutcome>

/** 受控 `progress`：每一拍登记一张可结算的票，用例自己决定哪一拍回什么、什么时候回。 */
function scriptedProgress(onCall?: (signal?: AbortSignal) => void) {
  const calls: Ticket[] = []
  const progress = vi.fn((signal?: AbortSignal) => {
    onCall?.(signal)
    const ticket = deferredOutcome()
    calls.push(ticket)
    return ticket.promise
  })
  return { progress, calls }
}

/** 结算一拍，并让响应流过微任务与 React 提交（`.then` 落地 + setWire 重渲染各一拍）。 */
async function land(ticket: Ticket | undefined, outcome: RemoteOutcome<WriteProgressWire>): Promise<void> {
  // 票不在 = 这一拍压根没发出去读：前提不成立直接炸掉，别静默跳过把断言变成假绿。
  if (ticket === undefined) throw new Error('这一拍没有在飞的 progress 读')
  await act(async () => {
    ticket.resolve(outcome)
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_700_000_000_000)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useWriteProgress · 写身份认领（ADR-0069 决定 4）', () => {
  it('①认领上出 own：done/total/step/startedAt 原样（ids 有交集即可，不要求相等）', async () => {
    const { progress, calls } = scriptedProgress()
    const deps = createFakeRemote({ progress })
    const { result } = renderHook(() => useWriteProgress(deps, { action: 'delete', ids: ['s2', 's9'] }, true))

    // 首帧立即拉一次；读没回来之前是 null（调用方出兜底忙碌文案），不许先冒一个 0/N。
    expect(progress).toHaveBeenCalledTimes(1)
    expect(result.current).toBeNull()

    await land(calls[0], remoteOk(RUNNING_OURS))
    // 动作码随脸走（own 支自带 `action`，渲染端不再二次传身份）。
    expect(result.current).toEqual({ kind: 'own', action: 'delete', done: 1, total: 3, step: 'moving', startedAt: 1234, localStartedAt: 1_700_000_000_000 })
  })

  it('②running 属于另一 action ⇒ queued（本趟在飞，k/N 却是别人的）', async () => {
    const { progress, calls } = scriptedProgress()
    const deps = createFakeRemote({ progress })
    const { result } = renderHook(() => useWriteProgress(deps, { action: 'delete', ids: ['s1'] }, true))

    await land(calls[0], remoteOk({ ...RUNNING_OURS, action: 'restore' }))
    expect(result.current).toEqual({ kind: 'queued' })
  })

  it('③running 同 action 但 ids 无交集 ⇒ queued（另一趟 delete 在飞）', async () => {
    const { progress, calls } = scriptedProgress()
    const deps = createFakeRemote({ progress })
    const { result } = renderHook(() => useWriteProgress(deps, { action: 'delete', ids: ['s1'] }, true))

    await land(calls[0], remoteOk({ ...RUNNING_OURS, ids: ['s3', 's4'] }))
    expect(result.current).toEqual({ kind: 'queued' })
  })

  it('③′空集守卫：认领名单为空集时同 action 在飞的那趟可能是本趟 ⇒ 既不认领也不断言排队，归 null 兜底', async () => {
    const { progress, calls } = scriptedProgress()
    const deps = createFakeRemote({ progress })
    const { result } = renderHook(() => useWriteProgress(deps, { action: 'delete', ids: [] }, true))

    await land(calls[0], remoteOk(RUNNING_OURS))
    // 「排队中：另一写入进行中…」断言的是**另一趟**在写——空名单没有身份，无从断言，也不许冒领它的 k/N。
    expect(result.current).toBeNull()
  })

  it('③″空集 + 另一 action ⇒ 仍出 queued：排队断言不靠交集（语序上 action 先于空集守卫）', async () => {
    const { progress, calls } = scriptedProgress()
    const deps = createFakeRemote({ progress })
    const { result } = renderHook(() => useWriteProgress(deps, { action: 'delete', ids: [] }, true))

    await land(calls[0], remoteOk({ ...RUNNING_OURS, action: 'restore' }))
    // 认领名单是空集，但 action 不同 ⇒ 在飞的必是另一趟：这句排队断言是真的，照出 queued。
    expect(result.current).toEqual({ kind: 'queued' })
  })

  it('④flying:false 一拍都不拉，脸是 null（未在飞 ⇒ 不认领）', () => {
    const { progress } = scriptedProgress()
    const deps = createFakeRemote({ progress })
    const { result } = renderHook(() => useWriteProgress(deps, { action: 'delete', ids: ['s1'] }, false))

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(progress).not.toHaveBeenCalled()
    expect(result.current).toBeNull()
  })

  it('⑤写落定后 /progress 回 idle ⇒ null（脸随快照收，不留上一趟的 k/N）', async () => {
    const { progress, calls } = scriptedProgress()
    const deps = createFakeRemote({ progress })
    const { result } = renderHook(() => useWriteProgress(deps, { action: 'delete', ids: ['s2'] }, true))

    await land(calls[0], remoteOk(RUNNING_OURS))
    expect(result.current).toMatchObject({ kind: 'own' })

    await act(async () => {
      vi.advanceTimersByTime(PROGRESS_POLL_MS)
      await Promise.resolve()
    })
    await land(calls[1], remoteOk(IDLE))
    expect(result.current).toBeNull()
  })

  it('⑥慢响应（RTT>间隔）下脸仍推进到最新落地帧：在飞 tick 跳过但不作废票，落地才放行下一拍', async () => {
    const { progress, calls } = scriptedProgress()
    const deps = createFakeRemote({ progress })
    const { result } = renderHook(() => useWriteProgress(deps, { action: 'delete', ids: ['s2'] }, true))

    // RTT 拉到 3 个周期：期间的 tick 只许跳过，不许把在飞票作废——作废就是「脸停帧」的病根
    //（每票都活不到落地，旧 k/N 冻在屏上，用户以为卡了）。
    await act(async () => {
      vi.advanceTimersByTime(PROGRESS_POLL_MS * 3)
      await Promise.resolve()
    })
    expect(progress).toHaveBeenCalledTimes(1)

    // 在飞那票原样落地：脸推进到这一帧（不许回到停帧）。
    await land(calls[0], remoteOk({ ...RUNNING_OURS, done: 1, step: 'checking', startedAt: 111 }))
    expect(result.current).toMatchObject({ kind: 'own', done: 1, step: 'checking' })

    // 落地放行下一拍：再一拍再拉、再落地，脸继续推进到最新帧。
    await act(async () => {
      vi.advanceTimersByTime(PROGRESS_POLL_MS)
      await Promise.resolve()
    })
    expect(progress).toHaveBeenCalledTimes(2)
    await land(calls[1], remoteOk({ ...RUNNING_OURS, done: 3, step: 'finishing', startedAt: 111 }))
    expect(result.current).toMatchObject({ kind: 'own', done: 3, step: 'finishing' })
  })

  it('某一拍读失败不动现场：进度是遥测，上一帧的 k/N 是真的过去时，下一拍再读', async () => {
    const { progress, calls } = scriptedProgress()
    const deps = createFakeRemote({ progress })
    const { result } = renderHook(() => useWriteProgress(deps, { action: 'delete', ids: ['s2'] }, true))

    await land(calls[0], remoteOk(RUNNING_OURS))
    expect(result.current).toMatchObject({ kind: 'own', done: 1 })

    await act(async () => {
      vi.advanceTimersByTime(PROGRESS_POLL_MS)
      await Promise.resolve()
    })
    await land(calls[1], { ok: false, failure: { code: 'client/unknown', message: '取数通道超时' } })
    expect(result.current).toMatchObject({ kind: 'own', done: 1, total: 3 })
    await act(async () => {
      vi.advanceTimersByTime(PROGRESS_POLL_MS)
      await Promise.resolve()
    })
    expect(progress).toHaveBeenCalledTimes(3)
  })
})

describe('useWriteProgress · 轮询节奏（口径裁定：300ms、首帧立即拉、单票在飞、落 false 即停）', () => {
  it('首帧立即一拉；在飞期间 tick 跳过；落地后下一拍再拉；flying 落 false 即停', async () => {
    const { progress, calls } = scriptedProgress()
    const deps = createFakeRemote({ progress })
    const { result, rerender } = renderHook(
      ({ flying }: { flying: boolean }) => useWriteProgress(deps, { action: 'delete', ids: ['s1'] }, flying),
      { initialProps: { flying: true } },
    )
    expect(progress).toHaveBeenCalledTimes(1)

    // 第一票还在飞：后续 tick 只跳过、不重发（重发会作废在飞票）。
    await act(async () => {
      vi.advanceTimersByTime(PROGRESS_POLL_MS)
      await Promise.resolve()
    })
    expect(progress).toHaveBeenCalledTimes(1)

    await land(calls[0], remoteOk(RUNNING_OURS))
    await act(async () => {
      vi.advanceTimersByTime(PROGRESS_POLL_MS - 1)
    })
    expect(progress).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
    })
    expect(progress).toHaveBeenCalledTimes(2)

    rerender({ flying: false })
    await act(async () => {
      vi.advanceTimersByTime(PROGRESS_POLL_MS * 4)
    })
    expect(progress).toHaveBeenCalledTimes(2)
    expect(result.current).toBeNull()
  })

  it('flying 落 false 时在飞结果丢弃：下一趟在飞前不许把上一趟的快照端出来', async () => {
    const { progress, calls } = scriptedProgress()
    const deps = createFakeRemote({ progress })
    const { result, rerender } = renderHook(
      ({ flying }: { flying: boolean }) => useWriteProgress(deps, { action: 'delete', ids: ['s2'] }, flying),
      { initialProps: { flying: true } },
    )

    rerender({ flying: false })
    await land(calls[0], remoteOk(RUNNING_OURS))
    expect(result.current).toBeNull()

    // 下一趟在飞：首帧重新拉之前，上一趟的快照不许冒头。
    rerender({ flying: true })
    expect(result.current).toBeNull()
  })

  it('卸载中止在飞进度读，不让半开连接留到默认请求超时', () => {
    let seen: AbortSignal | undefined
    const { progress } = scriptedProgress((signal) => { seen = signal })
    const deps = createFakeRemote({ progress })
    const { unmount } = renderHook(() => useWriteProgress(deps, { action: 'delete', ids: ['s1'] }, true))

    expect(seen).toBeInstanceOf(AbortSignal)
    unmount()
    expect(seen?.aborted).toBe(true)
  })

  it('快照 ids 为空（空回收站 /empty）时不误报排队中，回 null 由按钮兜底', async () => {
    const { progress, calls } = scriptedProgress()
    const deps = createFakeRemote({ progress })
    const { result } = renderHook(() => useWriteProgress(deps, { action: 'empty', ids: ['e1'] }, true))

    await land(calls[0], remoteOk({
      status: 'running', action: 'empty', ids: [], done: 0, total: 0, step: 'measuring', startedAt: 100,
    }))
    expect(result.current).toBeNull()
  })
})
