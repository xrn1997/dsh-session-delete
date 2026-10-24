/**
 * Node 半用例的三件脚手架——**第二个 adapter 之上**的那一层，不是第二个 adapter。
 *
 * `tests/support/fake-deps.ts` 补齐的是端口的另一个实现；这一份补齐的是用例之间重复了十几遍的三件仪器：
 *  ① `trashEntry`：一条回收站记录的缺省形状（各文件的夹具只覆盖自己关心的那几格）；
 *  ② `createLogWorld`：带调用日志的世界（`calls` 按发生顺序，fs 与 host 共用一条）；
 *  ③ `failureOf`：把一次拒绝原样取回来（连 `code` / `cause` / `details` 一起）。
 *
 * 判据只有一条：**同一件仪器只许有一个家**。哪几个方法进日志、一条日志怎么写，仍是各文件自己的事
 * ——那是「这个用例关心什么」，不是仪器。
 */
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
