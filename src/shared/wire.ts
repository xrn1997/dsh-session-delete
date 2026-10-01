/**
 * 跨半 wire 契约：`/dsh-session-delete-api` 的**前缀、四个端点段、请求字段名**——
 * Node 半（`src/api/dispatch.ts` 注册并分发）与浏览器半（`src/client/remote.ts` 同源 fetch）
 * 之间唯一的那份真相。两侧都 import 它，不各写一份字面量。
 *
 * 两条构建期硬约束（不是偏好）：
 *  ① tsdown 的浏览器半纯度门拦 Node 内建与平台模块表外的 `@deepseek-ai/*` 值 import——
 *     本文件两者都不涉及，且**零运行时依赖**（client 半把它整个 inline 进 bundle）；
 *  ② 跨插件一律 `import type`——本文件干脆没有 import。
 *
 * 信封（`RemoteResult`）与失败形状（`RemoteFailure`）也在这里——**因为它们本来就是两半的共同契约**：
 * Node 半按它产出（`src/api/dispatch.ts` 的失败支就是 `RemoteFailure` 那两件），浏览器半按它判别
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

/** 四个端点的段名（相对前缀；`GET list` 读、其余三个 `POST` 写）。 */
export const ROUTES = {
  list: '/list',
  delete: '/delete',
  restore: '/restore',
  purge: '/purge',
} as const

/** 请求体字段名：浏览器半发、Node 半读，同名同义（`purge` 的 `entryId` 缺席 = 清空）。 */
export const PARAMS = {
  sessionId: 'sessionId',
  entryId: 'entryId',
} as const

/**
 * 失败信封的**线上形状**（设计稿 §6）：两半之间只走这两件——`code` 是判别依据
 * （`sessiondelete/<五个码>`），`message` 是上屏原文。**没有 `details`**：本插件的失败没有需要
 * 过线的结构化附带物（原始抛出物只住在 Node 进程里，出不了进程边界）。
 */
export interface RemoteFailure {
  code: string
  message: string
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
