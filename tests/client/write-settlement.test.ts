/**
 * 一次写入的**收尾顺序**按 action 收在一个家。
 *
 * 这里钉两件事：delete / restore / purge 各自的固定顺序，以及 `anySuccess` 这道门。
 * 跨槽位（main-view 收尾、回收站失效）在信封成功时就跑，逐条全失败也跑；呈现钩子
 * （撤销通告、熄灭横幅、遗忘主视图、清详情缓存）只在至少一条落地时跑，delete 的撤销另要求
 * 落地名单非空。
 *
 * 恢复有两个座位：外部恢复（撤销横幅）由 settlement 调 `afterRestore` 重开；面板恢复用
 * `panelSeat: true` 明说「面板已替这条完成『回来』的结算」⇒ 只遗忘、不重开、不抢焦点
 * （判据住 `src/client/main-view.ts` 的 `forgetMainView`）。撤销名单由 settlement 算好交给座位。
 */
import { describe, expect, it, vi } from 'vitest'
import { readReceipt } from '../../src/client/receipt.js'
import {
  noPresentation,
  settleWrite,
  type SettledFacts,
} from '../../src/client/write-settlement.js'
import type { ApplyAction } from '../../src/shared/wire.js'
import { ok, trashRow, writeOutcome } from './support/outcomes.js'

const mocks = vi.hoisted(() => {
  const calls: string[] = []
  return {
    calls,
    afterDelete: vi.fn((ids: readonly string[]) => { calls.push(`afterDelete:${ids.join(',')}`) }),
    afterRestore: vi.fn((ids: readonly string[]) => { calls.push(`afterRestore:${ids.join(',')}`) }),
    forgetMainView: vi.fn((ids: readonly string[]) => { calls.push(`forget:${ids.join(',')}`) }),
  }
})
vi.mock('../../src/client/main-view.js', () => ({
  afterDelete: mocks.afterDelete,
  afterRestore: mocks.afterRestore,
  forgetMainView: mocks.forgetMainView,
}))

/** 一条"没有逐条事实"的收尾材质：回执取 `writeOutcome` 的空回执，各用例只覆盖它关心的那几格。 */
function settled<A extends ApplyAction>(over: Partial<SettledFacts<A>> & { action: A }): SettledFacts<A> {
  return { ids: ['x'], receipt: writeOutcome(over.action, ['x']).receipt, successIds: [], anySuccess: false, ...over }
}

describe('settleWrite', () => {
  it('delete：main-view → invalidate → undo，且只在 anySuccess 时发布撤销', () => {
    mocks.calls.length = 0
    const receipt = readReceipt('delete', ['s1'], [ok('delete', 's1', trashRow('e1', 's1'))])
    settleWrite(settled({ action: 'delete', ids: ['s1'], receipt, successIds: ['s1'], anySuccess: true }), {
      invalidate: () => mocks.calls.push('invalidate'),
      publishUndo: ({ entryIds, n }) => mocks.calls.push(`publish:${entryIds.join(',')}:${n}`),
    })
    expect(mocks.calls).toEqual(['afterDelete:s1', 'invalidate', 'publish:e1:1'])

    mocks.calls.length = 0
    settleWrite(settled({ action: 'delete', ids: ['s1'], successIds: [], anySuccess: false }), {
      invalidate: () => mocks.calls.push('invalidate'),
      publishUndo: () => mocks.calls.push('publish'),
    })
    expect(mocks.calls).toEqual(['afterDelete:', 'invalidate'])
  })

  it('restore（外部座位）：afterRestore → invalidate → 熄灭撤销 / 清缓存；already-gone 由查找兜底', () => {
    mocks.calls.length = 0
    const receipt = readReceipt('restore', ['e1', 'e2'], [
      ok('restore', 'e1', trashRow('e1', 's1')),
      ok('restore', 'e2', null),
    ])
    settleWrite(settled({ action: 'restore', ids: ['e1', 'e2'], receipt, successIds: ['e1', 'e2'], anySuccess: true }), {
      invalidate: () => mocks.calls.push('invalidate'),
      sessionIdOfEntry: (id) => (id === 'e2' ? 's2' : undefined),
      dismissUndo: (ids) => mocks.calls.push(`dismiss:${ids.join(',')}`),
      clearDetailCache: (ids) => mocks.calls.push(`cache:${ids.join(',')}`),
    })
    expect(mocks.calls).toEqual([
      'afterRestore:s1,s2', 'invalidate', 'dismiss:e1,e2', 'cache:e1,e2',
    ])
  })

  it('restore（面板座位）：panelSeat 明说 ⇒ 只遗忘 / 清缓存，不重开主视图', () => {
    mocks.calls.length = 0
    const receipt = readReceipt('restore', ['e1', 'e2'], [
      ok('restore', 'e1', trashRow('e1', 's1')),
      ok('restore', 'e2', null),
    ])
    settleWrite(settled({ action: 'restore', ids: ['e1', 'e2'], receipt, successIds: ['e1', 'e2'], anySuccess: true }), {
      panelSeat: true,
      sessionIdOfEntry: (id) => (id === 'e2' ? 's2' : undefined),
      dismissUndo: (ids) => mocks.calls.push(`dismiss:${ids.join(',')}`),
      clearDetailCache: (ids) => mocks.calls.push(`cache:${ids.join(',')}`),
    })
    expect(mocks.calls).toEqual([
      'dismiss:e1,e2', 'forget:s1,s2', 'cache:e1,e2',
    ])
  })

  it('restore 全失败：外部座位仍失效回收站（跨槽位），但不碰呈现钩子', () => {
    mocks.calls.length = 0
    settleWrite(settled({ action: 'restore', ids: ['e1'], successIds: [], anySuccess: false }), {
      invalidate: () => mocks.calls.push('invalidate'),
      dismissUndo: () => mocks.calls.push('dismiss'),
      clearDetailCache: () => mocks.calls.push('cache'),
    })
    expect(mocks.calls).toEqual(['afterRestore:', 'invalidate'])
  })

  it('purge：anySuccess 时熄灭撤销 → 清详情缓存；全失败不碰呈现钩子', () => {
    mocks.calls.length = 0
    settleWrite(settled({
      action: 'purge', ids: ['e1'], receipt: readReceipt('purge', ['e1'], [{ id: 'e1', action: 'purge', ok: true, value: { removed: 1, freedBytes: 1 } }]),
      successIds: ['e1'], anySuccess: true,
    }), {
      dismissUndo: (ids) => mocks.calls.push(`dismiss:${ids.join(',')}`),
      clearDetailCache: (ids) => mocks.calls.push(`cache:${ids.join(',')}`),
    })
    expect(mocks.calls).toEqual(['dismiss:e1', 'cache:e1'])

    // 逐条全失败：撤销横幅与详情缓存都不许动——没有落点，清缓存只会让下一次详情白读。
    mocks.calls.length = 0
    settleWrite(settled({ action: 'purge', ids: ['e1'], successIds: [], anySuccess: false }), {
      dismissUndo: (ids) => mocks.calls.push(`dismiss:${ids.join(',')}`),
      clearDetailCache: (ids) => mocks.calls.push(`cache:${ids.join(',')}`),
    })
    expect(mocks.calls).toEqual([])

    // `count` / `orphan-clean` 的呈现材质是空记录：类型面就不给钩子，settlement 也不碰跨槽位。
    mocks.calls.length = 0
    settleWrite(settled({ action: 'orphan-clean', ids: ['r1'] }), noPresentation('orphan-clean'))
    settleWrite(settled({ action: 'count', ids: ['s1'] }), noPresentation('count'))
    expect(mocks.calls).toEqual([])
  })
})
