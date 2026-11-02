/**
 * 测试用的**第二个 adapter**。
 *
 * `ports/host-port.ts` 与 `ports/fs-port.ts` 是 seam，生产那边各有一个 adapter（`createHostPort` /
 * `createFsPort`，要起宿主、要真盘）。**一个 adapter 只是假设的 seam，两个才是真的**：这里补齐内存里的
 * 那一个，于是动词测试不必再自己拿对象字面量凑端口、也不必 `as never` 强转去打洞——
 * 打洞意味着"这个 interface 没被验证"，而这正是测试该验证的东西。
 *
 * 三条约定：
 * ① **形状就是端口**：逐方法实现、逐方法 `vi.fn`（`.mock` 照旧可用，`toHaveBeenCalledWith` 不需要强转）；
 * ② **缺省是"最安静的成功"，但"安静"分读写两半**：除 `readFile` 外的读口（`exists` / `listDirs` /
 *    `sizeOfDir` / `listFiles` / `statFile` / `realpath`）与 `ensureDir` 的缺省不改世界、不抛，用例只翻
 *    自己关心的那几格；`readFile` 例外——没喂就响亮抛（漏喂是用例的错，不装成空内容）。而
 *    `rename`/`removeDir` 是**写口**，它们的缺省就是真改世界（把目录搬走/删掉落进
 *    `present`/`absent` 与墓碑）——因为假件要把"目标路径算错、rename 后源目录仍在、removeDir 后目录
 *    还活着"这类**已经发生的写**变成可观察的漂移，"安静"就不能再是"什么都不动"。完全没发生的写
 *    （例如忘了调 rename）仍不可见——假件不猜意图；要抓这类遗漏，用例得显式断言调用日志或世界。
 * ③ **调用日志按需**：只有调用方点名的方法（`logMethods`）才往 `log` 里写，默认格式就是方法名——
 *    想带上参数就自己给 `format`。读口通常不进 `logMethods`（否则每个用例的日志里都塞满
 *    `workspaceOf`）；点名了也照记——`recorder` 只按 `logMethods` 过滤，不按读写分。
 */
import { vi } from 'vitest'
import type { FsPort } from '../../src/ports/fs-port.js'
import type {
  CorpusRead,
  EvictionOutcome,
  HostPort,
  SessionIdentity,
  SubagentMember,
} from '../../src/ports/host-port.js'
import type { TrashEntry } from '../../src/trash/entry.js'
import { createTrashLedger, type TrashLedger } from '../../src/trash/ledger.js'
import type { ManifestPort } from '../../src/trash/manifest.js'
import { createMemoryManifest } from './memory-manifest.js'
import type { DeleteDeps } from '../../src/deps.js'
import { createMemberPresence } from '../../src/verbs/member-presence.js'
import { TRASH_DIR_NAME } from '../../src/shared/wire.js'
import type { Mocked } from './mocked.js'

export type FakeHost = Mocked<HostPort>
export type FakeFs = Mocked<FsPort>

/** 日志：一条方法名（或 `format` 给的串）。
 *  这三格都是**纯测试 options 包**：只在用例内消费，键的缺席不承载任何对外契约（不进清册、不上线），
 *  读数一律按值判空，所以「不写这一格」与「显式写 undefined」在这里是同一件事——
 *  开启精确可选属性后就把这一档如实写进类型，而不是在每个调用点上重算一遍省略键。 */
export interface CallLog {
  readonly log?: string[] | undefined
  /** 哪几个方法要写日志。**读口不要写**，否则每条断言都得先滤一遍。 */
  readonly logMethods?: readonly string[] | undefined
  /** 日志条目的写法，默认 `(method) => method`。 */
  readonly format?: ((method: string, args: readonly unknown[]) => string) | undefined
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
  title?: string | undefined
  /** 活体判定：布尔，或按 id 判（批量用例要"这一条在跑"）。 */
  live?: boolean | ((sessionId: string) => boolean) | undefined
  archived?: boolean | undefined
  evicted?: EvictionOutcome | undefined
  workspaceExists?: boolean | undefined
  /** 父 → 盘上后代（`subagentMembersOf` 的值；缺席的父回空表，与真实 adapter 同形）。 */
  members?: Record<string, readonly SubagentMember[] | undefined> | undefined
  /** 父 → 后代条数：给了就**造等长的合成盘上成员**（`sessionId` 是 `${父}-member-${i}`、项目目录 `--p--`），
   *  **优先于 `members`**（同一个父两处都写时以这一格为准）。 */
  counts?: Record<string, number> | undefined
  /** 语料读面可见吗：`false` = `sessionQuery` 服务缺席（`subagentMembersOf` 回 `{ available:false }`）；
   *  缺省可见（「最安静的成功」，现有调用方不用每条都声明这一格）。 */
  membersAvailable?: boolean | undefined
  /** 整个语料（live ∪ persisted）；`undefined` = `sessionQuery` 没挂——扫描必须响亮失败。 */
  corpus?: readonly SessionIdentity[] | undefined
}

/**
 * 内存里的 `HostPort`：15 个方法全部实现。
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
  /** `subagentMembersOf` 的值：`counts` 是"只关心条数"的语法糖（造等长的占位成员，身份不会上盘）。
   *  空 id 与重复 id 的处置与真实 `membersFor` 同一口径：丢掉空 id、重复 id 只算第一次（保序）。 */
  const membersOf = (parentIds: readonly string[]): Record<string, readonly SubagentMember[]> => {
    const out: Record<string, readonly SubagentMember[]> = {}
    const seen = new Set<string>()
    for (const id of parentIds) {
      if (id.length === 0 || seen.has(id)) continue
      seen.add(id)
      const count = over.counts?.[id]
      out[id] = count === undefined
        ? over.members?.[id] ?? []
        : Array.from({ length: count }, (_, index) => ({ sessionId: `${id}-member-${index}`, projectDir: '--p--' }))
    }
    return out
  }

  const host: FakeHost = {
    workspaceOf: vi.fn(async (sessionId: string) => workspaceOf(sessionId)),
    workspaceExists: vi.fn(async () => over.workspaceExists ?? true),
    projectDirOf: vi.fn(async (sessionId: string) => projectDirOf(sessionId)),
    titleOf: vi.fn(async () => over.title ?? '会话标题'),
    isLive: vi.fn(async (sessionId: string) => isLive(sessionId)),
    isArchived: vi.fn(async () => over.archived ?? false),
    evictLive: vi.fn(async (sessionId: string) => {
      record('evictLive', [sessionId])
      return over.evicted ?? 'not-live'
    }),
    announceRemoved: vi.fn(async (sessionId: string) => { record('announceRemoved', [sessionId]) }),
    announceRestored: vi.fn(async (ids: readonly string[]) => { record('announceRestored', [ids]) }),
    unarchive: vi.fn(async (sessionId: string) => { record('unarchive', [sessionId]) }),
    detach: vi.fn(async (sessionId: string, workspaceId: string) => { record('detach', [sessionId, workspaceId]) }),
    attach: vi.fn(async (sessionId: string, workspaceId: string) => { record('attach', [sessionId, workspaceId]) }),
    archive: vi.fn(async (sessionId: string) => { record('archive', [sessionId]) }),
    listSessions: vi.fn(async (): Promise<CorpusRead<readonly SessionIdentity[]>> =>
      (over.corpus === undefined
        ? { available: false }
        : { available: true, value: over.corpus })),
    /** 缺席显式化版的 `members` 读：`membersAvailable:false` 表达"这一趟看不见语料"，
     *  其余情况按「看得见」作答（缺席的父回空表，与真实 adapter 同形）。 */
    subagentMembersOf: vi.fn(async (parentIds: readonly string[]): Promise<CorpusRead<Record<string, readonly SubagentMember[]>>> =>
      (over.membersAvailable === false
        ? { available: false }
        : { available: true, value: membersOf(parentIds) })),
  }
  return host
}

export interface FakeFsOptions extends CallLog {
  exists?: boolean | ((p: string) => boolean) | undefined
  size?: number | undefined
  /** 目录下的文件名：数组，或按路径算（附件扫描要按目录喂不同日志）。 */
  files?: string[] | ((p: string) => string[]) | undefined
  /** 子目录名：数组，或按路径算（对账用例要"这个根下有哪些条目目录"）。 */
  dirs?: string[] | ((p: string) => string[]) | undefined
  /** **显式声明初值世界**（含刻意漂移）：给了就以它为 `createFakeFs` 的路径树初值，
   *  不再从清册行集派生；每个目录的初值字节用 `seedSize`（缺省 `size`，再缺省 1024）。 */
  seedDirs?: Iterable<string> | undefined
  /** `seedDirs` 里每个目录的初值字节；缺省 `size`，再缺省 1024。 */
  seedSize?: number | undefined
  readFile?: ((p: string) => Buffer | Promise<Buffer>) | undefined
  fileSize?: number | ((p: string) => number) | undefined
  statFile?: ((p: string) => { size: number } | Promise<{ size: number }>) | undefined
  removeFile?: ((p: string) => void | Promise<void>) | undefined
  /** 软链世界：真实路径可以不同于逻辑路径；缺省是树（identity）。 */
  realpath?: ((p: string) => string | Promise<string>) | undefined
}

/**
 * 内存里的 `FsPort`：11 个方法；**路径树状态机**。
 *
 * 世界 = `present`（盘上真在的目录：`seedDirs` 初值 + 写操作搬进来/建出来的）与 `absent`
 * （被写操作明确搬走/删掉的目录，墓碑）。三个读口（`exists` / `listDirs` / `sizeOfDir`）按这个世界作答，
 * 于是**漂移可观察**：`rename` 真搬（源消失、目标出现、size 跟随）、`removeDir` 真删（含子树）——
 * 过去"目标路径算错、写了行忘了搬目录、rename 后源目录仍在"这类世界观 bug 对假件不可见，现在当场可见。
 *
 * 缺省世界仍从清册行集派生（`createFakeDeps` 把初值行集交成 `dirs` 的基础读数），但**会被写操作改变**
 * ——这正是漂移可观察的来源。三个旧入口 `over.dirs` / `over.exists` / `over.size` 保留兼容：它们是
 * "基础读数"，世界在其上叠加（`absent` 是唯一的减项；`size` 同时是"世界不认得的目录"的扁平读数与
 * 每目录缺省字节）。
 */
export function createFakeFs(over: FakeFsOptions = {}): FakeFs {
  const record = recorder(over)

  /** 每目录缺省字节：`size` 给了就用它，否则 1024——世界里每个目录的初值与"不认得的目录"的扁平读数共用。 */
  const perDirSize = (): number => over.size ?? 1024

  // --- 路径树世界 -------------------------------------------------------
  /** 盘上真在的目录（`seedDirs` 初值 + `rename` 目标）。值是它**自己的**字节（求和时再加后代）。 */
  const present = new Map<string, { size: number }>()
  /** 被写操作明确搬走/删掉的目录（墓碑）：`exists` 为 false、`listDirs` 不列它们。 */
  const absent = new Set<string>()
  for (const dir of over.seedDirs ?? []) present.set(dir, { size: over.seedSize ?? perDirSize() })

  const baseExists = (p: string): boolean =>
    (typeof over.exists === 'function' ? over.exists(p) : over.exists ?? true)
  const parentOf = (p: string): string => {
    const i = p.lastIndexOf('/')
    return i <= 0 ? '' : p.slice(0, i)
  }
  const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
  const under = (prefix: string, p: string): boolean => p === prefix || p.startsWith(prefix + '/')

  /** `listDirs` 的基础读数（旧入口 `dirs` 保留兼容；缺省"没有子目录"）。 */
  const baseNames = (p: string): string[] =>
    (typeof over.dirs === 'function' ? over.dirs(p) : over.dirs ?? [])

  /** 直接子目录名 =（基础读数 ∪ 世界里在的子目录）− 世界里已墓碑的子目录。 */
  const listDirsOf = (p: string): string[] => {
    const out = new Set(baseNames(p))
    for (const dir of present.keys()) if (parentOf(dir) === p) out.add(nameOf(dir))
    for (const dir of absent) if (parentOf(dir) === p) out.delete(nameOf(dir))
    return [...out]
  }

  /** `sizeOfDir`：世界认得这个目录 ⇒ 按世界求和（自己 + 后代）；不认得 ⇒ 扁平缺省。 */
  const sizeOfDirOf = (p: string): number => {
    const self = present.get(p)
    if (self === undefined) return perDirSize()
    let total = self.size
    const prefix = p + '/'
    for (const [dir, node] of present) if (dir.startsWith(prefix)) total += node.size
    return total
  }

  /** `exists`：基础读数为真、且没被写操作搬走/删掉（墓碑）才为真。 */
  const existsOf = (p: string): boolean => baseExists(p) && !absent.has(p)

  /** `rename` 真搬：源子树从世界里摘掉、落墓碑；目标子树先清出世界（含墓碑）再接上搬来的，size 跟随。 */
  const moveTree = (from: string, to: string): void => {
    // 源的自身字节 = 它在世界里的 size；不在世界里 = 扁平缺省（"size 跟随"就是跟这个值）。
    const ownSize = present.get(from)?.size ?? perDirSize()
    const moved: Array<[string, { size: number }]> = [[to, { size: ownSize }]]
    for (const [dir, node] of present) if (dir.startsWith(from + '/')) moved.push([to + dir.slice(from.length), node])
    // 目标先清出世界（含墓碑）：搬进来即"目标出现"。
    for (const dir of [...present.keys()]) if (under(to, dir)) present.delete(dir)
    for (const dir of [...absent]) if (under(to, dir)) absent.delete(dir)
    // 源子树摘掉、落墓碑：搬走即"源消失"。
    for (const dir of [...present.keys()]) if (under(from, dir)) { present.delete(dir); absent.add(dir) }
    absent.add(from)
    // 搬来的放上去。
    for (const [dir, node] of moved) { absent.delete(dir); present.set(dir, node) }
  }

  /** `removeDir` 真删：整棵子树从世界里摘掉、落墓碑。 */
  const removeTree = (p: string): void => {
    for (const dir of [...present.keys()]) if (under(p, dir)) { present.delete(dir); absent.add(dir) }
    absent.add(p)
  }

  return {
    exists: vi.fn(async (p: string) => existsOf(p)),
    ensureDir: vi.fn(async (p: string) => { record('ensureDir', [p]) }),
    rename: vi.fn(async (from: string, to: string) => { record('rename', [from, to]); moveTree(from, to) }),
    removeDir: vi.fn(async (p: string) => { record('removeDir', [p]); removeTree(p) }),
    sizeOfDir: vi.fn(async (p: string) => { record('sizeOfDir', [p]); return sizeOfDirOf(p) }),
    listFiles: vi.fn(async (p: string) => {
      record('listFiles', [p])
      return typeof over.files === 'function' ? over.files(p) : over.files ?? []
    }),
    listDirs: vi.fn(async (p: string) => {
      record('listDirs', [p])
      return listDirsOf(p)
    }),
    // 内存世界是棵树：没有软链，真实路径就是自己。
    realpath: vi.fn(async (p: string) => (over.realpath === undefined ? p : await over.realpath(p))),
    readFile: vi.fn(async (p: string) => {
      record('readFile', [p])
      if (over.readFile === undefined) throw new Error(`fake fs: 没有为 ${p} 准备 readFile`)
      return over.readFile(p)
    }),
    statFile: vi.fn(async (p: string) => {
      record('statFile', [p])
      if (over.statFile !== undefined) return await over.statFile(p)
      const size = typeof over.fileSize === 'function' ? over.fileSize(p) : over.fileSize ?? 0
      return { size }
    }),
    removeFile: vi.fn(async (p: string) => {
      record('removeFile', [p])
      await over.removeFile?.(p)
    }),
  }
}

export interface FakeDepsOptions extends Omit<FakeHostOptions, 'log' | 'logMethods' | 'format'> {
  /** 清册初值。 */
  seed?: TrashEntry[] | undefined
  /** 宿主数据根（`sessions/` 与 `session-trash/` 都在它下面）。 */
  home?: string | undefined
  /** `Date.now()` 的替身（删除时刻进条目 id，所以要固定）。 */
  now?: number | (() => number) | undefined
  /** 日志与它要记的方法——**fs 与 host 共用一条**，于是"fs 的 rename 排在 host 的 archive 之后"这种
   *  跨端口的顺序也能一条断言钉住。 */
  log?: string[] | undefined
  logMethods?: readonly string[] | undefined
  format?: ((method: string, args: readonly unknown[]) => string) | undefined
  /** `FsPort` 的缺省；给了就整个换掉（少数用例要自带一个）。 */
  fs?: FakeFsOptions | undefined
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
 * 一次装配出 `{ deps, host, fs, ledger, manifest }`：**返回值就是 `DeleteDeps`，没有强转**。
 *
 * 这也是"端口窄到可以假"的量尺：这份文件比 `host-port.ts` 的 15 个方法短，说明那 15 个方法没有藏
 * 第二个概念。三个角色切面已就位（`HostIdentityPort` / `HostPresencePort` / `HostCorpusPort`，ADR-0007），
 * 这份假件仍实现复合面——因为它们共用一颗 adapter，用例也只交一个 `deps`。
 *
 * **raw 清单与 `fs` 的路径树世界是两个独立的账**：过去 `dirs` 缺省从**实时**清册行集派生，
 * 于是一行写下回收站目录就"自动出现"——`rename` 只记账不搬、`removeDir` 只记账不删时，"写了行忘了搬目录、
 * rename 后源目录仍在"这类世界观 bug 对经世界跑的动词用例不可见。现在 `dirs` 缺省只从**初值**行集派生
 * （`initRowIds` 快照），此后世界只被**写操作**改变（`rename` 真搬、`removeDir` 真删）——漂移于是可观察。
 * `over.fs.dirs` 仍是"要测漂移自己翻一格"的入口（它声明 `listDirs` 的基础读数），`over.fs.seedDirs`
 * 则是显式声明初值世界（含刻意漂移，优先于缺省行派生）。`manifest` 露出来只给 raw 断言，动词与路由只认
 * `ledger`（真相读 `list()` 先对账，pure 读面（`/orphans` / `/detail`）走 `raw()` 不对账，见 `src/trash/ledger.ts`）。
 */
export function createFakeDeps(over: FakeDepsOptions = {}): {
  deps: FakeDeps
  host: FakeHost
  fs: FakeFs
  ledger: TrashLedger
  manifest: ManifestPort
} {
  const callLog: CallLog = { log: over.log, logMethods: over.logMethods, format: over.format }
  const host = createFakeHost({ ...over, ...callLog })
  const seed = over.seed ?? []
  const rows = createMemoryManifest(seed)
  // 初值行集的**快照**：`dirs` 缺省从它派生（现行为），但世界此后只被写操作改变——
  // 于是"写了行没搬目录"不再让目录自动出现，漂移对经世界跑的用例可见。
  const initRowIds = seed.map((entry) => entry.id)
  const manifest: ManifestPort = {
    list: () => rows.list(),
    add: async (entry) => { await rows.add(entry) },
    remove: async (id) => { await rows.remove(id) },
  }
  const home = over.home ?? '/h'
  const trashRoot = `${home}/${TRASH_DIR_NAME}`
  const fsOver = over.fs ?? {}
  // `seedDirs` 给了就以它为初值世界（显式声明，含刻意漂移），不再从行派生；
  // 没给时缺省世界仍从清册行集派生（`dirs` 的基础读数），此后会被写操作改变。
  // **为什么 `dirs` 与 `seedDirs` 取 union 而不是"`present` 覆盖就遮蔽 `dirs`"**：`listDirs` 是
  // `(dirs基础 ∪ present子目录) − absent`（见 `createFakeFs.listDirsOf`）。若 `present` 一覆盖就遮蔽基础
  // 读数，删除的 `rename` 把 `trashDir` 放进 `present` 会连带遮蔽快照里的**未动过的**初值行目录，
  // `/list` 就丢行——那是误伤，与"seedDirs 优先"要表达的（给了 `seedDirs` 就不再从行派生缺省）无关。
  const hasSeedDirs = fsOver.seedDirs !== undefined
  const fs = createFakeFs({
    ...fsOver,
    dirs: fsOver.dirs ?? (hasSeedDirs ? undefined : (p: string) => (p === trashRoot ? [...initRowIds] : [])),
    ...callLog,
  })
  const ledger = createTrashLedger(manifest, fs, home)
  const now = over.now
  return {
    deps: {
      fs,
      host,
      ledger,
      home,
      presence: createMemberPresence(host),
      now: typeof now === 'function' ? now : () => now ?? 0,
    },
    host,
    fs,
    ledger,
    manifest,
  }
}
