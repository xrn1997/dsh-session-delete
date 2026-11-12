/**
 * 归档档的失效通告台（`archive-store.ts`）：形状与 `trash-store.ts` 同款——
 * 一个递增修订号，`invalidateArchive` 戳一下、`useArchiveRevision` 订阅、`resetArchiveStore` 收场。
 * 归档档的**唯一重读入口**是 `useArchiveQuery` 的 `reload`；这里只管「变过」这一个语义。
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  invalidateArchive,
  resetArchiveStore,
  useArchiveRevision,
} from '../../src/client/archive-store.js'

describe('归档档失效台（archive-store）', () => {
  beforeEach(() => { resetArchiveStore() })

  it('invalidateArchive 逐次递增修订；订阅者收到通告', () => {
    const { result } = renderHook(() => useArchiveRevision())
    expect(result.current).toBe(0)
    act(() => { invalidateArchive() })
    expect(result.current).toBe(1)
    act(() => { invalidateArchive() })
    expect(result.current).toBe(2)
  })

  it('resetArchiveStore 归零（测试收场专用）', () => {
    const { result } = renderHook(() => useArchiveRevision())
    act(() => { invalidateArchive() })
    act(() => { resetArchiveStore() })
    expect(result.current).toBe(0)
  })
})
