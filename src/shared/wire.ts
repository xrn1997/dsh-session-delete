/**
 * 跨半 wire 契约：`/dsh-session-delete-api` 的**前缀、五个端点段、请求字段名**——
 * Node 半（`src/api/dispatch.ts` 注册并分发）与浏览器半（`src/client/remote.ts` 同源 fetch）
 * 之间唯一的那份真相。两侧都 import 它，不各写一份字面量。
 *
 * 两条构建期硬约束（不是偏好）：
 *  ① tsdown 的浏览器半纯度门拦 Node 内建与平台模块表外的 `@deepseek-ai/*` 值 import——
 *     本文件两者都不涉及，且**零运行时依赖**（client 半把它整个 inline 进 bundle）；
 *  ② 跨插件一律 `import type`——本文件干脆没有 import。
 *
 * 信封（`RemoteResult`）与失败形状（`RemoteFailure`）也在这里——**因为它们本来就是两半的共同契约**：
 * Node 半按它产出（`src/api/dispatch.ts` 的失败支就是 `RemoteFailure` 那三件），浏览器半按它判别
 * （`src/client/remote.ts` 的 `unwrapRemoteResult` / `failureOf`）。形状取自宿主网关客户端面的原文
 * 「每次 unary 调用 resolve 成 RemoteResult、不为载体问题 reject」，但**它是本仓自己的 wire 契约**，
 * 不是对宿主模块的 import。
 */

/**
 * 插件专属前缀。
 *
 * 为什么必须带插件名：宿主 web server 的 `register({kind:'prefix', path})` 对**重复的 (kind, path)
 * 直接抛错**（`dsh-host-webserver` 原文 `webserver: duplicate ${route.kind} route "${route.path}"`），
 * 撞了就是整棵插件树 boot 失败——所以这条路径是与生态的硬边界，不是显示好不好看的问题。
 */
export const SESSION_DELETE_API_PREFIX = '/dsh-session-delete-api'

/** 五个段名（相对前缀）。2026-10-17 批量重构：写动词从「一条一段」收成**一段 `/apply`**——
 *  一次 HTTP 带一组 id、逐条回结果；单条就是长度为 1 的批量，仓里不再留第二条执行路径。
 *  - `GET /list`：**对账并读**清单（`session-trash/` 里的目录是准）。
 *  - `GET /ping`：最便宜的在/不在（不碰清册、不碰盘、不进链）——客户端探测用它，不用一次全表读。
 *  - `POST /detail`：单条详情（用 POST 表达一个读：见设计稿 2026-10-15 §3）。
 *  - `POST /apply`：批量执行一个动作（`delete` / `restore` / `purge` / `count`），逐条回 `ApplyOutcome`。
 *  - `POST /empty`：清空回收站（聚合回执，**不**按条回）。 */
export const ROUTES = {
  list: '/list',
  /** 通道的"在不在"专用：没有入参、没有副作用、没有磁盘读。 */
  ping: '/ping',
  /** 单条详情（读回收站目录里那条会话自己的日志）。 */
  detail: '/detail',
  /** 一组 id 上的同一个动作；删除确认框那句「含 N 个子会话」也走这里（`action: 'count'`，纯读语义）。 */
  apply: '/apply',
  /** 清空回收站。 */
  empty: '/empty',
} as const

/** `/apply` 的四个动作。id 的含义随动作走：`delete`/`count` 是**宿主会话 id**（还没进回收站），
 *  `restore`/`purge` 是**回收站条目 id**。 */
export type ApplyAction = 'delete' | 'restore' | 'purge' | 'count'

/** 每个动作的成功值：`count` 是一个数（拿不到就是 0，界面上那半句整句不出现）；
 *  `delete`/`restore` 是回收站那一行（`null` = 这一条已被**同批前一条**带走，幂等 no-op）；
 *  `purge` 是这一组的聚合回执（同批已带走 ⇒ `{removed:0,freedBytes:0}`）。 */
export type ApplyValueByAction = {
  delete: TrashEntryWire | null
  restore: TrashEntryWire | null
  purge: PurgeStatsWire
  count: number
}

/** 一条动作的落地：原始输入 id 一律回带，成败各按信封（成功 `value` / 失败 `error`）。
 *  按 `action` + `ok` 双重可判别——浏览器半的便捷包装靠它把 `value` 收成各自动作的类型。 */
export type ApplyOutcome = { id: string } & {
  [A in ApplyAction]:
    | { action: A; ok: true; value: ApplyValueByAction[A] }
    | { action: A; ok: false; error: RemoteFailure }
}[ApplyAction]

/** `TrashEntry` 的线上形状（浏览器半自己有一份窄镜像 `TrashEntryLike`）。 */
export interface TrashEntryWire {
  id: string
  sessionId: string
  projectDir: string
  workspaceId: string
  wasArchived: boolean
  deletedAt: number
  title: string
  sizeBytes: number
  parentEntryId?: string
}

/** 清空回收站的回执（与旧 `purge` 同形）。 */
export interface PurgeStatsWire {
  removed: number
  freedBytes: number
}

/** 请求体字段名：浏览器半发、Node 半读，同名同义（`empty` 没有入参）。 */
export const PARAMS = {
  entryId: 'entryId',
  action: 'action',
  ids: 'ids',
} as const

/**
 * 失败信封的**线上形状**（设计稿 §6）：`code` 是判别依据、`message` 是上屏原文、
 * `details` 是**可选的结构化附带物**——对齐官方 `rpcErrorSchema` 那三件
 * （`dsh-client-connection` 原文：`z.object({ code, message, details: z.record(z.string(), z.unknown()) })`）。
 * 来历两类：宿主类型化错误自己身上的字段（`WorkspaceActiveSessionError` 的 `sessionId` / `activity`…），
 * 以及动词在抛出处就地给的（`verbError(code, msg, cause, details)`）。没有附带物时**整件缺席**，
 * 不写空表——"带过但为空"和"没有可带的"是两件事。
 */
export interface RemoteFailure {
  code: string
  message: string
  details?: Record<string, unknown>
}

/** 两半之间的一次落地（**信封**）：要么值，要么失败。 */
export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: RemoteFailure }

/**
 * 进程内判别「这已经是一次失败」——**按标记位认，不按 `instanceof`**（跨 realm / 跨 bundle 都不成立）。
 * 位名与判法取自宿主网关客户端面的原文：
 * `if (typeof value === "object" && value !== null && value.isDSHRemoteError === true && typeof value.code === "string") return value`。
 *
 * 线上递过来的是**一段 JSON**（标记位不跟着过线）⇒ 落到哪一端，由那端的构造处就地补上标记：
 * 浏览器半是 `src/client/remote.ts` 的 `throwRemoteFailure`。
 */
export function isDSHRemoteError(value: unknown): value is RemoteFailure {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { isDSHRemoteError?: unknown; code?: unknown }
  return candidate.isDSHRemoteError === true && typeof candidate.code === 'string'
}

/**
 * 宿主 `projectKey` 的 **`~XXXX` 转义还原**。
 *
 * 编码那一半在 Node 侧（`src/ports/host-port.ts` 的 `projectKey`，逐字镜像宿主实现）；这里放与它配对的
 * 解码，客户端渲染回收站组头用它——**字母表只有这一份**，两边不会各自漂移（配对关系由
 * `tests/assembly.test.ts` 的往返用例钉住）。
 *
 * **只还原可还原的那部分**：不在 `[A-Za-z0-9._-]` 里、又不是 `~` 的字符编成 `~` + 4 位大写十六进制码元，
 * 字面 `~` 自己编成 `~007E` ⇒ `~XXXX` 不含歧义。而**分隔符（`/` `\` `:`）被折成一个 `-`，那一段是有损的**，
 * 这里还原不回来——调用方按"尽力显示"用它，别拿它反推真实路径。
 */
export function unescapeProjectKey(encoded: string): string {
  return encoded.replace(
    /~([0-9A-F]{4})/g,
    (_whole, hex: string) => String.fromCharCode(parseInt(hex, 16)),
  )
}
