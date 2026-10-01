// Node 半路由层（`/dsh-session-delete-api`）——**薄线**的那一半
//
// 照本机既有插件的做法：分发器是**纯构造器**（`createApiHandler(deps)`），不依赖 Cordis，
// 用**真 `node:http` server** 承载（Node 原生 req/res 语义不替身），所以这一层可以单测到位。
//
// 钉住的是**契约**，不是实现细节：
//  ① 四个端点各自的方法 + 路径；② 信封就是浏览器半消费的那个形状
//  （`{ok:true,value}` / `{ok:false,error:{code,message}}`）；③ 码只从那五个里出、且失败的
//  **原文**进 `error.message`；④ 路由层自检（未知路径 / 方法不对 / body 不对）不静默吞；
//  ⑤ 取数通道的**同源栅栏**：跨源请求拒掉，且拒之前一个副作用都不发生。
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiHandler } from '../src/api/dispatch.js'
import { SESSION_DELETE_API_PREFIX, ROUTES } from '../src/shared/wire.js'
import { makeEntryId, type TrashEntry } from '../src/trash/entry.js'
import { createMemoryManifest } from '../src/trash/manifest.js'
import type { DeleteDeps } from '../src/verbs/delete-session.js'

const HOME = '/h'
const NOW = Date.UTC(2026, 8, 30, 13, 5, 0)

/** 条目 id 一律由 `makeEntryId` 产出（`恢复` 动词按 id 反推原目录名）⇒ 夹具照真实形状造，
 *  不拿 `'a'` 这种手写串冒充。 */
const entryIdOf = (sessionDirName: string) => makeEntryId(NOW, sessionDirName)
const entry = (sessionDirName: string, over: Partial<TrashEntry> = {}): TrashEntry => ({
  id: entryIdOf(sessionDirName), sessionId: sessionDirName, projectDir: '--p--', workspaceId: 'ws-1',
  wasArchived: false, deletedAt: 1,
  title: '', sizeBytes: 0, ...over,
})

/**
 * 四个端点的假依赖：动词要什么给什么——**真动词 + 真清单端口**，只有宿主与文件系统是替身。
 * 替身暴露出来（`fakes`）是为了让每条用例能只翻自己那一格，而不必重建整副依赖。
 */
function makeDeps(over: { seed?: TrashEntry[]; live?: boolean } = {}) {
  const manifest = createMemoryManifest(over.seed ?? [])
  const fs = {
    exists: vi.fn(async (_path: string) => true),
    sizeOfDir: vi.fn(async (_path: string) => 224 * 1024),
    ensureDir: vi.fn(async (_path: string) => {}),
    rename: vi.fn(async (_from: string, _to: string) => {}),
    removeDir: vi.fn(async (_path: string) => {}),
  }
  const host = {
    isLive: vi.fn(async (_sessionId: string) => over.live ?? false),
    projectDirOf: vi.fn(async (_sessionId: string): Promise<string | undefined> => '--p--'),
    workspaceOf: vi.fn(async (_sessionId: string): Promise<string | undefined> => 'ws-1'),
    titleOf: vi.fn(async (_sessionId: string) => '会话标题'),
    isArchived: vi.fn(async (_sessionId: string) => false),
    evictLive: vi.fn(async (_sessionId: string) => 'not-live' as const),
    announceRemoved: vi.fn(async (_sessionId: string) => {}),
    announceRestored: vi.fn(async (_sessionId: string) => {}),
    unarchive: vi.fn(async (_sessionId: string) => {}),
    detach: vi.fn(async (_sessionId: string, _workspaceId: string) => {}),
    attach: vi.fn(async (_sessionId: string, _workspaceId: string) => {}),
    archive: vi.fn(async (_sessionId: string, _workspaceId: string) => {}),
  }
  return { deps: { fs, host, manifest, home: HOME, now: () => NOW } as unknown as DeleteDeps, fs, host, manifest }
}

const servers: Array<() => Promise<void>> = []
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as () => Promise<void>)()
})

/** 起真 http server（127.0.0.1:0）承载分发器——与宿主把我们的 handler 挂进前缀路由同形。 */
async function start(deps: DeleteDeps, mountPrefix = true): Promise<string> {
  const handler = createApiHandler(deps)
  const server = http.createServer((req, res) => {
    void handler(req, res).catch(() => { /* 分发器内部已写错误信封，这里只兜底 */ })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(() => new Promise((resolve) => server.close(() => resolve())))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}${mountPrefix ? SESSION_DELETE_API_PREFIX : ''}`
}

interface CallInit { method?: string; body?: unknown; headers?: Record<string, string> }

/** 一次调用 → 解析出的信封（HTTP 状态一并带出，因为路由层自检要看它）。 */
async function call(base: string, path: string, init: CallInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? init.headers : { 'content-type': 'application/json', ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** 失败的形状（设计稿 §6 的五个码）：`{ok:false, error:{code, message}}`。 */
async function failureOf(base: string, path: string, init: CallInit = {}): Promise<{ status: number; code: string; message: string }> {
  const { status, body } = await call(base, path, init)
  expect(body.ok).toBe(false)
  const error = body.error as { code: string; message: string }
  expect(error.code.startsWith('sessiondelete/')).toBe(true)
  expect(['live', 'not-found', 'trash-empty', 'project-missing', 'io'])
    .toContain(error.code.slice('sessiondelete/'.length))
  return { status, code: error.code, message: error.message }
}

/**
 * 原生 `http.request` 形态的一次调用。**栅栏用例必须用它**：`Origin` / `Referer` 在 Fetch 规范里
 * 是 forbidden header name，`fetch()` 传了也会被丢掉——那样测出来的就是"没有 Origin"那条放行支。
 */
function rawCall(
  base: string, path: string, method: string, headers: Record<string, string>, body?: string,
): Promise<{ status: number; text: string }> {
  const url = new URL(`${base}${path}`)
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method, headers },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

describe('路由层 · 四个端点', () => {
  it('GET /list 回信封 {ok:true,value}，值就是清单（最近删除在前）', async () => {
    const { deps } = makeDeps({ seed: [entry('a', { deletedAt: 100 }), entry('b', { deletedAt: 200 })] })
    const base = await start(deps)
    const { status, body } = await call(base, ROUTES.list)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect((body.value as TrashEntry[]).map((e) => e.id)).toEqual([entryIdOf('b'), entryIdOf('a')])
  })

  it('POST /delete 拿 body 里的 sessionId 走删除动词，回移入回收站的那一条', async () => {
    const { deps, manifest, host } = makeDeps()
    const base = await start(deps)
    const { status, body } = await call(base, ROUTES.delete, { method: 'POST', body: { sessionId: 'session-abc' } })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.value).toMatchObject({ sessionId: 'session-abc', title: '会话标题', sizeBytes: 224 * 1024 })
    // 清单真的多了一行（路由不是把动词的返回值转发一下了事），且账本/归档都动到了
    expect((await manifest.list()).map((e) => e.sessionId)).toEqual(['session-abc'])
    expect(host.detach).toHaveBeenCalledWith('session-abc', 'ws-1')
  })

  it('POST /restore 拿 body 里的 entryId 走恢复动词，成功即从清单消失', async () => {
    const { deps, manifest } = makeDeps({ seed: [entry('a')] })
    const base = await start(deps)
    const { status, body } = await call(base, ROUTES.restore, { method: 'POST', body: { entryId: entryIdOf('a') } })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.value).toMatchObject({ id: entryIdOf('a') })
    expect(await manifest.list()).toEqual([])
  })

  it('POST /purge 带 entryId = 单条；不带 = 清空（回执 {removed,freedBytes}）', async () => {
    const one = makeDeps({ seed: [entry('a'), entry('b')] })
    const oneBase = await start(one.deps)
    const single = await call(oneBase, ROUTES.purge, { method: 'POST', body: { entryId: entryIdOf('a') } })
    expect(single.body).toMatchObject({ ok: true, value: { removed: 1, freedBytes: 224 * 1024 } })
    expect((await one.manifest.list()).map((e) => e.id)).toEqual([entryIdOf('b')])

    const all = makeDeps({ seed: [entry('a'), entry('b')] })
    const allBase = await start(all.deps)
    const cleared = await call(allBase, ROUTES.purge, { method: 'POST', body: {} })
    expect(cleared.body).toMatchObject({ ok: true, value: { removed: 2, freedBytes: 448 * 1024 } })
    expect(await all.manifest.list()).toEqual([])
  })
})

describe('路由层 · 失败路径（码来自 map-error，原文不吞）', () => {
  it('删一个正在跑的会话 ⇒ sessiondelete/live，且一个字节都没动', async () => {
    const { deps, manifest, fs } = makeDeps({ live: true })
    const base = await start(deps)
    const { code, message } = await failureOf(base, ROUTES.delete, { method: 'POST', body: { sessionId: 'session-abc' } })
    expect(code).toBe('sessiondelete/live')
    expect(message).toContain('session-abc')
    expect(fs.rename).not.toHaveBeenCalled()
    expect(await manifest.list()).toEqual([])
  })

  it('恢复一条不在清单里的 id ⇒ sessiondelete/trash-empty', async () => {
    const { deps } = makeDeps()
    const base = await start(deps)
    const { code, message } = await failureOf(base, ROUTES.restore, { method: 'POST', body: { entryId: 'ghost' } })
    expect(code).toBe('sessiondelete/trash-empty')
    expect(message).toContain('ghost')
  })

  it('恢复时原项目目录没了 ⇒ sessiondelete/project-missing（不静默建目录）', async () => {
    const { deps, fs } = makeDeps({ seed: [entry('a')] })
    // 清单在、回收站目录也在，唯独 sessions 根不在
    fs.exists.mockImplementation(async (path: string) => path !== `${HOME}/sessions`)
    const base = await start(deps)
    const { code } = await failureOf(base, ROUTES.restore, { method: 'POST', body: { entryId: entryIdOf('a') } })
    expect(code).toBe('sessiondelete/project-missing')
    expect(fs.rename).not.toHaveBeenCalled()
  })

  it('删一条不在账本里的会话 ⇒ sessiondelete/not-found', async () => {
    const { deps, host } = makeDeps()
    host.projectDirOf.mockResolvedValue(undefined)
    const base = await start(deps)
    const { code } = await failureOf(base, ROUTES.delete, { method: 'POST', body: { sessionId: 'ghost' } })
    expect(code).toBe('sessiondelete/not-found')
  })

  it('清空一条不存在的 entryId ⇒ sessiondelete/trash-empty', async () => {
    const { deps } = makeDeps({ seed: [entry('a')] })
    const base = await start(deps)
    const { code } = await failureOf(base, ROUTES.purge, { method: 'POST', body: { entryId: 'ghost' } })
    expect(code).toBe('sessiondelete/trash-empty')
  })

  it('list 的域层故障也过同一张映射表 ⇒ sessiondelete/io，原文带出', async () => {
    const { deps, manifest } = makeDeps()
    manifest.list = async () => { throw new Error('domain xrn1997_session_delete_trash is already open') }
    const base = await start(deps)
    const { code, message } = await failureOf(base, ROUTES.list)
    expect(code).toBe('sessiondelete/io')
    expect(message).toContain('already open')
  })
})

describe('路由层 · 自检（不静默吞）', () => {
  it('方法不对：GET /delete 不在 list 那条道上', async () => {
    const { deps } = makeDeps()
    const base = await start(deps)
    const { message } = await failureOf(base, ROUTES.delete)
    expect(message).toMatch(/方法不允许/)
  })

  it('未知路径：前缀本身、未知段、前缀外的请求都回错误信封，绝不假装成功', async () => {
    const { deps } = makeDeps()
    const base = await start(deps)
    expect((await failureOf(base, '')).message).toMatch(/未知路由/)
    expect((await failureOf(base, '/nope')).message).toMatch(/未知路由/)
    // 卸载前缀（宿主之外直接打到 handler 的路径）同样按未知路由处理
    const bare = await start(deps, false)
    expect((await failureOf(bare, '/outside')).message).toMatch(/未知路由/)
  })

  it('body 不对：缺 sessionId / 不是字符串 / 非法 JSON，都回信封而不是崩成空响应', async () => {
    const { deps } = makeDeps()
    const base = await start(deps)
    expect((await failureOf(base, ROUTES.delete, { method: 'POST', body: {} })).message).toMatch(/sessionId/)
    expect((await failureOf(base, ROUTES.delete, { method: 'POST', body: { sessionId: 42 } })).message).toMatch(/sessionId/)
    expect((await failureOf(base, ROUTES.restore, { method: 'POST', body: {} })).message).toMatch(/entryId/)
    expect((await failureOf(base, ROUTES.purge, { method: 'POST', body: { entryId: 42 } })).message).toMatch(/entryId/)

    const res = await fetch(`${base}${ROUTES.delete}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { ok: boolean }).ok).toBe(false)
  })
})

describe('路由层 · 同源栅栏', () => {
  const body = JSON.stringify({ sessionId: 'session-abc' })
  const json = { 'content-type': 'application/json' }

  it('跨源的 Origin（无 Referer 也会带）被挡在门外：403，且一个副作用都不发生', async () => {
    const { deps, manifest, fs } = makeDeps()
    const base = await start(deps)
    const res = await rawCall(base, ROUTES.delete, 'POST', { ...json, origin: 'https://evil.example' }, body)
    expect(res.status).toBe(403)
    expect(fs.rename).not.toHaveBeenCalled()
    expect(await manifest.list()).toEqual([])
  })

  it('跨源的 Referer 同样被挡', async () => {
    const { deps } = makeDeps()
    const base = await start(deps)
    const res = await rawCall(base, ROUTES.delete, 'POST', { ...json, referer: 'https://evil.example/x' }, body)
    expect(res.status).toBe(403)
  })

  it('同源（Origin / Referer 与 Host 同源）放行；两者都缺席（curl 形态）也放行', async () => {
    const { deps, manifest } = makeDeps()
    const base = await start(deps)
    const host = new URL(base).host
    const sameOrigin = await rawCall(base, ROUTES.delete, 'POST', { ...json, origin: `http://${host}`, referer: `http://${host}/` }, body)
    expect(sameOrigin.status).toBe(200)
    expect(JSON.parse(sameOrigin.text)).toMatchObject({ ok: true })
    expect((await manifest.list()).length).toBe(1)

    const bare = await rawCall(base, ROUTES.delete, 'POST', json, JSON.stringify({ sessionId: 'session-xyz' }))
    expect(bare.status).toBe(200)
    expect((await manifest.list()).length).toBe(2)
  })

  // 桌面壳那条路（asar `/lib/main.js`）：渲染进程从 `dsh-app://app/` 加载，页面里对非静态路径的
  // 请求由 `protocol.handle("dsh-app")` 转给宿主，转之前它**摘掉 `origin`**（并换成宿主 cookie）。
  // 所以桌面版的请求到了我们这里既没有 Origin、Referer 也不是 http 同源——栅栏必须认得这个形状，
  // 否则真机上探测永远 403、四个入口一个都不出现（而 headless Edge 直连 http 的过门读数看不出来）。
  it('桌面壳转发的形态（Origin 被摘掉、Referer 是 dsh-app://app/）放行', async () => {
    const { deps, manifest } = makeDeps()
    const base = await start(deps)
    const res = await rawCall(base, ROUTES.delete, 'POST', { ...json, referer: 'dsh-app://app/' }, body)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.text)).toMatchObject({ ok: true })
    expect((await manifest.list()).length).toBe(1)
  })

  it('挂着 dsh-app 前缀但不是桌面壳那个 origin 的 Referer 照样挡（别把它写成前缀匹配）', async () => {
    const { deps, manifest } = makeDeps()
    const base = await start(deps)
    const res = await rawCall(base, ROUTES.delete, 'POST', { ...json, referer: 'dsh-app://app.evil/' }, body)
    expect(res.status).toBe(403)
    expect(await manifest.list()).toEqual([])
  })
})
