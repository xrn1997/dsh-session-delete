# 无主子会话维护与彻底删除收尾实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **状态（2026-10-19）**：**已实现**。文中代码片段是计划快照，最终实现以 `src/**`、`tests/**` 与现状稿第十七批及其评审修正批为准；个别片段（`scanOrphans` 的落点、`unarchive` 的 `io` 包装、状态色 token、清单失败时的扫描门控）已在评审修正批改掉。

**Goal:** 让“彻底删除”连带清掉盘上剩下的子会话与后代、并摘掉归档集里的 id；在回收站面板提供一个条件出现的无主子会话扫描与永久清理入口；把回滚失败如实上报；`empty` 先对账。

**Architecture:** Node 半新增 `GET /orphans` 纯读扫描（官方 `sessionQuery.listSessions`）与 `POST /apply` 的 `orphan-clean` 动作（按根 + 传递闭包清理）；`purgeTrash` 把 `subagentMembersBatch` 交回的盘上后代纳入目标，并在删目录前 `unarchive`；浏览器半在清单页顶部条件渲染残留条，预览后调用同一个 `apply` 动作。清单行的 `strandedBytes` 与 purge 的 `releaseBytesOf` 复用同一口径。投影缓存与附件**不在本计划**。

**Tech Stack:** TypeScript / Node 24 / React 18 / vitest（node + jsdom）+ @testing-library/react；宿主服务窄镜像 + cordis；样式只用 `--dsw-*` token。

**Spec:** `docs/design/2026-09-30-session-delete-design.md` 新增**第十七批（2026-10-19 收尾批）**；`docs/design/2026-10-15-trash-detail-design.md` §10/§11/§12 的存量判据。计划与代码冲突时以代码为准，并把设计稿那处改正。

## Global Constraints

- **段名从五个变成六个**：`GET /list`、`GET /ping`、`POST /detail`、`POST /apply`、`POST /empty`、**`GET /orphans`**。`/orphans` 是纯读，不进到达序串行链；`/apply` 的动作从四个变成五个：`delete` / `restore` / `purge` / `count` / **`orphan-clean`**。所有“五个段名 / 四个动作”的注释、测试说明、AGENTS 与 README 都要同步。
- **不自动、不搬进回收站**：无主子会话只在用户点“查看并清理”并二次确认后永久删除；检测不写盘，不能把它做成每次 `/list` 的后台自动删除。
- **检测只走官方面**：`ctx.get('sessionQuery').listSessions()`（live ∪ persisted）；不自扫 `~/.dsh/sessions` 建图。`sessionQuery` 缺席 ⇒ 扫描**响亮失败**（`sessiondelete/io`），不拿空语料冒充“没有”。
- **闭包与活体**：清理目标必须包含孤儿根的**全部后代**；清理前逐条 `isLive`，任一成员在跑 ⇒ 整组拒绝、零副作用。
- **投影缓存与附件不做**：`session_projcache` 没有公开删除面，附件没有引用计数；本次只清会话目录。UI 必须明说这一句。
- **`purge` 的 `removed` 语义扩展**：清册行 + 实际删掉的盘上后代目录都计入 `removed`；`freedBytes` 同样计入盘上后代。清单行的 `strandedBytes` 与 `releaseBytesOf` 必须同源。
- **浏览器半不许 import 任何 `@deepseek-ai/*`**（type-only 也不留）；文案只住 `src/client/copy.ts`，`ZH` 真源 + `EN` 逐键镜像。
- **TDD**：每个任务先写失败用例、跑红、最小实现、跑绿；提交信息中文。
- **每任务收尾三道门**：`npm test`、`npx tsc --noEmit`、`npm run build`，退出码全 0；浏览器半改动**先在带可见浏览器的隔离 home 验**，再交 live 真机门。
- **文档与注释不写机器绝对路径**：用 `~` / `$DSH_HOME`。

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/ports/host-port.ts` | 新增 `listSessions` / `subagentMembersBatch` / `SessionIdentity`；`subagentCounts` 与 `subagentMembers` 共用闭包助手 | 改 |
| `src/verbs/orphan-subagents.ts` | 孤儿分组、闭包、扫描报告、单组清理 | 新建 |
| `src/verbs/purge-trash.ts` | 盘上后代纳入目标、删前 `unarchive`、`removed/freedBytes` 扩展 | 改 |
| `src/verbs/apply.ts` | 新增 `orphan-clean` 分支，逐根结果 | 改 |
| `src/verbs/errors.ts` | `withRollbackFailures`（回滚失败汇总） | 改 |
| `src/verbs/delete-session.ts` | 回滚步骤返回失败清单；不再“回滚失败还通告已恢复” | 改 |
| `src/verbs/restore-session.ts` | 回滚失败汇总（组回滚 + 单成员回滚，与 delete 对称） | 改 |
| `src/api/dispatch.ts` | `GET /orphans`、`orphan-clean`、`empty` 先对账、`strandedBytes` | 改 |
| `src/shared/wire.ts` | 六段名、五动作、`OrphanReportWire` / `OrphanCleanStatsWire` | 改 |
| `src/client/remote.ts` | `orphans()` 原始面 + `scanOrphans()` 裸值面 | 改 |
| `src/client/trash-panel.tsx` | 条件残留条、预览确认框、`strandedBytes` 进合计 | 改 |
| `src/client/copy.ts` | 残留条/确认框 zh+en 文案 | 改 |
| `tests/assembly.test.ts` | 端口接线：`listSessions` / 批量成员 | 改 |
| `tests/orphan-subagents.test.ts` | 扫描闭包、排除清册父、清理与 live 拒绝 | 新建 |
| `tests/purge-trash.test.ts` | 盘上后代、`unarchive`、去重、live | 改 |
| `tests/api.test.ts` | `/orphans`、`orphan-clean`、`empty` 对账、`strandedBytes` | 改 |
| `tests/delete-session.test.ts` | 回滚失败汇总 | 改 |
| `tests/restore-session.test.ts` | 回滚失败汇总 | 改 |
| `tests/client/trash-panel.test.tsx` | 残留条/确认框/合计 | 改 |
| `tests/client/index.test.tsx` | 六段名 fetch 表 | 改 |
| `AGENTS.md` | 六段名 / 五动作 / 本批不变量 | 改 |
| `docs/design/2026-09-30-session-delete-design.md` | 追加第十七批 | 改 |
| `README.md` | 维护入口、purge 连带、手工搬回边界 | 改 |

---

### Task 1: 端口新增会话语料与批量后代

**Files:**
- Modify: `src/ports/host-port.ts`
- Test: `tests/assembly.test.ts`

**Interfaces:**
- Consumes: 现有 `SessionQueryLike` / `descendantsByParent` / `subtreeOf` / `bareSessionId`。
- Produces（后续任务按这些名字消费，一个字都别改）：

```ts
export interface SessionIdentity {
  readonly sessionId: string
  readonly parentSessionId?: string
  readonly projectDir: string
  readonly subagent: boolean
}
export interface SubagentMember {
  readonly sessionId: string
  readonly projectDir: string
}
// HostPort 新增：
listSessions(): Promise<readonly SessionIdentity[] | undefined>
subagentMembersBatch(parentIds: readonly string[]): Promise<Record<string, readonly SubagentMember[]>>
```

- [ ] **Step 1: 写失败用例**

在 `tests/assembly.test.ts` 的 `makeEnv` 参数类型里给 `sessionQuery` 加上：

```ts
  /** `ctx.get('sessionQuery')` 的替身。`listSessions` 给无主子会话扫描；`filterSessions` 给闭包。 */
  sessionQuery?: {
    listSessions?: () => Promise<Array<{ header?: { id?: string; cwd?: string; parentSession?: string; origin?: string } }>>
    filterSessions: (filters: Array<{ kind: string; values: string[] }>) => Promise<Array<{ header: { id?: string; cwd?: string; parentSession?: string } }>>
  }
```

把“十七个方法”改成“十九个方法”，并在数组里补两项：

```ts
      host.subagentCounts(['s1']), host.subagentMembers('s1'),
      host.subagentMembersBatch(['s1']), host.listSessions(),
```

在 `describe('subagentCounts（清单的只读子会话计数）')` 前新增：

```ts
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
      expect(await createHostPort(ctx).listSessions()).toEqual([
        { sessionId: 'session-root', parentSessionId: 'session-gone', projectDir: '--C-p--', subagent: true },
        { sessionId: 'session-kid', parentSessionId: 'session-root', projectDir: '--C-p--', subagent: false },
      ])
    })

    it('sessionQuery 没挂 / 没有 listSessions ⇒ undefined，不冒充空语料', async () => {
      const { ctx } = makeEnv({})
      await expect(createHostPort(ctx).listSessions()).resolves.toBeUndefined()
      const withQuery = makeEnv({ sessionQuery: { filterSessions: async () => [] } })
      await expect(createHostPort(withQuery.ctx).listSessions()).resolves.toBeUndefined()
    })
  })

  describe('subagentMembersBatch（批量点后代）', () => {
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
      expect(await port.subagentMembersBatch(['session-a', 'b'])).toEqual({
        'session-a': [{ sessionId: 'session-k1', projectDir: '_no-cwd' }],
        b: [{ sessionId: 'k2', projectDir: '_no-cwd' }],
      })
      expect(asked).toHaveLength(2) // 第一层 a/b，第二层 k1/k2 问空即停
      asked.length = 0
      expect(await port.subagentMembersBatch([])).toEqual({})
      expect(asked).toHaveLength(0)
    })
  })
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run tests/assembly.test.ts -t "listSessions|subagentMembersBatch"`
Expected: FAIL，`listSessions` / `subagentMembersBatch` 不是函数。

- [ ] **Step 3: 最小实现**

在 `src/ports/host-port.ts` 的 `HostPort` 里、`subagentCounts` 前加：

```ts
  /** 整个会话语料（live ∪ persisted）的只读身份表。**服务缺席回 `undefined`**，不拿空数组冒充
   *  “这个家没有会话”；扫描方必须把缺席当失败。 */
  listSessions(): Promise<readonly SessionIdentity[] | undefined>
  /** 一次 BFS 点出多个父的全部后代；键按调用方传进来的写法回。 */
  subagentMembersBatch(parentIds: readonly string[]): Promise<Record<string, readonly SubagentMember[]>>
```

在文件顶部的 `Descendant` 后加两个导出类型：

```ts
export interface SessionIdentity {
  readonly sessionId: string
  readonly parentSessionId?: string
  readonly projectDir: string
  readonly subagent: boolean
}

export interface SubagentMember {
  readonly sessionId: string
  readonly projectDir: string
}
```

把 `SessionQueryLike` 改成：

```ts
interface SessionQueryLike {
  listSessions(signal?: unknown): Promise<readonly {
    readonly header?: {
      readonly id?: string
      readonly cwd?: string
      readonly parentSession?: string
      readonly origin?: string
    }
  }[]>
  filterSessions(
    filters: readonly { readonly kind: string; readonly values: readonly string[] }[],
  ): Promise<readonly { readonly header?: { readonly id?: string; readonly cwd?: string; readonly parentSession?: string } }[]>
}
```

把 `bareSessionId` 改成导出：

```ts
export function bareSessionId(id: string): string {
  return id.startsWith('session-') ? id.slice('session-'.length) : id
}
```

在 `descendantsByParent` 与 `subtreeOf` 之后加共用的批量助手：

```ts
function toMember(d: Descendant): SubagentMember {
  return { sessionId: d.id, projectDir: d.projectDir }
}

/** `subagentCounts` / `subagentMembers` / `subagentMembersBatch` 共用的一次 BFS。
 *  空清单在调用宿主之前就返回（不为一张空表扫全库）。 */
async function membersFor(
  sessionQuery: SessionQueryLike,
  parentIds: readonly string[],
): Promise<Record<string, readonly Descendant[]>> {
  const wanted: string[] = []
  for (const id of parentIds) if (id.length > 0 && !wanted.includes(id)) wanted.push(id)
  if (wanted.length === 0) return {}
  const children = await descendantsByParent(sessionQuery, wanted)
  const out: Record<string, readonly Descendant[]> = {}
  for (const id of wanted) out[id] = subtreeOf(children, bareSessionId(id))
  return out
}
```

把 `subagentCounts`、`subagentMembers` 改成下面的形状，并新增 `listSessions` / `subagentMembersBatch`：

```ts
    async listSessions() {
      const sessionQuery = host.get('sessionQuery') as SessionQueryLike | undefined
      if (typeof sessionQuery?.listSessions !== 'function') return undefined
      const records = await sessionQuery.listSessions()
      const out: SessionIdentity[] = []
      for (const record of records) {
        const id = record.header?.id
        if (typeof id !== 'string' || id === '') continue
        const parent = record.header?.parentSession
        const cwd = record.header?.cwd
        out.push({
          sessionId: id,
          ...(typeof parent === 'string' && parent !== '' ? { parentSessionId: parent } : {}),
          projectDir: cwd === undefined ? NO_CWD_PROJECT_DIR : projectKey(cwd),
          subagent: record.header?.origin === 'subagent',
        })
      }
      return out
    },

    async subagentCounts(parentIds) {
      const sessionQuery = host.get('sessionQuery') as SessionQueryLike | undefined
      if (typeof sessionQuery?.filterSessions !== 'function') return {}
      const members = await membersFor(sessionQuery, parentIds)
      const counts: Record<string, number> = {}
      for (const [id, list] of Object.entries(members)) if (list.length > 0) counts[id] = list.length
      return counts
    },

    async subagentMembers(sessionId) {
      const sessionQuery = host.get('sessionQuery') as SessionQueryLike | undefined
      if (typeof sessionQuery?.filterSessions !== 'function') return []
      const members = await membersFor(sessionQuery, [sessionId])
      return (members[sessionId] ?? []).map(toMember)
    },

    async subagentMembersBatch(parentIds) {
      const sessionQuery = host.get('sessionQuery') as SessionQueryLike | undefined
      if (typeof sessionQuery?.filterSessions !== 'function') return {}
      const members = await membersFor(sessionQuery, parentIds)
      return Object.fromEntries(
        Object.entries(members).map(([id, list]) => [id, list.map(toMember)]),
      )
    },
```

- [ ] **Step 4: 跑绿**

Run: `npx vitest run tests/assembly.test.ts`
Expected: PASS；原有 `subagentCounts` / `subagentMembers` 用例一条都不改。

- [ ] **Step 5: Commit**

```bash
git add src/ports/host-port.ts tests/assembly.test.ts
git commit -m "feat: 宿主端口补会话语料与批量后代查询"
```

---

### Task 2: 孤儿扫描与单组清理动词

**Files:**
- Create: `src/verbs/orphan-subagents.ts`
- Modify: `src/shared/wire.ts`（只加两个报告类型；路由/动作在 Task 4）
- Test: `tests/orphan-subagents.test.ts`

**Interfaces:**
- Consumes: `HostPort.listSessions()`、`HostPort.isLive`、`HostPort.workspaceOf`、`HostPort.detach`、`HostPort.unarchive`、`HostPort.evictLive`、`HostPort.announceRemoved`、`DeleteDeps`、`sessionDirOf`、`bareSessionId`。
- Produces:

```ts
export interface OrphanMember {
  readonly sessionId: string
  readonly projectDir: string
  readonly bytes: number
}
export interface OrphanGroup {
  readonly root: OrphanMember
  readonly parentSessionId: string
  readonly members: readonly OrphanMember[]
}
export function orphanGroupsOf(
  corpus: readonly SessionIdentity[],
  trashSessionIds: readonly string[],
): Array<{ root: SessionIdentity; parentSessionId: string; members: readonly SessionIdentity[] }>
export async function loadOrphanGroups(deps: DeleteDeps): Promise<readonly OrphanGroup[]>
export function reportOrphans(groups: readonly OrphanGroup[]): OrphanReportWire
export async function cleanOrphanGroup(deps: DeleteDeps, group: OrphanGroup): Promise<OrphanCleanStatsWire>
```

- [ ] **Step 1: 写失败用例**

新建 `tests/orphan-subagents.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  cleanOrphanGroup,
  loadOrphanGroups,
  orphanGroupsOf,
  reportOrphans,
  type OrphanGroup,
} from '../src/verbs/orphan-subagents.js'
import { createMemoryManifest } from '../src/trash/manifest.js'
import type { SessionIdentity } from '../src/ports/host-port.js'
import type { DeleteDeps } from '../src/verbs/delete-session.js'
import type { TrashEntry } from '../src/trash/entry.js'

const HOME = '/h'
const s = (sessionId: string, over: Partial<SessionIdentity> = {}): SessionIdentity => ({
  sessionId, projectDir: '--p--', subagent: true, ...over,
})

function deps(corpus: readonly SessionIdentity[], seed: TrashEntry[] = [], over: Partial<DeleteDeps> = {}) {
  const fs = {
    exists: vi.fn(async () => true),
    sizeOfDir: vi.fn(async () => 100),
    removeDir: vi.fn(async () => {}),
    ensureDir: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    listFiles: vi.fn(async () => []),
    listDirs: vi.fn(async () => []),
    readFile: vi.fn(async () => Buffer.alloc(0)),
  }
  const calls: string[] = []
  const host = {
    listSessions: vi.fn(async () => corpus),
    isLive: vi.fn(async () => false),
    workspaceOf: vi.fn(async (id: string): Promise<string | undefined> => id === 'session-kid' ? 'ws-1' : undefined),
    detach: vi.fn(async (id: string, ws: string) => { calls.push(`detach(${id},${ws})`) }),
    unarchive: vi.fn(async (id: string) => { calls.push(`unarchive(${id})`) }),
    evictLive: vi.fn(async (id: string) => { calls.push(`evictLive(${id})`); return 'not-live' as const }),
    announceRemoved: vi.fn(async (id: string) => { calls.push(`announceRemoved(${id})`) }),
  }
  return {
    fs, host, calls,
    d: { fs, host, manifest: createMemoryManifest(seed), home: HOME, now: () => 1, ...over } as unknown as DeleteDeps,
  }
}

describe('孤儿分组（纯函数）', () => {
  it('根是父不在语料/清册里的 subagent；后代全收；清册里的父不算孤儿', () => {
    const corpus = [
      s('session-root', { parentSessionId: 'session-gone' }),
      s('session-kid', { parentSessionId: 'session-root', subagent: false }),
      s('session-g1', { parentSessionId: 'session-kid', subagent: false }),
      s('session-stranded', { parentSessionId: 'session-trashed' }),
      s('session-normal', { subagent: false }),
    ]
    const groups = orphanGroupsOf(corpus, ['session-trashed'])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.root.sessionId).toBe('session-root')
    expect(groups[0]!.members.map((m) => m.sessionId)).toEqual(['session-root', 'session-kid', 'session-g1'])
    expect(groups[0]!.parentSessionId).toBe('session-gone')
  })

  it('同样父带前缀/不带前缀算同一件事', () => {
    const corpus = [s('session-root', { parentSessionId: 'gone' })]
    expect(orphanGroupsOf(corpus, ['session-gone'])).toEqual([])
    expect(orphanGroupsOf(corpus, [])).toHaveLength(1)
  })
})

describe('扫描报告与清理', () => {
  it('loadOrphanGroups 量字节；report 汇总根、闭包、缺失父与项目分组', async () => {
    const { d } = deps([
      s('session-root', { parentSessionId: 'session-gone' }),
      s('session-kid', { parentSessionId: 'session-root', subagent: false, projectDir: '--q--' }),
    ])
    const groups = await loadOrphanGroups(d)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.members.reduce((n, m) => n + m.bytes, 0)).toBe(200)
    expect(reportOrphans(groups)).toMatchObject({
      roots: ['session-root'], totalSessions: 2, totalBytes: 200, missingParents: 1,
      groups: [{ projectDir: '--p--', sessions: 1, bytes: 100 }, { projectDir: '--q--', sessions: 1, bytes: 100 }],
    })
  })

  it('sessionQuery 没挂 ⇒ io，不拿空语料冒充没有孤儿', async () => {
    const { d } = deps([])
    ;(d as never as { host: { listSessions: ReturnType<typeof vi.fn> } }).host.listSessions =
      vi.fn(async () => undefined)
    await expect(loadOrphanGroups(d)).rejects.toMatchObject({ code: 'sessiondelete/io' })
  })

  it('清理：逐条 live 检查 → unarchive → detach → 删目录并通告', async () => {
    const { d, fs, host, calls } = deps([
      s('session-root', { parentSessionId: 'session-gone' }),
      s('session-kid', { parentSessionId: 'session-root', subagent: false }),
    ])
    const [group] = await loadOrphanGroups(d)
    const result = await cleanOrphanGroup(d, group as OrphanGroup)
    expect(result).toEqual({ removed: 2, freedBytes: 200 })
    expect(calls).toEqual([
      'unarchive(session-root)', 'unarchive(session-kid)',
      'detach(session-kid,ws-1)',
      'evictLive(session-root)', 'announceRemoved(session-root)',
      'evictLive(session-kid)', 'announceRemoved(session-kid)',
    ])
    expect(fs.removeDir).toHaveBeenCalledTimes(2)
    expect(host.isLive).toHaveBeenCalledWith('session-root')
    expect(host.isLive).toHaveBeenCalledWith('session-kid')
  })

  it('任一成员在跑 ⇒ live，零写：unarchive/removeDir 都不许发生', async () => {
    const { d, fs, host } = deps([
      s('session-root', { parentSessionId: 'session-gone' }),
      s('session-kid', { parentSessionId: 'session-root', subagent: false }),
    ])
    const [group] = await loadOrphanGroups(d)
    host.isLive = vi.fn(async (id: string) => id === 'session-kid')
    await expect(cleanOrphanGroup(d, group as OrphanGroup)).rejects.toMatchObject({ code: 'sessiondelete/live' })
    expect(host.unarchive).not.toHaveBeenCalled()
    expect(fs.removeDir).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run tests/orphan-subagents.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 最小实现**

先在 `src/shared/wire.ts` 加两个类型（Task 4 再把它们接进 `ApplyValueByAction` 与路由）：

```ts
export interface OrphanProjectGroupWire {
  projectDir: string
  sessions: number
  bytes: number
}
export interface OrphanReportWire {
  roots: readonly string[]
  totalSessions: number
  totalBytes: number
  missingParents: number
  groups: readonly OrphanProjectGroupWire[]
}
export interface OrphanCleanStatsWire {
  removed: number
  freedBytes: number
}
```

新建 `src/verbs/orphan-subagents.ts`：

```ts
import { bareSessionId, type SessionIdentity } from '../ports/host-port.js'
import type { OrphanCleanStatsWire, OrphanReportWire } from '../shared/wire.js'
import { sessionDirOf } from '../trash/entry.js'
import type { DeleteDeps } from './delete-session.js'
import { verbError } from './errors.js'

export interface OrphanMember {
  readonly sessionId: string
  readonly projectDir: string
  readonly bytes: number
}
export interface OrphanGroup {
  readonly root: OrphanMember
  readonly parentSessionId: string
  readonly members: readonly OrphanMember[]
}

interface RawGroup {
  readonly root: SessionIdentity
  readonly parentSessionId: string
  readonly members: readonly SessionIdentity[]
}

/**
 * 无主子会话 = `origin:"subagent"`、父既不在当前语料（live ∪ persisted）也不在回收站清册里的会话。
 * 根按传递闭包收全部后代；清册里的父是“ stranded ”不是孤儿，留给 purge。
 */
export function orphanGroupsOf(
  corpus: readonly SessionIdentity[],
  trashSessionIds: readonly string[],
): RawGroup[] {
  const known = new Set<string>()
  for (const session of corpus) known.add(bareSessionId(session.sessionId))
  for (const id of trashSessionIds) known.add(bareSessionId(id))

  const children = new Map<string, SessionIdentity[]>()
  for (const session of corpus) {
    const parent = session.parentSessionId
    if (parent === undefined) continue
    const key = bareSessionId(parent)
    const list = children.get(key)
    if (list === undefined) children.set(key, [session])
    else list.push(session)
  }

  const claimed = new Set<string>()
  const groups: RawGroup[] = []
  for (const session of corpus) {
    const parent = session.parentSessionId
    if (!session.subagent || parent === undefined) continue
    if (known.has(bareSessionId(parent))) continue
    if (claimed.has(bareSessionId(session.sessionId))) continue
    const members: SessionIdentity[] = []
    const queue: SessionIdentity[] = [session]
    for (let i = 0; i < queue.length; i += 1) {
      const current = queue[i]!
      const id = bareSessionId(current.sessionId)
      if (claimed.has(id)) continue
      claimed.add(id)
      members.push(current)
      for (const child of children.get(id) ?? []) queue.push(child)
    }
    groups.push({ root: session, parentSessionId: parent, members })
  }
  return groups
}

/** 纯读：调用方应先走一次 `/list` 对账（面板的 refresh 就是这样）；本函数不写清单。
 *  写动作 `orphan-clean` 会自己先 reconcile，避免拿一份过期清册判“父没了”。 */
export async function loadOrphanGroups(deps: DeleteDeps): Promise<readonly OrphanGroup[]> {
  const corpus = await deps.host.listSessions()
  if (corpus === undefined) {
    throw verbError('io', '无主子会话扫描需要宿主的 sessionQuery.listSessions')
  }
  const trash = await deps.manifest.list()
  const groups = orphanGroupsOf(corpus, trash.map((entry) => entry.sessionId))
  const out: OrphanGroup[] = []
  for (const group of groups) {
    const members: OrphanMember[] = []
    for (const member of group.members) {
      const dir = sessionDirOf(member.projectDir, member.sessionId, deps.home)
      const bytes = await deps.fs.exists(dir) ? await deps.fs.sizeOfDir(dir) : 0
      members.push({ sessionId: member.sessionId, projectDir: member.projectDir, bytes })
    }
    out.push({ root: members[0]!, parentSessionId: group.parentSessionId, members })
  }
  return out
}

export function reportOrphans(groups: readonly OrphanGroup[]): OrphanReportWire {
  const projects = new Map<string, { sessions: number; bytes: number }>()
  let totalSessions = 0
  let totalBytes = 0
  for (const group of groups) {
    for (const member of group.members) {
      totalSessions += 1
      totalBytes += member.bytes
      const row = projects.get(member.projectDir) ?? { sessions: 0, bytes: 0 }
      row.sessions += 1
      row.bytes += member.bytes
      projects.set(member.projectDir, row)
    }
  }
  return {
    roots: groups.map((group) => group.root.sessionId),
    totalSessions,
    totalBytes,
    missingParents: new Set(groups.map((group) => bareSessionId(group.parentSessionId))).size,
    groups: [...projects]
      .map(([projectDir, value]) => ({ projectDir, ...value }))
      .sort((a, b) => b.bytes - a.bytes),
  }
}

/**
 * 清一组：先整组 live 准入（零写），再收集目录/字节/账本归属，再 unarchive → detach → 删目录。
 * 任何 preflight 失败都在第一件写之前抛出；删目录之后照 purge 的规矩摘活体并如实通告。
 * 不碰投影缓存与附件。
 */
export async function cleanOrphanGroup(
  deps: DeleteDeps,
  group: OrphanGroup,
): Promise<OrphanCleanStatsWire> {
  for (const member of group.members) {
    if (await deps.host.isLive(member.sessionId)) {
      throw verbError('live', `会话正在运行：${member.sessionId}`)
    }
  }

  const plans: Array<{ sessionId: string; dir: string; bytes: number; workspaceId?: string }> = []
  for (const member of group.members) {
    const dir = sessionDirOf(member.projectDir, member.sessionId, deps.home)
    if (!(await deps.fs.exists(dir))) continue
    const workspaceId = await deps.host.workspaceOf(member.sessionId)
    plans.push({
      sessionId: member.sessionId,
      dir,
      bytes: await deps.fs.sizeOfDir(dir),
      ...(workspaceId === undefined ? {} : { workspaceId }),
    })
  }

  // 归档集在删目录之前摘：失败时目录还在，下一次还能重试；成功后再删就没有“幽灵 id”了。
  for (const member of group.members) await deps.host.unarchive(member.sessionId)
  for (const plan of plans) {
    if (plan.workspaceId !== undefined) await deps.host.detach(plan.sessionId, plan.workspaceId)
  }

  let removed = 0
  let freedBytes = 0
  for (const plan of plans) {
    await deps.fs.removeDir(plan.dir)
    removed += 1
    freedBytes += plan.bytes
    const eviction = await deps.host.evictLive(plan.sessionId)
    if (eviction !== 'unknown') await deps.host.announceRemoved(plan.sessionId)
  }
  return { removed, freedBytes }
}
```

- [ ] **Step 4: 跑绿**

Run: `npx vitest run tests/orphan-subagents.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/verbs/orphan-subagents.ts tests/orphan-subagents.test.ts
git commit -m "feat: 无主子会话扫描与单组清理动词"
```

---

### Task 3: purge 收尾与清单的 `strandedBytes`

**Files:**
- Modify: `src/verbs/purge-trash.ts`
- Modify: `src/api/dispatch.ts`（`TrashRow` / `assembleTrashRows`）
- Test: `tests/purge-trash.test.ts`、`tests/api.test.ts`

**Interfaces:**
- Consumes: `HostPort.subagentMembersBatch`、`HostPort.unarchive`、`HostPort.workspaceOf`、`HostPort.detach`、`HostPort.isLive`、`bareSessionId`、`sessionDirOf`。
- Produces: `TrashRow.strandedBytes?: number`; `purgeTrash` 的 `removed` 含盘上后代目录；`freedBytes` 含这些目录。

- [ ] **Step 1: 写失败用例**

在 `tests/purge-trash.test.ts` 的 `deps` 假 host 里补：

```ts
    subagentMembersBatch: vi.fn(async () => ({})),
```

新增用例：

```ts
  it('盘上还剩的后代跟着一起清：先 unarchive，再删目录，字节与条数都算上', async () => {
    const { d, fs, host } = deps([e('p')])
    host.subagentMembersBatch = vi.fn(async () => ({
      p: [{ sessionId: 'session-kid', projectDir: '--p--' }],
    }))
    const r = await purgeTrash(d)('p')
    expect(r).toEqual({ removed: 2, freedBytes: 1024 })
    expect(host.unarchive).toHaveBeenCalledWith('p')
    expect(host.unarchive).toHaveBeenCalledWith('session-kid')
    expect(fs.removeDir).toHaveBeenCalledWith(sessionDirOf('--p--', 'session-kid', HOME))
  })

  it('盘上后代在跑 ⇒ live，整个条目一条目录都不删', async () => {
    const { d, fs, host } = deps([e('p')])
    host.subagentMembersBatch = vi.fn(async () => ({
      p: [{ sessionId: 'session-kid', projectDir: '--p--' }],
    }))
    host.isLive = vi.fn(async (id: string) => id === 'session-kid')
    await expect(purgeTrash(d)('p')).rejects.toMatchObject({ code: 'sessiondelete/live' })
    expect(fs.removeDir).not.toHaveBeenCalled()
  })

  it('清册里已经有的孩子不按盘上后代重复删', async () => {
    const parent = e('p')
    const kid = { ...e('k'), parentEntryId: 'p' }
    const { d, fs, host } = deps([parent, kid])
    host.subagentMembersBatch = vi.fn(async () => ({
      p: [{ sessionId: 'k', projectDir: '--p--' }],
    }))
    await purgeTrash(d)('p')
    expect(fs.removeDir).toHaveBeenCalledTimes(2) // p 与 k 的回收站目录，不是 3
    expect(fs.removeDir).not.toHaveBeenCalledWith(sessionDirOf('--p--', 'k', HOME))
  })

  it('unarchive 失败 ⇒ io，目录与清册行都不动', async () => {
    const { d, fs, host } = deps([e('p')])
    host.unarchive = vi.fn(async () => { throw new Error('archive boom') })
    await expect(purgeTrash(d)('p')).rejects.toMatchObject({ code: 'sessiondelete/io' })
    expect(fs.removeDir).not.toHaveBeenCalled()
    expect(await (d as never as { manifest: { list(): Promise<unknown[]> } }).manifest.list()).toHaveLength(1)
  })
```

把 `deps` 里的 `fs`/host 补上 `sessionDirOf` 的 import：

```ts
import { sessionDirOf } from '../src/trash/entry.js'
```

在 `tests/api.test.ts` 的 `makeDeps` 假 host 里补：

```ts
    subagentMembersBatch: vi.fn(async (_parentIds: readonly string[]) => over.members ?? {}),
```

并把 `makeDeps` 的 `over` 类型改成：

```ts
function makeDeps(over: {
  seed?: TrashEntry[]
  live?: boolean
  subagents?: Record<string, number>
  members?: Record<string, Array<{ sessionId: string; projectDir: string }>>
  workspaceExists?: boolean
} = {}) {
```

把 `subagentCounts` 的替身改成从 `over.members` 派生，保留 `over.subagents` 的旧用例：

```ts
    subagentCounts: vi.fn(async (_parentIds: readonly string[]) =>
      over.subagents ?? Object.fromEntries(
        Object.entries(over.members ?? {}).map(([id, list]) => [id, list.length]),
      )),
```

把“GET /list 只列父行”那条的 `subagents` 改成 `members`：

```ts
    const { deps, host } = makeDeps({
      seed: [parent, ...kids],
      members: {
        'session-parent': [
          { sessionId: 'session-kidA', projectDir: '--p--' },
          { sessionId: 'session-kidB', projectDir: '--p--' },
        ],
      },
    })
    ...
    expect(rows[0]).toMatchObject({
      subagentCount: 2, subagentBytes: 1000,
      strandedSubagents: 2, strandedBytes: 448 * 1024,
    })
    expect(host.subagentMembersBatch).toHaveBeenCalledTimes(1)
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run tests/purge-trash.test.ts tests/api.test.ts -t "strandedBytes|盘上还剩|清册里已经有"`
Expected: FAIL，`subagentMembersBatch` 未被调用、`removed` 仍为 1、`strandedBytes` 缺席。

- [ ] **Step 3: 最小实现**

在 `src/verbs/purge-trash.ts` 把整个 `purgeTrash` 换成：

```ts
import { trashDirOf, sessionDirOf, type TrashEntry } from '../trash/entry.js'
import { bareSessionId } from '../ports/host-port.js'
import type { DeleteDeps } from './delete-session.js'
import { verbError } from './errors.js'

export function purgeTrash(deps: DeleteDeps) {
  return async function purgeTrash(
    entryId?: string,
    snapshot?: TrashEntry[],
  ): Promise<{ removed: number; freedBytes: number }> {
    const all = snapshot ?? await deps.manifest.list()
    const targets: TrashEntry[] = entryId
      ? all.filter(e => e.id === entryId || e.parentEntryId === entryId)
      : [...all]
    if (entryId && targets.length === 0) throw verbError('trash-empty', `回收站里没有这一条：${entryId}`)

    const manifestIds = new Set(targets.map(entry => bareSessionId(entry.sessionId)))
    const membersByParent = await deps.host.subagentMembersBatch(targets.map(entry => entry.sessionId))
    const seenDisk = new Set<string>()
    const diskPlans: Array<{ sessionId: string; dir: string; bytes: number; workspaceId?: string }> = []

    for (const entry of targets) {
      for (const member of membersByParent[entry.sessionId] ?? []) {
        const bare = bareSessionId(member.sessionId)
        if (manifestIds.has(bare) || seenDisk.has(bare)) continue
        seenDisk.add(bare)
        if (await deps.host.isLive(member.sessionId)) {
          throw verbError('live', `会话正在运行：${member.sessionId}`)
        }
        const dir = sessionDirOf(member.projectDir, member.sessionId, deps.home)
        if (!(await deps.fs.exists(dir))) continue
        const workspaceId = await deps.host.workspaceOf(member.sessionId)
        diskPlans.push({
          sessionId: member.sessionId,
          dir,
          bytes: await deps.fs.sizeOfDir(dir),
          ...(workspaceId === undefined ? {} : { workspaceId }),
        })
      }
    }

    // 归档集在删目录之前摘；失败时目录还在，重试还能清。盘上后代本来没被删过，账本也可能是挂着的。
    for (const entry of targets) {
      await deps.host.unarchive(entry.sessionId).catch((error) => {
        throw verbError('io', `取消归档失败：${String(error)}`, error)
      })
    }
    for (const plan of diskPlans) {
      await deps.host.unarchive(plan.sessionId).catch((error) => {
        throw verbError('io', `取消归档失败：${String(error)}`, error)
      })
    }
    for (const plan of diskPlans) {
      if (plan.workspaceId !== undefined) await deps.host.detach(plan.sessionId, plan.workspaceId)
    }

    let freedBytes = 0
    let removed = 0
    for (const entry of targets) {
      const dir = trashDirOf(entry.id, deps.home)
      if (await deps.fs.exists(dir)) {
        freedBytes += await deps.fs.sizeOfDir(dir)
        await deps.fs.removeDir(dir).catch((error) => {
          throw verbError('io', `删除回收站目录失败：${String(error)}`, error)
        })
      }
      await deps.manifest.remove(entry.id)
      removed += 1
      const eviction = await deps.host.evictLive(entry.sessionId)
      if (eviction !== 'unknown') await deps.host.announceRemoved(entry.sessionId)
    }
    for (const plan of diskPlans) {
      await deps.fs.removeDir(plan.dir).catch((error) => {
        throw verbError('io', `删除盘上后代目录失败：${String(error)}`, error)
      })
      removed += 1
      freedBytes += plan.bytes
      const eviction = await deps.host.evictLive(plan.sessionId)
      if (eviction !== 'unknown') await deps.host.announceRemoved(plan.sessionId)
    }
    return { removed, freedBytes }
  }
}
```

在 `src/api/dispatch.ts` 的 `TrashRow` 里加：

```ts
  /** 那些盘上后代的实际字节合计；清空/彻底删除会一起释放。 */
  readonly strandedBytes?: number
```

把 `assembleTrashRows` 的取数段改成：

```ts
  const [membersByParent, missingByRowId] = await Promise.all([
    deps.host.subagentMembersBatch(visible.map(row => row.sessionId)),
    Promise.all(visible.map(async (row) => [row.id, await isWorkspaceMissing(deps.host, row)] as const)),
  ])
  const stranded = new Map<string, { count: number; bytes: number }>()
  for (const row of visible) {
    const members = membersByParent[row.sessionId] ?? []
    let bytes = 0
    for (const member of members) {
      const dir = sessionDirOf(member.projectDir, member.sessionId, deps.home)
      if (await deps.fs.exists(dir)) bytes += await deps.fs.sizeOfDir(dir)
    }
    if (members.length > 0) stranded.set(row.id, { count: members.length, bytes })
  }
  const gone = new Map(missingByRowId)
  return visible.map((row) => {
    const kids = kidsByParent.get(row.id)
    const info = stranded.get(row.id)
    const missing = gone.get(row.id) === true
    if (kids === undefined && info === undefined && !missing) return row
    return {
      ...row,
      ...(kids === undefined ? {} : {
        subagentCount: kids.length,
        subagentBytes: kids.reduce((total, kid) => total + kid.sizeBytes, 0),
      }),
      ...(info === undefined ? {} : { strandedSubagents: info.count, strandedBytes: info.bytes }),
      ...(missing ? { workspaceMissing: true } : {}),
    }
  })
```

`src/api/dispatch.ts` 顶部补 import：

```ts
import { sessionDirOf } from '../trash/entry.js'
```

- [ ] **Step 4: 跑绿**

Run: `npx vitest run tests/purge-trash.test.ts tests/api.test.ts`
Expected: PASS；旧 `purge` 用例的 `removed` 仍等于清册行数（没有盘上后代时）。

- [ ] **Step 5: Commit**

```bash
git add src/verbs/purge-trash.ts src/api/dispatch.ts tests/purge-trash.test.ts tests/api.test.ts
git commit -m "fix: 彻底删除连带盘上后代并摘归档集"
```

---

### Task 4: 六段名、`orphan-clean` 与 `empty` 对账

**Files:**
- Modify: `src/shared/wire.ts`
- Modify: `src/api/dispatch.ts`
- Modify: `src/verbs/apply.ts`
- Test: `tests/api.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `loadOrphanGroups` / `cleanOrphanGroup`；Task 1 的 `listSessions`。
- Produces:

```ts
export const ROUTES = {
  list: '/list', ping: '/ping', detail: '/detail', apply: '/apply', empty: '/empty', orphans: '/orphans',
} as const
export type ApplyAction = 'delete' | 'restore' | 'purge' | 'count' | 'orphan-clean'
export interface OrphanProjectGroupWire { projectDir: string; sessions: number; bytes: number }
export interface OrphanReportWire {
  roots: readonly string[]
  totalSessions: number
  totalBytes: number
  missingParents: number
  groups: readonly OrphanProjectGroupWire[]
}
export interface OrphanCleanStatsWire { removed: number; freedBytes: number }
// ApplyValueByAction 新增：'orphan-clean': OrphanCleanStatsWire
```

- [ ] **Step 1: 写失败用例**

在 `tests/api.test.ts` 的 `makeDeps` 假 host 里补：

```ts
    listSessions: vi.fn(async (_signal?: unknown) => undefined as
      | readonly {
          sessionId: string
          parentSessionId?: string
          projectDir: string
          subagent: boolean
        }[]
      | undefined),
```

新增用例：

```ts
  it('GET /orphans 是纯读：交回闭包总数、字节、项目分组；不删任何东西', async () => {
    const { deps, fs, host, manifest } = makeDeps()
    host.listSessions = vi.fn(async () => [
      { sessionId: 'session-root', parentSessionId: 'session-gone', projectDir: '--p--', subagent: true },
      { sessionId: 'session-kid', parentSessionId: 'session-root', projectDir: '--p--', subagent: false },
    ])
    const base = await start(deps)
    const { status, body } = await call(base, ROUTES.orphans)
    expect(status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      value: {
        roots: ['session-root'], totalSessions: 2, totalBytes: 448 * 1024, missingParents: 1,
        groups: [{ projectDir: '--p--', sessions: 2, bytes: 448 * 1024 }],
      },
    })
    expect(fs.removeDir).not.toHaveBeenCalled()
    expect(await manifest.list()).toEqual([])
  })

  it('GET /orphans 的 sessionQuery 缺席 ⇒ io 信封，不冒充空报告', async () => {
    const { deps } = makeDeps()
    const base = await start(deps)
    const failure = await failureOf(base, ROUTES.orphans)
    expect(failure.code).toBe('sessiondelete/io')
  })

  it('POST /orphans 不是第五个写动作 ⇒ 405', async () => {
    const { deps } = makeDeps()
    const base = await start(deps)
    const { status } = await call(base, ROUTES.orphans, { method: 'POST', body: {} })
    expect(status).toBe(405)
  })

  it('POST /apply orphan-clean：按根清闭包，回逐根字节与条数', async () => {
    const { deps, host, fs } = makeDeps()
    host.listSessions = vi.fn(async () => [
      { sessionId: 'session-root', parentSessionId: 'session-gone', projectDir: '--p--', subagent: true },
      { sessionId: 'session-kid', parentSessionId: 'session-root', projectDir: '--p--', subagent: false },
    ])
    const base = await start(deps)
    const { body } = await call(base, ROUTES.apply, { method: 'POST', body: { [PARAMS.action]: 'orphan-clean', [PARAMS.ids]: ['session-root'] } })
    expect(body.ok).toBe(true)
    expect((body.value as ApplyOutcome[])[0]).toMatchObject({
      action: 'orphan-clean', ok: true, value: { removed: 2, freedBytes: 448 * 1024 },
    })
    expect(fs.removeDir).toHaveBeenCalledTimes(2)
  })

  it('POST /apply orphan-clean：成员在跑 ⇒ live，零删', async () => {
    const { deps, host, fs } = makeDeps()
    host.listSessions = vi.fn(async () => [
      { sessionId: 'session-root', parentSessionId: 'session-gone', projectDir: '--p--', subagent: true },
      { sessionId: 'session-kid', parentSessionId: 'session-root', projectDir: '--p--', subagent: false },
    ])
    host.isLive = vi.fn(async (id: string) => id === 'session-kid')
    const base = await start(deps)
    const failure = await failureOfOutcome(base, ROUTES.apply, {
      method: 'POST', body: { [PARAMS.action]: 'orphan-clean', [PARAMS.ids]: ['session-root'] },
    })
    expect(failure.code).toBe('sessiondelete/live')
    expect(fs.removeDir).not.toHaveBeenCalled()
  })

  it('empty 先对账：只有目录、清册里没有的条目也会被清空带走', async () => {
    const { deps, fs, manifest } = makeDeps()
    const id = entryIdOf('session-ghost')
    fs.listDirs = vi.fn(async () => [id])
    const base = await start(deps)
    const { body } = await call(base, ROUTES.empty, { method: 'POST', body: {} })
    expect(body.ok).toBe(true)
    expect(fs.removeDir).toHaveBeenCalledWith(`/h/session-trash/${id}`)
    expect(await manifest.list()).toEqual([])
  })
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run tests/api.test.ts -t "orphans|orphan-clean|empty 先对账"`
Expected: FAIL，`ROUTES.orphans` 不存在、动作不认识、empty 不删手工目录。

- [ ] **Step 3: 最小实现**

`src/shared/wire.ts`：

```ts
export const ROUTES = {
  list: '/list',
  ping: '/ping',
  detail: '/detail',
  apply: '/apply',
  empty: '/empty',
  /** 纯读：扫描回收站之外的无主子会话（父已不在语料/清册）。 */
  orphans: '/orphans',
} as const

export type ApplyAction = 'delete' | 'restore' | 'purge' | 'count' | 'orphan-clean'

// OrphanProjectGroupWire / OrphanReportWire / OrphanCleanStatsWire 已在 Task 2 加入。

export type ApplyValueByAction = {
  delete: TrashEntryWire | null
  restore: TrashEntryWire | null
  purge: PurgeStatsWire
  count: number
  'orphan-clean': OrphanCleanStatsWire
}
```

把文件头与 `ROUTES` 注释里的“五个段名 / 四个动作”改成六个 / 五个。

`src/verbs/apply.ts`：

```ts
import { cleanOrphanGroup, loadOrphanGroups } from './orphan-subagents.js'
import { reconcileTrash } from '../trash/reconcile.js'
import { verbError } from './errors.js'

export function applyActions(deps: DeleteDeps, action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]> {
  switch (action) {
    case 'delete': return applyDelete(deps, ids)
    case 'restore': return applyRestore(deps, ids)
    case 'purge': return applyPurge(deps, ids)
    case 'count': return applyCount(deps, ids)
    case 'orphan-clean': return applyOrphanClean(deps, ids)
  }
}

async function applyOrphanClean(deps: DeleteDeps, ids: readonly string[]): Promise<ApplyOutcome[]> {
  // 这是写动作，在链上：先对账，别让“刚手工搬进回收站的父目录”被误判成已消失的父。
  await reconcileTrash(deps)
  const groups = await loadOrphanGroups(deps)
  const byRoot = new Map(groups.map(group => [group.root.sessionId, group]))
  const outcomes: ApplyOutcome[] = []
  for (const id of unique(ids)) {
    const group = byRoot.get(id)
    if (group === undefined) {
      outcomes.push(failure(id, 'orphan-clean', verbError('not-found', `不再是可清理的无主子会话：${id}`)))
      continue
    }
    try {
      outcomes.push(success(id, 'orphan-clean', await cleanOrphanGroup(deps, group)))
    } catch (error) {
      outcomes.push(failure(id, 'orphan-clean', error))
    }
  }
  return outcomes
}
```

`src/api/dispatch.ts`：

```ts
import { loadOrphanGroups, reportOrphans } from '../verbs/orphan-subagents.js'

const APPLY_ACTIONS: readonly ApplyAction[] = ['delete', 'restore', 'purge', 'count', 'orphan-clean']
```

`purityOf` 在 `ping` / `detail` 之后加：

```ts
  if (rest === ROUTES.orphans) return { pure: true, body: null }
```

`dispatch` 在 `empty` 前加：

```ts
  if (rest === ROUTES.orphans) {
    requireMethod(method, 'GET', ROUTES.orphans)
    return reportOrphans(await loadOrphanGroups(deps))
  }
```

`empty` 分支改成：

```ts
  if (rest === ROUTES.empty) {
    requireMethod(method, 'POST', ROUTES.empty)
    const rows = await reconcileTrash(deps)
    return await purgeTrash(deps)(undefined, rows)
  }
```

- [ ] **Step 4: 跑绿**

Run: `npx vitest run tests/api.test.ts`
Expected: PASS；`/apply` 的旧动作全部保留。

- [ ] **Step 5: Commit**

```bash
git add src/shared/wire.ts src/verbs/apply.ts src/api/dispatch.ts tests/api.test.ts
git commit -m "feat: 无主子会话扫描路由与清理动作，empty 先对账"
```

---

### Task 5: 浏览器半——残留条、预览确认框、`strandedBytes`

**Files:**
- Modify: `src/client/remote.ts`
- Modify: `src/client/trash-panel.tsx`
- Modify: `src/client/copy.ts`
- Test: `tests/client/trash-panel.test.tsx`、`tests/client/index.test.tsx`

**Interfaces:**
- Consumes: `ROUTES.orphans`、`OrphanReportWire`、`applyOutcomes('orphan-clean', roots)`。
- Produces: `SessionDeleteRemote.scanOrphans()`；`TrashPanelDeps` 多一项 `scanOrphans`；`TrashEntryLike.strandedBytes?: number`。

- [ ] **Step 1: 写失败用例**

`tests/client/trash-panel.test.tsx`：

```tsx
const EMPTY_ORPHANS = { roots: [], totalSessions: 0, totalBytes: 0, missingParents: 0, groups: [] }
const ORPHANS = {
  roots: ['session-root'], totalSessions: 2, totalBytes: 2 * 1024, missingParents: 1,
  groups: [{ projectDir: '--p--', sessions: 2, bytes: 2 * 1024 }],
}

type Deps = {
  list: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  detail: ReturnType<typeof vi.fn>
  applyOutcomes: ReturnType<typeof vi.fn>
  emptyTrash: ReturnType<typeof vi.fn>
  scanOrphans: ReturnType<typeof vi.fn>
}

function makeDeps(over: Partial<Omit<Deps, 'detail'>> & { detail?: ReturnType<typeof vi.fn> } = {}): Deps {
  return {
    list: vi.fn(async () => rows),
    restore: vi.fn(async () => ({})),
    applyOutcomes: vi.fn(async (action: string, ids: readonly string[]) => outcomesOf(action, ids)),
    emptyTrash: vi.fn(async () => ({ removed: 1, freedBytes: 1 })),
    scanOrphans: vi.fn(async () => EMPTY_ORPHANS),
    detail: vi.fn(async () => detailFixture),
    ...over,
  }
}
```

`outcomesOf` 加：

```ts
    const value = action === 'purge' ? { removed: 1, freedBytes: 1 }
      : action === 'count' ? 0
      : action === 'orphan-clean' ? { removed: 1, freedBytes: 1 }
      : {}
```

新增用例：

```tsx
  it('扫描到无主子会话 ⇒ 顶部条件提示；预览后调用 orphan-clean', async () => {
    const deps = makeDeps({ scanOrphans: vi.fn(async () => ORPHANS) })
    renderWide(deps)
    expect(await screen.findByText('回收站之外发现 2 个无主子会话')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看并清理' }))
    expect(screen.getByText('清理 2 个无主子会话？')).toBeInTheDocument()
    expect(screen.getByText('p · 2 个 · 2KB')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清理' }))
    await waitFor(() => expect(deps.applyOutcomes).toHaveBeenCalledWith('orphan-clean', ['session-root']))
  })

  it('没有残留 ⇒ 不出现那条提示', async () => {
    renderWide(makeDeps())
    await waitFor(() => expect(screen.queryByText(/无主子会话/)).not.toBeInTheDocument())
  })

  it('扫描失败 ⇒ 原位上屏并可重试', async () => {
    const scan = vi.fn(async () => { throw Object.assign(new Error('sessionQuery 不在'), { code: 'sessiondelete/io' }) })
    renderWide(makeDeps({ scanOrphans: scan }))
    expect(await screen.findByText(/残留检查\/清理失败：sessionQuery 不在/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(2))
  })

  it('头部合计与单条彻底删除确认都算上 strandedBytes', async () => {
    const row = { ...rows[0]!, strandedSubagents: 2, strandedBytes: 2 * 1024 }
    renderWide(makeDeps({ list: vi.fn(async () => [row]) }))
    expect(await screen.findByText(/共 226KB/)).toBeInTheDocument()
  })
```

`tests/client/index.test.tsx` 的 `rawRemote` 加：

```ts
    orphans: async () => ({
      ok: true,
      value: { roots: [], totalSessions: 0, totalBytes: 0, missingParents: 0, groups: [] },
    }),
```

`installFetch` 的路由表加：

```ts
    [SESSION_DELETE_API_PREFIX + ROUTES.orphans]: async () => raw.orphans(),
```

`okOutcomes` 加：

```ts
    if (action === 'orphan-clean') return { id, action, ok: true as const, value: { removed: 1, freedBytes: 1 } }
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run tests/client/trash-panel.test.tsx tests/client/index.test.tsx -t "无主子会话|strandedBytes|orphan"`
Expected: FAIL，`scanOrphans` 不在依赖面、文案键不存在。

- [ ] **Step 3: 最小实现**

`src/client/remote.ts`：

```ts
import type { ApplyAction, ApplyOutcome, OrphanReportWire, RemoteFailure, RemoteResult } from '../shared/wire.js'

export interface TrashEntryLike {
  // ...
  /** 盘上还留着、没被带走的孩子的字节合计；与 `strandedSubagents` 同源，缺席 = 没有/不知道。 */
  strandedBytes?: number
}

export interface RawSessionDeleteRemote {
  list(): Promise<RemoteResult<TrashEntryLike[]>>
  ping(): Promise<RemoteResult<string>>
  /** 纯读：回收站之外的无主子会话扫描。 */
  orphans(): Promise<RemoteResult<OrphanReportWire>>
  detail(entryId: string): Promise<RemoteResult<TrashDetailLike>>
  apply(action: ApplyAction, ids: readonly string[]): Promise<RemoteResult<ApplyOutcome[]>>
  empty(): Promise<RemoteResult<PurgeResultLike>>
}

export interface SessionDeleteRemote {
  list(): Promise<TrashEntryLike[]>
  scanOrphans(): Promise<OrphanReportWire>
  // ...
}

// createHttpRemote:
    orphans: () => requestEnvelope<OrphanReportWire>(prefix + ROUTES.orphans, { method: 'GET' }),
// buildDeps:
    scanOrphans: () => raw.orphans().then((result) => unwrapRemoteResult(result)),
```

把 `ApplyAction` / `ApplyOutcome` 的 re-export 处补 `OrphanReportWire`：

```ts
export type { ApplyAction, ApplyOutcome, OrphanReportWire } from '../shared/wire.js'
```

`src/client/copy.ts` 的 `ZH` 加：

```ts
  'trash.orphans.banner': '回收站之外发现 {count} 个无主子会话',
  'trash.orphans.meta': '共 {size}，来自 {parents} 个失踪的父会话',
  'trash.orphans.open': '查看并清理',
  'trash.orphans.confirm': '清理 {count} 个无主子会话？',
  'trash.orphans.body': '这些子会话的父会话已不存在，清理后不可恢复。正在运行的子会话会被拒绝，不会被删除。',
  'trash.orphans.group': '{project} · {count} 个 · {size}',
  'trash.orphans.cacheNote': '本次只清理会话目录，不包含宿主投影缓存和附件。',
  'trash.orphans.clean': '清理',
  'trash.orphans.failure': '残留检查/清理失败：{message}',
  'trash.orphans.cleanFailed': '{count} 组未清理：{message}',
```

`EN` 逐键镜像：

```ts
  'trash.orphans.banner': 'Found {count} orphan subagent sessions outside the trash',
  'trash.orphans.meta': '{size} total, from {parents} deleted parent sessions',
  'trash.orphans.open': 'Review and clean',
  'trash.orphans.confirm': 'Clean {count} orphan subagent sessions?',
  'trash.orphans.body': 'Their parent sessions no longer exist; this cannot be undone. Running sessions are refused and left untouched.',
  'trash.orphans.group': '{project} · {count} sessions · {size}',
  'trash.orphans.cacheNote': 'This cleans session directories only; host projection caches and attachments are not included.',
  'trash.orphans.clean': 'Clean',
  'trash.orphans.failure': 'Orphan check/cleanup failed: {message}',
  'trash.orphans.cleanFailed': '{count} groups were not cleaned: {message}',
```

`src/client/trash-panel.tsx`：

```ts
import { type OrphanReportWire } from './remote.js'

export type TrashPanelDeps = Pick<
  SessionDeleteRemote,
  'list' | 'detail' | 'applyOutcomes' | 'emptyTrash' | 'restore' | 'scanOrphans'
>

function releaseBytesOf(entry: TrashEntryLike): number {
  return entry.sizeBytes + (entry.subagentBytes ?? 0) + (entry.strandedBytes ?? 0)
}
```

组件内状态与扫描：

```ts
  const [orphanReport, setOrphanReport] = useState<OrphanReportWire | null>(null)
  const [orphanFailure, setOrphanFailure] = useState<string | null>(null)
  const [orphanConfirm, setOrphanConfirm] = useState(false)
  const orphanScanSeq = useRef(0)
  const scanOrphans = useCallback(async (): Promise<void> => {
    const seq = ++orphanScanSeq.current
    const outcome = await callRemote(() => deps.scanOrphans())
    if (seq !== orphanScanSeq.current) return
    if (!outcome.ok) {
      setOrphanReport(null)
      setOrphanFailure(t('trash.orphans.failure', { message: outcome.failure.message }))
      return
    }
    setOrphanReport(outcome.value)
    setOrphanFailure(null)
  }, [deps, t])
  const refresh = useCallback(async (): Promise<void> => {
    await reload()
    await scanOrphans()
  }, [reload, scanOrphans])
```

把 effect 与动作里的 `await reload()` 改成 `await refresh()`；effect 改成：

```ts
  useEffect(() => {
    void refresh()
  }, [refresh, revision])
```

顶部（`toolbar` 之前）加：

```tsx
      {orphanReport !== null && orphanReport.totalSessions > 0 ? (
        <div
          data-dsh-session-delete="orphan-banner"
          style={{ ...CARD, alignItems: 'flex-start', gap: 12, marginBottom: 10 }}
        >
          <span style={{ display: 'inline-flex', flex: 'none', paddingTop: 2, color: 'var(--dsw-alias-state-warn-primary)' }} aria-hidden="true">
            <IconWarningOutlineRegular size={16} />
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 auto', minWidth: 0 }}>
            <div style={{ fontSize: 13, lineHeight: '19px' }}>
              {t('trash.orphans.banner', { count: orphanReport.totalSessions })}
            </div>
            <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }}>
              {t('trash.orphans.meta', {
                size: fileSizeText(orphanReport.totalBytes),
                parents: orphanReport.missingParents,
              })}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            style={{ flex: 'none' }}
            onClick={() => { setOrphanFailure(null); setOrphanConfirm(true) }}
          >
            {t('trash.orphans.open')}
          </Button>
        </div>
      ) : null}

      {orphanFailure !== null ? (
        <div role="status" style={{ ...CARD, alignItems: 'flex-start', gap: 10, marginBottom: 10, padding: '10px 12px' }}>
          <span style={{ display: 'inline-flex', flex: 'none', color: 'var(--dsw-alias-state-error-primary)' }} aria-hidden="true">
            <IconWarningOutlineRegular size={15} />
          </span>
          <span style={{ flex: '1 1 auto', fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-state-error-primary)' }}>
            {orphanFailure}
          </span>
          <Button variant="outline" size="sm" onClick={() => void scanOrphans()}>{t('common.retry')}</Button>
        </div>
      ) : null}
```

执行：

```ts
  const confirmOrphans = async (): Promise<void> => {
    if (orphanReport === null) return
    setBusy(true)
    const outcome = await callRemote(() => deps.applyOutcomes('orphan-clean', orphanReport.roots))
    setBusy(false)
    setOrphanConfirm(false)
    await refresh()
    if (!outcome.ok) {
      setOrphanFailure(t('trash.orphans.failure', { message: outcome.failure.message }))
      return
    }
    const failures = outcome.value.filter((item): item is Extract<ApplyOutcome, { ok: false }> => !item.ok)
    if (failures.length > 0) {
      setOrphanFailure(t('trash.orphans.cleanFailed', {
        count: failures.length,
        message: failures[0]!.error.message,
      }))
    }
  }
```

在 `pending` 的 `TrashConfirm` 后渲染：

```tsx
      {orphanConfirm && orphanReport !== null ? (
        <OrphanConfirm
          report={orphanReport}
          busy={busy}
          t={t}
          onCancel={() => setOrphanConfirm(false)}
          onConfirm={() => void confirmOrphans()}
        />
      ) : null}
```

文件末尾新增：

```tsx
function OrphanConfirm({
  report,
  busy,
  t,
  onCancel,
  onConfirm,
}: {
  report: OrphanReportWire
  busy: boolean
  t: Translate
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Modal
      open
      onClose={onCancel}
      title={t('trash.orphans.confirm', { count: report.totalSessions })}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="outline" onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" style={BULK_DANGER} disabled={busy} onClick={onConfirm}>
            {t('trash.orphans.clean')}
          </Button>
        </>
      }
    >
      {report.groups.length === 0 ? null : (
        <div
          style={{
            display: 'flex', flexDirection: 'column', gap: 6,
            maxHeight: 280, overflow: 'auto', marginBlockEnd: 10,
          }}
        >
          {report.groups.map((group) => (
            <div key={group.projectDir} style={{ ...CARD, padding: '9px 12px', fontSize: 13, lineHeight: '19px' }}>
              {t('trash.orphans.group', {
                project: projectLabel(group.projectDir, t),
                count: group.sessions,
                size: fileSizeText(group.bytes),
              })}
            </div>
          ))}
        </div>
      )}
      <p>{t('trash.orphans.body')}</p>
      <p style={{ fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)' }}>
        {t('trash.orphans.cacheNote')}
      </p>
    </Modal>
  )
}
```

- [ ] **Step 4: 跑绿**

Run: `npx vitest run tests/client/trash-panel.test.tsx tests/client/index.test.tsx`
Expected: PASS；旧面板交互一条不回归。

- [ ] **Step 5: Commit**

```bash
git add src/client/remote.ts src/client/trash-panel.tsx src/client/copy.ts tests/client/trash-panel.test.tsx tests/client/index.test.tsx
git commit -m "feat: 回收站面板的无主子会话维护入口"
```

---

### Task 6: 回滚失败如实上报

**Files:**
- Modify: `src/verbs/errors.ts`
- Modify: `src/verbs/delete-session.ts`
- Modify: `src/verbs/restore-session.ts`
- Test: `tests/delete-session.test.ts`、`tests/restore-session.test.ts`

**Interfaces:**
- Produces: `withRollbackFailures(error, failures)`；`undoOneIn` / `restoreOne` 的 undo 返回 `readonly string[]`；错误的 `details.rollbackFailures` 可上线。

- [ ] **Step 1: 写失败用例**

先把 `tests/delete-session.test.ts` 的 `failureOf` 返回类型补上
`details?: { rollbackFailures?: string[] }`（否则下一段断言过不了类型检查），再在级联 `describe` 里加：

```ts
  it('回滚本身失败 ⇒ 原错误保留，回滚失败进 details，且不发“已恢复”', async () => {
    const { deps: d } = deps({ host: { subagentMembers: vi.fn(async () => [kidA, kidB]) } })
    ;(d as never as { fs: { rename: ReturnType<typeof vi.fn> } }).fs.rename = vi.fn(
      async (from: string, to: string) => {
        if (to.includes('session-kidB')) throw new Error('EBUSY')
        if (from.includes('session-trash') && to.includes('/sessions/')) throw new Error('EACCES')
      },
    )
    const err = await failureOf(d, 'session-parent')
    expect(err.code).toBe('sessiondelete/io')
    expect(err.details).toMatchObject({ rollbackFailures: [expect.stringContaining('EACCES')] })
    expect((d as never as { host: { announceRestored: ReturnType<typeof vi.fn> } }).host.announceRestored)
      .not.toHaveBeenCalled()
  })
```

在 `tests/restore-session.test.ts` 的组恢复 `describe` 里加；同时给 `world()` 的 `host` 补
`evictLive: vi.fn(async () => 'not-live' as const)`（组回滚的 undo 会调它）：

```ts
  it('组回滚的目录退回失败 ⇒ details 带 rollbackFailures，且不发“已移除”', async () => {
    const { d, fs, host } = world()
    host.attach = vi.fn(async (id: string) => {
      if (id === 'session-kidB') throw new Error('attach boom')
    })
    fs.rename = vi.fn(async (from: string, to: string) => {
      if (from.includes('/sessions/') && to.includes('session-trash')) throw new Error('EACCES')
    })
    const err = await failureOf(d, parent.id)
    expect(err.details).toMatchObject({ rollbackFailures: [expect.stringContaining('EACCES')] })
    expect(host.announceRemoved).not.toHaveBeenCalled()
  })
```

`restore-session.test.ts` 顶部加：

```ts
async function failureOf(d: unknown, entryId: string) {
  try {
    await restoreSession(d as never)(entryId)
  } catch (error) {
    return error as Error & { code?: string; details?: { rollbackFailures?: string[] } }
  }
  throw new Error('expected restoreSession to reject')
}
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run tests/delete-session.test.ts tests/restore-session.test.ts -t "回滚本身失败|组回滚的目录退回失败"`
Expected: FAIL，`details.rollbackFailures` 缺席（或被吞掉）。

- [ ] **Step 3: 最小实现**

`src/verbs/errors.ts` 加：

```ts
/** 原错误保留，回滚失败作为 `details.rollbackFailures` 上线；码仍按原错误的动词码，
 *  没有可继承的就落 io。 */
export function withRollbackFailures(error: unknown, failures: readonly string[]): VerbError {
  const raw = (error as { code?: unknown } | undefined)?.code
  const reason = typeof raw === 'string' && raw.startsWith('sessiondelete/')
    ? raw.slice('sessiondelete/'.length)
    : undefined
  const code = reason !== undefined && (VERB_CODES as readonly string[]).includes(reason)
    ? reason as VerbCode
    : 'io'
  const base = error instanceof Error ? error.message : String(error)
  return verbError(
    code,
    `${base}；回滚未完成：${failures.join('；')}`,
    error,
    { rollbackFailures: [...failures] },
  )
}

export function rollbackReason(label: string, error: unknown): string {
  return `${label}：${error instanceof Error ? error.message : String(error)}`
}
```

`src/verbs/delete-session.ts`：

```ts
type Undo = () => Promise<readonly string[]>
// 文件顶部 import { rollbackReason, verbError, withRollbackFailures } from './errors.js'
// 函数名是单数 rollbackReason；下面各 catch 统一用它。

// rename 失败的 catch：
  } catch (error) {
    const base = verbError('io', `移动会话目录失败：${String(error)}`, error)
    const failures: string[] = []
    if (workspaceId !== undefined) {
      try { await deps.host.attach(sessionId, workspaceId) }
      catch (e) { failures.push(rollbackReason('账本挂回失败', e)) }
    }
    if (!wasArchived) {
      try { await deps.host.unarchive(sessionId) }
      catch (e) { failures.push(rollbackReason('可见性还原失败', e)) }
    }
    throw failures.length > 0 ? withRollbackFailures(base, failures) : base
  }

// manifest.add 失败的 catch：
  } catch (error) {
    const base = verbError('io', `登记回收站条目失败：${String(error)}`, error)
    const failures: string[] = []
    try { await deps.fs.rename(trashDir, sessionDir) }
    catch (e) { failures.push(rollbackReason('目录搬回失败', e)) }
    if (workspaceId !== undefined) {
      try { await deps.host.attach(sessionId, workspaceId) }
      catch (e) { failures.push(rollbackReason('账本挂回失败', e)) }
    }
    if (!wasArchived) {
      try { await deps.host.unarchive(sessionId) }
      catch (e) { failures.push(rollbackReason('可见性还原失败', e)) }
    }
    throw failures.length > 0 ? withRollbackFailures(base, failures) : base
  }

// detach 失败的 catch：
  } catch (error) {
    const base = verbError('io', `摘账本失败：${String(error)}`, error)
    if (!wasArchived) {
      try { await deps.host.unarchive(sessionId) }
      catch (e) { throw withRollbackFailures(base, [rollbackReason('可见性还原失败', e)]) }
    }
    throw base
  }
```

`undoOneIn` 换成：

```ts
async function undoOneIn(deps: DeleteDeps, entry: TrashEntry): Promise<readonly string[]> {
  const sessionDir = sessionDirOf(entry.projectDir, entry.sessionId, deps.home)
  try {
    await deps.fs.rename(trashDirOf(entry.id, deps.home), sessionDir)
  } catch (error) {
    return [rollbackReason('目录搬回失败', error)]
  }
  const failures: string[] = []
  let attached = true
  let visibility = true
  if (entry.workspaceId !== '') {
    try { await deps.host.attach(entry.sessionId, entry.workspaceId) }
    catch (error) { attached = false; failures.push(rollbackReason('账本挂回失败', error)) }
  }
  if (!entry.wasArchived) {
    try { await deps.host.unarchive(entry.sessionId) }
    catch (error) { visibility = false; failures.push(rollbackReason('可见性还原失败', error)) }
  }
  try { await deps.manifest.remove(entry.id) }
  catch (error) { failures.push(rollbackReason('清册行摘除失败', error)) }
  if (attached && visibility) {
    try { await deps.host.announceRestored(entry.sessionId) }
    catch (error) { failures.push(rollbackReason('恢复通告失败', error)) }
  }
  return failures
}
```

组回滚的 catch 改成：

```ts
  } catch (error) {
    const failures: string[] = []
    for (const undo of done.reverse()) failures.push(...await undo())
    if (failures.length > 0) throw withRollbackFailures(error, failures)
    throw error
  }
```

`src/verbs/restore-session.ts`：

```ts
import { rollbackReason, verbError, withRollbackFailures } from './errors.js'

type Undo = () => Promise<readonly string[]>

// ① attach 失败：目录退回回收站；退不回去就进 details。
    } catch (error) {
      if (!isWorkspaceMissingError(error) || await deps.host.workspaceExists(workspaceId)) {
        const base = verbError('io', `挂回账本失败：${String(error)}`, error)
        const failures: string[] = []
        try { await deps.fs.rename(sessionDir, trashDir) }
        catch (e) { failures.push(rollbackReason('目录退回回收站失败', e)) }
        throw failures.length > 0 ? withRollbackFailures(base, failures) : base
      }
    }

// ② unarchive 失败：重新归档、摘账本、目录退回回收站，逐项收集。
    } catch (error) {
      const base = verbError('io', `取消归档失败：${String(error)}`, error)
      const failures: string[] = []
      try { await deps.host.archive(entry.sessionId, workspaceId ?? undefined) }
      catch (e) { failures.push(rollbackReason('重新归档失败', e)) }
      if (attachedTo !== undefined) {
        try { await deps.host.detach(entry.sessionId, attachedTo) }
        catch (e) { failures.push(rollbackReason('摘账本失败', e)) }
      }
      try { await deps.fs.rename(sessionDir, trashDir) }
      catch (e) { failures.push(rollbackReason('目录退回回收站失败', e)) }
      throw failures.length > 0 ? withRollbackFailures(base, failures) : base
    }

// ③ 摘清单行失败：同样回滚三步。
  } catch (error) {
    const base = verbError('io', `摘回收站条目失败：${String(error)}`, error)
    const failures: string[] = []
    if (!entry.wasArchived) {
      try { await deps.host.archive(entry.sessionId, workspaceId ?? undefined) }
      catch (e) { failures.push(rollbackReason('重新归档失败', e)) }
    }
    if (attachedTo !== undefined) {
      try { await deps.host.detach(entry.sessionId, attachedTo) }
      catch (e) { failures.push(rollbackReason('摘账本失败', e)) }
    }
    try { await deps.fs.rename(sessionDir, trashDir) }
    catch (e) { failures.push(rollbackReason('目录退回回收站失败', e)) }
    throw failures.length > 0 ? withRollbackFailures(base, failures) : base
  }

// ④ restoreOne 末尾的反向动作：目录没退回去就不发“已移除”。
  return async (): Promise<readonly string[]> => {
    const failures: string[] = []
    try { await deps.manifest.add(entry) }
    catch (e) { failures.push(rollbackReason('清册行写回失败', e)) }
    if (!entry.wasArchived) {
      try { await deps.host.archive(entry.sessionId, workspaceId ?? undefined) }
      catch (e) { failures.push(rollbackReason('重新归档失败', e)) }
    }
    if (attachedTo !== undefined) {
      try { await deps.host.detach(entry.sessionId, attachedTo) }
      catch (e) { failures.push(rollbackReason('摘账本失败', e)) }
    }
    let movedBack = false
    try {
      await deps.fs.rename(sessionDir, trashDir)
      movedBack = true
    } catch (e) {
      failures.push(rollbackReason('目录退回回收站失败', e))
    }
    if (movedBack) {
      const eviction = await deps.host.evictLive(entry.sessionId).catch(() => 'unknown' as const)
      if (eviction !== 'unknown') await deps.host.announceRemoved(entry.sessionId).catch(() => {})
    }
    return failures
  }

// ⑤ restoreSession 的组回滚 catch。
  } catch (error) {
    const failures: string[] = []
    for (const undo of done.reverse()) failures.push(...await undo())
    if (failures.length > 0) throw withRollbackFailures(error, failures)
    throw error
  }
```

- [ ] **Step 4: 跑绿**

Run: `npx vitest run tests/delete-session.test.ts tests/restore-session.test.ts`
Expected: PASS；成功回滚的老用例调用顺序不变。

- [ ] **Step 5: Commit**

```bash
git add src/verbs/errors.ts src/verbs/delete-session.ts src/verbs/restore-session.ts tests/delete-session.test.ts tests/restore-session.test.ts
git commit -m "fix: 回滚失败如实上报，不再发假通告"
```

---

### Task 7: 文档与不变量

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/design/2026-09-30-session-delete-design.md`
- Modify: `README.md`

- [ ] **Step 1: 改 AGENTS.md**

把薄线那条“2026-10-17 起五个段名”改成：

```md
- **2026-10-19 起六个段名**：`GET /list`、`GET /ping`、`POST /detail`、`POST /apply`（**五个动作**：`delete` / `restore` / `purge` / `count` / `orphan-clean`）、`POST /empty`、`GET /orphans`。`/orphans` 是纯读、不进串行链；`orphan-clean` 是写、进链。**加一段就改这一处**。
```

在硬约束里补一条：

```md
- **无主子会话维护只走官方面**：扫描用 `ctx.get('sessionQuery').listSessions()`（live ∪ persisted），只认 `origin:"subagent"` 且父既不在语料也不在回收站清册的根；清理按传递闭包、逐条 `isLive`，不自动、不搬进回收站。投影缓存与附件不在清理范围（宿主没有公开删除面/引用计数）。
```

把“真相在哪”第 1 条的批次列表末尾补：

```md
**第十七批（2026-10-19）= 收尾批**：`purge` 连带盘上后代 + `unarchive`、`GET /orphans` + `orphan-clean`、回滚失败 `details.rollbackFailures`、`empty` 先对账。
```

- [ ] **Step 2: 追加设计稿第十七批**

在 `docs/design/2026-09-30-session-delete-design.md` 末尾追加：

```md
### 2026-10-19 收尾批（第十七批）：无主子会话、purge 收尾与回滚失败

**存量读数（只读 `~/.dsh`）**：盘面 202 个根 / 221 个闭包会话 / 60.6 MB 日志（202 个根自身是 55.2 MB，19 个后代另 5.4 MB）+ 约 18 MB 投影缓存，31 个父 id 既不在语料也不在清册；客户端对所有 `origin:"subagent"` 隐藏，回收站只列清册行 ⇒ 无任何 UI 路径。另有 68 个归档幽灵 id 与 159 个回收站条目仍留在归档集里。

**裁定**：
1. **`purgeTrash` 收尾**：用 `subagentMembersBatch` 把父行在盘上还剩的后代纳入目标；盘上后代先 `isLive`（任一在跑整条拒绝）、再 `unarchive`/`detach`、再删目录；`removed` 与 `freedBytes` 都算上它们。清单行新增 `strandedBytes`，与 `releaseBytesOf` 同源。
2. **`purge` 顺手摘归档集**：所有目标在删目录前 `unarchive`；宿主 `unarchiveSession` 对未知 id 只 filter（0.2.x 源码实读），所以安全。已有 68 个幽灵不单独立项。
3. **`GET /orphans` + `POST /apply action:"orphan-clean"`**：扫描走官方 `sessionQuery.listSessions`（live ∪ persisted）；根 = `origin:"subagent"` 且父不在语料/清册；清理按闭包，逐条 live，永久删除（不搬进回收站），逐根 `ApplyOutcome`。`/orphans` 纯读、不进链；`orphan-clean` 进链。段名从五个变六个、`apply` 从四个动作变五个。
4. **UI**：只在 `totalSessions > 0` 时出现顶部残留条；点开按项目列数量/字节，二次确认后清理；不自动。文案明说“不包含投影缓存和附件”。
5. **回滚失败**：`withRollbackFailures` 把失败步骤挂进 `details.rollbackFailures`，且目录没退回时不发“已恢复/已移除”。
6. **`empty` 先对账**：`POST /empty` 先 `reconcileTrash` 再 purge，手工放进来的可识别目录也归“清空”管；认不出的目录仍按 §9 口径不动。
7. **手工搬回不是恢复**：下次 `list` 会摘行，但不 attach/unarchive；README FAQ 写清。
8. **不做**：投影缓存清理（无公开面）、附件 GC（无引用计数）、自动清理、把孤儿搬进回收站。
```

- [ ] **Step 3: 改 README**

在功能表加一行：

```md
| 清理回收站之外的残留 | 回收站面板顶部的条件提示 → 「查看并清理」 | 扫描父会话已不存在的子会话；预览后永久清理，不自动执行 |
```

在“数据与安全”附件那条后加：

```md
- **无主子会话不在回收站里**：它们的父会话已不存在，宿主客户端又不显示；面板只在扫描到时出现维护提示。清理只清会话目录，不包含投影缓存和附件。
```

在常见问题里加：

```md
**我把会话目录从回收站手工搬回 `sessions/` 了，为什么列表里没有？**

回收站目录只负责文件；恢复还要挂回工作区账本并按删除前的归档态还原可见性。手工搬回不是恢复，下一次读清单会把对应行对账掉。请在面板里点「恢复」。
```

- [ ] **Step 4: 跑文档门**

Run: `rg -n "五个段名|四个动作|五个端点" src AGENTS.md README.md docs/design/2026-09-30-session-delete-design.md`
Expected: 只剩历史批次的原话；当前状态句已改六段/五动作。历史句不追改。

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md README.md docs/design/2026-09-30-session-delete-design.md
git commit -m "docs: 收尾批的六段名、无主子会话维护与手工搬回边界"
```

---

### Task 8: 收尾门与真机门

**Files:** 无新增；只跑门与记录。

- [ ] **Step 1: 全量单测**

Run: `npm test`
Expected: 全绿；新增用例数记入提交说明。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 退出码 0。

- [ ] **Step 3: 构建**

Run: `npm run build`
Expected: 退出码 0；纯度门过；`lib/types` 产出。

- [ ] **Step 4: 浏览器半隔离 home 验证（agent 侧）**

在带可见浏览器的隔离 home（镜像 live profile 的插件组成）上：
1. 造一个孤儿根（父目录不存在、子目录有日志）与一条正常回收站条目；
2. 打开回收站面板 → 顶部出现「回收站之外发现 N 个无主子会话」；记录从打开面板到残留条出现的时间；超过 300ms 就把扫描拆成“先数条数、点开预览再量字节”的后续项；
3. 点「查看并清理」→ 对话框列出项目分组与字节 → 取消，目录不动；
4. 再打开 → 清理 → 目录被删、提示消失；
5. live 拒绝由 `tests/orphan-subagents.test.ts` / `tests/api.test.ts` 钉住；若隔离台架能造出在跑的子会话，再补一次“清理回 live、目录不动”，造不出就把这条留给真机门；
6. 控制台零 error/warn。
**未跑就写“未跑”，别把构建绿当成真机绿。**

- [ ] **Step 5: 交用户的 live 真机门**

只写最小活路径与编号判据：
1. 打开回收站面板，确认顶部残留条出现（若当前盘面仍有残留）且数字与 `~/.dsh/sessions` 下父缺失的 `origin:"subagent"` 子树一致；
2. 点开预览，项目分组与字节合计合理；取消后目录数量不变；
3. 再点清理，确认目录被删、页面上残留条消失；
4. 对一条正在跑的子会话（若有）清理，应报“会话正在运行”且目录不变；
5. 对一条有盘上后代的回收站父行点「彻底删除」，确认后代目录一起消失，归档集里不再有那些 id（可用宿主归档页/自己的只读探针核对）；
6. 控制台零 error/warn。
真机读数由用户在桌面版上给；本计划不代签。

- [ ] **Step 6: 记录读数**

把用例数、`tsc` / `build` 退出码、隔离 home 的操作读数与“真机门未跑/已由用户跑”的状态写进设计稿第十七批的读数账。**不要**用 `git add -A` 收尾；各任务已按文件提交。

## Self-Review 记录

- **Spec coverage**：`purge` 收尾（Task 3）、`unarchive`（Task 3）、孤儿扫描/清理（Task 2/4/5）、回滚失败（Task 6）、`empty` 对账（Task 4）、手工搬回文档（Task 7）逐项有任务。
- **Placeholder scan**：无 TBD/TODO；每个代码步骤都有可落地的片段或明确的替换点。
- **Type consistency**：`SessionIdentity` / `SubagentMember` / `OrphanGroup` / `OrphanReportWire` / `OrphanCleanStatsWire` 在 Task 1/2/4/5 中同名同形；`strandedBytes` 在服务端 `TrashRow` 与客户端 `TrashEntryLike` 同名。
- **Scope cuts**：投影缓存、附件、自动过期、把孤儿搬进回收站、崩溃意图日志不在本计划；它们各自需要独立决策。
