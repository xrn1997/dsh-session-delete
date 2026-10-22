/**
 * 一次客户端写入的生命周期：信封 → 逐条判读 → commit → refresh。
 * `ok` 只说**信封**成不成；逐条成败在 `failures` 里，调用方自己决定怎么上屏。
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
  it('顶层失败：同一句原文铺到每个 id，不 commit；refresh 交到失败 outcome', async () => {
    const applyOutcomes = vi.fn(async () => {
      throw Object.assign(new Error('通道断了'), { code: 'sessiondelete/io' })
    })
    const commit = vi.fn()
    const refresh = vi.fn()

    const outcome = await runWrite({
      deps: { applyOutcomes },
      action: 'delete',
      ids: ['a', 'b'],
      commit,
      refresh,
    })

    expect(outcome.ok).toBe(false)
    expect([...outcome.failures.entries()]).toEqual([['a', '通道断了'], ['b', '通道断了']])
    expect(commit).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })

  it('信封成功 + 逐条混合：commit 拿 receipt，refresh 一次，顺序 commit → refresh', async () => {
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [
      ok('a', 'delete', { id: 'entry-a' }),
      failed('b', 'delete', '删不动'),
    ])
    const order: string[] = []

    const outcome = await runWrite({
      deps: { applyOutcomes },
      action: 'delete',
      ids: ['a', 'b'],
      commit: (success) => {
        order.push('commit')
        expect(success.receipt.verdicts).toHaveLength(2)
        expect(success.receipt.verdicts[0]).toMatchObject({ kind: 'ok', id: 'a' })
      },
      refresh: () => { order.push('refresh') },
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.anySuccess).toBe(true)
    expect([...outcome.failures.entries()]).toEqual([['b', '删不动']])
    expect(order).toEqual(['commit', 'refresh'])
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

  it('全失败：commit 仍跑（信封成功），调用方按 successIds 投影；refresh 照交', async () => {
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [failed('e1', 'purge', '删不动')])
    const commit = vi.fn()
    const refresh = vi.fn()
    const outcome = await runWrite({
      deps: { applyOutcomes }, action: 'purge', ids: ['e1'], commit, refresh,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.anySuccess).toBe(false)
    // 信封成功 ⇒ 收尾照跑：批量删除/撤销要靠它发失效通告；空成功名单是合法输入。
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ anySuccess: false, successIds: [] }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('single：N=1 的 null 是协议错，不静默当成功；commit 拿到空成功名单', async () => {
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [ok('a', 'delete', null)])
    const commit = vi.fn()
    const outcome = await runWrite({
      deps: { applyOutcomes }, action: 'delete', ids: ['a'], single: true, commit,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.anySuccess).toBe(false)
    expect(outcome.failures.get('a')).toContain('单条动作回了幂等空值')
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ successIds: [] }))
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
    if (outcome.ok) expect(outcome.receipt.verdicts).toHaveLength(1)
  })
})
