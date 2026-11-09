import { describe, expect, it, vi } from 'vitest'
import { createBareFakeRemote, channelOf, createFakeRemote, failureOf } from './fake-remote.js'

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

// 假件与生产 adapter 同一条契约（ADR-0053）：用例只交裸值或**抛出**失败，抬成落地面是假件的活。
// 这两支没测到，用例就会把「假件里的 bug」读成「通道失败」，或反过来用 `as never` 自己拼信封。
describe('假件把抛出的失败抬成落地面', () => {
  it('抛 Error ⇒ 回 `client/unknown` + 原文，且不向调用方抛', async () => {
    const bare = createBareFakeRemote({
      list: vi.fn(async () => {
        throw new Error('清单坏了')
      }),
    })
    await expect(channelOf(bare).list()).resolves.toEqual({
      ok: false,
      failure: { code: 'client/unknown', message: '清单坏了' },
    })
  })

  it('抛带官方标记位的失败 ⇒ 原样带出自己的 code（别域的码不许被改写）', async () => {
    const bare = createBareFakeRemote({
      detail: vi.fn(async (): Promise<never> => {
        throw Object.assign(new Error('会话正在运行'), {
          code: 'sessiondelete/live',
          isDSHRemoteError: true,
          details: { sessionId: 'session-a' },
        })
      }),
    })
    await expect(channelOf(bare).detail('a')).resolves.toEqual({
      ok: false,
      failure: { code: 'sessiondelete/live', message: '会话正在运行', details: { sessionId: 'session-a' } },
    })
  })

  it('非 Error 的抛出也留原文，不吞成空失败', () => {
    expect(failureOf('炸了')).toEqual({ code: 'client/unknown', message: '炸了' })
  })
})
