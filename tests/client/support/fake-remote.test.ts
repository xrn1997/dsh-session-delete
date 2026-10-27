import { expect, it } from 'vitest'
import { createFakeRemote } from './fake-remote.js'

it('FakeRemote 是完整的 SessionDeleteRemote，默认安静成功', async () => {
  const remote = createFakeRemote()
  await expect(remote.list()).resolves.toEqual([])
  await expect(remote.scanOrphans()).resolves.toMatchObject({ roots: [] })
  await expect(remote.detail('e1')).resolves.toMatchObject({ entryId: 'fake' })
  await expect(remote.emptyTrash()).resolves.toEqual({ removed: 0, freedBytes: 0 })
  await expect(remote.applyOutcomes('delete', [])).resolves.toEqual([])
  await expect(remote.scanAttachmentOrphans()).resolves.toEqual({ count: 0, totalBytes: 0, items: [] })
  await expect(remote.cleanAttachmentOrphans()).resolves.toEqual({ removed: 0, freedBytes: 0, failed: 0 })
})
