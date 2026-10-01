import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryManifest } from '../src/trash/manifest.js'
import type { TrashEntry } from '../src/trash/entry.js'

const entry = (id: string, over: Partial<TrashEntry> = {}): TrashEntry => ({
  id, sessionId: id, projectDir: '--p--', workspaceId: 'ws-1',
  wasArchived: false, deletedAt: 1,
  title: '', sizeBytes: 0, ...over,
})

describe('清单', () => {
  let m: ReturnType<typeof createMemoryManifest>
  beforeEach(() => { m = createMemoryManifest() })

  it('加入后能列出，按删除时间倒序（最近的在前）', async () => {
    await m.add(entry('a', { deletedAt: 100 }))
    await m.add(entry('b', { deletedAt: 200 }))
    expect((await m.list()).map(e => e.id)).toEqual(['b', 'a'])
  })

  it('同一 id 重复加入是覆盖而不是两条', async () => {
    await m.add(entry('a', { wasArchived: false }))
    await m.add(entry('a', { wasArchived: true, title: '改过的标题', sizeBytes: 999 }))
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
