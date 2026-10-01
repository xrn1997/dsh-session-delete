import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { createApiHandler } from './api/dispatch.js'
import { createFsPort } from './ports/fs-port.js'
import { createHostPort } from './ports/host-port.js'
import {
  createStorageManifest as manifestOverDomain,
  type ManifestPort,
  type StorageDomainLike,
} from './trash/manifest.js'
import type { TrashEntry } from './trash/entry.js'
import type { DeleteDeps } from './verbs/delete-session.js'
import { SESSION_DELETE_API_PREFIX } from './shared/wire.js'

export const name = '@xrn1997/dsh-session-delete'

/**
 * 插件依赖：**只写字符串数组**（隔离数据根上实测：写成 `{ required, optional }` 会让插件停在
 * `pending (waiting for services: required, optional)`）。
 *
 * 三项都是在隔离数据根上实测注入成功、且本插件真正用到的宿主服务。三个**故意不写**的：
 * - `remote`：那是**浏览器半**的服务（asar `dsh-api-gateway/lib/client.js`：`super(ctx, "remote")`），
 *   Node 半挂的是 `ctx.typertGateway`。把它写进 Node 半的 inject 会让插件永远 pending（同 `slots` 那次的形状）。
 * - `sessions` / `sessionProjectionCache`：前者本实现不用（活跃判据走 waterfall，见设计稿 §5）；后者是**可选**服务，
 *   官方消费方也按可选读（`ctx.get('sessionProjectionCache')?.…`），inject 一个可能没挂的服务 = 整个插件 pending。
 *   它取不到时 `titleOf` 返回空串，正是契约允许的降级。
 *
 * `webServer` 是**浏览器半取数通道的承载者**（那条薄线）：插件用它注册 `/dsh-session-delete-api`
 * 前缀路由，浏览器半同源 fetch 那四个端点。它是宿主 web 组成里的硬依赖（`dsh-host-webserver` 的
 * `super(ctx, "webServer")`），服务名与 `register({kind:'prefix', path, handler})` 的形状按
 * `dsh-host-webserver/lib/index.js` 与 `README.md` 原文读实，不是猜的。
 */
export const inject = ['workspaceRegistry', 'storageDomain', 'webServer']

/* ------------------------------------------------------------------ *
 * 清单：宿主 storage domain 的绑定
 * ------------------------------------------------------------------ */

/** 本插件自己的域（设计稿 §3：介质落在 `~/.dsh/storages/`）。
 *
 *  **名字必须带插件专属前缀**：domain 名是 `storageDomain` facility 里的**全局键**，而**一个名字在
 *  一个 facility 里只能 `open()` 一次**（句柄归调用方所有）——别人先占了同名域，本插件会**在激活时**
 *  抛错，整个插件不工作。前缀取 npm scope（`xrn1997`），后面接插件与内容。
 *  名字还要过宿主的 `UNIT_NAME_RE`（asar `dsh-storage/lib/index.js` 原文 `/^[a-z][a-z0-9_]*$/`）
 *  ⇒ 只能小写字母数字下划线，`@` / `/` / `-` 都不行。 */
const TRASH_DOMAIN_NAME = 'xrn1997_session_delete_trash'

const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

/**
 * `defineDomain` / `domainTable` 的窄镜像。官方实现在 asar
 * `dsh/node_modules/@deepseek-ai/dsh-storage-domain/lib/index.js`：
 * `function domainTable(schema) { return { valueSchema: schema }; }`；
 * `defineDomain(spec)` 逐项校验（`UNIT_NAME_RE`、version 为非负整数、`compatibleVersions` 必须低于 version、
 * `layout` ∈ {single, per-record}、`invalidRecords` ∈ {backup-and-skip}、表名同样过 `UNIT_NAME_RE`）后**原样返回 spec**。
 * 它是宿主包：跨插件值 import 是红线，它也不在本插件依赖里 ⇒ 照原文写一份本地镜像。
 */
function domainTable<T>(schema: T): { valueSchema: T } {
  return { valueSchema: schema }
}

interface DomainSpecLike {
  name: string
  version: number
  layout?: 'single' | 'per-record'
  invalidRecords?: 'backup-and-skip'
  tables: Record<string, { valueSchema: { parse(value: unknown): unknown } }>
}

function defineDomain<T extends DomainSpecLike>(spec: T): T {
  if (!UNIT_NAME_RE.test(spec.name)) throw new Error(`domain name '${spec.name}' must match ${UNIT_NAME_RE}`)
  if (!Number.isInteger(spec.version) || spec.version < 0) {
    throw new Error(`domain '${spec.name}' version must be a non-negative integer, got ${spec.version}`)
  }
  if (spec.layout !== undefined && spec.layout !== 'single' && spec.layout !== 'per-record') {
    throw new Error(`domain '${spec.name}' layout must be 'single' or 'per-record', got ${spec.layout}`)
  }
  if (spec.invalidRecords !== undefined && spec.invalidRecords !== 'backup-and-skip') {
    throw new Error(`domain '${spec.name}' invalidRecords must be 'backup-and-skip' when present`)
  }
  for (const table of Object.keys(spec.tables)) {
    if (!UNIT_NAME_RE.test(table)) throw new Error(`domain '${spec.name}' table name '${table}' must match ${UNIT_NAME_RE}`)
  }
  return spec
}

/** `TrashEntry` 的字段面（`src/trash/entry.ts` 的接口逐项）。 */
const TRASH_ENTRY_FIELDS = {
  id: 'string', sessionId: 'string', projectDir: 'string', workspaceId: 'string',
  wasArchived: 'boolean', deletedAt: 'number', title: 'string', sizeBytes: 'number',
} as const

/**
 * 记录校验器：**域要的那种 schema** 只有一个方法会被域调用——`open()` 里对每条已存记录
 * `tableSpec.valueSchema.parse(raw)`（官方实现：`parseRecord(spec.name, table, key, () => tableSpec.valueSchema.parse(raw))`）。
 *
 * 官方配方里记录 schema 是 **zod**（`dsh-storage-domain/src/spec.ts` 的 JSDoc 原文："Record schemas are zod"）。
 * 本仓硬约束不许新增依赖，而 `zod` 既不在依赖里、也解析不到（`ERR_MODULE_NOT_FOUND`）⇒ 这里按域要求的**那一个方法**
 * 写一个本地校验器。**这是本插件唯一一处偏离官方配方的地方**：换 zod 只需把这张对象换成 `z.object({...})`，
 * `spec` 其余部分一字不动。
 */
const trashEntrySchema = {
  parse(raw: unknown): TrashEntry {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new TypeError('session trash entry record must be a plain object')
    }
    for (const [field, kind] of Object.entries(TRASH_ENTRY_FIELDS)) {
      if (typeof (raw as Record<string, unknown>)[field] !== kind) {
        throw new TypeError(`session trash entry record field "${field}" must be a ${kind}`)
      }
    }
    return raw as unknown as TrashEntry
  },
}

/**
 * 回收站清单的域声明。
 *
 * `layout: 'per-record'` + `invalidRecords: 'backup-and-skip'`：一条坏记录被域层移开并跳过（清单是可丢数据，
 * 不该让一份坏文档把整个域开不起来）；`single` 布局下没有 `backupRecord`，一条坏记录会让 `open()` 整个失败。
 * 同款选择：官方 `session_projcache` 域也是 `per-record` + `backup-and-skip`（其 spec 的 JSDoc 明写理由）。
 */
const trashDomainSpec = defineDomain({
  name: TRASH_DOMAIN_NAME,
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: { entries: domainTable(trashEntrySchema) },
})

/** 域句柄的最小面（asar `dsh-storage-domain/lib/index.js` 的 `DomainImpl` / `KvTableImpl`）：
 *  `domain.table(name)` → `{ entries(), put(key, value), delete(key) }`（读是同步的内存读面），`domain.close()`。
 *  打开语义：**一个 domain 名在一个 facility 里只能开一次**，句柄归调用方所有、由调用方 `close()`。 */
interface DomainTableLike {
  entries(): IterableIterator<[string, TrashEntry]>
  put(key: string, value: TrashEntry): Promise<void>
  delete(key: string): Promise<boolean>
}
interface DomainLike {
  table(name: string): DomainTableLike
  close(): Promise<void>
}
interface StorageDomainCtxLike {
  storageDomain: { open(spec: unknown): Promise<DomainLike> }
  effect(execute: () => () => unknown, label?: string): unknown
}

/**
 * 清单的真实绑定：官方 storage domain → `ManifestPort`（`StorageDomainLike` 在动词层保持一种读法）。
 * 域**懒开**且只开一次（`apply` 是同步的，而 `open()` 是异步的），并挂一条 `ctx.effect` 清理：
 * 插件卸载时关掉句柄（句柄归调用方所有，这是 `open()` 的 JSDoc 明写的契约）。
 */
export function createStorageManifest(ctx: Context): ManifestPort {
  const host = ctx as unknown as StorageDomainCtxLike
  let opening: Promise<DomainLike> | undefined
  ctx.effect(() => () => {
    void opening?.then(handle => handle.close()).catch(() => { /* 关不掉只说明域已经不在了 */ })
  }, 'session-delete.manifest')
  const table = async (): Promise<DomainTableLike> => {
    opening ??= host.storageDomain.open(trashDomainSpec)
    return (await opening).table('entries')
  }
  const adapter: StorageDomainLike = {
    readAll: async () => [...(await table()).entries()].map(([, record]) => record),
    put: async (record) => { await (await table()).put(record.id, record) },
    delete: async (key) => { await (await table()).delete(key) },
  }
  return manifestOverDomain(adapter)
}

/* ------------------------------------------------------------------ *
 * home：宿主数据根
 * ------------------------------------------------------------------ */

/**
 * 宿主数据根。官方解析器在 asar `dsh/node_modules/@deepseek-ai/dsh-home-paths/lib/index.js`：
 * `resolveDshHome(configured, env)` 的优先级 = 显式配置 > `$DSH_HOME`（**空白视为未设**，免得非法覆盖把 home
 * 解析成当前工作目录）> `~/.dsh`，并 `resolve()` 规范化、展开 `~/`。
 *
 * **只镜像后两级，且这与平台的同款设施等价**——"显式配置"那一级对插件**不可得**，三条实证：
 *  ① 平台自己的 helper `dshHomePath(...segments)` 逐字是 `join(resolveDshHome(), ...segments)`，
 *     **同样不传 `configured`**；
 *  ② `ctx.profileContext` 按 launcher 原文只装「profile 位置 / 启动 bundle 名 / 调用覆盖 / 遥测开关」，
 *     里面没有数据根；
 *  ③ 宿主自己的服务也不是"问出来"的——它们各自声明 `Config.dshHome`，由**装配那一行的人**填。
 * ⇒ 后果与边界（设计稿 §5）：显式配置过的 profile 上我们算出的根与宿主不一致 ⇒ 文件探测落空 ⇒
 * 删除/恢复以 `not-found` **响亮拒绝、零副作用**；**不会**动到别的树（sessions 与回收站同源 ⇒ 同卷）。
 * 本机两条路径都因此对得上：桌面版走 `~/.dsh`（实测 profile 在其下），隔离探针靠 `$DSH_HOME`。
 */
function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME
  const raw = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return resolve(join(homedir(), raw.slice(2)))
  return resolve(raw)
}

/* ------------------------------------------------------------------ *
 * 装配
 * ------------------------------------------------------------------ */

/** 宿主 web server 的窄镜像（只声明用到的那一个成员 + 一次强转；不装宿主类型包）。 */
interface WebServerLike {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * 装配顺序：**清单 → 端口 → 动词依赖 → 前缀路由**（`DeleteDeps` 就是前两者的合一）。
 *
 * 路由用 `ctx.effect` 挂、disposer 归装载它的那根 fiber：插件卸载即摘路由（`register` 返回的
 * disposer 是官方契约）。**同一进程里只注册一次**这件事由宿主把住：重复的 `(kind, path)`
 * 在 `register` 里直接抛（`webserver: duplicate prefix route "…"`），响亮失败而不是悄悄覆盖。
 */
export function apply(ctx: Context): void {
  const deps: DeleteDeps = {
    fs: createFsPort(),
    host: createHostPort(ctx),
    manifest: createStorageManifest(ctx),
    home: resolveHome(),
    now: () => Date.now(),
  }
  const webServer = (ctx as unknown as { webServer: WebServerLike }).webServer
  ctx.effect(() => {
    const dispose = webServer.register({
      kind: 'prefix',
      path: SESSION_DELETE_API_PREFIX,
      handler: createApiHandler(deps),
    })
    return () => { dispose() }
  }, 'session-delete: /dsh-session-delete-api routes')
}
