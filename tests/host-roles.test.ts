import { describe, expect, it, vi } from 'vitest'
import { createHostPort } from '../src/ports/host-port.js'
import type {
  CorpusRead,
  HostCorePort,
  HostCorpusPort,
  HostIdentityPort,
  HostPort,
  HostPresencePort,
  HostProjectionPort,
  HostProjectionReadPort,
  HostProjectionWritePort,
  HostRemovalPort,
  SessionIdentity,
} from '../src/ports/host-port.js'

/**
 * 角色接口的**形状用例**：`HostPort` 拆成 identity / presence / corpus / projection 四个角色，
 * 复合别名是四者的交集；`HostCorePort` 只拿投影缓存读面，`HostRemovalPort` 才拿删除面。
 *
 * 三条要求都是**编译期 + 运行期各钉一半**：
 *  - `createHostPort` 的返回对象可赋给每个角色（类型检查由 `pnpm typecheck` 跑，运行期是同一颗对象）；
 *  - 每个角色接口的键集合**恰好**是下面那几张表（`ExactKeys` 让"多一个/少一个"都编译不过）；
 *  - adapter 的 24 个方法 == 四张角色表的并集；核心/删除面是角色表上的再收窄。
 *
 * 另有一组**行为**用例：`subagentMembersOf` 的缺席 / 在场 / 空入参（`CorpusRead` 的判别）、
 * 投影缓存键集与删除面的缺席/部分失败。两个语料读面的完整行为仍逐条钉在 `tests/assembly.test.ts`。
 */

/** 编译期精确断言：`T` 的键集合恰好是 `K`。任一处不成立，`true satisfies …` 就编译不过。 */
type ExactKeys<T, K extends PropertyKey> =
  [Exclude<keyof T, K>] extends [never]
    ? [K] extends [keyof T] ? true : false
    : false

/** 编译期类型相等（双向 `extends` 的经典写法）：`A` 与 `B` 是同一个类型才为 `true`。 */
type Equal<A, B> =
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- 经典编译期相等判据：`T` 只出现一次正是这条写法的要求。
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

/**
 * 角色的键集合：语料读面都把"这一趟看不见语料"写成显式的 `CorpusRead`。
 */
const IDENTITY_KEYS = [
  'workspaceOf', 'workspaceExists', 'projectDirOf', 'titleOf', 'labelOf', 'isLive', 'isArchived',
  'archivedSessionIds', 'archive', 'unarchive', 'attach', 'detach',
] as const
const PRESENCE_KEYS = ['evictLive', 'announceRemoved', 'announceRestored'] as const
const CORPUS_KEYS = ['listSessions', 'subagentMembersOf', 'titleSnapshots', 'sessionActivity', 'persistedSizes', 'persistenceMounted', 'readSession'] as const
const PROJECTION_READ_KEYS = ['projectionCacheIds'] as const
const PROJECTION_WRITE_KEYS = ['dropProjectionCache'] as const
const PROJECTION_KEYS = [...PROJECTION_READ_KEYS, ...PROJECTION_WRITE_KEYS] as const

const ROLE_KEYS = {
  identity: {
    keys: IDENTITY_KEYS,
    exact: true satisfies ExactKeys<HostIdentityPort, (typeof IDENTITY_KEYS)[number]>,
  },
  presence: {
    keys: PRESENCE_KEYS,
    exact: true satisfies ExactKeys<HostPresencePort, (typeof PRESENCE_KEYS)[number]>,
  },
  corpus: {
    keys: CORPUS_KEYS,
    exact: true satisfies ExactKeys<HostCorpusPort, (typeof CORPUS_KEYS)[number]>,
  },
  projection: {
    keys: PROJECTION_KEYS,
    exact: true satisfies ExactKeys<HostProjectionPort, (typeof PROJECTION_KEYS)[number]>,
  },
  projectionRead: {
    keys: PROJECTION_READ_KEYS,
    exact: true satisfies ExactKeys<HostProjectionReadPort, (typeof PROJECTION_READ_KEYS)[number]>,
  },
  projectionWrite: {
    keys: PROJECTION_WRITE_KEYS,
    exact: true satisfies ExactKeys<HostProjectionWritePort, (typeof PROJECTION_WRITE_KEYS)[number]>,
  },
} as const

const COMPOSITE_KEYS = [...IDENTITY_KEYS, ...PRESENCE_KEYS, ...CORPUS_KEYS, ...PROJECTION_KEYS] as const
const COMPOSITE_EXACT = true satisfies ExactKeys<HostPort, (typeof COMPOSITE_KEYS)[number]>

/** 核心面 = 身份 + 语料 + 投影缓存**读**面；删除面只在 `HostRemovalPort`。 */
const CORE_KEYS = [...IDENTITY_KEYS, ...CORPUS_KEYS, ...PROJECTION_READ_KEYS] as const
const CORE_EXACT = true satisfies ExactKeys<HostCorePort, (typeof CORE_KEYS)[number]>
const REMOVAL_KEYS = [...CORE_KEYS, ...PROJECTION_WRITE_KEYS] as const
const REMOVAL_EXACT = true satisfies ExactKeys<HostRemovalPort, (typeof REMOVAL_KEYS)[number]>

/**
 * `listSessions` 的返回类型**恰好**是 `CorpusRead<readonly SessionIdentity[]>`：`undefined`
 * （旧契约）或「`CorpusRead` 再并上 `undefined`」都会让这行编译不过。
 */
const LIST_SESSIONS_READ = true satisfies Equal<
  Awaited<ReturnType<HostCorpusPort['listSessions']>>,
  CorpusRead<readonly SessionIdentity[]>
>

/**
 * `archive` **恰好一个参数**：归档是 registry 全局的、与工作区账目无关（为什么住
 * `src/ports/host-port.ts` 的成员注释），实现从不读第二参数 ⇒ interface 不许再暗示按工作区作用域。
 * 带可选第二参时 `Parameters[…]` 算出 `[string, string?]`、`['length']` 是 `1 | 2`，这行编译不过。
 */
const ARCHIVE_ARITY = true satisfies Equal<Parameters<HostIdentityPort['archive']>['length'], 1>

/**
 * 宿主 ctx 的最小替身：`createHostPort` 构造期只读 `workspaceRegistry`，`get` / `waterfall` / `emit`
 * 是各方法运行期才碰的。形状用例不调任何方法；行为用例只走 `get('…')` 这一条
 * （不复制 `assembly.test.ts` 的整套 `makeEnv`——那份钉的是两个语料读面的完整行为）。
 */
function makeCtx(options: {
  readonly sessionQuery?: unknown
  readonly projectionCache?: unknown
  readonly storageDomain?: unknown
  readonly sessionController?: unknown
  readonly sessionPersistence?: unknown
  readonly archived?: readonly string[]
} = {}): unknown {
  const services: Record<string, unknown> = {
    sessionQuery: options.sessionQuery,
    sessionProjectionCache: options.projectionCache,
    storageDomain: options.storageDomain,
    sessionController: options.sessionController,
    sessionPersistence: options.sessionPersistence,
  }
  return {
    workspaceRegistry: {
      list: () => [],
      get: () => undefined,
      archivedSessionIds: options.archived ?? [],
      unarchiveSession: async () => {},
      archiveSession: async () => {},
    },
    waterfall: async (_name: string, _args: object, next: () => Promise<readonly unknown[]>) => next(),
    get: (name: string) => services[name],
    emit: () => {},
  }
}

/** `sessionQuery.filterSessions` 的替身：按 `values` 作答（宿主那一支的判据是
 *  `values.includes(record.header.parentSession ?? null)`），并记下每次问了哪些写法。 */
function closingQuery(
  records: readonly { readonly id: string; readonly parentSession: string; readonly cwd?: string }[],
  asked: string[][] = [],
) {
  return {
    filterSessions: async (filters: readonly { readonly kind: string; readonly values: readonly string[] }[]) => {
      const values = new Set(filters[0]?.values ?? [])
      asked.push([...values])
      return records.filter(r => values.has(r.parentSession)).map(r => ({ header: { ...r, origin: 'subagent' } }))
    },
  }
}

describe('宿主端口的角色接口', () => {
  it('createHostPort 的返回对象可赋给每个角色与复合别名，且四个角色拼回来仍是一个 HostPort', () => {
    const port = createHostPort(makeCtx())
    const identity: HostIdentityPort = port
    const presence: HostPresencePort = port
    const corpus: HostCorpusPort = port
    const projection: HostProjectionPort = port
    const projectionRead: HostProjectionReadPort = port
    const projectionWrite: HostProjectionWritePort = port
    const core: HostCorePort = port
    const removal: HostRemovalPort = port
    const composite: HostPort = port
    // 反向：四个角色的并集能拼回 HostPort（复合别名若多出一个成员，这行编译不过）。
    const rebuilt: HostPort = { ...identity, ...presence, ...corpus, ...projection }

    for (const view of [identity, presence, corpus, projection, projectionRead, projectionWrite, core, removal, composite]) {
      expect(view).toBe(port)
    }
    expect(rebuilt).toEqual(port)
  })

  it('四个角色拼起来恰好是 adapter 的 24 个方法', () => {
    const actual = Object.keys(createHostPort(makeCtx())).sort()
    expect(actual).toHaveLength(24)
    expect(actual).toEqual([...COMPOSITE_KEYS].sort())
  })

  it('角色边界是 12 / 3 / 7 / 2，且核心面只拿投影缓存读面', () => {
    expect(ROLE_KEYS.identity.keys).toHaveLength(12)
    expect(ROLE_KEYS.presence.keys).toHaveLength(3)
    expect(ROLE_KEYS.corpus.keys).toHaveLength(7)
    expect(ROLE_KEYS.projection.keys).toHaveLength(2)
    expect(ROLE_KEYS.projectionRead.keys).toHaveLength(1)
    expect(ROLE_KEYS.projectionWrite.keys).toHaveLength(1)
    const declared = [...COMPOSITE_KEYS]
    expect(new Set(declared).size).toBe(declared.length) // 四张表互不重叠
    for (const role of Object.values(ROLE_KEYS)) expect(role.exact).toBe(true)
    expect(COMPOSITE_EXACT).toBe(true)
    expect(CORE_EXACT).toBe(true)
    expect(REMOVAL_EXACT).toBe(true)
    expect(CORE_KEYS).toHaveLength(20)
    expect(REMOVAL_KEYS).toHaveLength(21)
  })

  it('HostCorpusPort.listSessions 的返回类型就是 CorpusRead<readonly SessionIdentity[]>（undefined 不再是契约的一部分）', () => {
    expect(LIST_SESSIONS_READ).toBe(true)
  })

  it('HostIdentityPort.archive 恰好一个参数（归档是 registry 全局的，与工作区账目无关）', () => {
    expect(ARCHIVE_ARITY).toBe(true)
  })

  it('persistenceMounted 只探服务，不看 list 是否可用（状态与读面分开）', () => {
    expect(createHostPort(makeCtx()).persistenceMounted()).toBe(false)
    expect(createHostPort(makeCtx({ sessionPersistence: {} })).persistenceMounted()).toBe(true)
  })
})

/**
 * 语料读面的**缺席显式化**（`CorpusRead`）：调用方要分得开"这一趟看不见语料"与"看见了、里面是空的"——
 * 前者只许降级，后者是可以行动的事实。BFS/闭包/去重都在这唯一一个 `subagentMembersOf` 读面后面，
 * 这里只钉判别与键。
 */
describe('HostCorpusPort.subagentMembersOf（缺席显式化）', () => {
  it('sessionQuery 缺席 ⇒ { available: false }，不拿空表冒充"没有后代"', async () => {
    const port = createHostPort(makeCtx())
    await expect(port.subagentMembersOf(['p'])).resolves.toEqual({ available: false })
  })

  it('服务缺席优先于空入参 ⇒ { available: false }（看不见语料时不说"没有后代"）', async () => {
    const port = createHostPort(makeCtx())
    await expect(port.subagentMembersOf([])).resolves.toEqual({ available: false })
  })

  it('服务在场、没有后代 ⇒ { available: true, value: { p: [] } }', async () => {
    const port = createHostPort(makeCtx({ sessionQuery: closingQuery([]) }))
    await expect(port.subagentMembersOf(['p'])).resolves.toEqual({
      available: true,
      value: { p: [] },
    })
  })

  it('服务在场、空入参 ⇒ { available: true, value: {} }，一次宿主调用都不发', async () => {
    const asked: string[][] = []
    const port = createHostPort(makeCtx({ sessionQuery: closingQuery([], asked) }))
    await expect(port.subagentMembersOf([])).resolves.toEqual({ available: true, value: {} })
    expect(asked).toHaveLength(0)
  })

  it('父 id 的两种写法各按键回；追到孙代（传递闭包）', async () => {
    const asked: string[][] = []
    const port = createHostPort(makeCtx({
      sessionQuery: closingQuery(
        [
          { id: 'session-kid', parentSession: 'session-x', cwd: 'C:/p' },
          { id: 'session-grand', parentSession: 'session-kid', cwd: 'C:/p' },
        ],
        asked,
      ),
    }))
    const members = [
      { sessionId: 'session-kid', projectDir: '--C-p--' },
      { sessionId: 'session-grand', projectDir: '--C-p--' },
    ]

    const prefixed = await port.subagentMembersOf(['session-x'])
    expect(prefixed).toEqual({ available: true, value: { 'session-x': members } })

    const bare = await port.subagentMembersOf(['x'])
    expect(bare).toEqual({ available: true, value: { x: members } })
  })

  // 这一格钉的是「重复入参不放大结果与宿主调用」，**不是**「`membersFor` 的入参去重被单独覆盖」：
  // `descendantsByParent` 的根集合本来就按 bare id 收过一次，删掉 `membersFor` 里那行去重它仍会绿。
  it('重复入参 ⇒ 一个键、宿主调用次数与单次入参相同', async () => {
    const asked: string[][] = []
    const port = createHostPort(makeCtx({
      sessionQuery: closingQuery(
        [{ id: 'session-kid', parentSession: 'session-x', cwd: 'C:/p' }],
        asked,
      ),
    }))

    await port.subagentMembersOf(['session-x'])
    const callsForOne = asked.length
    asked.length = 0
    const duplicated = await port.subagentMembersOf(['session-x', 'session-x'])
    if (!duplicated.available) throw new Error('sessionQuery 在场时不该缺席')
    expect(Object.keys(duplicated.value)).toEqual(['session-x'])
    expect(asked).toHaveLength(callsForOne)
  })
})

/**
 * 归档档的宿主读面（ADR-0060 决定第 3 条）：窄镜像 + **四条降级各不相同**——`readTitleSnapshots`
 * 缺席只降级标题、`sessionController` 缺席只回退 createdAt、`sessionPersistence` 服务缺席逐行缺大小
 * （整档照常）、`sessionPersistence.list` 抛错才是整档 `io` 的原料（不给空表）、`readSession` 缺席是响亮失败。
 * 折码（`SESSION_QUERY_SESSION_NOT_FOUND` → `sessiondelete/not-found`）归上层（归档详情读路
 * `readArchiveDetail`），端口只保证原样抛。
 */
describe('宿主端口的归档读面（窄镜像）', () => {
  it('archivedSessionIds 原样交回归档集', async () => {
    const port = createHostPort(makeCtx({ archived: ['session-a', 'session-b'] }))
    await expect(port.archivedSessionIds()).resolves.toEqual(['session-a', 'session-b'])
    const empty = createHostPort(makeCtx())
    await expect(empty.archivedSessionIds()).resolves.toEqual([])
  })

  it('labelOf：subagent 投影 label 非空才回，空/形状不符回空串、不回落标题', async () => {
    const persistence = { stat: async () => ({ header: { cwd: '/p' } }) }
    const withLabel = createHostPort(makeCtx({
      sessionPersistence: persistence,
      projectionCache: {
        cachedSnapshot: () => ({ values: { subagent: { label: '子任务名' }, title: { title: '主标题' } } }),
        cachedPredecessorTitle: () => undefined,
      },
    }))
    await expect(withLabel.labelOf('session-a')).resolves.toBe('子任务名')

    const emptyLabel = createHostPort(makeCtx({
      sessionPersistence: persistence,
      projectionCache: {
        // label 空串 = 没有名字；title 行在场也不回落——回落标题是 `titleOf` 的口径，不是 `labelOf` 的。
        cachedSnapshot: () => ({ values: { subagent: { label: '' }, title: { title: '主标题' } } }),
        cachedPredecessorTitle: () => undefined,
      },
    }))
    await expect(emptyLabel.labelOf('session-a')).resolves.toBe('')

    const oddShape = createHostPort(makeCtx({
      sessionPersistence: persistence,
      projectionCache: {
        cachedSnapshot: () => ({ values: { subagent: '不是对象' } }),
        cachedPredecessorTitle: () => undefined,
      },
    }))
    await expect(oddShape.labelOf('session-a')).resolves.toBe('')
  })

  it('titleSnapshots：fulfilled 折标题、单条 rejected 只是该 id 不在 map；方法缺席回 available:false', async () => {
    const port = createHostPort(makeCtx({
      sessionQuery: {
        readTitleSnapshots: async () => [
          { sessionId: 'a', status: 'fulfilled', value: { session: {}, title: { title: '甲' } } },
          { sessionId: 'b', status: 'fulfilled', value: { session: {} } },
          { sessionId: 'c', status: 'rejected', reason: new Error('boom') },
        ],
      },
    }))
    await expect(port.titleSnapshots(['a', 'b', 'c'])).resolves.toEqual({
      available: true,
      value: new Map([['a', '甲']]),
    })

    // 方法缺席（旧宿主）：整档降级的信号，不是失败。
    const oldHost = createHostPort(makeCtx({ sessionQuery: closingQuery([]) }))
    await expect(oldHost.titleSnapshots(['a'])).resolves.toEqual({ available: false })
  })

  it('sessionActivity：updatedAt 按 id 折表；服务缺席/抛错回 available:false', async () => {
    const port = createHostPort(makeCtx({
      sessionController: {
        list: async () => ({ items: [{ sessionId: 'a', updatedAt: 111 }, { sessionId: 'b', updatedAt: 'x' }, { sessionId: 'c' }] }),
      },
    }))
    await expect(port.sessionActivity()).resolves.toEqual({ available: true, value: new Map([['a', 111]]) })

    await expect(createHostPort(makeCtx()).sessionActivity()).resolves.toEqual({ available: false })
    const throwing = createHostPort(makeCtx({ sessionController: { list: async () => { throw new Error('boom') } } }))
    await expect(throwing.sessionActivity()).resolves.toEqual({ available: false })
  })

  it('persistedSizes：sizeBytes 可选（缺席 = undefined）；服务缺席回 available:false，list 抛错照抛', async () => {
    const port = createHostPort(makeCtx({
      sessionPersistence: {
        stat: async () => undefined,
        list: async () => [{ header: { id: 'a', createdAt: 1 }, sizeBytes: 10 }, { header: { id: 'b', createdAt: 2 } }],
      },
    }))
    await expect(port.persistedSizes()).resolves.toEqual({
      available: true,
      value: new Map([['a', 10], ['b', undefined]]),
    })

    await expect(createHostPort(makeCtx()).persistedSizes()).resolves.toEqual({ available: false })
    const throwing = createHostPort(makeCtx({
      sessionPersistence: { stat: async () => undefined, list: async () => { throw new Error('boom') } },
    }))
    await expect(throwing.persistedSizes()).rejects.toThrow('boom')
  })

  it('readSession：events 原样、session 头只投影折叠消费的三格；方法缺席抛错；SESSION_QUERY_SESSION_NOT_FOUND 原样抛（折码归上层）', async () => {
    const events = [{ type: 'user/message', seq: 3, time: 5, data: { x: 1 } }]
    const port = createHostPort(makeCtx({
      sessionQuery: {
        readSession: async () => ({
          session: { id: 'session-a', createdAt: 1, cwd: '/p', parentSession: 'session-p', origin: 'subagent' },
          inheritedEventCount: 2,
          events,
        }),
      },
    }))
    // `origin` 宿主给了也不投影：折叠认的是 `parentSession`，投过来没有消费方。
    await expect(port.readSession('session-a')).resolves.toEqual({
      session: { createdAt: 1, cwd: '/p', parentSession: 'session-p' },
      events,
    })

    const oldHost = createHostPort(makeCtx({ sessionQuery: closingQuery([]) }))
    await expect(oldHost.readSession('session-a')).rejects.toThrow(/readSession/)

    const notFound = Object.assign(new Error('gone'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    const failing = createHostPort(makeCtx({
      sessionQuery: { readSession: async () => { throw notFound } },
    }))
    await expect(failing.readSession('ghost')).rejects.toBe(notFound)
  })

  it('readSession：事件流不是数组、或元素缺 type/time 都抛（不静默折成空正文）', async () => {
    const notAnArray = createHostPort(makeCtx({
      sessionQuery: { readSession: async () => ({ session: {}, events: undefined }) },
    }))
    await expect(notAnArray.readSession('session-a')).rejects.toThrow(/形状不符/)

    for (const bad of [null, 'user/message', { type: 'user/message' }, { type: 1, time: 5 }]) {
      const port = createHostPort(makeCtx({
        sessionQuery: { readSession: async () => ({ session: {}, events: [bad] }) },
      }))
      await expect(port.readSession('session-a')).rejects.toThrow(/形状不符/)
    }
  })

  it('listSessions 的 SessionIdentity 带 createdAt（header.createdAt；缺失不落键，不拿 0 冒充）', async () => {
    const port = createHostPort(makeCtx({
      sessionQuery: {
        listSessions: async () => [
          { header: { id: 'session-a', createdAt: 123, cwd: '/p' }, live: false, persisted: true },
          { header: { id: 'session-b', cwd: '/p' }, live: false, persisted: true },
        ],
      },
    }))
    const read = await port.listSessions()
    if (!read.available) throw new Error('sessionQuery 在场时不该缺席')
    expect(read.value.map((row) => [row.sessionId, row.createdAt])).toEqual([['session-a', 123], ['session-b', undefined]])
  })
})

/** `storageDomain` facility 的替身：只认 `session_projcache` 域与 `sessions` 表。 */
function projectionFacility(table: {
  keys: () => IterableIterator<string>
  delete?: (key: string) => Promise<boolean>
  deleteMany?: (keys: readonly string[]) => Promise<number>
}): unknown {
  return {
    get: (name: string) => name === 'session_projcache'
      ? {
        table: (tableName: string) => {
          if (tableName !== 'sessions') throw new Error(`no table ${tableName}`)
          return table
        },
      }
      : undefined,
  }
}

/**
 * 投影缓存的键集与删除面：**服务缺席不是空表**——只认已打开的存储域；域不可用才回
 * `available:false`（维护卡必须报 io，不许折成 0 条）。删除只经 storage domain 的同一条写链。
 */
describe('HostProjectionPort（session_projcache 的键集与删除面）', () => {
  it('存储域不可用 ⇒ available:false（缓存服务缺席也不能当没有记录）', async () => {
    const port = createHostPort(makeCtx())
    await expect(port.projectionCacheIds()).resolves.toEqual({ available: false })
  })

  it('缓存服务缺席但域已打开 ⇒ 仍读得到（服务不是读面的前提）', async () => {
    const port = createHostPort(makeCtx({
      storageDomain: projectionFacility({ keys: () => ['session-a'][Symbol.iterator](), delete: async () => true }),
    }))
    await expect(port.projectionCacheIds()).resolves.toEqual({ available: true, value: ['session-a'] })
  })

  it('storageDomain.get 缺席 / 域不在 / 表形状不符 ⇒ available:false', async () => {
    await expect(createHostPort(makeCtx({ storageDomain: {} })).projectionCacheIds())
      .resolves.toEqual({ available: false })
    await expect(createHostPort(makeCtx({ storageDomain: { get: () => undefined } })).projectionCacheIds())
      .resolves.toEqual({ available: false })
    await expect(createHostPort(makeCtx({
      storageDomain: { get: () => ({ table: () => ({ keys: '不是函数', delete: async () => true }) }) },
    })).projectionCacheIds()).resolves.toEqual({ available: false })
  })

  it('键集原样来自 sessions 表；删除优先走 deleteMany 且按名单去重', async () => {
    const deleteMany = vi.fn(async (ids: readonly string[]) => ids.length)
    const deleteOne = vi.fn(async () => true)
    const port = createHostPort(makeCtx({
      storageDomain: projectionFacility({
        keys: () => ['session-a', 'b'][Symbol.iterator](),
        delete: deleteOne,
        deleteMany,
      }),
    }))
    await expect(port.projectionCacheIds()).resolves.toEqual({ available: true, value: ['session-a', 'b'] })
    await expect(port.dropProjectionCache(['session-a', 'session-a', 'b'])).resolves.toEqual({ removed: 2, failed: 0 })
    expect(deleteMany).toHaveBeenCalledWith(['session-a', 'b'])
    expect(deleteOne).not.toHaveBeenCalled()
  })

  it('旧宿主没有 deleteMany ⇒ 逐条 delete，缺失记录不算失败、单条抛错收进 failed', async () => {
    const deleteOne = vi.fn(async (id: string) => {
      if (id === 'boom') throw new Error('disk')
      return id !== 'missing'
    })
    const port = createHostPort(makeCtx({
      storageDomain: projectionFacility({ keys: () => ['a'][Symbol.iterator](), delete: deleteOne }),
    }))
    await expect(port.dropProjectionCache(['a', 'missing', 'boom'])).resolves.toEqual({ removed: 1, failed: 1 })
    expect(deleteOne.mock.calls.map(([id]) => id)).toEqual(['a', 'missing', 'boom'])
  })

  it('取不到表时 drop 抛错（调用方决定 warning 还是回执），空名单不发宿主调用', async () => {
    const port = createHostPort(makeCtx())
    await expect(port.dropProjectionCache([])).resolves.toEqual({ removed: 0, failed: 0 })
    await expect(port.dropProjectionCache(['a'])).rejects.toThrow(/session_projcache/)
  })
})
