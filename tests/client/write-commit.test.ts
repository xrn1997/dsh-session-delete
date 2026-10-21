import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const calls: string[] = []
  return {
    calls,
    afterDelete: vi.fn((ids: readonly string[]) => { calls.push(`afterDelete:${ids.join(',')}`) }),
    afterRestore: vi.fn((ids: readonly string[]) => { calls.push(`afterRestore:${ids.join(',')}`) }),
    invalidateTrash: vi.fn(() => { calls.push('invalidate') }),
  }
})
vi.mock('../../src/client/main-view.js', () => ({
  afterDelete: mocks.afterDelete,
  afterRestore: mocks.afterRestore,
}))
vi.mock('../../src/client/trash-store.js', () => ({ invalidateTrash: mocks.invalidateTrash }))

import { commitExternalDelete, commitExternalRestore } from '../../src/client/write-commit.js'

describe('external write commit', () => {
  it('delete: main-view first, then invalidation, then the undo notice', () => {
    mocks.calls.length = 0
    commitExternalDelete({ sessionIds: ['s1'], publishUndo: () => mocks.calls.push('publish') })
    expect(mocks.calls).toEqual(['afterDelete:s1', 'invalidate', 'publish'])
  })

  it('restore: reopen the main view, then invalidate the trash list', () => {
    mocks.calls.length = 0
    commitExternalRestore(['s1'])
    expect(mocks.calls).toEqual(['afterRestore:s1', 'invalidate'])
  })
})
