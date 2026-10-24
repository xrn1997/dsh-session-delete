import { describe, expect, it, vi } from 'vitest'
import { createHostPort } from '../src/ports/host-port.js'
import { createHostStorageManifest } from '../src/trash/storage-manifest.js'
import { unescapeProjectKey } from '../src/shared/wire.js'
import { deleteSession } from '../src/verbs/delete-session.js'
import type { DeleteDeps } from '../src/deps.js'
import type { TrashEntry } from '../src/trash/entry.js'
import { trashEntry } from './support/world.js'

/**
 * 两个「接线用例」的共用夹具：**默认的窄镜像 ctx**、不是宿主模拟器。
 *
 * `createHostPort` / `createHostStorageManifest` 的真实绑定要起宿主才验得了（本轮不起宿主），
 * 这两组用例钉的是**接线形状**：
 *  - 宿主成员被调到（哪个服务、哪个方法、什么入参、什么顺序），
 *  - 纯算法（projectKey / 兜底 / 排序 / key 映射）的行为。
 * 夹具只声明被接线代码真正声明的东西（`host-port.ts` 的 `HostCtxLike`、`trash/storage-manifest.ts` 的 `StorageDomainCtxLike`），
 * 所以它不会替实现兜住一个不存在的宿主成员——写错的成员名会让用例红而不是被夹具喂绿。
 */

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
  /** `ctx.get('agents')` 的替身（捕获 `resume`/`create` 返回的 AgentHandle）。 */
  agents?: unknown
  /** `ctx.inject` 的替身：捕获延迟挂载的 agents 服务。 */
  inject?: (names: readonly string[], callback: (ctx: { get(name: string): unknown }) => void) => void
  /** `ctx.get('sessionController')` 的替身（通告"加回"时取摘要的那一处）。 */
  sessionController?: unknown
  /** `ctx.get('sessionQuery')` 的替身。`listSessions` 给无主子会话扫描；`filterSessions` 给闭包。
   *  `filterSessions` 可缺席：用例要钉「服务在场、方法不在」那一支的缺席（不是空表）。 */
  sessionQuery?: {
    listSessions?: () => Promise<Array<{ header?: { id?: string; cwd?: string; parentSession?: string; origin?: string } }>>
    filterSessions?: (filters: Array<{ kind: string; values: string[] }>) => Promise<Array<{ header: { id?: string; cwd?: string; parentSession?: string } }>>
  }
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
      if (name === 'agents') return over.agents
      if (name === 'sessionController') return over.sessionController
      if (name === 'sessionQuery') return over.sessionQuery
      return undefined
    },
    emit: (name: string, ...args: unknown[]) => {
      calls.push(`emit(${name})`)
      over.emit?.(name, ...args)
    },
    inject: over.inject,
  }
  return { ctx, calls }
}

describe('宿主服务层端口的接线', () => {
  it('十五个方法都返回 Promise，且没有一个还停在 not wired yet', async () => {
    const { ctx } = makeEnv({ workspaces: [{ id: 'ws-1', sessionIds: ['s1'] }], headers: { s1: { cwd: 'C:/p' } } })
    const host = createHostPort(ctx)
    const results = [
      host.workspaceOf('s1'), host.projectDirOf('s1'), host.titleOf('s1'),
      host.isLive('s1'), host.isArchived('s1'), host.unarchive('s1'),
      host.detach('s1', 'ws-1'), host.attach('s1', 'ws-1'), host.archive('s1', 'ws-1'),
      host.workspaceExists('ws-1'),
      // 后面这几个是收尾用的（摘活体 + 两条如实通告 + 清单的两个只读/取数面），契约都是"不抛"。
      // 一组会话的通告只走一条路：单条就是长度为 1 的批。
      host.evictLive('s1'), host.announceRemoved('s1'), host.announceRestored(['s1']),
      host.subagentMembersOf(['s1']), host.listSessions(),
    ]
    expect(results.length).toBe(15)
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
    expect(calls).toEqual(['get(agents)', 'registry.readSessionHeader(s9)'])
  })

  // 未知会话这条：宿主 `readSessionHeader(id)` 抛的是**裸 Error**（无类型、无码）。它是**未命中**，
  // 与 `workspaceOf` 同一口径回 `undefined`——否则 `delete-session.ts` 里
  // `if (!projectDir) throw verbError('not-found', …)` 的 `!projectDir` 永远是假。
  it('projectDirOf 对未知会话返回 undefined（裸抛的 miss 不算故障）', async () => {
    const { ctx } = makeEnv({ headers: { s1: { cwd: 'C:/p' } } })
    expect(await createHostPort(ctx).projectDirOf('ghost')).toBeUndefined()
  })

  describe('listSessions（无主子会话扫描的语料）', () => {
    it('把 header 折成 id/parent/projectDir/subagent；缺 id 的记录跳过', async () => {
      const { ctx } = makeEnv({
        sessionQuery: {
          listSessions: async () => [
            { header: { id: 'session-root', cwd: 'C:/p', origin: 'subagent', parentSession: 'session-gone' } },
            { header: { id: 'session-kid', cwd: 'C:/p', parentSession: 'session-root' } },
            { header: { cwd: 'C:/p' } },
          ],
          filterSessions: async () => [],
        },
      })
      expect(await createHostPort(ctx).listSessions()).toEqual({
        available: true,
        value: [
          { sessionId: 'session-root', parentSessionId: 'session-gone', projectDir: '--C-p--', subagent: true },
          { sessionId: 'session-kid', parentSessionId: 'session-root', projectDir: '--C-p--', subagent: false },
        ],
      })
    })

    it('sessionQuery 没挂 / 没有 listSessions ⇒ { available:false }，不冒充空语料', async () => {
      const { ctx } = makeEnv({})
      await expect(createHostPort(ctx).listSessions()).resolves.toEqual({ available: false })
      const withQuery = makeEnv({ sessionQuery: { filterSessions: async () => [] } })
      await expect(createHostPort(withQuery.ctx).listSessions()).resolves.toEqual({ available: false })
    })
  })

  // 盘上后代的两个调用点（删除带走的孩子 / 清单与 purge 的盘上残留）共用这一份读面：
  // 走官方 `sessionQuery.filterSessions` 的 `kind:'parent'` 一支（宿主判据逐字是
  // `filter.values.includes(record.header.parentSession ?? null)`），不自扫 `~/.dsh/sessions`。
  // 归堆必须**按去掉 `session-` 前缀后的 id** 算：本机实测父会话自己的 header id
  // 带前缀（`session-ac07f2bb-…`）、它的子会话写的 `parentSession` 也带前缀，而 v3 代的老 id 不带 ⇒ 两种写法是同一个父。
  describe('subagentMembersOf（批量点后代）', () => {
    it('一次 BFS 问多个父，按调用方给的写法交回成员；空清单零调用', async () => {
      const asked: string[][] = []
      const { ctx } = makeEnv({
        sessionQuery: {
          listSessions: async () => [],
          filterSessions: async (filters) => {
            const values = new Set(filters[0]?.values ?? [])
            asked.push([...values])
            return [
              { header: { id: 'session-k1', parentSession: 'session-a' } },
              { header: { id: 'k2', parentSession: 'b' } },
            ].filter((r) => values.has(r.header.parentSession))
          },
        },
      })
      const port = createHostPort(ctx)
      expect(await port.subagentMembersOf(['session-a', 'b'])).toEqual({
        available: true,
        value: {
          'session-a': [{ sessionId: 'session-k1', projectDir: '_no-cwd' }],
          b: [{ sessionId: 'k2', projectDir: '_no-cwd' }],
        },
      })
      expect(asked).toHaveLength(2) // 第一层 a/b，第二层 k1/k2 问空即停
      asked.length = 0
      expect(await port.subagentMembersOf([])).toEqual({ available: true, value: {} })
      expect(asked).toHaveLength(0)
    })

    it('调官方 filterSessions 的 kind:"parent"，两种前缀写法归到同一个父（清单的计数就是成员长度）', async () => {
      const seen: Array<Array<{ kind: string; values: string[] }>> = []
      const { ctx } = makeEnv({
        sessionQuery: {
          filterSessions: async (filters) => {
            seen.push(filters)
            // 每条都带 `header.id`——那是宿主记录本来就有的一件（闭包靠它去重与往下问，
            // 缺 id 的记录整条跳过，见下面那条用例）
            return [
              { header: { id: 'session-k1', parentSession: 'session-a' } },
              { header: { id: 'session-k2', parentSession: 'session-a' } },
              { header: { id: 'k3', parentSession: 'a' } },
              { header: { id: 'session-kz', parentSession: 'session-z' } }, // 没问它的父：不许混进结果
            ]
          },
        },
      })
      const read = await createHostPort(ctx).subagentMembersOf(['session-a', 'b'])
      // 只钉"问了什么"，不钉顺序：宿主那一支的判据是 `values.includes(...)`，顺序对它无意义
      expect(seen[0]).toEqual([{ kind: 'parent', values: ['session-a', 'a', 'session-b', 'b'].sort() }])
      expect(read.available).toBe(true)
      if (!read.available) throw new Error('sessionQuery 在场时不该缺席')
      expect(Object.fromEntries(Object.entries(read.value).map(([id, list]) => [id, list.length]))).toEqual({
        'session-a': 3,
        b: 0,
      })
    })

    it('sessionQuery 没挂（可选服务缺席）⇒ { available:false }，不拿空表冒充"没有后代"', async () => {
      const { ctx } = makeEnv({}) // get('sessionQuery') 回 undefined
      await expect(createHostPort(ctx).subagentMembersOf(['session-a'])).resolves.toEqual({ available: false })
    })

    it('sessionQuery 在场但 filterSessions 缺席（不是函数）⇒ { available:false }，同样不冒充"没有后代"', async () => {
      const { ctx } = makeEnv({ sessionQuery: { listSessions: async () => [] } })
      await expect(createHostPort(ctx).subagentMembersOf(['p'])).resolves.toEqual({ available: false })
    })

    it('入参为空 ⇒ { available:true, value:{} }，一次宿主调用都不发（别为一张空清单去扫全库）', async () => {
      let called = 0
      const { ctx } = makeEnv({
        sessionQuery: {
          filterSessions: async () => { called++; return [] },
        },
      })
      await expect(createHostPort(ctx).subagentMembersOf([])).resolves.toEqual({ available: true, value: {} })
      expect(called).toBe(0)
    })
  })

  // 删除要带走整个组，先得知道**后代是谁、目录在哪**。身份与 cwd 都取宿主自己的记录（官方 `filterSessions`
  // 的 `kind:'parent'` 那一支交回的是带 `header` 的记录克隆，而那一支只会交出**带 `parentSession`** 的记录），
  // 项目目录用我们**已在端口里逐字镜像**的 `projectKey` 从 cwd 反推（与 `projectDirOf` 同一根算法，不另起一套）。
  describe('subagentMembersOf（删除时把盘上的孩子点出来）', () => {
    it('交回每个孩子的 sessionId 与项目目录（cwd 走同一个 projectKey 算法）', async () => {
      const { ctx } = makeEnv({
        sessionQuery: {
          filterSessions: async () => [
            { header: { id: 'session-child1', parentSession: 'session-parent', cwd: 'C:/develop/p' } },
            { header: { id: 'session-child2', parentSession: 'session-parent', cwd: 'C:\\develop\\p' } },
          ],
        },
      })
      expect(await createHostPort(ctx).subagentMembersOf(['session-parent'])).toEqual({
        available: true,
        value: {
          'session-parent': [
            { sessionId: 'session-child1', projectDir: '--C-develop-p--' },
            { sessionId: 'session-child2', projectDir: '--C-develop-p--' },
          ],
        },
      })
    })

    it('问的是这个父：values 带上它两种写法；parent 自己不混进来（宿主按 header.parentSession 判）', async () => {
      const seen: unknown[] = []
      const { ctx } = makeEnv({
        sessionQuery: {
          filterSessions: async (filters) => { seen.push(filters); return [] },
        },
      })
      await createHostPort(ctx).subagentMembersOf(['bare-parent'])
      expect(seen[0]).toEqual([{ kind: 'parent', values: ['bare-parent', 'session-bare-parent'].sort() }])
    })

    it('header 缺 id ⇒ 这个孩子点不出来，跳过它（不拿目录名冒充身份）；缺 cwd 走 _no-cwd', async () => {
      const { ctx } = makeEnv({
        sessionQuery: {
          filterSessions: async () => [
            { header: { parentSession: 'p', cwd: 'C:/x' } },
            { header: { id: 'session-kid', parentSession: 'p', createdAt: 1 } },
          ],
        },
      })
      expect(await createHostPort(ctx).subagentMembersOf(['p'])).toEqual({
        available: true,
        value: { p: [{ sessionId: 'session-kid', projectDir: '_no-cwd' }] },
      })
    })

    it('sessionQuery 没挂 ⇒ { available:false }（删除侧据此只删父，不因此失败）', async () => {
      const { ctx } = makeEnv({})
      await expect(createHostPort(ctx).subagentMembersOf(['p'])).resolves.toEqual({ available: false })
    })
  })

  // 级联的那个「组」是**全部后代**，不是"直接孩子"（issue #1）：宿主客户端对所有 `origin:"subagent"`
  // 一律藏行 ⇒ 深度 ≥2 上"删了父还剩多少本来看不见"原样存在。往下问只有一条路：`kind:'parent'`
  // 一次问一层——官方的 `traceSession` 在父已经进回收站时认不出目标（`SESSION_QUERY_SESSION_NOT_FOUND`）。
  describe('subagentMembersOf 走传递闭包', () => {
    /** 按 `values` 作答的替身：宿主那一支的判据逐字是 `values.includes(record.header.parentSession ?? null)`。 */
    function closing(
      records: Array<{ id: string; parentSession?: string; cwd?: string }>,
      asked: string[][],
    ) {
      return {
        filterSessions: async (filters: Array<{ kind: string; values: string[] }>) => {
          const values = new Set(filters[0]?.values ?? [])
          asked.push([...values])
          return records
            .filter(r => typeof r.parentSession === 'string' && values.has(r.parentSession))
            .map(r => ({ header: r }))
        },
      }
    }

    it('孩子与孙代都算进同一个数，且真的往下问到问空为止', async () => {
      const asked: string[][] = []
      const { ctx } = makeEnv({ sessionQuery: closing([
        { id: 'session-kid', parentSession: 'session-root', cwd: 'C:/p' },
        { id: 'session-grandkid', parentSession: 'session-kid', cwd: 'C:/p' },
        { id: 'session-greatkid', parentSession: 'session-grandkid', cwd: 'C:/p' },
      ], asked) })
      const read = await createHostPort(ctx).subagentMembersOf(['session-root'])
      expect(read.available).toBe(true)
      if (!read.available) throw new Error('sessionQuery 在场时不该缺席')
      expect(read.value['session-root']).toHaveLength(3)
      expect(asked.length).toBe(4) // 根 / kid / grandkid / greatkid 各问一层，第五层没有记录就停
      expect(asked[1]).toEqual(expect.arrayContaining(['kid', 'session-kid']))
    })

    it('subagentMembersOf 交回全部后代 ⇒ 删父时孙代也一起搬进回收站', async () => {
      const asked: string[][] = []
      const { ctx } = makeEnv({ sessionQuery: closing([
        { id: 'session-kid', parentSession: 'session-root', cwd: 'C:/p' },
        { id: 'session-grandkid', parentSession: 'session-kid', cwd: 'C:/p' },
        { id: 'session-greatkid', parentSession: 'session-grandkid', cwd: 'C:/p' },
      ], asked) })
      expect(await createHostPort(ctx).subagentMembersOf(['session-root'])).toEqual({
        available: true,
        value: {
          'session-root': [
            { sessionId: 'session-kid', projectDir: '--C-p--' },
            { sessionId: 'session-grandkid', projectDir: '--C-p--' },
            { sessionId: 'session-greatkid', projectDir: '--C-p--' },
          ],
        },
      })
    })

    // 行数与宿主调用次数**脱钩**：一层一次，而不是每行各扫一遍库（清单可以有几百行）。
    it('多个父合在一起问 ⇒ 层数决定调用次数，与行数无关', async () => {
      const asked: string[][] = []
      const { ctx } = makeEnv({ sessionQuery: closing([
        { id: 'session-kid1', parentSession: 'session-p1' },
        { id: 'session-kid2', parentSession: 'session-p2' },
        { id: 'session-grand', parentSession: 'session-kid1' },
      ], asked) })
      const read = await createHostPort(ctx).subagentMembersOf(['session-p1', 'session-p2'])
      expect(read.available).toBe(true)
      if (!read.available) throw new Error('sessionQuery 在场时不该缺席')
      expect({
        'session-p1': read.value['session-p1']?.length,
        'session-p2': read.value['session-p2']?.length,
      }).toEqual({ 'session-p1': 2, 'session-p2': 1 })
      expect(asked.length).toBe(3) // 最深那支三层 ⇒ 三次，两行也一样
    })

    // 环本来不该出现（`parentSession` 是一条有向边），出现时（手工改过日志 / 宿主 bug）代价必须是
    // "少数一条"，而不是把清单读挂死。
    it('记录里有环 ⇒ 每个后代只数一次，且不会无限往下问', async () => {
      const asked: string[][] = []
      const { ctx } = makeEnv({ sessionQuery: closing([
        { id: 'session-a', parentSession: 'session-root' },
        { id: 'session-root', parentSession: 'session-a' },
        { id: 'session-b', parentSession: 'session-a' },
      ], asked) })
      const read = await createHostPort(ctx).subagentMembersOf(['session-root'])
      expect(read.available).toBe(true)
      if (!read.available) throw new Error('sessionQuery 在场时不该缺席')
      expect(read.value['session-root']).toHaveLength(2)
      expect(asked.length).toBe(3)
    })
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
  // 客户端拿到的是 `sessiondelete/io`；现在必须是 `sessiondelete/not-found`（src/shared/wire.ts）。
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
      // 删除路径上不该有清册读：四个面一起设伏（`raw` 也在内——它是 pure 读面的事，删除动词不该碰）。
      // 将来谁在删除路径上顺手读清册，这条用例会当场红（局部 fs 与这条不完整 ledger 靠下面的强转通过类型）。
      ledger: {
        list: forbidden('ledger.list'),
        raw: forbidden('ledger.raw'),
        add: forbidden('ledger.add'),
        remove: forbidden('ledger.remove'),
      },
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
    expect(calls).toEqual(['get(agents)', 'registry.get(ws-1)', 'detachSession(ws-1,s1)', 'registry.get(ws-1)', 'attachSession(ws-1,s1)'])
  })

  it('detach / attach 遇到未知工作区**响亮失败**，不静默当成功', async () => {
    const { ctx } = makeEnv()
    const host = createHostPort(ctx)
    await expect(host.detach('s1', 'gone')).rejects.toThrow(/workspace/)
    await expect(host.attach('s1', 'gone')).rejects.toThrow(/workspace/)
  })

  // 恢复拿它判"记下的工作区还在不在"：宿主的「删除工作区」只删注册、保留目录与日志 ⇒
  // 回收站里的老条目可能指着一个已经不存在的工作区。这个判据**不抛**（registry.get 是同步 Map 查找），
  // 才好在写任何字节之前问一遍。
  it('workspaceExists 走 registry.get：在 ⇒ true，不在 ⇒ false，不抛', async () => {
    const { ctx, calls } = makeEnv({ workspaces: [{ id: 'ws-1', sessionIds: ['s1'] }] })
    const host = createHostPort(ctx)
    expect(await host.workspaceExists('ws-1')).toBe(true)
    expect(await host.workspaceExists('gone')).toBe(false)
    expect(calls).toEqual(['get(agents)', 'registry.get(ws-1)', 'registry.get(gone)'])
  })

  // 这是本仓走宿主**内部入口**的几处之一（另见 captureAgentHandles 与 `announceRemoved` 的转发事件）——
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

  // `SessionController` 把 `agents.resume/create` 返回的 AgentHandle 丢掉；本端口在服务实例上包一层，
  // 按会话 id 留住 handle，删除时调用它的 dispose（宿主自己的外层 teardown：关写句柄、摘 agent/session）。
  // 没有这一步，恢复后旧 agent 会拦住 prompt（真机事故 2026-10-21）。
  it('evictLive：捕获 agents.resume 返回的 AgentHandle，连 agent 一起 dispose', async () => {
    const detached: string[] = []
    const disposed: string[] = []
    const handle = { agent: { id: 's1' }, dispose: async () => { disposed.push('s1') } }
    const agents = { resume: async () => handle, create: async () => handle }
    const session = { id: 's1' }
    const sessions = {
      get: (id: string) => (id === 's1' ? session : undefined),
      liveEntryFor: () => ({ detach: () => { detached.push('s1') } }),
    }
    const { ctx } = makeEnv({ agents, sessions })
    const port = createHostPort(ctx)
    await agents.resume()
    expect(await port.evictLive('s1')).toBe('evicted')
    expect(detached).toEqual(['s1'])
    expect(disposed).toEqual(['s1'])
  })

  // 真机事故（2026-10-21）：cordis 的 traceable 服务代理每次读函数都会新包一层（`createShadowMethod`），
  // 所以 `service[name] !== wrapped` 是**必然**的假警报。旧安装器在这里抛，循环还没走到 `create`
  // ⇒ 新建会话的 handle 一个都没捕获；恢复后旧 agent 留在 `ctx.agents` 里，`resolve()` 直接命中它。
  // 这条用例用同一个"读函数返回新代理"的形状钉住：resume 与 create 都必须真正装上。
  it('evictLive：traceable 代理读回不等于写入函数时，resume/create 仍各自装上并捕获', async () => {
    const detached: string[] = []
    const disposed: string[] = []
    const events: string[] = []
    const resumeHandle = { agent: { id: 's1' }, dispose: async () => { disposed.push('s1'); events.push('dispose:s1') } }
    const createHandle = { agent: { id: 's2' }, dispose: async () => { disposed.push('s2'); events.push('dispose:s2') } }
    const writes: string[] = []
    const raw = {
      resume: async () => resumeHandle,
      create: async () => createHandle,
    }
    const traced = new Proxy(raw, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        // 只模拟 cordis 对函数的那一层：读回永远是一个新代理，但调用仍落到原函数/后装 wrapper。
        return typeof value === 'function'
          ? new Proxy(value, { apply: (fn, thisArg, args) => Reflect.apply(fn, thisArg, args) })
          : value
      },
      set(target, prop, value, receiver) {
        writes.push(String(prop))
        return Reflect.set(target, prop, value, receiver)
      },
    })
    const sessions = {
      get: (id: string) => ({ id }),
      liveEntryFor: (session: unknown) => ({
        detach: () => {
          const id = (session as { id: string }).id
          detached.push(id)
          events.push(`detach:${id}`)
        },
      }),
    }
    const { ctx } = makeEnv({ agents: traced, sessions })
    const port = createHostPort(ctx)
    // 第二次安装（get 与 inject 各一次）必须看见第一次留下的 symbol 标记，不能再套一层；
    // 而且第二个端口的 evictLive 必须用**第一层 wrapper 写的同一张表**（返回空表 = handle 捕捉不到）。
    const secondPort = createHostPort(ctx)

    await traced.resume()
    await traced.create()
    expect(await port.evictLive('s1')).toBe('evicted')
    expect(await secondPort.evictLive('s2')).toBe('evicted')
    expect(detached.sort()).toEqual(['s1', 's2'])
    expect(disposed.sort()).toEqual(['s1', 's2'])
    // 先摘 session、再 dispose agent（ADR-0008 的承重顺序）
    expect(events).toEqual(['detach:s1', 'dispose:s1', 'detach:s2', 'dispose:s2'])
    expect(writes.filter(name => name === 'resume')).toHaveLength(1)
    expect(writes.filter(name => name === 'create')).toHaveLength(1)
  })

  // live profile 的插件激活顺序可能早于 agents 服务就绪：createHostPort 不能在 apply 时只 get 一次就放弃。
  it('evictLive：agents 服务晚于端口创建挂载时，走 ctx.inject 补装 handle 捕获', async () => {
    const detached: string[] = []
    const disposed: string[] = []
    const handle = { agent: { id: 's1' }, dispose: async () => { disposed.push('s1') } }
    const service = { resume: async () => handle, create: async () => handle }
    const sessions = {
      get: (id: string) => (id === 's1' ? { id: 's1' } : undefined),
      liveEntryFor: () => ({ detach: () => { detached.push('s1') } }),
    }
    let late: ((ctx: { get(name: string): unknown }) => void) | undefined
    const { ctx } = makeEnv({ agents: undefined, sessions, inject: (_names, callback) => { late = callback } })
    const port = createHostPort(ctx)
    expect(late).toBeDefined()
    late!({ get: (name) => (name === 'agents' ? service : undefined) })
    await service.resume()
    expect(await port.evictLive('s1')).toBe('evicted')
    expect(detached).toEqual(['s1'])
    expect(disposed).toEqual(['s1'])
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
      await createHostPort(ctx).announceRestored(['s1'])
      expect(events).toEqual([['api-session/added', [summary]]])
    }
  })

  it('announceRestored：列表里没有它 / 控制器缺席 / 抛错 —— 一条都不发，也不抛', async () => {
    const events: Array<[string, unknown[]]> = []
    const emit = (name: string, ...args: unknown[]) => { events.push([name, args]) }

    const missing = makeEnv({ emit, sessionController: { list: async () => [] } })
    await createHostPort(missing.ctx).announceRestored(['s1'])

    const absent = makeEnv({ emit })
    await createHostPort(absent.ctx).announceRestored(['s1'])

    const boom = makeEnv({ emit, sessionController: { list: async () => { throw new Error('list boom') } } })
    await createHostPort(boom.ctx).announceRestored(['s1'])

    expect(events).toEqual([])
  })

  it('announceRestored：一组 id 只拉一次会话表，按 id 逐条发 added', async () => {
    const events: Array<[string, unknown[]]> = []
    const list = vi.fn(async () => [
      { sessionId: 's1', updatedAt: 1 },
      { sessionId: 's2', updatedAt: 2 },
      { sessionId: 'other', updatedAt: 3 },
    ])
    const { ctx } = makeEnv({
      emit: (name, ...args) => { events.push([name, args]) },
      sessionController: { list },
    })
    await createHostPort(ctx).announceRestored(['s1', 's2', 'missing'])
    expect(list).toHaveBeenCalledTimes(1)
    expect(events).toEqual([
      ['api-session/added', [{ sessionId: 's1', updatedAt: 1 }]],
      ['api-session/added', [{ sessionId: 's2', updatedAt: 2 }]],
    ])
  })

  it('archive / unarchive 走 registry 的全局归档面（archive 不传 stopActivity）', async () => {
    const { ctx, calls } = makeEnv()
    const host = createHostPort(ctx)
    await host.archive('s1', 'ws-1')
    await host.unarchive('s1')
    expect(calls).toEqual(['get(agents)', 'registry.archiveSession(s1)', 'registry.unarchiveSession(s1)'])
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
 * 清单的 storage domain 绑定（createHostStorageManifest）
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
  let setup: (() => unknown) | undefined
  const ctx: {
    storageDomain: { open: (spec: unknown) => Promise<unknown> }
    effect: (fn: () => unknown, label?: string) => unknown
  } = {
    storageDomain: {
      open: async (s: unknown) => { spec = s; calls.push('open()'); return unit },
    },
    effect: (fn: () => unknown) => {
      calls.push('effect()')
      setup = fn
      return undefined
    },
  }
  return {
    ctx, calls, rows,
    /** 真 cordis 的语义：`effect(fn)` 当场跑 `fn()` 拿到 disposer，**卸载时**才跑 disposer 并等它的落地。
     *  这里把 disposer 的 promise **原样交回**（不 await），调用方才量得到"它到底等的是谁的落地"。 */
    dispose: () => (setup?.() as (() => Promise<unknown>) | undefined)?.(),
    get spec() { return spec as { name: string; version: number; layout?: string; invalidRecords?: string; tables: Record<string, { valueSchema: { parse(v: unknown): unknown } }> } },
    get closedCount() { return closed },
  }
}

describe('清单的 storage domain 绑定', () => {
  it('open 的 spec 是官方形状（defineDomain：name/version/tables + domainTable 的 valueSchema），名字过 UNIT_NAME_RE', async () => {
    const env = makeStorageEnv()
    await createHostStorageManifest(env.ctx as never).list()
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
    await createHostStorageManifest(env.ctx as never).list()
    const { parse } = env.spec.tables.entries.valueSchema
    expect(parse(trashEntry('a'))).toMatchObject({ id: 'a' })
    expect(() => parse({ id: 'a' })).toThrow(/sessionId/)
    expect(() => parse(null)).toThrow(/plain object/)
    expect(() => parse(trashEntry('a', { deletedAt: '1' as never }))).toThrow(/deletedAt/)
  })

  it('list/add/remove 折成 domain.table("entries") 的 entries/put/delete，key = 条目 id', async () => {
    const env = makeStorageEnv([trashEntry('a', { deletedAt: 100 }), trashEntry('b', { deletedAt: 200 })])
    const m = createHostStorageManifest(env.ctx as never)
    expect((await m.list()).map(e => e.id)).toEqual(['b', 'a']) // 最近的在前
    await m.add(trashEntry('c', { deletedAt: 300 }))
    expect([...env.rows.keys()].sort()).toEqual(['a', 'b', 'c'])
    await m.remove('a')
    expect([...env.rows.keys()].sort()).toEqual(['b', 'c'])
    expect(env.calls.filter(c => c === 'table(entries)').length).toBeGreaterThan(0)
  })

  it('域句柄在插件卸载时被关掉（ctx.effect 的清理），且只开一次域', async () => {
    const env = makeStorageEnv()
    const m = createHostStorageManifest(env.ctx as never)
    await m.list()
    await m.list()
    expect(env.calls.filter(c => c === 'open()').length).toBe(1)
    expect(env.calls).toContain('effect()')
    await env.dispose()
    expect(env.closedCount).toBe(1)
  })

  // 打开失败**不许缓存成永久 rejected**：storage 域被别的持有者占着是瞬态（重启、卸载竞态），
  // 缓存住第一次的拒绝就等于"这个会话永远删不掉"，而它其实下一次 `open()` 就能成。
  it('open 失败不缓存 rejected promise：下一次读会重开一次，成功后照常', async () => {
    const env = makeStorageEnv()
    const open = env.ctx.storageDomain.open
    let attempts = 0
    env.ctx.storageDomain.open = async (s: unknown) => {
      attempts += 1
      if (attempts === 1) throw new Error('domain already open')
      return open(s)
    }
    const m = createHostStorageManifest(env.ctx as never)
    await expect(m.list()).rejects.toThrow(/already open/)
    expect(await m.list()).toEqual([]) // 第二次重新走 open()，拿到的就是活的句柄
    expect(attempts).toBe(2)
  })

  // 卸载时那条拒绝**不许从 disposer 里冒出来**：句柄没开成就没有东西要关，disposer 安静落地即可
  // （框架那边正等它的 promise，抛出去只会变成卸载期的一条 unhandled）。
  it('open 失败后立刻卸载：disposer 不等那条拒绝，安静落地', async () => {
    const env = makeStorageEnv()
    env.ctx.storageDomain.open = async () => { throw new Error('domain already open') }
    const m = createHostStorageManifest(env.ctx as never)
    await expect(m.list()).rejects.toThrow(/already open/)
    await expect(env.dispose()).resolves.toBeUndefined()
    expect(env.closedCount).toBe(0)
  })

  // disposer 把 `close()` 的 promise 交回框架（官方 `ctx.effect` 会等 disposer 的落地）——
  // `void` 走掉意味着卸载时句柄可能还没关，下一份同名域就会撞 `already-open` 闸。
  it('卸载的 disposer 返回 close() 的 promise，而不是走空', async () => {
    const env = makeStorageEnv()
    let closeStarted = false
    let finishClose!: () => void
    env.ctx.storageDomain.open = async () => ({
      table: () => ({ entries: () => [][Symbol.iterator](), put: async () => {}, delete: async () => false }),
      close: () => { closeStarted = true; return new Promise<void>((r) => { finishClose = r }) },
    })
    const m = createHostStorageManifest(env.ctx as never)
    await m.list()
    const disposed: unknown = env.dispose() // 不 await：等的正是这条还没落地的 promise
    expect(closeStarted).toBe(true)
    expect(disposed).toBeInstanceOf(Promise)
    finishClose()
    await disposed
  })
})
