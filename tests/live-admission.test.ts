import { describe, expect, it } from 'vitest'
import { createFakeHost } from './support/fake-deps.js'
import { assertNoLive } from '../src/verbs/live-admission.js'

describe('活体准入', () => {
  it('名单里每一个都要问过，顺序就是传入顺序', async () => {
    const host = createFakeHost()
    await assertNoLive(host, ['s1', 's2', 's3'])
    expect(host.isLive.mock.calls.map((call) => call[0])).toEqual(['s1', 's2', 's3'])
  })

  it('空名单：不问、不抛', async () => {
    const host = createFakeHost()
    await expect(assertNoLive(host, [])).resolves.toBeUndefined()
    expect(host.isLive).not.toHaveBeenCalled()
  })

  // 这句话只住这个 module：任何调用点问的都是同一句措辞，各写一份，客户端就会看到两个版本的「还在跑」。
  it('第一个在跑就停：码是 live，原文点名那一个会话', async () => {
    const host = createFakeHost({ live: (id) => id === 's2' })
    await expect(assertNoLive(host, ['s1', 's2', 's3'])).rejects.toMatchObject({
      code: 'sessiondelete/live',
      message: '会话正在运行：s2',
    })
    // 短路：命中之后不再问后面的成员（不许把一次拒绝变成 N 次宿主查询）
    expect(host.isLive.mock.calls.map((call) => call[0])).toEqual(['s1', 's2'])
  })
})
