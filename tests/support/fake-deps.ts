/**
 * 测试用的**第二个 adapter**（架构复核候选 7）。
 *
 * `ports/host-port.ts` 与 `ports/fs-port.ts` 是 seam，生产那边各有一个 adapter（`createHostPort` /
 * `createFsPort`，要起宿主、要真盘）。**一个 adapter 只是假设的 seam，两个才是真的**：这里补齐内存里的
 * 那一个，于是动词测试不必再自己拿对象字面量凑端口、也不必 `as never` 强转去打洞——
 * 打洞意味着"这个 interface 没被验证"，而这正是测试该验证的东西。
 *
 * 三条约定：
 * ① **形状就是端口**：逐方法实现、逐方法 `vi.fn`（`.mock` 照旧可用，`toHaveBeenCalledWith` 不需要强转）；
 * ② **缺省是"最安静的成功"**：每个方法都有一个不改变世界、不抛的缺省，用例只翻自己关心的那几格；
 * ③ **调用日志按需**：只有调用方点名的方法（`logMethods`）才往 `log` 里写，默认格式就是方法名——
 *    想带上参数就自己给 `format`。读口一律不写日志（否则每个用例的日志里都塞满 `workspaceOf`）。
 */
import { vi, type Mock } from 'vitest'
import type { FsPort } from '../../src/ports/fs-port.js'
import type { EvictionOutcome, HostPort, SessionIdentity, SubagentMember } from '../../src/ports/host-port.js'
import type { TrashEntry } from '../../src/trash/entry.js'
import { createMemoryManifest, type ManifestPort } from '../../src/trash/manifest.js'
import type { DeleteDeps } from '../../src/verbs/delete-session.js'

/** 把端口上的每个方法换成 `vi.fn`（保参数与返回值类型——强转换不来这一点）。
 *  成员**可写**：用例经常"翻一格"（`host.isLive = vi.fn(...)`）来表达"这一条在跑"，那是这份假件的
 *  interface 的一部分，不该逼人绕回强转。 */
type Mocked<T> = {
  -readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : never
}

export type FakeHost = Mocked<HostPort>
export type FakeFs = Mocked<FsPort>

/** 日志：一条方法名（或 `format` 给的串）。 */
export interface CallLog {
  readonly log?: string[]
  /** 哪几个方法要写日志。**读口不要写**，否则每条断言都得先滤一遍。 */
  readonly logMethods?: readonly string[]
  /** 日志条目的写法，默认 `(method) => method`。 */
  readonly format?: (method: string, args: readonly unknown[]) => string
}

function recorder({ log, logMethods, format }: CallLog): (method: string, args: readonly unknown[]) => void {
  if (log === undefined || logMethods === undefined) return () => {}
  const wanted = new Set(logMethods)
  return (method, args) => {
    if (!wanted.has(method)) return
    log.push(format === undefined ? method : format(method, args))
  }
}

export interface FakeHostOptions extends CallLog {
  /** 删除时记下的工作区；`undefined` = 「未分组」。 */
  workspaceOf?: string | undefined | ((sessionId: string) => string | undefined)
  /** 会话落盘的项目目录名；`undefined` = 账本里没有这个会话。 */
  projectDirOf?: string | undefined | ((sessionId: string) => string | undefined)
  title?: string
  /** 活体判定：布尔，或按 id 判（批量用例要"这一条在跑"）。 */
  live?: boolean | ((sessionId: string) => boolean)
  archived?: boolean
  evicted?: EvictionOutcome
  workspaceExists?: boolean
  /** 父 → 盘上后代（`subagentMembers` 与 `subagentMembersBatch` 共用这一份）。 */
  members?: Record<string, readonly SubagentMember[] | undefined>
  /** 父 → 后代条数（缺省按 `members` 推；两处都缺就不出现在结果里，即 0 条）。 */
  counts?: Record<string, number>
  /** 整个语料（live ∪ persisted）；`undefined` = `sessionQuery` 没挂——扫描必须响亮失败。 */
  corpus?: readonly SessionIdentity[] | undefined
  /** 通告预取用的摘要表。 */
  summaries?: readonly { readonly sessionId: string; readonly summary: unknown }[]
}

/**
 * 内存里的 `HostPort`：19 个方法全部实现。
 *
 * **声明式的只读数**（`workspaceOf` / `projectDirOf` / `title` / `live` / `archived` / `members` …）
 * 是这一份 adapter 的 interface：用例说"这个世界长什么样"，而不是"第几行会被调到"。
 */
export function createFakeHost(over: FakeHostOptions = {}): FakeHost {
  const record = recorder(over)
  const projectDirOf = (sessionId: string): string | undefined =>
    typeof over.projectDirOf === 'function' ? over.projectDirOf(sessionId) : over.projectDirOf ?? '--p--'
  const workspaceOf = (sessionId: string): string | undefined =>
    typeof over.workspaceOf === 'function' ? over.workspaceOf(sessionId) : over.workspaceOf ?? 'ws-1'
  const isLive = (sessionId: string): boolean =>
    typeof over.live === 'function' ? over.live(sessionId) : over.live ?? false
  const membersOf = (parentId: string): readonly SubagentMember[] => over.members?.[parentId] ?? []
  const countsFor = (parentIds: readonly string[]): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const id of parentIds) {
      const fromMembers = membersOf(id).length
      const count = over.counts?.[id] ?? fromMembers
      if (count > 0) out[id] = count
    }
    return out
  }

  const host: FakeHost = {
    workspaceOf: vi.fn(async (sessionId: string) => workspaceOf(sessionId)),
    workspaceExists: vi.fn(async (_workspaceId: string) => over.workspaceExists ?? true),
    projectDirOf: vi.fn(async (sessionId: string) => projectDirOf(sessionId)),
    titleOf: vi.fn(async (_sessionId: string) => over.title ?? '会话标题'),
    isLive: vi.fn(async (sessionId: string) => isLive(sessionId)),
    isArchived: vi.fn(async (_sessionId: string) => over.archived ?? false),
    evictLive: vi.fn(async (sessionId: string) => {
      record('evictLive', [sessionId])
      return over.evicted ?? 'not-live'
    }),
    announceRemoved: vi.fn(async (sessionId: string) => { record('announceRemoved', [sessionId]) }),
    announceRestored: vi.fn(async (sessionId: string) => { record('announceRestored', [sessionId]) }),
    restoredSummariesOf: vi.fn(async () => over.summaries ?? []),
    announceRestoredBatch: vi.fn(async (ids: readonly string[], known?: readonly { readonly sessionId: string; readonly summary: unknown }[]) => {
      record('announceRestoredBatch', [ids, known])
    }),
    unarchive: vi.fn(async (sessionId: string) => { record('unarchive', [sessionId]) }),
    detach: vi.fn(async (sessionId: string, workspaceId: string) => { record('detach', [sessionId, workspaceId]) }),
    attach: vi.fn(async (sessionId: string, workspaceId: string) => { record('attach', [sessionId, workspaceId]) }),
    archive: vi.fn(async (sessionId: string, _workspaceId?: string) => { record('archive', [sessionId]) }),
    listSessions: vi.fn(async () => over.corpus),
    subagentMembersBatch: vi.fn(async (parentIds: readonly string[]) => {
      const out: Record<string, readonly SubagentMember[]> = {}
      for (const id of parentIds) {
        const members = over.members?.[id]
        if (members !== undefined) out[id] = members
      }
      return out
    }),
    subagentCounts: vi.fn(async (parentIds: readonly string[]) => countsFor(parentIds)),
    subagentMembers: vi.fn(async (sessionId: string) => membersOf(sessionId)),
  }
  return host
}

export interface FakeFsOptions extends CallLog {
  exists?: boolean | ((p: string) => boolean)
  size?: number
  files?: string[]
  /** 子目录名：数组，或按路径算（对账用例要"这个根下有哪些条目目录"）。 */
  dirs?: string[] | ((p: string) => string[])
  readFile?: (p: string) => Buffer | Promise<Buffer>
}

/** 内存里的 `FsPort`：8 个方法；缺省是"目录都在、字节可量、什么都不真的动"。 */
export function createFakeFs(over: FakeFsOptions = {}): FakeFs {
  const record = recorder(over)
  const exists = (p: string): boolean => (typeof over.exists === 'function' ? over.exists(p) : over.exists ?? true)
  return {
    exists: vi.fn(async (p: string) => exists(p)),
    ensureDir: vi.fn(async (p: string) => { record('ensureDir', [p]) }),
    rename: vi.fn(async (from: string, to: string) => { record('rename', [from, to]) }),
    removeDir: vi.fn(async (p: string) => { record('removeDir', [p]) }),
    sizeOfDir: vi.fn(async (p: string) => { record('sizeOfDir', [p]); return over.size ?? 1024 }),
    listFiles: vi.fn(async (p: string) => { record('listFiles', [p]); return over.files ?? [] }),
    listDirs: vi.fn(async (p: string) => {
      record('listDirs', [p])
      return typeof over.dirs === 'function' ? over.dirs(p) : over.dirs ?? []
    }),
    readFile: vi.fn(async (p: string) => {
      record('readFile', [p])
      if (over.readFile === undefined) throw new Error(`fake fs: 没有为 ${p} 准备 readFile`)
      return over.readFile(p)
    }),
  }
}

export interface FakeDepsOptions extends Omit<FakeHostOptions, 'log' | 'logMethods' | 'format'> {
  /** 清册初值。 */
  seed?: TrashEntry[]
  /** 宿主数据根（`sessions/` 与 `session-trash/` 都在它下面）。 */
  home?: string
  /** `Date.now()` 的替身（删除时刻进条目 id，所以要固定）。 */
  now?: number | (() => number)
  /** 日志与它要记的方法——**fs 与 host 共用一条**，于是"fs 的 rename 排在 host 的 archive 之后"这种
   *  跨端口的顺序也能一条断言钉住。 */
  log?: string[]
  logMethods?: readonly string[]
  format?: (method: string, args: readonly unknown[]) => string
  /** `FsPort` 的缺省；给了就整个换掉（少数用例要自带一个）。 */
  fs?: FakeFsOptions
}

/**
 * 一次装配出来的依赖面：**形状仍是 `DeleteDeps`**（能原样交给动词），但两个端口露出的是 `vi.fn` 那一侧，
 * 于是用例既能 `d.host.attach` 直接断言，又不需要任何 `as never`。强转消失不是风格问题——它意味着这份
 * 假件真的满足了端口，而不是"让编译器闭嘴"。
 */
export type FakeDeps = Omit<DeleteDeps, 'fs' | 'host'> & {
  readonly fs: FakeFs
  readonly host: FakeHost
}

/**
 * 一次装配出 `{ deps, host, fs, manifest }`：**返回值就是 `DeleteDeps`，没有强转**。
 *
 * 这也是"端口窄到可以假"的量尺：这份文件比 `host-port.ts` 的 19 个方法短，说明那 19 个方法没有藏
 * 第二个概念。哪天它长得比端口还复杂，该拆的是端口（身份与可见性 / 通告 / 语料读取），不是这份假件。
 */
export function createFakeDeps(over: FakeDepsOptions = {}): {
  deps: FakeDeps
  host: FakeHost
  fs: FakeFs
  manifest: ManifestPort
} {
  const callLog: CallLog = { log: over.log, logMethods: over.logMethods, format: over.format }
  const host = createFakeHost({ ...over, ...callLog })
  const fs = createFakeFs({ ...over.fs, ...callLog })
  const manifest = createMemoryManifest(over.seed ?? [])
  const now = over.now
  return {
    deps: { fs, host, manifest, home: over.home ?? '/h', now: typeof now === 'function' ? now : () => now ?? 0 },
    host,
    fs,
    manifest,
  }
}
