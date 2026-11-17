/**
 * `/apply` 六动作的**矩阵**：动作索引（`src/shared/apply-actions.ts`）与六家判据的双向核对。
 *
 * 为什么要有它：一个动作的口径散在 wire 值判形、路由纯度、取数超时档、客户端回执读法、写后座位
 * 五家（文案那一格没有按动作分派的键，见文末注）。动作索引只收了三格静态事实；这一份按**各家的
 * 公开 interface 行为**逐动作核对一遍——索引写错、某一家漏了一个动作、或两处口径漂了，先在这里红，
 * 而不是等真机上"慢动作被 30 秒掐断"或"新动作没有回执读法"。
 *
 * 双向核对：
 * - 枚举：索引的键序 = 规范动作序 = 路由表动作名单（拒否原文按它念）；
 * - 索引 → 各家：每个动作喂一遍 `WIRE_VALUE_GUARDS.apply`、路由纯度函数、实际超时档、回执读法；
 * - 各家 → 索引：客户端回执的落地 id 域 / not-found 中性 / 附件读数只在索引声明的那一类形状上出现；
 * - 类型级：写座位集与 `write-seats.ts` 的 `SeatedAction` 互为子集，`receipt.ts` 的
 *   `Record<ApplyAction, …>` 与索引的 `satisfies Record<ApplyAction, …>` 各守一侧。
 */
import { describe, expect, it, vi } from 'vitest'
import { APPLY_ACTIONS, APPLY_ACTION_INDEX } from '../src/shared/apply-actions.js'
import { APPLY_ACTION_TABLE, APPLY_ACTIONS as ROUTE_APPLY_ACTIONS, routeOf } from '../src/api/route-table.js'
import { readReceipt, summarizeReceipt } from '../src/client/receipt.js'
import {
  createHttpRemote,
  REQUEST_TIMEOUT_MS,
  SLOW_REQUEST_TIMEOUT_MS,
} from '../src/client/remote.js'
import type { SeatedAction } from '../src/client/write-seats.js'
import {
  PARAMS,
  ROUTES,
  SESSION_DELETE_CODES,
  WIRE_VALUE_GUARDS,
  type ApplyAction,
  type ApplyOutcome,
  type PurgeStatsWire,
  type TrashEntryWire,
} from '../src/shared/wire.js'

/** 回收站那一行的线上形状（判形所需的字段；`delete` / `restore` 的成功支就是它或 null）。 */
const TRASH_ROW: TrashEntryWire = {
  id: 'entry-x',
  sessionId: 'session-x',
  projectDir: '--p--',
  workspaceId: 'ws',
  wasArchived: false,
  deletedAt: 1,
  title: '会话',
  sizeBytes: 2,
}

/** 聚合回执（purge / orphan-clean 的成功支）：带附件读数，用来核对回执那半份读数只在 stats 上过线。 */
const STATS: PurgeStatsWire = {
  removed: 2,
  freedBytes: 3,
  attachments: { removed: 1, freedBytes: 1, failed: 0 },
}

/** 数的成功支（count / unarchive）。 */
const NUMBER = 1

/** 形状族 → 一个该形状的成功值（形状族是索引里唯一与 wire 判形共用的判别键）。 */
function valueOfShape(shape: (typeof APPLY_ACTION_INDEX)[ApplyAction]['value']): unknown {
  switch (shape) {
    case 'trash-entry-or-null': return TRASH_ROW
    case 'stats': return STATS
    case 'number': return NUMBER
  }
}

/** 一条成功的逐条回执（断言口径：判形读的是同一份 union，所以这里按动作断言）。 */
function okOutcome(action: ApplyAction, value: unknown): ApplyOutcome {
  return { id: 'x', action, ok: true, value } as ApplyOutcome
}

/** 一条失败的逐条回执。 */
function failedOutcome(action: ApplyAction, code: string, message: string): ApplyOutcome {
  return { id: 'x', action, ok: false, error: { code, message } }
}

describe('/apply 动作矩阵', () => {
  it('枚举：索引六支齐全、键序 = 规范动作序 = 路由表的动作名单（拒否原文按同一份序念）', () => {
    // `APPLY_ACTION_INDEX` 的 `satisfies Record<ApplyAction, …>` 是编译侧完整性；这里补运行期的
    // 「三份名单是同一份」：索引键集、规范序、路由表（`Object.keys(APPLY_ACTION_TABLE)`）。
    expect(Object.keys(APPLY_ACTION_INDEX)).toEqual([...APPLY_ACTIONS])
    expect([...ROUTE_APPLY_ACTIONS]).toEqual([...APPLY_ACTIONS])
    expect(Object.keys(APPLY_ACTION_TABLE)).toEqual([...APPLY_ACTIONS])
    for (const action of APPLY_ACTIONS) {
      expect(APPLY_ACTION_TABLE[action]).toBe(APPLY_ACTION_INDEX[action].purity)
    }
  })

  it('wire 值判形：每个动作的成功值形状过 `/apply` 判形；null 幂等只属于 entry 形状；换形状必须被拒', () => {
    for (const action of APPLY_ACTIONS) {
      const shape = APPLY_ACTION_INDEX[action].value
      // 成功支：索引声明的形状能过判形（判形按 action 校 value 的形状）。
      expect(WIRE_VALUE_GUARDS.apply([okOutcome(action, valueOfShape(shape))])).toBe(true)
      // 失败支与形状无关：任何动作的失败回执都该过。
      expect(WIRE_VALUE_GUARDS.apply([failedOutcome(action, SESSION_DELETE_CODES.io, '坏了')])).toBe(true)
    }
    for (const action of APPLY_ACTIONS) {
      const shape = APPLY_ACTION_INDEX[action].value
      // `null` 是"被同批前一条带走"的幂等 no-op，只属于 delete / restore（entry 形状）。
      expect(WIRE_VALUE_GUARDS.apply([okOutcome(action, null)])).toBe(shape === 'trash-entry-or-null')
      // 形状族互斥：换一种形状的值必须被拒（否则索引的 value 就是一句空话）。
      const wrongShape = shape === 'number' ? STATS : NUMBER
      expect(WIRE_VALUE_GUARDS.apply([okOutcome(action, wrongShape)])).toBe(false)
    }
  })

  it('纯度：路由表逐动作投影索引；运行时纯度函数逐动作一致，认不得的动作仍按 chained', () => {
    const purity = routeOf(ROUTES.apply.path)?.purity
    expect(typeof purity).toBe('function')
    const purityOf = purity as (body: Record<string, unknown> | null) => string
    for (const action of APPLY_ACTIONS) {
      expect(APPLY_ACTION_TABLE[action]).toBe(APPLY_ACTION_INDEX[action].purity)
      expect(purityOf({ [PARAMS.action]: action, [PARAMS.ids]: ['id'] })).toBe(APPLY_ACTION_INDEX[action].purity)
    }
    // 认不得的动作由解析手响亮拒否，纯度这一层只保证"不插队"。
    expect(purityOf(null)).toBe('chained')
    expect(purityOf({ [PARAMS.action]: 'nope' })).toBe('chained')
  })

  it('慢请求分档：索引的 slow 与取数通道实际超时档一致（普通 30s / 慢 120s）', async () => {
    /** 永不 resolve 的假 fetch：只听 AbortSignal（真实 fetch 的行为），不打信号就永远挂着。 */
    const stubNeverSettlingFetch = (): void => {
      vi.stubGlobal('fetch', async (_path: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        }, { once: true })
      }))
    }
    /** 这一档实际用的上限：推过普通档就已落地 ⇒ normal；要推到慢档才落地 ⇒ slow；都没落地 ⇒ none。 */
    const timeoutTierOf = async (action: ApplyAction): Promise<'normal' | 'slow' | 'none'> => {
      // 落地标记放对象里、经函数现读：闭包写 `let` 会被控制流收窄成"永远 false"
      // （与 `remote.ts` 的超时标记 `clock.timedOut` 同一条写法）。
      const state: { settled: boolean } = { settled: false }
      const settled = (): boolean => state.settled
      void createHttpRemote().applyOutcomes(action, ['id']).then(() => { state.settled = true })
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS)
      if (settled()) return 'normal'
      await vi.advanceTimersByTimeAsync(SLOW_REQUEST_TIMEOUT_MS - REQUEST_TIMEOUT_MS)
      return settled() ? 'slow' : 'none'
    }
    vi.useFakeTimers()
    try {
      stubNeverSettlingFetch()
      for (const action of APPLY_ACTIONS) {
        const tier = await timeoutTierOf(action)
        expect(`${action}:${tier}`).toBe(`${action}:${APPLY_ACTION_INDEX[action].slow ? 'slow' : 'normal'}`)
      }
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('回执读法：成功读得出成功；落地 id 域 / not-found 中性 / 附件读数与动作的索引事实对齐', () => {
    /** 落地 id 的域：delete 是条目 id、restore 是会话 id，其余三个动作没有可撤销的落地 id。 */
    const landedByAction = {
      delete: ['entry-x'],
      restore: ['session-x'],
      purge: [],
      count: [],
      'orphan-clean': [],
      unarchive: [],
    } satisfies Record<ApplyAction, readonly string[]>
    /** not-found 这枚失败码是不是中性提示（只有孤儿清理把"组已经不在了"当成功）。 */
    const neutralOnNotFound = {
      delete: false,
      restore: false,
      purge: false,
      count: false,
      'orphan-clean': true,
      unarchive: false,
    } satisfies Record<ApplyAction, boolean>

    for (const action of APPLY_ACTIONS) {
      const shape = APPLY_ACTION_INDEX[action].value
      const { summary } = summarizeReceipt(readReceipt(action, ['x'], [okOutcome(action, valueOfShape(shape))]))
      expect(summary.successIds).toEqual(['x'])
      expect(summary.landedIds).toEqual([...landedByAction[action]])
      // 附件读数只住在 stats 形状（purge / orphan-clean）的 ok 回执里；其余形状没有这一格。
      expect(summary.attachmentCleanup !== undefined).toBe(shape === 'stats')

      const notFound = readReceipt(action, ['x'], [failedOutcome(action, SESSION_DELETE_CODES['not-found'], '不在了')])
      expect(notFound.byId.get('x')?.kind).toBe(neutralOnNotFound[action] ? 'neutral' : 'failed')
    }
  })

  it('写座位覆盖：索引推出的座位集 = write-seats 的 SeatedAction；座位动作一定是写；两个不结算动作不是座位', () => {
    // 类型级：索引推出的座位集与 `write-seats.ts` 的 `SeatedAction` 互为子集；任一侧改了排除项都是编译错。
    type SeatedFromIndex = Exclude<ApplyAction, 'count' | 'orphan-clean'>
    type SeatedTypeCheck = SeatedFromIndex extends SeatedAction
      ? (SeatedAction extends SeatedFromIndex ? true : never)
      : never
    const seatedTypeCheck: SeatedTypeCheck = true
    expect(seatedTypeCheck).toBe(true)

    // 运行期：座位 = 去掉了两个不结算的动作（count 是纯读、orphan-clean 归维护卡）；顺序按规范序。
    const seated = APPLY_ACTIONS.filter((action) => action !== 'count' && action !== 'orphan-clean')
    expect([...seated]).toEqual(['delete', 'restore', 'purge', 'unarchive'])
    // 座位动作一定是写（chained）：纯读动作进座位会让写入链替一个读动作做跨槽位收尾。
    for (const action of seated) expect(APPLY_ACTION_INDEX[action].purity).toBe('chained')
    // 慢请求只落在聚合写上：purge（有座位）与 orphan-clean（无座位、归维护卡），其余动作都是普通档。
    expect(APPLY_ACTIONS.filter((action) => APPLY_ACTION_INDEX[action].slow)).toEqual(['purge', 'orphan-clean'])
  })
})

/*
 * 文案那一格没有按动作分派的键：`copy.ts` 的键按界面面（menu / undo / trash / archive）组织，
 * 一个动作可能被多个面用不同句子（删除 = 「移入回收站」、撤销 = 「撤销」）。所以矩阵不拿 copy 的键
 * 逐动作核对——那会把字典的结构钉成动作的投影，而不是反过来的口径。改文案时以 `copy.test.ts`
 * 的键镜像为准。
 */
