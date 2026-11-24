/**
 * Node 半用例的六件脚手架——**第二个 adapter 之上**的那一层，不是第二个 adapter。
 *
 * `tests/support/fake-deps.ts` 补齐的是端口的另一个实现；这一份补齐的是用例之间重复出现的仪器：
 *  ① `trashEntry`：一条回收站记录的缺省形状（各文件的夹具只覆盖自己关心的那几格）；
 *  ② `createLogWorld`：带调用日志的世界（`calls` 按发生顺序，fs 与 host 共用一条）；
 *  ③ `failureOf`：把一次拒绝原样取回来（连 `code` / `cause` / `details` 一起）；
 *  ④ `holdCalls`：可手动放行的调用闸（写在飞途中插进 `GET /progress` 这类读请求靠它）；
 *  ⑤ `expectSteps`：步骤序列的**按序包含**断言（写入进度的步骤码序列用例共用）；
 *  ⑥ `stepProbe`：放行闸 + 放行点读 `readWriteProgress().step` 的采样器（三个动词的步骤级用例共用）。
 *
 * 判据只有一条：**同一件仪器只许有一个家**。哪几个方法进日志、一条日志怎么写，仍是各文件自己的事
 * ——那是「这个用例关心什么」，不是仪器。
 */
import { expect, vi, type Mock } from 'vitest'
import { readWriteProgress } from '../../src/verbs/write-progress.js'
import type { TrashEntry } from '../../src/trash/entry.js'
import type { TrashLedger } from '../../src/trash/ledger.js'
import type { ManifestPort } from '../../src/trash/manifest.js'
import {
  createFakeDeps,
  type FakeDeps,
  type FakeDepsOptions,
  type FakeFs,
  type FakeHost,
} from './fake-deps.js'

/** 一条回收站记录的缺省：`sessionId` 跟着 `id`，其余取最安静的值。
 *  条目 id 的真实算法归各文件自己的夹具（id 由删除时刻算出，这里不替它猜）。 */
export function trashEntry(id: string, over: Partial<TrashEntry> = {}): TrashEntry {
  return {
    id,
    sessionId: id,
    projectDir: '--p--',
    workspaceId: 'ws-1',
    wasArchived: false,
    deletedAt: 1,
    title: '',
    sizeBytes: 0,
    ...over,
  }
}

export interface LogWorldOptions extends Omit<FakeDepsOptions, 'log' | 'logMethods' | 'format'> {
  /** 哪几个方法要进 `calls`；顺序即发生顺序。读口不要写，否则每条断言都得先滤一遍。 */
  readonly logMethods: readonly string[]
  /** 一条日志怎么写；缺省就是方法名。 */
  readonly format?: (method: string, args: readonly unknown[]) => string
}

export interface LogWorld {
  readonly deps: FakeDeps
  readonly host: FakeHost
  readonly fs: FakeFs
  readonly ledger: TrashLedger
  readonly manifest: ManifestPort
  /** 按 `logMethods` 记下的调用序；fs 与 host 共用这一条。 */
  readonly calls: string[]
}

/** 一次装配出带调用日志的世界：世界怎么长仍由 `createFakeDeps` 的声明式读数说，
 *  这里只加一条日志并把写下来的数组交回。 */
export function createLogWorld(over: LogWorldOptions): LogWorld {
  const calls: string[] = []
  const made = createFakeDeps({ ...over, log: calls })
  return { ...made, calls }
}

export type Rejection = Error & {
  readonly code?: string
  readonly cause?: unknown
  readonly details?: unknown
}

/** 一次应当失败的调用：把原始错误交回来，没失败就用一句可读的原文炸掉。
 *  **不在取回时断言码**——断言留在用例里，这里只负责「把拒绝交回来」。 */
export async function failureOf(run: Promise<unknown>): Promise<Rejection> {
  try {
    await run
  } catch (error) {
    return error as Rejection
  }
  throw new Error('expected the call to reject')
}

/** 可手动放行的调用闸（测试基建）：被 {@link holdCalls} 包住的替身方法每次调用先挂起，用例逐条放行。
 *  「写在飞途中插进读请求」（如 `GET /progress`）靠它——生产语义一格不动。 */
export interface HeldCalls {
  /** 现在挂着、还没放行的调用数：用例轮询「那条真的到了」用。 */
  readonly waiting: number
  /** 放行最早挂起的一次调用（FIFO）；闸上没人时是 no-op，不误放之后才来的调用。 */
  release(): void
}

/** 能被 {@link holdCalls} 挂起的替身方法：`vi.fn` 的那一侧（取当前实现、换实现）。
 *  各调用点的函数型互不相容（`(p: string) => Promise<void>` 与 `(parentIds: readonly string[]) => Promise<…>`），
 *  所以形参从替身自己的函数型上推（`A` / `T`），单态签名装不下它们。 */
type HoldableCall<A extends unknown[], T> = Mock<(...args: A) => Promise<T>>

/**
 * 把一个 `vi.fn` 替身方法逐次挂起：调用先等 `release()`，放行后走**包住那一刻**的原实现（假件的世界
 * 语义照旧生效）。只认回 Promise 的异步方法——同步调用没有「挂在半空」这回事。
 * **警示：同一 mock 被再次 mockResolvedValue / mockImplementation 会顶掉本闸**（换实现等于拆闸）。
 */
export function holdCalls<A extends unknown[], T>(target: HoldableCall<A, T>): HeldCalls {
  const waiting: Array<() => void> = []
  const original = target.getMockImplementation()
  if (original === undefined) throw new Error('holdCalls: 被包的替身没有实现可委派')
  target.mockImplementation(async (...args: A): Promise<T> => {
    await new Promise<void>((resolve) => { waiting.push(resolve) })
    return await original(...args)
  })
  return {
    get waiting() { return waiting.length },
    release: () => { waiting.shift()?.() },
  }
}

/**
 * 步骤序列的**按序包含**断言：`expected` 是步骤码映射表在某个场景下的子序列，按序出现在 `observed` 里即过
 * ——场景不必把每码都走一遍（没账本可挂就没有 `ledger` 那一步），但走出来的顺序不许乱。
 * 反过来钉 `observed` 全等会把「替身被调了几次」这类夹具噪声混进映射口径，这里只判映射。
 */
export function expectSteps(observed: readonly string[], expected: readonly string[]): void {
  let cursor = 0
  for (const step of expected) {
    const found = observed.indexOf(step, cursor)
    expect(found, `期望步骤 '${step}' 按序出现在观察序列里；观察到: ${JSON.stringify(observed)}`).toBeGreaterThanOrEqual(0)
    cursor = found + 1
  }
}

/** 步骤级 tick 用例的采样器：`observed` 收集放行点读到的步骤码，`at` 等闸挂上、读一格、再放行。
 *  不给记录器加测试专用状态——观察面只有公开的 {@link readWriteProgress}。 */
export function stepProbe(): { readonly observed: string[]; at: (held: HeldCalls, times?: number) => Promise<void> } {
  const observed: string[] = []
  return {
    observed,
    at: async (held: HeldCalls, times = 1) => {
      for (let i = 0; i < times; i += 1) {
        await vi.waitFor(() => { expect(held.waiting).toBe(1) })
        const snapshot = readWriteProgress()
        observed.push(snapshot.status === 'running' ? snapshot.step : 'idle')
        held.release()
      }
    },
  }
}
