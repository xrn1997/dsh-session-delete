/**
 * 一次客户端写入的生命周期：信封 → 逐条判读 → settlement → refresh。
 * `ok` 只说**信封**成不成；逐条成败在 `failures` 里，调用方自己决定怎么上屏。
 * 这里只钉 `runWrite` 的时机与交给 settlement 的呈现材质；按 action 的收尾顺序住
 * `tests/client/write-settlement.test.ts`。
 */
import { describe, expect, it, vi } from 'vitest'
import { runWrite } from '../../src/client/write.js'
import type { ApplyOutcome } from '../../src/shared/wire.js'
import { failed, ok, trashRow } from './support/outcomes.js'

/** 成功支里的回收站那一行：本文件只关心它的 `id`（撤销名单取 `value.id`），造行统一走构造器。 */
const row = (entryId: string) => trashRow(entryId, `session-${entryId}`)

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

  it('信封成功 + 逐条混合：settlement 先跑（publishUndo 拿落地名单），refresh 一次，顺序 settle → refresh', async () => {
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [
      ok('delete', 'a', row('entry-a')),
      failed('delete', 'b', '删不动'),
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
    expect(outcome.ok && outcome.summary.anySuccess).toBe(true)
    expect([...outcome.failures.entries()]).toEqual([['b', '删不动']])
    expect(publishUndo).toHaveBeenCalledTimes(1)
    // settlement 算好落地条目与请求名单再交座位：座位不再自己读回执。
    expect(publishUndo).toHaveBeenCalledWith({ entryIds: ['entry-a'], n: 1 })
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
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [failed('delete', 'e1', '删不动')])
    const publishUndo = vi.fn()
    const refresh = vi.fn()
    const outcome = await runWrite({
      deps: { applyOutcomes }, action: 'delete', ids: ['e1'], presentation: { publishUndo }, refresh,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.summary.anySuccess).toBe(false)
    // 信封成功 ⇒ 跨槽位收尾照跑：批量删除的失效通告不能漏；空成功名单是合法输入。
    // 呈现钩子按 anySuccess 门拦住：一条都没落地时不发布撤销。
    expect(publishUndo).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('撤销名单只收落地行，条数含幂等带走——两个数可以不等', async () => {
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [
      ok('delete', 'a', row('entry-a')),
      ok('delete', 'b', null),
    ])
    const publishUndo = vi.fn()
    const outcome = await runWrite({
      deps: { applyOutcomes }, action: 'delete', ids: ['a', 'b'], presentation: { publishUndo },
    })
    expect(outcome.ok && outcome.summary.anySuccess).toBe(true)
    // `b` 被同批前一条带走（幂等 null）：算条数、不算撤销落点。
    expect(publishUndo).toHaveBeenCalledWith({ entryIds: ['entry-a'], n: 2 })
  })

  it('全部被同批前一条带走：不发布没有落点的撤销横幅', async () => {
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [
      ok('delete', 'a', null),
      ok('delete', 'b', null),
    ])
    const publishUndo = vi.fn()
    const outcome = await runWrite({
      deps: { applyOutcomes }, action: 'delete', ids: ['a', 'b'], presentation: { publishUndo },
    })
    expect(outcome.ok && outcome.summary.anySuccess).toBe(true)
    expect(publishUndo).not.toHaveBeenCalled()
  })

  it('single：N=1 的 null 是协议错，不静默当成功；不发布撤销', async () => {
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [ok('delete', 'a', null)])
    const publishUndo = vi.fn()
    const outcome = await runWrite({
      deps: { applyOutcomes }, action: 'delete', ids: ['a'], single: true, presentation: { publishUndo },
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.summary.anySuccess).toBe(false)
    expect(outcome.failures.get('a')).toContain('单条动作回了幂等空值')
    expect(outcome.ok && outcome.summary.successIds).toEqual([])
    expect(publishUndo).not.toHaveBeenCalled()
  })

  it('single 只在 N=1 时生效：多 id 的 null 仍是批量幂等', async () => {
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [
      ok('delete', 'a', null),
      ok('delete', 'b', row('entry-b')),
    ])
    const outcome = await runWrite({
      deps: { applyOutcomes }, action: 'delete', ids: ['a', 'b'], single: true,
    })
    expect(outcome.ok && outcome.summary.anySuccess).toBe(true)
    expect(outcome.failures.has('a')).toBe(false)
  })

  it('id 去重保序：同一 id 只请求一次、只判一条', async () => {
    const applyOutcomes = vi.fn(async (): Promise<ApplyOutcome[]> => [ok('delete', 'a', row('entry-a'))])
    const outcome = await runWrite({
      deps: { applyOutcomes }, action: 'delete', ids: ['a', 'a'],
    })
    expect(applyOutcomes).toHaveBeenCalledWith('delete', ['a'])
    expect(outcome.ok).toBe(true)
    expect(outcome.action).toBe('delete')
    expect(outcome.ids).toEqual(['a'])
    if (outcome.ok) expect(outcome.summary.successIds).toHaveLength(1)
  })
})
