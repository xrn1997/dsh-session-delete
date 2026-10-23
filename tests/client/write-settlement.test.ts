/**
 * 一次写入的**收尾顺序**按 action 收在一个家。
 *
 * 这里钉两件事：delete / restore / purge 各自的固定顺序，以及 `anySuccess` 这道门。
 * 跨槽位（main-view 收尾、回收站失效）在信封成功时就跑，逐条全失败也跑；呈现钩子
 * （撤销通告、熄灭横幅、遗忘主视图、清详情缓存）只在至少一条落地时跑。
 *
 * 恢复有两个座位：外部恢复（撤销横幅）没有主视图收尾素材 ⇒ 由 settlement 调 `afterRestore` 重开；
 * 面板恢复自带 `forgetMainView`（面板已经替这条会话完成“回来”的结算）⇒ 只遗忘、不重开、不抢焦点
 * （判据住 `src/client/main-view.ts` 的 `forgetMainView`）。
 */
import { describe, expect, it, vi } from 'vitest'
import { readReceipt } from '../../src/client/receipt.js'
import {
  settleWrite,
  type SettledFacts,
} from '../../src/client/write-settlement.js'
import type { ApplyAction } from '../../src/shared/wire.js'

const mocks = vi.hoisted(() => {
  const calls: string[] = []
  return {
    calls,
    afterDelete: vi.fn((ids: readonly string[]) => { calls.push(`afterDelete:${ids.join(',')}`) }),
    afterRestore: vi.fn((ids: readonly string[]) => { calls.push(`afterRestore:${ids.join(',')}`) }),
  }
})
vi.mock('../../src/client/main-view.js', () => ({
  afterDelete: mocks.afterDelete,
  afterRestore: mocks.afterRestore,
}))

/** `/apply` 成功支里的回收站条目（`TrashEntryWire`）；`id` 是条目 id，`sessionId` 是会话 id。 */
function row(id: string, sessionId: string) {
  return {
    id, sessionId, projectDir: '--p--', workspaceId: 'ws',
    wasArchived: false, deletedAt: 1, title: id, sizeBytes: 1,
  }
}

function settled<A extends ApplyAction>(over: Partial<SettledFacts<A>> & { action: A }): SettledFacts<A> {
  return { ids: ['x'], receipt: readReceipt(over.action, ['x'], []), successIds: [], anySuccess: false, ...over }
}

describe('settleWrite', () => {
  it('delete：main-view → invalidate → undo，且只在 anySuccess 时发布撤销', () => {
    mocks.calls.length = 0
    const receipt = readReceipt('delete', ['s1'], [{ id: 's1', action: 'delete', ok: true, value: row('e1', 's1') }])
    settleWrite(settled({ action: 'delete', ids: ['s1'], receipt, successIds: ['s1'], anySuccess: true }), {
      invalidate: () => mocks.calls.push('invalidate'),
      publishUndo: () => mocks.calls.push('publish'),
    })
    expect(mocks.calls).toEqual(['afterDelete:s1', 'invalidate', 'publish'])

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
      { id: 'e1', action: 'restore', ok: true, value: row('e1', 's1') },
      { id: 'e2', action: 'restore', ok: true, value: null },
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

  it('restore（面板座位）：有 forgetMainView 就只遗忘 / 清缓存，不重开主视图', () => {
    mocks.calls.length = 0
    const receipt = readReceipt('restore', ['e1', 'e2'], [
      { id: 'e1', action: 'restore', ok: true, value: row('e1', 's1') },
      { id: 'e2', action: 'restore', ok: true, value: null },
    ])
    settleWrite(settled({ action: 'restore', ids: ['e1', 'e2'], receipt, successIds: ['e1', 'e2'], anySuccess: true }), {
      sessionIdOfEntry: (id) => (id === 'e2' ? 's2' : undefined),
      dismissUndo: (ids) => mocks.calls.push(`dismiss:${ids.join(',')}`),
      forgetMainView: (ids) => mocks.calls.push(`forget:${ids.join(',')}`),
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

  it('purge：invalidate → 清详情缓存；orphan-clean / count 不碰跨槽位', () => {
    mocks.calls.length = 0
    settleWrite(settled({
      action: 'purge', ids: ['e1'], receipt: readReceipt('purge', ['e1'], [{ id: 'e1', action: 'purge', ok: true, value: { removed: 1, freedBytes: 1 } }]),
      successIds: ['e1'], anySuccess: true,
    }), {
      invalidate: () => mocks.calls.push('invalidate'),
      clearDetailCache: (ids) => mocks.calls.push(`cache:${ids.join(',')}`),
    })
    expect(mocks.calls).toEqual(['invalidate', 'cache:e1'])

    mocks.calls.length = 0
    settleWrite(settled({ action: 'orphan-clean', ids: ['r1'] }), { invalidate: () => mocks.calls.push('invalidate') })
    settleWrite(settled({ action: 'count', ids: ['s1'] }), { invalidate: () => mocks.calls.push('invalidate') })
    expect(mocks.calls).toEqual([])
  })

  it('purge 全失败：跨槽位失效照发，清详情缓存也走 anySuccess 门', () => {
    mocks.calls.length = 0
    settleWrite(settled({ action: 'purge', ids: ['e1'], successIds: [], anySuccess: false }), {
      invalidate: () => mocks.calls.push('invalidate'),
      clearDetailCache: () => mocks.calls.push('cache'),
    })
    expect(mocks.calls).toEqual(['invalidate'])
  })
})
