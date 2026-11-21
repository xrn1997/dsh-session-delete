import type { Context } from '@deepseek-ai/cordis'
import {
  createStorageManifest as manifestOverDomain,
  type ManifestPort,
  type StorageDomainLike,
} from './manifest.js'
import type { TrashEntry } from './entry.js'
import { REQUIRED_ENTRY_FIELDS } from './entry.js'

/* ------------------------------------------------------------------ *
 * 清单：宿主 storage domain 的绑定
 * ------------------------------------------------------------------ */

/** 本插件自己的域（CONTEXT.md 的「清册」条：介质落在数据根下的 `storages/`）。**名字必须带插件专属前缀**：domain 名是 facility 里的**全局键**，
 *  一个名字只能 `open()` 一次（句柄归调用方所有）——别人先占了同名域，本插件会**在激活时**抛错，整个插件不工作。前缀取 npm scope（`xrn1997`）。
 *  名字还要过宿主的 `UNIT_NAME_RE`（asar `dsh-storage/lib/index.js` 原文 `/^[a-z][a-z0-9_]*$/`）⇒ 只能小写字母数字下划线。 */
const TRASH_DOMAIN_NAME = 'xrn1997_session_delete_trash'

const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

/**
 * `defineDomain` / `domainTable` 的窄镜像。官方实现在 asar `dsh/node_modules/@deepseek-ai/dsh-storage-domain/lib/index.js`：
 * `domainTable(schema)` 回 `{ valueSchema: schema }`；
 * `defineDomain(spec)` 逐项校验（`UNIT_NAME_RE`、version 为非负整数、`compatibleVersions` 必须低于 version、`layout` ∈ {single, per-record}、
 * `invalidRecords` ∈ {backup-and-skip}、表名同样过 `UNIT_NAME_RE`）后**原样返回 spec**。它是宿主包：跨插件值 import 是红线，它也不在本插件依赖里
 * ⇒ 照原文写一份本地镜像。
 */
function domainTable<T>(schema: T): { valueSchema: T } {
  return { valueSchema: schema }
}

interface DomainSpecLike {
  name: string
  version: number
  layout?: 'single' | 'per-record'
  invalidRecords?: 'backup-and-skip'
  tables: Record<string, { valueSchema: { parse: (value: unknown) => unknown } }>
}

function defineDomain<T extends DomainSpecLike>(spec: T): T {
  if (!UNIT_NAME_RE.test(spec.name)) throw new Error(`domain name '${spec.name}' must match ${UNIT_NAME_RE}`)
  if (!Number.isInteger(spec.version) || spec.version < 0) {
    throw new Error(`domain '${spec.name}' version must be a non-negative integer, got ${spec.version}`)
  }
  // spec 来自宿主/持久化面（过线值）：类型镜像写的是合法联合，运行时却可能带来别的名字；局部放宽成 string 再校验。
  const layout: string | undefined = spec.layout
  if (layout !== undefined && layout !== 'single' && layout !== 'per-record') {
    throw new Error(`domain '${spec.name}' layout must be 'single' or 'per-record', got ${layout}`)
  }
  const invalidRecords: string | undefined = spec.invalidRecords
  if (invalidRecords !== undefined && invalidRecords !== 'backup-and-skip') {
    throw new Error(`domain '${spec.name}' invalidRecords must be 'backup-and-skip' when present`)
  }
  for (const table of Object.keys(spec.tables)) {
    if (!UNIT_NAME_RE.test(table)) throw new Error(`domain '${spec.name}' table name '${table}' must match ${UNIT_NAME_RE}`)
  }
  return spec
}

/**
 * 记录校验器：**域要的那种 schema** 只有一个方法会被域调用——`open()` 里对每条已存记录 `tableSpec.valueSchema.parse(raw)`。
 * 必填那几格的清单**不在这里**，它住在 `src/trash/entry.ts` 紧贴 `TrashEntry` 接口（ADR-0003）——抄一份在这里，运行期校验就看不见接口的变更了。
 *
 * 官方配方里记录 schema 是 **zod**；本仓硬约束不许新增依赖，且 `zod` 解析不到 ⇒ 这里按域要求的**那一个方法**写本地校验器。
 * 这是本插件唯一一处偏离官方配方的地方：换 zod 只需把这张对象换成 `z.object({...})`，`spec` 其余部分一字不动。
 * **本仓的契约面**只提供 `parse`；测试钉不住宿主换用 `safeParse` / `_def` 时仍成立——宿主换代先用真实 `storageDomain.open` 做一次冒烟。
 */
const trashEntrySchema = {
  parse(raw: unknown): TrashEntry {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new TypeError('session trash entry record must be a plain object')
    }
    for (const [field, kind] of Object.entries(REQUIRED_ENTRY_FIELDS)) {
      if (typeof (raw as Record<string, unknown>)[field] !== kind) {
        throw new TypeError(`session trash entry record field "${field}" must be a ${kind}`)
      }
    }
    return raw as unknown as TrashEntry
  },
}

/**
 * 回收站清单的域声明。`layout: 'per-record'` + `invalidRecords: 'backup-and-skip'`：一条坏记录被域层移开并跳过（清单是可丢数据，不该让一份坏文档把整个域开不起来；
 * `single` 布局下没有 `backupRecord`）。同款选择：官方 `session_projcache` 域也是这一对（其 spec 的 JSDoc 明写理由）。
 */
const trashDomainSpec = defineDomain({
  name: TRASH_DOMAIN_NAME,
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: { entries: domainTable(trashEntrySchema) },
})

/** 域句柄的最小面（asar `dsh-storage-domain/lib/index.js` 的 `DomainImpl` / `KvTableImpl`）：`domain.table(name)` → 同步内存读 + put/delete，`domain.close()`。打开语义：
 *  **一个 domain 名在一个 facility 里只能开一次**，句柄归调用方所有、由调用方 `close()`。 */
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
 * 清单的真实绑定：官方 storage domain → `ManifestPort`。域**懒开**且成功句柄只开一次（`apply` 是同步的，而 `open()` 是异步的），
 * 并挂一条 `ctx.effect` 清理：卸载时关掉句柄（句柄归调用方所有；不能 `void` 走掉——没关严会让下一份同名域撞 `already-open`）。
 * **失败不缓存**：`open()` 被拒是瞬态（域被别的持有者占着、装载竞态），缓存 rejected promise 等于"这个会话永远删不掉"——
 * 下一次读重新走 `open()`，成功才落下活句柄。
 */
export function createHostStorageManifest(ctx: Context): ManifestPort {
  const host = ctx as unknown as StorageDomainCtxLike
  let domain: DomainLike | undefined
  let opening: Promise<DomainLike> | undefined
  ctx.effect(() => async () => {
    // 开失败过就没有句柄要关：那条拒绝在这里就地咽掉，不让它从卸载路径上冒出来。
    const handle = (opening !== undefined ? await opening.catch(() => undefined) : undefined) ?? domain
    await handle?.close()
  }, 'session-delete.manifest')
  const table = async (): Promise<DomainTableLike> => {
    if (domain === undefined) {
      opening ??= host.storageDomain.open(trashDomainSpec)
      try {
        domain = await opening
      } finally {
        opening = undefined
      }
    }
    return domain.table('entries')
  }
  const adapter: StorageDomainLike = {
    readAll: async () => [...(await table()).entries()].map(([, record]) => record),
    put: async (record) => { await (await table()).put(record.id, record) },
    delete: async (key) => { await (await table()).delete(key) },
  }
  return manifestOverDomain(adapter)
}
