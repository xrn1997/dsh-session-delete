import { describe, expect, it } from 'vitest'
import { createLogWorld, failureOf, trashEntry } from './world.js'

describe('条目记录', () => {
  it('缺省就是一条最安静的条目；over 逐格覆盖', () => {
    expect(trashEntry('e1')).toEqual({
      id: 'e1', sessionId: 'e1', projectDir: '--p--', workspaceId: 'ws-1',
      wasArchived: false, deletedAt: 1, title: '', sizeBytes: 0,
    })
    expect(trashEntry('e1', { sessionId: 'session-a', sizeBytes: 7 }))
      .toMatchObject({ id: 'e1', sessionId: 'session-a', sizeBytes: 7 })
  })
})

describe('带调用日志的世界', () => {
  it('calls 按发生顺序记；只记点名的方法；fs 与 host 共用一条', async () => {
    const world = createLogWorld({ logMethods: ['unarchive', 'removeDir'] })
    await world.host.unarchive('s1')
    await world.fs.removeDir('/h/x')
    await world.host.detach('s1', 'ws-1')

    expect(world.calls).toEqual(['unarchive', 'removeDir'])
  })

  it('format 决定一条日志怎么写；缺省只有方法名', async () => {
    const plain = createLogWorld({ logMethods: ['detach'] })
    await plain.host.detach('s1', 'ws-1')
    expect(plain.calls).toEqual(['detach'])

    const formatted = createLogWorld({
      logMethods: ['detach'],
      format: (method, args) => `${method}(${args.join(',')})`,
    })
    await formatted.host.detach('s1', 'ws-1')
    expect(formatted.calls).toEqual(['detach(s1,ws-1)'])
  })

  it('世界仍是可交给动词的依赖面：种子、清册与端口替身都在', async () => {
    const world = createLogWorld({ logMethods: [], seed: [trashEntry('e1')] })

    expect((await world.manifest.list()).map((row) => row.id)).toEqual(['e1'])
    expect(world.deps.home).toBe('/h')
    expect(world.deps.ledger).toBe(world.ledger)
  })
})

describe('被拒绝的错误', () => {
  it('原样取回（code / cause / details 都还在）；没拒绝就炸', async () => {
    const boom = Object.assign(new Error('boom'), { code: 'sessiondelete/io' })
    expect(await failureOf(Promise.reject(boom))).toBe(boom)
    await expect(failureOf(Promise.resolve(1))).rejects.toThrow(/expected the call to reject/)
  })
})
