// 浏览器半的取数通道（路径 / 方法 / 请求体投影 + 唯一下落 + 探测）
//
// 这一层钉住的是**契约形状**：每个操作交回同一种落地面 `{ ok:true, value }` / `{ ok:false, failure }`；
// 失败**不抛**，也不再经过「raw 信封 → 展开 → 再归一」的分层。信封解析、401/403 原文、非信封诊断与
// 网络失败归一都在 `createHttpRemote` 这一条通道里完成。用例全部围绕这条契约，不触碰任何组件。
//
// 信封形状（`RemoteResult`）与失败形状（`RemoteFailure`）的家是两半共用的 `src/shared/wire.js`；
// 这里验的是**浏览器半对它们的使用**：解析、原文兜底、落地面。标记位判别（`isDSHRemoteError`）本文件
// 不再用到——浏览器半不抛失败、也不补标记，那条判别的用例住在 `tests/wire-shape.test.ts`。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PARAMS,
  ROUTES,
  OFFICIAL_SESSION_DELETE_API_PREFIX,
  type ApplyOutcome,
} from '../../src/shared/wire.js'
import {
  applyOne,
  createHttpRemote,
  probeChannel,
  type RemoteOutcome,
  type SessionDeleteRemote,
} from '../../src/client/remote.js'
import type { TrashPanelDeps } from '../../src/client/trash-panel.js'
import { pick } from '../support/fixture.js'

afterEach(() => {
  // 断言失败时也把 fetch 还原；否则下一条用例会拿着上一条的 stub 跑（新增用例不再依赖 finally）。
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 一次落地面 → 失败原文；成功即用例前提不成立，直接炸掉。 */
async function failureMessage(run: Promise<RemoteOutcome<unknown>>): Promise<string> {
  const outcome = await run
  if (outcome.ok) throw new Error('这一趟应当失败')
  return outcome.failure.message
}

describe('createHttpRemote · 文档挂载点', () => {
  it('九个 JSON 段的 fetch 都保留 document.baseURI 的挂载点（config 读/写同段）', async () => {
    vi.spyOn(document, 'baseURI', 'get').mockReturnValue('http://host/dsh/')
    const paths: string[] = []
    vi.stubGlobal('fetch', async (path: string) => {
      paths.push(path)
      return new Response(JSON.stringify({ ok: true, value: [] }), {
        headers: { 'content-type': 'application/json' },
      })
    })

    const remote = createHttpRemote()
    await remote.list()
    await remote.ping()
    await remote.config()
    await remote.saveConfig({ orphanPreviewLimit: 200, maxAttachmentBytes: 20971520, maxJsonRefBytes: 10485760 })
    await remote.scanOrphans()
    await remote.scanAttachmentOrphans()
    await remote.cleanAttachmentOrphans()
    await remote.detail('e1')
    await remote.applyOutcomes('purge', ['e1'])
    await remote.emptyTrash()

    expect(paths).toEqual([
      `/dsh${OFFICIAL_SESSION_DELETE_API_PREFIX}${ROUTES.list.path}`,
      `/dsh${OFFICIAL_SESSION_DELETE_API_PREFIX}${ROUTES.ping.path}`,
      `/dsh${OFFICIAL_SESSION_DELETE_API_PREFIX}${ROUTES.config.path}`,
      `/dsh${OFFICIAL_SESSION_DELETE_API_PREFIX}${ROUTES.config.path}`,
      `/dsh${OFFICIAL_SESSION_DELETE_API_PREFIX}${ROUTES.orphans.path}`,
      `/dsh${OFFICIAL_SESSION_DELETE_API_PREFIX}${ROUTES.attachmentOrphans.path}`,
      `/dsh${OFFICIAL_SESSION_DELETE_API_PREFIX}${ROUTES.attachmentClean.path}`,
      `/dsh${OFFICIAL_SESSION_DELETE_API_PREFIX}${ROUTES.detail.path}`,
      `/dsh${OFFICIAL_SESSION_DELETE_API_PREFIX}${ROUTES.apply.path}`,
      `/dsh${OFFICIAL_SESSION_DELETE_API_PREFIX}${ROUTES.empty.path}`,
    ])
  })
})

describe('createHttpRemote · config 读/写共用一段', () => {
  it('两趟都是 POST：读发空对象、写带整份值；方法/路径投影自段名表', async () => {
    const calls: Array<{ path: string; method: string | undefined; body: unknown }> = []
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      // 本仓只以 string 体调 fetch；类型收窄证明拿到的不是被 String 折过的对象。
      const raw = init.body
      if (typeof raw !== 'string') throw new Error(`期望请求体是字符串，实得 ${typeof raw}`)
      calls.push({ path, method: init.method, body: JSON.parse(raw) })
      return new Response(JSON.stringify({ ok: true, value: {} }), {
        headers: { 'content-type': 'application/json' },
      })
    })
    const next = { orphanPreviewLimit: 200, maxAttachmentBytes: 20971520, maxJsonRefBytes: 10485760 }
    const remote = createHttpRemote()
    await expect(remote.config()).resolves.toEqual({ ok: true, value: {} })
    await expect(remote.saveConfig(next)).resolves.toEqual({ ok: true, value: {} })

    const path = `${OFFICIAL_SESSION_DELETE_API_PREFIX}${ROUTES.config.path}`
    expect(calls).toEqual([
      { path, method: ROUTES.config.method, body: {} },
      { path, method: ROUTES.config.method, body: next },
    ])
  })
})

describe('createHttpRemote · detail 那一趟（十段里的 `POST /detail`）', () => {
  const envelope = (value: unknown) =>
    new Response(JSON.stringify({ ok: true, value }), { headers: { 'content-type': 'application/json' } })

  it('POST 到 /detail，请求体是 { entryId }；带游标时多一格 before（字段名与 Node 半同源）', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      calls.push({ path, init })
      return envelope({ entryId: 'e1', blocks: [], olderCursor: null })
    })
    await expect(createHttpRemote().detail('e1')).resolves.toMatchObject({ ok: true })
    await expect(createHttpRemote().detail('e1', 12)).resolves.toMatchObject({ ok: true })
    expect(pick(calls, 0).path).toBe(`${OFFICIAL_SESSION_DELETE_API_PREFIX}${ROUTES.detail.path}`)
    expect(pick(calls, 0).init?.method).toBe('POST')
    // 本仓只以 string 体调 fetch（remote.ts 里 body 一律 JSON.stringify）；用 typeof 证明收窄而不是
    // String()，免得对象经 String 折成 '[object Object]' 还蒙着解析下一步。
    const firstBody = pick(calls, 0).init?.body
    if (typeof firstBody !== 'string') throw new Error(`期望请求体是字符串，实得 ${typeof firstBody}`)
    expect(JSON.parse(firstBody)).toEqual({ [PARAMS.entryId]: 'e1' })
    const secondBody = pick(calls, 1).init?.body
    if (typeof secondBody !== 'string') throw new Error(`期望请求体是字符串，实得 ${typeof secondBody}`)
    expect(JSON.parse(secondBody)).toEqual({ [PARAMS.entryId]: 'e1', [PARAMS.before]: 12 })
    vi.unstubAllGlobals()
  })

  it('通道把失败支原样交回落地面，码与原文都不丢（详情读失败要能原样上屏）', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ ok: false, error: { code: 'sessiondelete/io', message: '读会话日志失败：第 2 帧解压失败' } }),
        { headers: { 'content-type': 'application/json' } }))
    await expect(createHttpRemote().detail('e1')).resolves.toEqual({
      ok: false,
      failure: { code: 'sessiondelete/io', message: '读会话日志失败：第 2 帧解压失败' },
    })
    vi.unstubAllGlobals()
  })

})

describe('probeChannel · 唯一 /api 通道', () => {
  /** 失败路径会 `console.warn` 留诊断；这些用例只关心入口出不出，别把警告刷进测试输出。 */
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  const envelope = (value: unknown) =>
    new Response(JSON.stringify({ ok: true, value }), { headers: { 'content-type': 'application/json' } })
  const failureEnvelope = () =>
    new Response(JSON.stringify({ ok: false, error: { code: 'host/unknown', message: 'no such route' } }), {
      headers: { 'content-type': 'application/json' },
    })

  it('ping 回 pong ⇒ 通道在，且只打官方 /api 路径', async () => {
    const paths: string[] = []
    vi.stubGlobal('fetch', async (path: string) => {
      paths.push(path)
      return envelope('pong')
    })
    await expect(probeChannel(createHttpRemote())).resolves.toBe(true)
    expect(paths).toEqual([`${OFFICIAL_SESSION_DELETE_API_PREFIX}${ROUTES.ping.path}`])
  })

  // 判据是 `ping` 的读数，不是 `ok` 布尔：`/api` 网关对未命中的路径也可能回 `ok:true` 形状的 JSON。
  it('回 ok:true 但不是 pong ⇒ 不是本插件的路由', async () => {
    vi.stubGlobal('fetch', async () => envelope('ok'))
    await expect(probeChannel(createHttpRemote())).resolves.toBe(false)
  })

  it('401 是身份缺失 ⇒ 入口不出现', async () => {
    vi.stubGlobal('fetch', async () => new Response('unauthorized', { status: 401 }))
    await expect(probeChannel(createHttpRemote())).resolves.toBe(false)
  })

  it('失败信封（可能是 /api 网关自己的错误形状）⇒ 入口不出现', async () => {
    vi.stubGlobal('fetch', async () => failureEnvelope())
    await expect(probeChannel(createHttpRemote())).resolves.toBe(false)
  })

  it('非信封 / 404 ⇒ 入口不出现', async () => {
    vi.stubGlobal('fetch', async () => new Response('not found', { status: 404 }))
    await expect(probeChannel(createHttpRemote())).resolves.toBe(false)
  })

  it('401/403 纯文本翻成两条固定原文，不冒充「回的不是信封」', async () => {
    vi.stubGlobal('fetch', async () => new Response('unauthorized', { status: 401 }))
    expect(await failureMessage(createHttpRemote().list())).toMatch(/宿主的 Web 身份/)
    vi.stubGlobal('fetch', async () => new Response('forbidden', { status: 403 }))
    expect(await failureMessage(createHttpRemote().list())).toBe('非受信来源')
  })
})

describe('createHttpRemote · 非信封 JSON 的诊断（issue #8 第 1 条）', () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

  it('中间层回 {} 或 {"error":"…"} 时：落「回的不是信封」，不是 TypeError、不是 "undefined" 上屏', async () => {
    for (const body of [{}, { error: 'boom' }, { ok: 'yes', value: 1 }]) {
      vi.stubGlobal('fetch', async () => json(body))
      expect(await failureMessage(createHttpRemote().list())).toMatch(/取数通道回的不是信封/)
      vi.unstubAllGlobals()
    }
  })

  it('合法信封照旧放行：{ok:true,value} 原样落地（guard 不误伤）', async () => {
    vi.stubGlobal('fetch', async () => json({ ok: true, value: [{ id: 'a' }] }))
    await expect(createHttpRemote().list()).resolves.toEqual({ ok: true, value: [{ id: 'a' }] })
    vi.unstubAllGlobals()
  })

  it('{ok:false,error:{code,message}} 仍是落地（返回不抛）', async () => {
    vi.stubGlobal('fetch', async () => json({ ok: false, error: { code: 'sessiondelete/io', message: '读清单失败' } }))
    await expect(createHttpRemote().list()).resolves.toMatchObject({ ok: false })
    vi.unstubAllGlobals()
  })
})

describe('createHttpRemote · orphans 那一趟（十段里的 `GET /orphans`）', () => {
  const report = {
    roots: ['session-root'],
    totalSessions: 2,
    totalBytes: 2048,
    missingParents: 1,
    groups: [{ projectDir: '--p--', sessions: 2, bytes: 2048 }],
  }
  const envelope = (value: unknown) =>
    new Response(JSON.stringify({ ok: true, value }), { headers: { 'content-type': 'application/json' } })

  it('GET 到 /orphans，不带 body；成功信封原样展开成报告', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      calls.push({ path, init })
      return envelope(report)
    })
    await expect(createHttpRemote().scanOrphans()).resolves.toEqual({ ok: true, value: report })
    expect(pick(calls, 0).path).toBe(`${OFFICIAL_SESSION_DELETE_API_PREFIX}${ROUTES.orphans.path}`)
    expect(pick(calls, 0).init?.method).toBe('GET')
    expect(pick(calls, 0).init?.body).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('通道把失败支原样交回：扫描失败不许折成"零条残留"', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ ok: false, error: { code: 'sessiondelete/io', message: 'sessionQuery 不在' } }),
        { headers: { 'content-type': 'application/json' } }))
    await expect(createHttpRemote().scanOrphans()).resolves.toEqual({
      ok: false,
      failure: { code: 'sessiondelete/io', message: 'sessionQuery 不在' },
    })
    vi.unstubAllGlobals()
  })
})

// 2026-10-27 孤儿附件：报告是纯读（GET），清理是聚合写（POST）。两段都回 JSON 信封，
// 失败按 `RemoteOutcome` 交回调用方（ADR-0053）——与其余段同一条契约。
describe('createHttpRemote · 孤儿附件两段（十段里的 `GET /attachment-orphans` / `POST /attachment-clean`）', () => {
  const envelope = (value: unknown) =>
    new Response(JSON.stringify({ ok: true, value }), { headers: { 'content-type': 'application/json' } })

  it('报告 GET 到 /attachment-orphans，不带 body；成功信封原样展开', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const report = { count: 106, totalBytes: 29_150_413, items: [] }
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      calls.push({ path, init })
      return envelope(report)
    })
    await expect(createHttpRemote().scanAttachmentOrphans()).resolves.toEqual({ ok: true, value: report })
    expect(pick(calls, 0).path).toBe(`${OFFICIAL_SESSION_DELETE_API_PREFIX}${ROUTES.attachmentOrphans.path}`)
    expect(pick(calls, 0).init?.method).toBe('GET')
    expect(pick(calls, 0).init?.body).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('清理 POST 到 /attachment-clean，空请求体；聚合回执原样落地', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const cleanup = { removed: 106, freedBytes: 29_150_413, failed: 0 }
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      calls.push({ path, init })
      return envelope(cleanup)
    })
    await expect(createHttpRemote().cleanAttachmentOrphans()).resolves.toEqual({ ok: true, value: cleanup })
    expect(pick(calls, 0).path).toBe(`${OFFICIAL_SESSION_DELETE_API_PREFIX}${ROUTES.attachmentClean.path}`)
    expect(pick(calls, 0).init?.method).toBe('POST')
    const cleanBody = pick(calls, 0).init?.body
    if (typeof cleanBody !== 'string') throw new Error(`期望请求体是字符串，实得 ${typeof cleanBody}`)
    expect(JSON.parse(cleanBody)).toEqual({})
    vi.unstubAllGlobals()
  })

  it('两段的失败都以落地面交回，码与原文不丢', async () => {
    const report = { count: 3, totalBytes: 300, items: [] }
    vi.stubGlobal('fetch', async (path: string) => {
      if (path.endsWith(ROUTES.attachmentOrphans.path)) return envelope(report)
      return envelope({ removed: 2, freedBytes: 200, failed: 0 })
    })
    const remote = createHttpRemote()
    await expect(remote.scanAttachmentOrphans()).resolves.toEqual({ ok: true, value: report })
    await expect(remote.cleanAttachmentOrphans()).resolves.toEqual({
      ok: true,
      value: { removed: 2, freedBytes: 200, failed: 0 },
    })

    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ ok: false, error: { code: 'sessiondelete/io', message: '引用源读不出' } }),
        { headers: { 'content-type': 'application/json' } }))
    const failure = { ok: false, failure: { code: 'sessiondelete/io', message: '引用源读不出' } }
    await expect(remote.scanAttachmentOrphans()).resolves.toEqual(failure)
    await expect(remote.cleanAttachmentOrphans()).resolves.toEqual(failure)
    vi.unstubAllGlobals()
  })
})

// 2026-10-17 批量重构：写动词从「一条一段」收成一段 `POST /apply`（body `{action, ids}`，
// 回逐条 `ApplyOutcome`）。这里钉通道的两件事：**只发一次请求**，以及**单条的失败不在信封层找**。
describe('createHttpRemote · /apply 一段管所有动作', () => {
  const envelope = (value: unknown) =>
    new Response(JSON.stringify({ ok: true, value }), { headers: { 'content-type': 'application/json' } })

  it('POST 到 /apply，请求体是 { action, ids }（字段名与 Node 半同源）', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      calls.push({ path, init })
      return envelope([{ id: 'e1', action: 'restore', ok: true, value: { id: 'e1' } }])
    })
    await expect(createHttpRemote().applyOutcomes('restore', ['e1', 'e2'])).resolves.toMatchObject({ ok: true })
    expect(calls).toHaveLength(1)
    expect(pick(calls, 0).path).toBe(`${OFFICIAL_SESSION_DELETE_API_PREFIX}${ROUTES.apply.path}`)
    expect(pick(calls, 0).init?.method).toBe('POST')
    const applyBody = pick(calls, 0).init?.body
    if (typeof applyBody !== 'string') throw new Error(`期望请求体是字符串，实得 ${typeof applyBody}`)
    expect(JSON.parse(applyBody)).toEqual({ [PARAMS.action]: 'restore', [PARAMS.ids]: ['e1', 'e2'] })
    vi.unstubAllGlobals()
  })

  it('清空是另一段 /empty：聚合回执，不带 ids', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      calls.push({ path, init })
      return envelope({ removed: 3, freedBytes: 1 })
    })
    await expect(createHttpRemote().emptyTrash()).resolves.toMatchObject({ ok: true, value: { removed: 3 } })
    expect(pick(calls, 0).path).toBe(`${OFFICIAL_SESSION_DELETE_API_PREFIX}${ROUTES.empty.path}`)
    vi.unstubAllGlobals()
  })

  it('通道：applyOne 折成同一落地面；批量里单条的失败**不 throw**（它住在 outcome 里）', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({
        ok: true,
        value: [
          { id: 'a', action: 'restore', ok: true, value: { id: 'a' } },
          { id: 'b', action: 'restore', ok: false, error: { code: 'sessiondelete/project-missing', message: '原项目目录已不存在' } },
        ],
      }), { headers: { 'content-type': 'application/json' } }))
    const remote = createHttpRemote()
    const result = await remote.applyOutcomes('restore', ['a', 'b'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.map((o) => o.ok)).toEqual([true, false])
    // N=1 的那一支把逐条失败折成落地面（组件按"这条没成"处理，与批量同一张表）
    await expect(applyOne(remote, 'restore', 'b')).resolves.toEqual({
      ok: false,
      failure: { code: 'sessiondelete/project-missing', message: '原项目目录已不存在' },
    })
    vi.unstubAllGlobals()
  })

  it('整次调用没办成（顶层 ok:false）时 applyOne 与批量口都交回同一个失败', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ ok: false, error: { code: 'sessiondelete/io', message: '方法不允许' } }),
        { headers: { 'content-type': 'application/json' } }))
    const remote = createHttpRemote()
    const failure = { ok: false, failure: { code: 'sessiondelete/io', message: '方法不允许' } }
    await expect(remote.applyOutcomes('purge', ['a'])).resolves.toEqual(failure)
    await expect(applyOne(remote, 'count', 'x')).resolves.toEqual(failure)
    vi.unstubAllGlobals()
  })
})

describe('注入面 · 一个动作只有一条路', () => {
  it('注入面与面板的 deps 里都没有单条便捷方法：写走 `runWrite`，单条非写调用走 `applyOne`', () => {
    // 这两行是**类型层**的闸：谁把 `restore` / `delete` / `countSubagents` 加回 interface，
    // 它们立刻编译不过（同一个动作在一个 module 里有两条路——写路径收进 `runWrite` 就是要拆掉这个形状）。
    const remoteHasRestore: 'restore' extends keyof SessionDeleteRemote ? true : false = false
    const panelHasRestore: 'restore' extends keyof TrashPanelDeps ? true : false = false
    const remoteHasCount: 'countSubagents' extends keyof SessionDeleteRemote ? true : false = false
    expect([remoteHasRestore, panelHasRestore, remoteHasCount]).toEqual([false, false, false])
  })

  it('`applyOne` 取的是**发出去的那个 id** 的结果，不是第一条', async () => {
    const deps = {
      applyOutcomes: async (action: 'restore', ids: readonly string[]) => ({
        ok: true as const,
        value: ids.map((id) => ({ id, action, ok: true as const, value: { id } as never })),
      }),
    }
    const outcome = await applyOne(deps, 'restore', 'only-one')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value.id).toBe('only-one')
  })

  it('applyOne：请求的 id 没回 / 回了幂等空值 ⇒ 都当通道错，不冒充成功', async () => {
    const empty = { applyOutcomes: async () => ({ ok: true as const, value: [] as ApplyOutcome[] }) }
    expect(await failureMessage(applyOne(empty, 'restore', 'a'))).toMatch(/批量通道没回这一条的结果/)

    const gone = {
      applyOutcomes: async (action: 'restore', ids: readonly string[]) => ({
        ok: true as const,
        value: ids.map((id) => ({ id, action, ok: true as const, value: null })),
      }),
    }
    expect(await failureMessage(applyOne(gone, 'restore', 'a'))).toMatch(/单条动作回了幂等空值/)
  })
})

describe('取数通道探测：一次往返 + 5s 上限', () => {
  const rawOf = (ping: (signal?: AbortSignal) => Promise<unknown>): SessionDeleteRemote =>
    ({ ping } as unknown as SessionDeleteRemote)

  it('成功回 pong 才真', async () => {
    const ping = vi.fn(async (_signal?: AbortSignal) => ({ ok: true as const, value: 'pong' }))
    await expect(probeChannel(rawOf(ping))).resolves.toBe(true)
    expect(ping).toHaveBeenCalledTimes(1)
  })

  it('失败信封 / 非 pong 都按不可用，且只探一次，并在 console 留下原因', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failure = vi.fn(async (_signal?: AbortSignal) => ({
      ok: false as const,
      failure: { code: 'sessiondelete/io', message: 'x' },
    }))
    await expect(probeChannel(rawOf(failure))).resolves.toBe(false)
    expect(failure).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('入口不注册'), 'sessiondelete/io', 'x')

    const wrong = vi.fn(async (_signal?: AbortSignal) => ({ ok: true as const, value: 'nope' }))
    await expect(probeChannel(rawOf(wrong))).resolves.toBe(false)
    expect(wrong).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('不是 pong'), 'nope')
  })

  it('超时：AbortSignal 被 abort，回 false，不重试，并留下诊断', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ping = vi.fn((signal?: AbortSignal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    }))
    await expect(probeChannel(rawOf(ping), { timeoutMs: 5 })).resolves.toBe(false)
    expect(ping).toHaveBeenCalledTimes(1)
    expect(ping.mock.calls[0]?.[0]?.aborted).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('打不通'), expect.any(Error))
  })
})
