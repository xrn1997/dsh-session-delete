/**
 * 首帧快照（`trash-snapshot.ts`）：面板跨挂载保留的**上一次成功读数**。
 *
 * 它不是「清单状态」的第四态，也不是持久化：只有读一次、不订阅、写失败就整份丢掉。
 * 这一份只钉 store 的读写与修剪；首帧怎么用归 `use-trash-query.test.tsx` 与面板用例。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearTrashDetails,
  clearTrashSnapshot,
  forgetTrashDetail,
  readCachedTrashDetail,
  readTrashSnapshot,
  reconcileTrashRows,
  writeTrashDetail,
  writeTrashSelection,
} from '../../src/client/trash-snapshot.js'
import type { TrashDetailLike, TrashEntryLike } from '../../src/client/remote.js'
import { resetClientState } from '../../src/client/reset-client-state.js'

const A: TrashEntryLike = {
  id: 'a', sessionId: 'session-a', projectDir: '--p--', workspaceId: 'ws',
  wasArchived: false, deletedAt: 1, sizeBytes: 10, releaseBytes: 10, title: 'A',
}
const B: TrashEntryLike = { ...A, id: 'b', sessionId: 'session-b', title: 'B' }

function detailOf(entryId: string): TrashDetailLike {
  return {
    entryId, cwd: '', createdAt: 0, lastActivity: 0, logTitle: '', models: [],
    turnCount: 0, userMessageCount: 0, assistantMessageCount: 0, toolCallCount: 0,
    injectedCount: 0, blocks: [], olderCursor: null,
  }
}

beforeEach(() => { resetClientState() })

describe('首帧快照', () => {
  it('没有写过 ⇒ null', () => {
    expect(readTrashSnapshot()).toBeNull()
  })

  it('写 rows / selection / detail 后能读回；rows 修剪已不在的选中与详情', () => {
    reconcileTrashRows([A, B])
    writeTrashSelection('b')
    writeTrashDetail('b', detailOf('b'))

    const snapshot = readTrashSnapshot()
    expect(snapshot?.rows.map((row) => row.id)).toEqual(['a', 'b'])
    expect(snapshot?.selectedId).toBe('b')
    expect(snapshot?.details.get('b')?.entryId).toBe('b')

    // 别处恢复了 b：下一次成功读数只带回 a，快照不许继续留着 b 的选中与详情。
    reconcileTrashRows([A])
    const pruned = readTrashSnapshot()
    expect(pruned?.rows.map((row) => row.id)).toEqual(['a'])
    expect(pruned?.selectedId).toBeNull()
    expect(pruned?.details.has('b')).toBe(false)
  })

  it('详情账本先于清单落账也能读到；下一份清单只修剪清单里消失的顶部条目', () => {
    writeTrashDetail('a', detailOf('a'))
    writeTrashDetail('kid', detailOf('kid'))
    expect(readCachedTrashDetail('a')?.entryId).toBe('a')

    reconcileTrashRows([A])
    expect(readCachedTrashDetail('a')?.entryId).toBe('a')
    expect(readCachedTrashDetail('kid')?.entryId).toBe('kid')

    reconcileTrashRows([B])
    expect(readCachedTrashDetail('a')).toBeUndefined()
    // 孩子从不在清单行里，重读清单不许把它误删。
    expect(readCachedTrashDetail('kid')?.entryId).toBe('kid')
  })

  it('forgetTrashDetail 只丢一条；clear 之后回到 null', () => {
    reconcileTrashRows([A])
    writeTrashDetail('a', detailOf('a'))
    forgetTrashDetail('a')
    expect(readTrashSnapshot()?.details.size).toBe(0)

    clearTrashSnapshot()
    expect(readTrashSnapshot()).toBeNull()
  })

  it('clearTrashDetails 只丢详情账本：清空回收站成功后的空清单快照原样留着', () => {
    // `emptyTrash` 已经重读并写下过空清单；整份 clear 会把这份成功读数也丢掉，
    // 下次挂载又从「正在读回收站…」起画（ADR-0048 要消灭的正是这帧闪）。
    reconcileTrashRows([])
    writeTrashDetail('kid', detailOf('kid'))
    clearTrashDetails()

    expect(readTrashSnapshot()?.rows).toEqual([])
    expect(readCachedTrashDetail('kid')).toBeUndefined()
    expect(readTrashSnapshot()?.details.size).toBe(0)
  })

  it('没有快照时选中写不进去：它只更新既有快照，不凭空造一份', () => {
    writeTrashSelection('a')
    expect(readTrashSnapshot()).toBeNull()
  })

  it('写出去的是副本：调用方改自己的数组不会改快照', () => {
    const rows = [A]
    reconcileTrashRows(rows)
    rows.push(B)
    expect(readTrashSnapshot()?.rows).toHaveLength(1)
  })

  it('写时复制：先前读到的 details 引用不会被后来的写入改动', () => {
    reconcileTrashRows([A])
    writeTrashDetail('a', detailOf('a'))
    const before = readTrashSnapshot()?.details
    writeTrashDetail('b', detailOf('b'))
    forgetTrashDetail('a')
    expect(before?.has('a')).toBe(true)
    expect(before?.has('b')).toBe(false)
    expect(readTrashSnapshot()?.details.has('b')).toBe(true)
  })

  it('账本有上限：第 65 条写进来时最久没被写的那条先走', () => {
    for (let i = 0; i < 65; i += 1) writeTrashDetail(`d${i}`, detailOf(`d${i}`))
    expect(readCachedTrashDetail('d0')).toBeUndefined()
    expect(readCachedTrashDetail('d64')?.entryId).toBe('d64')

    // 重写会把条目挪到队尾：它比 d2 更晚被写，先走的不是它。
    writeTrashDetail('d1', detailOf('d1'))
    writeTrashDetail('d65', detailOf('d65'))
    expect(readCachedTrashDetail('d1')).toBeDefined()
    expect(readCachedTrashDetail('d2')).toBeUndefined()
  })
})
