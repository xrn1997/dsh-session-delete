/**
 * 取数路径的挂载点（`api-base.ts`）。
 *
 * 根部署下挂载点为空、路径与旧版逐字相同；反代到 `/dsh/` 时多出 `/dsh` 前缀。这条行为不能只在
 * 真机上验：`mountPathOf` 的输入是 `document.baseURI`，所以这里直接喂各种 base 形态。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiPath, apiPathOf, mountPathOf } from '../../src/client/api-base.js'
import { attachmentUrl } from '../../src/client/attachment-view.js'
import { createHttpRemote } from '../../src/client/remote.js'
import type { TrashDetailAttachmentWire } from '../../src/shared/wire.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('取数路径的挂载点', () => {
  it('根部署：挂载点为空，路径与旧版逐字相同', () => {
    expect(mountPathOf('http://127.0.0.1:60570/')).toBe('')
    expect(apiPathOf('/list', 'http://127.0.0.1:60570/')).toBe('/api/dsh-session-delete-api/list')
  })

  it('反代到子路径：保留挂载点前缀', () => {
    expect(mountPathOf('http://host/dsh/')).toBe('/dsh')
    expect(apiPathOf('/list', 'http://host/dsh/')).toBe('/dsh/api/dsh-session-delete-api/list')
  })

  it('页面落在子目录的 index.html：取目录而不是文件名', () => {
    expect(apiPathOf('/ping', 'http://host/dsh/index.html')).toBe('/dsh/api/dsh-session-delete-api/ping')
  })

  it('多级挂载点也保留', () => {
    expect(mountPathOf('http://host/team/dsh/')).toBe('/team/dsh')
    expect(apiPathOf('/ping', 'http://host/team/dsh/')).toBe('/team/dsh/api/dsh-session-delete-api/ping')
  })

  it('baseURI 的 query/hash 与百分号编码按目录解析', () => {
    expect(mountPathOf('http://host/dsh/?a=1#x')).toBe('/dsh')
    expect(mountPathOf('http://host/dsh/index.html?x=1#y')).toBe('/dsh')
    expect(mountPathOf('http://host/dsh%20x/')).toBe('/dsh%20x')
  })

  it('不透明 base 退回根路径（与旧版一致）', () => {
    expect(mountPathOf('about:blank')).toBe('')
  })

  it('无 document 的 Node 侧退回根路径', () => {
    vi.stubGlobal('document', undefined)
    expect(apiPath('/ping')).toBe('/api/dsh-session-delete-api/ping')
  })

  it('挂载部署下：附件 URL 与 fetch 都保留同一挂载点', async () => {
    vi.spyOn(document, 'baseURI', 'get').mockReturnValue('http://host/dsh/')
    const paths: string[] = []
    vi.stubGlobal('fetch', async (path: string) => {
      paths.push(path)
      return new Response(JSON.stringify({ ok: true, value: [] }), {
        headers: { 'content-type': 'application/json' },
      })
    })

    await createHttpRemote().list()

    const image: TrashDetailAttachmentWire = { attachmentId: 'a'.repeat(64), kind: 'image', bytes: 1 }
    expect(paths).toEqual(['/dsh/api/dsh-session-delete-api/list'])
    expect(attachmentUrl(image)).toMatch(/^\/dsh\/api\/dsh-session-delete-api\/attachment\?/)
  })
})
