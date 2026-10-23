import { describe, expect, it } from 'vitest'
import { createHostPort } from '../src/ports/host-port.js'
import type {
  CorpusRead,
  HostCorpusPort,
  HostIdentityPort,
  HostPort,
  HostPresencePort,
  SessionIdentity,
} from '../src/ports/host-port.js'

/**
 * 角色接口的**形状用例**：`HostPort` 拆成 identity / presence / corpus 三个角色，
 * 复合别名是三者的交集。
 *
 * 三条要求都是**编译期 + 运行期各钉一半**：
 *  - `createHostPort` 的返回对象可赋给每个角色（类型检查由 `pnpm typecheck` 跑，运行期是同一颗对象）；
 *  - 每个角色接口的键集合**恰好**是下面那三张表（`ExactKeys` 让"多一个/少一个"都编译不过）；
 *  - adapter 的 15 个方法 == 三张表的并集。
 *
 * 另有一组**行为**用例：`subagentMembersOf` 的缺席 / 在场 / 空入参（`CorpusRead` 的判别）。
 * 两个语料读面的完整行为仍逐条钉在 `tests/assembly.test.ts`。
 */

/** 编译期精确断言：`T` 的键集合恰好是 `K`。任一处不成立，`true satisfies …` 就编译不过。 */
type ExactKeys<T, K extends PropertyKey> =
  [Exclude<keyof T, K>] extends [never]
    ? [K] extends [keyof T] ? true : false
    : false

/** 编译期类型相等（双向 `extends` 的经典写法）：`A` 与 `B` 是同一个类型才为 `true`。 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

/**
 * 角色的键集合：语料只剩两个读面，两者都把"这一趟看不见语料"写成显式的 `CorpusRead`。
 */
const IDENTITY_KEYS = [
  'workspaceOf', 'workspaceExists', 'projectDirOf', 'titleOf', 'isLive', 'isArchived',
  'archive', 'unarchive', 'attach', 'detach',
] as const
const PRESENCE_KEYS = ['evictLive', 'announceRemoved', 'announceRestored'] as const
const CORPUS_KEYS = ['listSessions', 'subagentMembersOf'] as const

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
} as const

const COMPOSITE_KEYS = [...IDENTITY_KEYS, ...PRESENCE_KEYS, ...CORPUS_KEYS] as const
const COMPOSITE_EXACT = true satisfies ExactKeys<HostPort, (typeof COMPOSITE_KEYS)[number]>

/**
 * `listSessions` 的返回类型**恰好**是 `CorpusRead<readonly SessionIdentity[]>`：`undefined`
 * （旧契约）或「`CorpusRead` 再并上 `undefined`」都会让这行编译不过。
 */
const LIST_SESSIONS_READ = true satisfies Equal<
  Awaited<ReturnType<HostCorpusPort['listSessions']>>,
  CorpusRead<readonly SessionIdentity[]>
>

/**
 * 宿主 ctx 的最小替身：`createHostPort` 构造期只读 `workspaceRegistry`，`get` / `waterfall` / `emit`
 * 是各方法运行期才碰的。形状用例不调任何方法；行为用例只走 `get('sessionQuery')` 这一条
 * （不复制 `assembly.test.ts` 的整套 `makeEnv`——那份钉的是两个语料读面的完整行为）。
 */
function makeCtx(options: { readonly sessionQuery?: unknown } = {}): unknown {
  return {
    workspaceRegistry: {
      list: () => [],
      get: () => undefined,
      archivedSessionIds: [],
      unarchiveSession: async () => {},
      archiveSession: async () => {},
      readSessionHeader: async () => {
        throw new Error('minimal ctx: no such session')
      },
    },
    waterfall: async (_name: string, _args: object, next: () => Promise<readonly unknown[]>) => next(),
    get: (name: string) => (name === 'sessionQuery' ? options.sessionQuery : undefined),
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
      return records.filter(r => values.has(r.parentSession)).map(r => ({ header: r }))
    },
  }
}

describe('宿主端口的角色接口', () => {
  it('createHostPort 的返回对象可赋给每个角色与复合别名，且三个角色拼回来仍是一个 HostPort', () => {
    const port = createHostPort(makeCtx())
    const identity: HostIdentityPort = port
    const presence: HostPresencePort = port
    const corpus: HostCorpusPort = port
    const composite: HostPort = port
    // 反向：三个角色的并集能拼回 HostPort（复合别名若多出一个成员，这行编译不过）。
    const rebuilt: HostPort = { ...identity, ...presence, ...corpus }

    for (const view of [identity, presence, corpus, composite]) expect(view).toBe(port)
    expect(rebuilt).toEqual(port)
  })

  it('三个角色拼起来恰好是 adapter 的 15 个方法', () => {
    const actual = Object.keys(createHostPort(makeCtx())).sort()
    expect(actual).toHaveLength(15)
    expect(actual).toEqual([...COMPOSITE_KEYS].sort())
  })

  it('角色边界是 10 / 3 / 2，且接口键集合与实现集合在类型上逐一相等', () => {
    expect(ROLE_KEYS.identity.keys).toHaveLength(10)
    expect(ROLE_KEYS.presence.keys).toHaveLength(3)
    expect(ROLE_KEYS.corpus.keys).toHaveLength(2)
    const declared = [...COMPOSITE_KEYS]
    expect(new Set(declared).size).toBe(declared.length) // 三张表互不重叠
    for (const role of Object.values(ROLE_KEYS)) expect(role.exact).toBe(true)
    expect(COMPOSITE_EXACT).toBe(true)
  })

  it('HostCorpusPort.listSessions 的返回类型就是 CorpusRead<readonly SessionIdentity[]>（undefined 不再是契约的一部分）', () => {
    expect(LIST_SESSIONS_READ).toBe(true)
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
