import { describe, expect, it, vi } from 'vitest'
import { createFakeRemote, remoteFail, remoteOk } from './fake-remote.js'

it('FakeRemote 是完整的 SessionDeleteRemote，默认安静成功', async () => {
  const remote = createFakeRemote()
  await expect(remote.ping()).resolves.toEqual({ ok: true, value: 'pong' })
  await expect(remote.list()).resolves.toEqual({ ok: true, value: [] })
  await expect(remote.config()).resolves.toMatchObject({ ok: true })
  const next = { orphanPreviewLimit: 3, maxAttachmentBytes: 4, maxJsonRefBytes: 5 }
  await expect(remote.saveConfig(next)).resolves.toEqual({ ok: true, value: next })
  await expect(remote.scanOrphans()).resolves.toEqual({
    ok: true,
    value: { roots: [], totalSessions: 0, totalBytes: 0, missingParents: 0, groups: [] },
  })
  await expect(remote.detail('e1')).resolves.toMatchObject({ ok: true, value: { entryId: 'fake' } })
  await expect(remote.emptyTrash()).resolves.toEqual({ ok: true, value: { removed: 0, freedBytes: 0 } })
  await expect(remote.applyOutcomes('delete', [])).resolves.toEqual({ ok: true, value: [] })
  await expect(remote.scanAttachmentOrphans()).resolves.toEqual({ ok: true, value: { count: 0, totalBytes: 0, items: [] } })
  await expect(remote.cleanAttachmentOrphans()).resolves.toEqual({
    ok: true,
    value: { removed: 0, freedBytes: 0, failed: 0 },
  })
})

// 假件与生产 adapter 同一条契约（ADR-0053）：方法直接交 `RemoteOutcome`——用例设成什么样，组件收到
// 的就是什么样。没有「裸值 + 抛出」的第二套口径，抬升 / 归一那一层不存在（通道不抛，失败是数据）。
// 这几支测不到，用例就会把「假件改写了落地面」读成「通道失败」，或反过来用 `as never` 自己拼信封。
describe('假件原样交回用例设的落地面', () => {
  it('成功支：设进去的值原样交回（不重包装、不改写）', async () => {
    const value = { roots: ['session-root'], totalSessions: 2, totalBytes: 2048, missingParents: 1, groups: [] }
    const remote = createFakeRemote({ scanOrphans: vi.fn(async () => remoteOk(value)) })
    await expect(remote.scanOrphans()).resolves.toEqual({ ok: true, value })
  })

  it('失败支：生产形状的 RemoteFailure 原样交回（code / message / details 三件不丢）', async () => {
    const remote = createFakeRemote({
      detail: vi.fn(async () => remoteFail({
        code: 'sessiondelete/live',
        message: '会话正在运行',
        details: { sessionId: 'session-a' },
      })),
    })
    await expect(remote.detail('a')).resolves.toEqual({
      ok: false,
      failure: { code: 'sessiondelete/live', message: '会话正在运行', details: { sessionId: 'session-a' } },
    })
  })

  it('失败支以 ok:false promise 落地，不向调用方抛', async () => {
    const remote = createFakeRemote({
      list: vi.fn(async () => remoteFail({ code: 'client/unknown', message: '清单坏了' })),
    })
    await expect(remote.list()).resolves.toEqual({
      ok: false,
      failure: { code: 'client/unknown', message: '清单坏了' },
    })
  })
})
