import { describe, expect, it } from 'vitest'
import { createHostPort } from '../src/ports/host-port.js'
import { createStorageManifest } from '../src/index.js'
import { unescapeProjectKey } from '../src/shared/wire.js'
import { deleteSession } from '../src/verbs/delete-session.js'
import type { DeleteDeps } from '../src/verbs/delete-session.js'
import type { TrashEntry } from '../src/trash/entry.js'

/**
 * 两个「接线用例」的共用夹具：**默认的窄镜像 ctx**、不是宿主模拟器。
 *
 * `createHostPort` / `createStorageManifest` 的真实绑定要起宿主才验得了（本轮不起宿主），
 * 这两组用例钉的是**接线形状**：
 *  - 宿主成员被调到（哪个服务、哪个方法、什么入参、什么顺序），
 *  - 纯算法（projectKey / 兜底 / 排序 / key 映射）的行为。
 * 夹具只声明被接线代码真正声明的东西（`host-port.ts` 的 `HostCtxLike`、`index.ts` 的 `StorageDomainCtxLike`），
 * 所以它不会替实现兜住一个不存在的宿主成员——写错的成员名会让用例红而不是被夹具喂绿。
 */

const entry = (id: string, over: Partial<TrashEntry> = {}): TrashEntry => ({
  id, sessionId: id, projectDir: '--p--', workspaceId: 'ws-1',
  wasArchived: false, deletedAt: 1,
  title: '', sizeBytes: 0, ...over,
})

/* ------------------------------------------------------------------ *
 * 宿主服务层端口（createHostPort）
 * ------------------------------------------------------------------ */

function makeEnv(over: {
  workspaces?: Array<{ id: string; sessionIds: string[] }>
  archived?: string[]
  headers?: Record<string, { cwd?: string }>
  activity?: unknown[]
  projectionCache?: unknown
  /** `ctx.get('sessions')` 的替身（live store 的窄面：`get` + `liveEntryFor`）。 */
  sessions?: unknown
  /** `ctx.get('sessionController')` 的替身（通告"加回"时取摘要的那一处）。 */
  sessionController?: unknown
  /** `ctx.emit` 的替身（通告走的就是它）。 */
  emit?: (name: string, ...args: unknown[]) => void
} = {}) {
  const calls: string[] = []
  const workspaces = (over.workspaces ?? []).map(w => ({
    id: w.id,
    sessionIds: w.sessionIds,
    detachSession: async (id: string) => { calls.push(`detachSession(${w.id},${id})`) },
    attachSession: async (id: string) => { calls.push(`attachSession(${w.id},${id})`) },
  }))
  const ctx = {
    workspaceRegistry: {
      list: () => { calls.push('registry.list()'); return workspaces },
      get: (id: string) => { calls.push(`registry.get(${id})`); return workspaces.find(w => w.id === id) },
      archivedSessionIds: over.archived ?? [],
      unarchiveSession: async (id: string) => { calls.push(`registry.unarchiveSession(${id})`) },
      archiveSession: async (id: string) => { calls.push(`registry.archiveSession(${id})`) },
      readSessionHeader: async (id: string) => {
        calls.push(`registry.readSessionHeader(${id})`)
        const header = (over.headers ?? {})[id]
        // 未知会话抛的是宿主那句**裸 Error**（asar 原文逐字），不是替身自己编的消息：
        // `projectDirOf` 的「未命中回 undefined」正是按这一句判的，写别的句子会让用例失去意义。
        if (header === undefined) {
          throw new Error(`cannot validate session '${id}': session persistence holds no such session`)
        }
        return header
      },
    },
    waterfall: async (name: string, args: { sessionId: string }, next: () => Promise<unknown[]>) => {
      calls.push(`waterfall(${name},${args.sessionId})`)
      return over.activity ?? (await next())
    },
    get: (name: string) => {
      calls.push(`get(${name})`)
      if (name === 'sessionProjectionCache') return over.projectionCache
      if (name === 'sessions') return over.sessions
      if (name === 'sessionController') return over.sessionController
      return undefined
    },
    emit: (name: string, ...args: unknown[]) => {
      calls.push(`emit(${name})`)
      over.emit?.(name, ...args)
    },
  }
  return { ctx, calls }
}

describe('宿主服务层端口的接线', () => {
  it('十二个方法都返回 Promise，且没有一个还停在 not wired yet', async () => {
    const { ctx } = makeEnv({ workspaces: [{ id: 'ws-1', sessionIds: ['s1'] }], headers: { s1: { cwd: 'C:/p' } } })
    const host = createHostPort(ctx)
    const results = [
      host.workspaceOf('s1'), host.projectDirOf('s1'), host.titleOf('s1'),
      host.isLive('s1'), host.isArchived('s1'), host.unarchive('s1'),
      host.detach('s1', 'ws-1'), host.attach('s1', 'ws-1'), host.archive('s1', 'ws-1'),
      // 后面这三个是收尾用的（摘活体 + 两条如实通告），契约都是"不抛"
      host.evictLive('s1'), host.announceRemoved('s1'), host.announceRestored('s1'),
    ]
    expect(results.length).toBe(12)
    for (const r of results) expect(r).toBeInstanceOf(Promise)
    await expect(Promise.all(results)).resolves.toBeDefined()
  })

  it('projectDirOf 用宿主的 projectKey 算法（`--<cwd 里的分隔符换成 ->--`），undefined cwd 走 _no-cwd', async () => {
    const { ctx } = makeEnv({ headers: { a: { cwd: 'C:/Users/dev' }, b: {}, c: { cwd: 'C:\\develop\\GitHub\\dsh-session-delete' } } })
    const host = createHostPort(ctx)
    // 分隔符（`/` `\` `:`）**连续出现只折成一个 `-`**（`C:\` 两字符 → 一个 `-`），两端再裹 `--`；cwd 缺席落 `_no-cwd`。
    expect(await host.projectDirOf('a')).toBe('--C-Users-dev--')
    expect(await host.projectDirOf('b')).toBe('_no-cwd')
    expect(await host.projectDirOf('c')).toBe('--C-develop-GitHub-dsh-session-delete--')
  })

  // 编码（Node 半，逐字镜像宿主）与解码（`shared/wire.ts`，客户端用它渲染回收站组头）是**一对**：
  // 只钉一边等于没钉——字母表在任一侧漂了，组头就会静默显示错。分隔符折叠是有损的，
  // 所以往返只断言**非分隔符字符**（中文、空格、字面 `~`）能原样回来。
  it('projectKey 的转义与 shared 的还原配对（往返）', async () => {
    const { ctx } = makeEnv({ headers: { s1: { cwd: 'D:/develop/中文 目录/~literal' } } })
    const key = await createHostPort(ctx).projectDirOf('s1')
    expect(key).toBeDefined()
    const back = unescapeProjectKey(key as string)
    expect(back).toContain('中文')      // 多字节字符走 ~XXXX
    expect(back).toContain(' 目录')     // 空格同样走转义，还原后仍是空格
    expect(back).toContain('~literal')  // 字面 `~` 编成 ~007E，还原后不许变成别的字符
  })

  it('projectDirOf 的 cwd 来自 workspaceRegistry.readSessionHeader（官方 header 读面）', async () => {
    const { ctx, calls } = makeEnv({ headers: { s9: { cwd: 'C:/x' } } })
    await createHostPort(ctx).projectDirOf('s9')
    expect(calls).toEqual(['registry.readSessionHeader(s9)'])
  })

  // 未知会话这条：宿主 `readSessionHeader(id)` 抛的是**裸 Error**（无类型、无码）。它是**未命中**，
  // 与 `workspaceOf` 同一口径回 `undefined`——否则 `delete-session.ts` 里
  // `if (!projectDir) throw verbError('not-found', …)` 的 `!projectDir` 永远是假。
  it('projectDirOf 对未知会话返回 undefined（裸抛的 miss 不算故障）', async () => {
    const { ctx } = makeEnv({ headers: { s1: { cwd: 'C:/p' } } })
    expect(await createHostPort(ctx).projectDirOf('ghost')).toBeUndefined()
  })

  // 同一段 try/catch 的另一半：认不出来的错误必须**照抛**，真存储故障不许被伪装成「无此会话」
  // （伪装了会让读盘失败以 `not-found` 回客户端，用户以为会话不存在，实际上盘读不了）。
  it('projectDirOf 只吞「账本里没有此会话」，真存储故障照抛', async () => {
    const { ctx } = makeEnv()
    const host = createHostPort({
      ...ctx,
      workspaceRegistry: {
        ...ctx.workspaceRegistry,
        readSessionHeader: async () => { throw new Error('ENOENT: 账本读不了') },
      },
    })
    await expect(host.projectDirOf('s1')).rejects.toThrow(/ENOENT/)
  })

  // 端到端：未知会话走删除动词。修复前 projectDirOf 裸抛 ⇒ 动词的 not-found 分支够不到，
  // 客户端拿到的是 `sessiondelete/io`；现在必须是 `sessiondelete/not-found`（设计稿 §6）。
  // 顺带钉住「零副作用」：not-found 在**任何** fs 动作之前就抛出。
  it('未知会话走删除动词 ⇒ sessiondelete/not-found（不是 io），且没碰文件系统', async () => {
    const { ctx } = makeEnv({})
    const touched: string[] = []
    const forbidden = (name: string) => async () => { touched.push(name); return undefined }
    const deps = {
      fs: {
        exists: forbidden('fs.exists'), sizeOfDir: forbidden('fs.sizeOfDir'),
        ensureDir: forbidden('fs.ensureDir'),
        rename: forbidden('fs.rename'),
      },
      host: createHostPort(ctx),
      manifest: { list: async () => [], add: forbidden('manifest.add'), remove: forbidden('manifest.remove') },
      home: '/no-such-home',
      now: () => 0,
    } as unknown as DeleteDeps
    await expect(deleteSession(deps)('ghost')).rejects.toMatchObject({ code: 'sessiondelete/not-found' })
    expect(touched).toEqual([])
  })

  it('workspaceOf 从 registry.list() 的实体里按 sessionIds 认领；不在任何账本里返回 undefined', async () => {
    const { ctx } = makeEnv({
      workspaces: [{ id: 'ws-a', sessionIds: ['s1'] }, { id: 'ws-b', sessionIds: ['s2', 's3'] }],
    })
    const host = createHostPort(ctx)
    expect(await host.workspaceOf('s3')).toBe('ws-b')
    expect(await host.workspaceOf('nope')).toBeUndefined()
  })

  it('isLive：waterfall("workspace/session-activity", {sessionId}) 空数组=无活动，非空=判 live；与宿主同源', async () => {
    const idle = makeEnv()
    expect(await createHostPort(idle.ctx).isLive('s1')).toBe(false)
    expect(idle.calls).toContain('waterfall(workspace/session-activity,s1)')

    const busy = makeEnv({ activity: [{ kind: 'turn' }] })
    expect(await createHostPort(busy.ctx).isLive('s1')).toBe(true)
  })

  it('isArchived 读 registry 的 archivedSessionIds 集合', async () => {
    const { ctx } = makeEnv({ archived: ['s1'] })
    const host = createHostPort(ctx)
    expect(await host.isArchived('s1')).toBe(true)
    expect(await host.isArchived('s2')).toBe(false)
  })

  it('detach / attach 走 registry.get(workspaceId) 实体上的方法（顶层没有这两个方法）', async () => {
    const { ctx, calls } = makeEnv({ workspaces: [{ id: 'ws-1', sessionIds: ['s1'] }] })
    const host = createHostPort(ctx)
    await host.detach('s1', 'ws-1')
    await host.attach('s1', 'ws-1')
    expect(calls).toEqual(['registry.get(ws-1)', 'detachSession(ws-1,s1)', 'registry.get(ws-1)', 'attachSession(ws-1,s1)'])
  })

  it('detach / attach 遇到未知工作区**响亮失败**，不静默当成功', async () => {
    const { ctx } = makeEnv()
    const host = createHostPort(ctx)
    await expect(host.detach('s1', 'gone')).rejects.toThrow(/workspace/)
    await expect(host.attach('s1', 'gone')).rejects.toThrow(/workspace/)
  })

  // 这是本仓走宿主**内部入口**的两处之一（另一处是 `announceRemoved` 发的转发事件）——
  // `dsh-session` 的 SessionStore：会话列表 = 持久化 ∪ 活体，
  // 搬文件摘不掉活体，只有 `liveEntryFor(session).detach()` 这一条路（宿主 owner 自己用的那条）。
  // 判据是三态：`evicted`/`not-live` = 宿主列表已经不含它（可以据此如实通告客户端）；
  // `unknown` = 读不到或摘不掉 ⇒ **不通告**（发了就是假话，重连后那一行会自己长回来）。
  it('evictLive：经 ctx.get(\'sessions\') 拿 live store，liveEntryFor(session).detach() 摘掉即 evicted', async () => {
    const detached: string[] = []
    const session = { id: 's1' }
    const store = {
      get: (id: string) => (id === 's1' ? session : undefined),
      liveEntryFor: (s: unknown) => ({ detach: () => { detached.push((s as { id: string }).id) } }),
    }
    const { ctx, calls } = makeEnv({ sessions: store })
    expect(await createHostPort(ctx).evictLive('s1')).toBe('evicted')
    expect(detached).toEqual(['s1'])
    expect(calls).toContain('get(sessions)')
  })

  it('evictLive：内存里本来就没有 ⇒ not-live；服务缺席/形状不符/detach 抛 ⇒ unknown，绝不抛', async () => {
    const gone = { get: () => undefined, liveEntryFor: () => ({ detach: () => {} }) }
    expect(await createHostPort(makeEnv({ sessions: gone }).ctx).evictLive('s1')).toBe('not-live')

    expect(await createHostPort(makeEnv().ctx).evictLive('s1')).toBe('unknown')

    // 旧版宿主没有 liveEntryFor（只按方法面判，不看 constructor.name）
    const shape = { get: () => ({ id: 's1' }) }
    expect(await createHostPort(makeEnv({ sessions: shape }).ctx).evictLive('s1')).toBe('unknown')

    // 摘过之后 owner 再走 flush 时宿主内部抛的就是这一句
    const throwing = {
      get: () => ({ id: 's1' }),
      liveEntryFor: () => { throw new Error('session "s1" is not live in this store') },
    }
    expect(await createHostPort(makeEnv({ sessions: throwing }).ctx).evictLive('s1')).toBe('unknown')
  })

  // 通告走宿主**自己声明的转发事件**（`dsh-api-remotes` 的 API_REMOTE_FORWARDED_EVENTS 里有
  // `api-session/removed` / `api-session/added`，mode 都是 emit）：转发器就是 `ctx.on(event, ...)` 的普通监听者，
  // 而 cordis 的 `dispatch` 只在 emit 带了 carrier（首参是对象/函数）时才过 filter
  //（asar `@deepseek-ai/cordis/lib/index.js`：`const filter = thisArg?.[Context.filter]`）⇒
  // 我们不带 carrier 地 emit 会被全量派发，客户端 `$on("api-session/removed")` 那一侧因此收到并删行。
  it('announceRemoved：如实发一条 api-session/removed（不带 carrier ⇒ 全量派发）', async () => {
    const events: Array<[string, unknown[]]> = []
    const { ctx } = makeEnv({ emit: (name: string, ...args: unknown[]) => { events.push([name, args]) } })
    await createHostPort(ctx).announceRemoved('s1')
    expect(events).toEqual([['api-session/removed', ['s1']]])
  })

  it('announceRestored：摘要取自宿主自己的会话列表（数组或 {items} 两种形状），发 api-session/added', async () => {
    const summary = { sessionId: 's1', updatedAt: 1, blank: false }
    for (const list of [async () => [summary], async () => ({ items: [summary] })]) {
      const events: Array<[string, unknown[]]> = []
      const { ctx } = makeEnv({
        emit: (name: string, ...args: unknown[]) => { events.push([name, args]) },
        sessionController: { list },
      })
      await createHostPort(ctx).announceRestored('s1')
      expect(events).toEqual([['api-session/added', [summary]]])
    }
  })

  it('announceRestored：列表里没有它 / 控制器缺席 / 抛错 —— 一条都不发，也不抛', async () => {
    const events: Array<[string, unknown[]]> = []
    const emit = (name: string, ...args: unknown[]) => { events.push([name, args]) }

    const missing = makeEnv({ emit, sessionController: { list: async () => [] } })
    await createHostPort(missing.ctx).announceRestored('s1')

    const absent = makeEnv({ emit })
    await createHostPort(absent.ctx).announceRestored('s1')

    const boom = makeEnv({ emit, sessionController: { list: async () => { throw new Error('list boom') } } })
    await createHostPort(boom.ctx).announceRestored('s1')

    expect(events).toEqual([])
  })

  it('archive / unarchive 走 registry 的全局归档面（archive 不传 stopActivity）', async () => {
    const { ctx, calls } = makeEnv()
    const host = createHostPort(ctx)
    await host.archive('s1', 'ws-1')
    await host.unarchive('s1')
    expect(calls).toEqual(['registry.archiveSession(s1)', 'registry.unarchiveSession(s1)'])
  })

  it('titleOf 取投影缓存 title 行的**视图值**（string）；null/缺失/没挂缓存/抛错一律空串', async () => {
    const view = (values: Record<string, unknown>) => ({
      cachedSnapshot: () => ({ values }),
      cachedPredecessorTitle: () => ({ values }),
    })
    const hit = makeEnv({ headers: { s1: { cwd: 'C:/p' } }, projectionCache: view({ title: '会话标题' }) })
    expect(await createHostPort(hit.ctx).titleOf('s1')).toBe('会话标题')

    const predecessor = makeEnv({
      headers: { s1: { cwd: 'C:/p' } },
      projectionCache: {
        cachedSnapshot: () => undefined,
        cachedPredecessorTitle: () => ({ values: { title: '上一代格式里的标题' } }),
      },
    })
    expect(await createHostPort(predecessor.ctx).titleOf('s1')).toBe('上一代格式里的标题')

    const nullTitle = makeEnv({ headers: { s1: { cwd: 'C:/p' } }, projectionCache: view({ title: null }) })
    expect(await createHostPort(nullTitle.ctx).titleOf('s1')).toBe('')

    const noCache = makeEnv({ headers: { s1: { cwd: 'C:/p' } } })
    expect(await createHostPort(noCache.ctx).titleOf('s1')).toBe('')

    const boom = makeEnv({ headers: { s1: { cwd: 'C:/p' } }, projectionCache: view({ title: 'x' }) })
    expect(await createHostPort({
      ...boom.ctx,
      workspaceRegistry: {
        ...boom.ctx.workspaceRegistry,
        readSessionHeader: async () => { throw new Error('storage fault') },
      },
    }).titleOf('s1')).toBe('')
  })
})

/* ------------------------------------------------------------------ *
 * 清单的 storage domain 绑定（createStorageManifest）
 * ------------------------------------------------------------------ */

function makeStorageEnv(seed: TrashEntry[] = []) {
  const rows = new Map(seed.map(e => [e.id, e]))
  const calls: string[] = []
  let closed = 0
  const unit = {
    table: (name: string) => { calls.push(`table(${name})`); return table },
    close: async () => { closed += 1 },
  }
  const table = {
    entries: () => [...rows.entries()][Symbol.iterator](),
    put: async (key: string, value: TrashEntry) => { rows.set(key, value) },
    delete: async (key: string) => rows.delete(key),
  }
  let spec: unknown
  let disposer: (() => unknown) | undefined
  const ctx = {
    storageDomain: {
      open: async (s: unknown) => { spec = s; calls.push('open()'); return unit },
    },
    effect: (fn: () => unknown) => {
      calls.push('effect()')
      const d = fn()
      if (typeof d === 'function') disposer = d as () => unknown
      return d
    },
  }
  return {
    ctx, calls, rows,
    dispose: async () => { await disposer?.() },
    get spec() { return spec as { name: string; version: number; layout?: string; invalidRecords?: string; tables: Record<string, { valueSchema: { parse(v: unknown): unknown } }> } },
    get closedCount() { return closed },
  }
}

describe('清单的 storage domain 绑定', () => {
  it('open 的 spec 是官方形状（defineDomain：name/version/tables + domainTable 的 valueSchema），名字过 UNIT_NAME_RE', async () => {
    const env = makeStorageEnv()
    await createStorageManifest(env.ctx as never).list()
    expect(env.calls).toContain('open()')
    expect(env.spec.name).toBe('xrn1997_session_delete_trash')
    expect(env.spec.name).toMatch(/^[a-z][a-z0-9_]*$/)
    expect(env.spec.version).toBe(1)
    expect(env.spec.layout).toBe('per-record')
    expect(env.spec.invalidRecords).toBe('backup-and-skip')
    expect(Object.keys(env.spec.tables)).toEqual(['entries'])
    expect(typeof env.spec.tables.entries.valueSchema.parse).toBe('function')
  })

  it('记录校验器认合法条目、拒残缺条目（域 open 时逐条 parse）', async () => {
    const env = makeStorageEnv()
    await createStorageManifest(env.ctx as never).list()
    const { parse } = env.spec.tables.entries.valueSchema
    expect(parse(entry('a'))).toMatchObject({ id: 'a' })
    expect(() => parse({ id: 'a' })).toThrow(/sessionId/)
    expect(() => parse(null)).toThrow(/plain object/)
    expect(() => parse(entry('a', { deletedAt: '1' as never }))).toThrow(/deletedAt/)
  })

  it('list/add/remove 折成 domain.table("entries") 的 entries/put/delete，key = 条目 id', async () => {
    const env = makeStorageEnv([entry('a', { deletedAt: 100 }), entry('b', { deletedAt: 200 })])
    const m = createStorageManifest(env.ctx as never)
    expect((await m.list()).map(e => e.id)).toEqual(['b', 'a']) // 最近的在前
    await m.add(entry('c', { deletedAt: 300 }))
    expect([...env.rows.keys()].sort()).toEqual(['a', 'b', 'c'])
    await m.remove('a')
    expect([...env.rows.keys()].sort()).toEqual(['b', 'c'])
    expect(env.calls.filter(c => c === 'table(entries)').length).toBeGreaterThan(0)
  })

  it('域句柄在插件卸载时被关掉（ctx.effect 的清理），且只开一次域', async () => {
    const env = makeStorageEnv()
    const m = createStorageManifest(env.ctx as never)
    await m.list()
    await m.list()
    expect(env.calls.filter(c => c === 'open()').length).toBe(1)
    expect(env.calls).toContain('effect()')
    await env.dispose()
    expect(env.closedCount).toBe(1)
  })
})
