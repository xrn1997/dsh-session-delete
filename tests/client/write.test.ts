/**
 * 一次客户端写入的生命周期：信封 → 逐条判读 → settlement → refresh。
 * `ok` 只说**信封**成不成；逐条成败在 `failures` 里，调用方自己决定怎么上屏。
 * 这里只钉 `runWrite` 的时机与交给 settlement 的素材；按 action 的收尾顺序住
 * `tests/client/write-settlement.test.ts`。
 */
import { describe, expect, it, vi } from 'vitest'
import { runWrite } from '../../src/client/write.js'
import type { ApplyOutcome } from '../../src/shared/wire.js'

function ok(id: string, action: 'delete' | 'restore' | 'purge', value: unknown): ApplyOutcome {
  return { id, action, ok: true, value } as ApplyOutcome
}

function failed(id: string, action: 'delete' | 'restore' | 'purge', message: string): ApplyOutcome {
  return { id, action, ok: false, error: { code: 'sessiondelete/io', message } } as ApplyOutcome
}

describe('runWrite', () => {
  it('顶层失败：同一句原文铺到每个 id，不结算；refresh 交到失败 outcome', async () => {
    const applyOutcomes = vi.fn(async () => {
      throw Object.assign(new Error('通道断了'), { code: 'sessiondelete/io' })
    })
    const publishUndo = vi.fn()
    const refresh = vi.fn()

    const outcome = await runWrite({
      deps: { applyOutcomes },
      action: 'delete',
      ids: ['a', 'b'],
      presentation: { publishUndo },
      refresh,
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.action).toBe('delete')
    expect(outcome.ids).toEqual(['a', 'b'])
    expect([...outcome.failures.entries()]).toEqual([['a', '通道断了'], ['b', '通道断了']])
    expect(publishUndo).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })

  it('信封成功 + 逐条混合：settlement 先跑（publishUndo 拿 success），refresh 一次，顺序 settle → refresh', async () => {
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [
      ok('a', 'delete', { id: 'entry-a' }),
      failed('b', 'delete', '删不动'),
    ])
    const order: string[] = []
    const publishUndo = vi.fn(() => { order.push('settle') })

    const outcome = await runWrite({
      deps: { applyOutcomes },
      action: 'delete',
      ids: ['a', 'b'],
      presentation: { publishUndo },
      refresh: () => { order.push('refresh') },
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.action).toBe('delete')
    expect(outcome.ids).toEqual(['a', 'b'])
    expect(outcome.ok && outcome.anySuccess).toBe(true)
    expect([...outcome.failures.entries()]).toEqual([['b', '删不动']])
    expect(publishUndo).toHaveBeenCalledTimes(1)
    expect(publishUndo).toHaveBeenCalledWith(expect.objectContaining({
      action: 'delete',
      ids: ['a', 'b'],
      successIds: ['a'],
      anySuccess: true,
    }))
    expect(order).toEqual(['settle', 'refresh'])
  })

  it('请求了但没回：missing 原文进失败表，不当成功', async () => {
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [])
    const outcome = await runWrite({
      deps: { applyOutcomes },
      action: 'restore',
      ids: ['e1'],
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.failures.get('e1')).toContain('批量通道没回这一条的结果：restore e1')
  })

  it('全失败：delete 的跨槽位收尾仍跑（无主视图绑定，无副作用），不发布撤销；refresh 照交', async () => {
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [failed('e1', 'delete', '删不动')])
    const publishUndo = vi.fn()
    const refresh = vi.fn()
    const outcome = await runWrite({
      deps: { applyOutcomes }, action: 'delete', ids: ['e1'], presentation: { publishUndo }, refresh,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.anySuccess).toBe(false)
    // 信封成功 ⇒ 跨槽位收尾照跑：批量删除的失效通告不能漏；空成功名单是合法输入。
    // 呈现钩子按 anySuccess 门拦住：一条都没落地时不发布撤销。
    expect(publishUndo).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('single：N=1 的 null 是协议错，不静默当成功；不发布撤销', async () => {
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [ok('a', 'delete', null)])
    const publishUndo = vi.fn()
    const outcome = await runWrite({
      deps: { applyOutcomes }, action: 'delete', ids: ['a'], single: true, presentation: { publishUndo },
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.anySuccess).toBe(false)
    expect(outcome.failures.get('a')).toContain('单条动作回了幂等空值')
    expect(outcome.ok && outcome.successIds).toEqual([])
    expect(publishUndo).not.toHaveBeenCalled()
  })

  it('single 只在 N=1 时生效：多 id 的 null 仍是批量幂等', async () => {
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [
      ok('a', 'delete', null),
      ok('b', 'delete', { id: 'entry-b' }),
    ])
    const outcome = await runWrite({
      deps: { applyOutcomes }, action: 'delete', ids: ['a', 'b'], single: true,
    })
    expect(outcome.ok && outcome.anySuccess).toBe(true)
    expect(outcome.failures.has('a')).toBe(false)
  })

  it('id 去重保序：同一 id 只请求一次、只判一条', async () => {
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [ok('a', 'delete', { id: 'entry-a' })])
    const outcome = await runWrite({
      deps: { applyOutcomes }, action: 'delete', ids: ['a', 'a'],
    })
    expect(applyOutcomes).toHaveBeenCalledWith('delete', ['a'])
    expect(outcome.ok).toBe(true)
    expect(outcome.action).toBe('delete')
    expect(outcome.ids).toEqual(['a'])
    if (outcome.ok) expect(outcome.receipt.verdicts).toHaveLength(1)
  })
})
