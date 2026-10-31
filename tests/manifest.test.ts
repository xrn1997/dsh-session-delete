import { beforeEach, describe, expect, it } from 'vitest'
import { createStorageManifest, type StorageDomainLike } from '../src/trash/manifest.js'
import type { TrashEntry } from '../src/trash/entry.js'
import { trashEntry } from './support/world.js'

/** 生产绑定只认 `StorageDomainLike`；用内存域钉住 `createStorageManifest` 的排序与整条覆盖语义。 */
function memoryDomain(): StorageDomainLike {
  const rows = new Map<string, TrashEntry>()
  return {
    async readAll() { return [...rows.values()] },
    async put(record) { rows.set(record.id, record) },
    async delete(key) { rows.delete(key) },
  }
}

describe('清单', () => {
  let m: ReturnType<typeof createStorageManifest>
  beforeEach(() => { m = createStorageManifest(memoryDomain()) })

  it('加入后能列出，按删除时间倒序（最近的在前）', async () => {
    await m.add(trashEntry('a', { deletedAt: 100 }))
    await m.add(trashEntry('b', { deletedAt: 200 }))
    expect((await m.list()).map(e => e.id)).toEqual(['b', 'a'])
  })

  it('同一 id 重复加入是覆盖而不是两条', async () => {
    await m.add(trashEntry('a', { wasArchived: false }))
    await m.add(trashEntry('a', { wasArchived: true, title: '改过的标题', sizeBytes: 999 }))
    expect((await m.list()).length).toBe(1)
    expect((await m.list())[0].wasArchived).toBe(true)
    // 清单存的是整条记录（面板直接读这两列），覆盖是整条替换、不是字段合并
    expect((await m.list())[0]).toMatchObject({ title: '改过的标题', sizeBytes: 999 })
  })

  it('移除不存在的 id 不抛错（幂等）', async () => {
    await expect(m.remove('nope')).resolves.toBeUndefined()
  })

  it('清单为空时 list() 返回空数组而不是 undefined', async () => {
    expect(await m.list()).toEqual([])
  })
})
