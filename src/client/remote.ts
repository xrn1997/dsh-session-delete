/**
 * 浏览器半的**取数通道**：同源 fetch 宿主 web server 上的 `/dsh-session-delete-api`，
 * 加上信封判别与注入面那一处「展开成裸值」的适配。
 *
 * 通道形状（裁决）：真相/账本/判据全在宿主那边，Node 半用宿主**自己的 web server** 开一条
 * 插件专属前缀路由把四个动词搬出来（`src/api/dispatch.ts`），浏览器半同源调用。**不是重造后端**：
 * 路由层只做搬运与信封。为什么不用官方的 `remote.<namespace>`：那条路要**生成的 Typert 远程描述符**
 * 加一次 `$mount`，而盒内装配清单写死在 `dsh-api-remotes` 里、全宿主没有动态发现，第三方只能自挂自，
 * 对一个薄插件不划算。
 *
 * 三条约束决定了这个文件长这样：
 *
 * 1. **信封刻意与官方 unary 面同形**：`{ ok: true, value }` / `{ ok: false, error }`。这不是"还留着
 *    官方通道"——它现在是**我们两半之间**的 wire 契约（Node 半按它产出，见 `src/api/dispatch.ts`），
 *    选它是为了让组件面、`unwrapRemoteResult` 与既有用例一行都不用改。失败是**返回**而不是
 *    reject（同宿主网关原文："Every unary call resolves to `RemoteResult<T>` … and never rejects for a
 *    carrier problem"）；只有往返本身失败（打不通、回的不是信封）才 reject，那是**通道缺席**。
 * 2. **不许值 import 跨插件包**。`error` 在线上就是一段 JSON（`{code, message}`），不是 `RemoteError`
 *    实例——所以判别**所依据的那一个标记位**只镜一份，家在两半共用的 `src/shared/wire.ts`
 *    （`isDSHRemoteError`）。浏览器半落到本地时用 `throwRemoteFailure` 就地补上 Error 本体与标记位；
 *    Node 半（`src/remote/map-error.ts`）只用它做「这已经是一次远程失败」的判别，产出的是线上那两件、
 *    不造任何 Error，更不 import 宿主那个类。
 * 3. **失败原文必须能上屏**。调用方（`callRemote`）只把**抛出来的失败**收成判别式状态——
 *    `{ ok: false, error }` 不是第三种落地：它在注入面那一处已经被 `unwrapRemoteResult` 抛成了异常，
 *    所以到了组件面前只剩「裸值 / throw」两支，调用方只写 `if (!outcome.ok)`，正常流里没有 try/catch；
 *    非本信封形状的异常（网络层、TypeError…）也不丢原文（见 `failureOf`）。
 *
 * 面（`list`/`delete`/`restore`/`purge`）与 Node 半路由的四个段名一一对应（段名本身的家是
 * `src/shared/wire.ts`）；`list/delete/restore` 回 `TrashEntry`，`purge` 回 `PurgeResult`。
 */
import {
  PARAMS,
  ROUTES,
  SESSION_DELETE_API_PREFIX,
  isDSHRemoteError,
  type RemoteFailure,
  type RemoteResult,
} from '../shared/wire.js'

/** 回收站条目（镜像 `src/trash/entry.ts` 的 `TrashEntry`；只读面）。 */
export interface TrashEntryLike {
  id: string
  sessionId: string
  projectDir: string
  workspaceId: string
  wasArchived: boolean
  deletedAt: number
  title: string
  sizeBytes: number
}

/** 彻底删除的回执（镜像 `PurgeResult`）。 */
export interface PurgeResultLike {
  removed: number
  freedBytes: number
}

/* 信封（`RemoteResult`）与失败形状（`RemoteFailure`）、以及标记位判别（`isDSHRemoteError`）都住在
 * `../shared/wire.js`——两半的共同契约只有那一份家。这里只管通道实现。 */

/** 任意异常 → 失败面。非带标记的失败（网络层、TypeError…）也保留原文，绝不吞。 */
export function failureOf(reason: unknown): RemoteFailure {
  if (isDSHRemoteError(reason)) return { code: reason.code, message: String(reason.message) }
  if (reason instanceof Error) return { code: 'client/unknown', message: reason.message }
  return { code: 'client/unknown', message: String(reason) }
}

/**
 * 信封的失败支 → 一个**抛出来的**失败。
 *
 * 后半句与网关客户端面同形：那边 `error` 是活的 `RemoteError`、`throw result.error` 保持 throw 语义，
 * 网关自己的重建函数 `rebuiltFailure(error) { return new RemoteError(error.code, error.message,
 * error.details) }` 就干这件事。这里多一层：线上递过来的失败必然是**普通对象**（JSON）而不是本 bundle
 * 的 Error 实例，所以就地造一个并打上同一个标记位——**code 与 message 都不丢**
 * （`code` 是判别依据，`message` 是上屏的原文；本插件的线上形状没有 `details`，见 `shared/wire.ts`）。
 */
function throwRemoteFailure(error: RemoteFailure): never {
  // 过一遍 `unknown` 再判别：判别的收窄若直接落在已具型的 `error` 上，假支会被 TS 窄成 `never`。
  const candidate: unknown = error
  if (isDSHRemoteError(candidate)) throw candidate
  throw Object.assign(new Error(String(error.message)), {
    code: error.code,
    isDSHRemoteError: true,
  })
}

/** 注入面用的那一处展开：`ok ? value : throw Object.assign(new Error(error.message), { code })`。 */
export function unwrapRemoteResult<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throwRemoteFailure(result.error)
}

/** 一次远程调用的落地面：要么值，要么失败——调用方只做状态检查。 */
export type RemoteOutcome<T> = { ok: true; value: T } | { ok: false; failure: RemoteFailure }

/**
 * 跑一次远程调用，把两种落地（值 / 抛出的失败）收成一个状态。
 *
 * 「返回的失败」在这里不再是一种落地：`{ ok: false, error }` 已在注入面被 `unwrapRemoteResult`
 * 抛成了异常，所以到这一层的只有裸值或 throw——判别留在 `failureOf` 里（带标记位的失败带出它自己的
 * code，其余按原文兜底）。
 */
export async function callRemote<T>(run: () => Promise<T>): Promise<RemoteOutcome<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (reason) {
    return { ok: false, failure: failureOf(reason) }
  }
}

/** 本插件前缀路由那套**响应信封**的窄镜像（不是宿主服务 `ctx.remote.*`——那条 typert 通道见 §10）：
 *  每个方法 resolve 成 `RemoteResult<T>`。 */
export interface RawSessionDeleteRemote {
  list(): Promise<RemoteResult<TrashEntryLike[]>>
  delete(sessionId: string): Promise<RemoteResult<TrashEntryLike>>
  restore(entryId: string): Promise<RemoteResult<TrashEntryLike>>
  purge(entryId?: string): Promise<RemoteResult<PurgeResultLike>>
}

/* ── 通道实现：同源 fetch 我们自己的前缀路由 ─────────────── */

/**
 * 一次 HTTP 往返 → 信封。**`ok:false` 也是落地**（返回，不抛）；只有往返本身失败才抛：
 * 打不通（宿主没起来 / 路由没挂）或回的不是信封（前缀路由缺席时请求会落到 SPA 兜底处理器上，
 * 回的是 index.html）。两种抛都带原文，组件侧的 `failureOf` 会把它们显示成 `client/unknown` + 原因。
 */
async function requestEnvelope<T>(path: string, init: RequestInit): Promise<RemoteResult<T>> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (reason) {
    throw new Error(`取数通道打不通：${reason instanceof Error ? reason.message : String(reason)}`)
  }
  try {
    return (await response.json()) as RemoteResult<T>
  } catch {
    throw new Error(`取数通道回的不是信封（HTTP ${String(response.status)}）`)
  }
}

/**
 * 前缀路由的 fetch 实现。**相对路径**：不拼 base、不认 origin——页面本身就是从宿主 web server
 * 加载的，同源是这条薄线的全部前提（也是它敢不带凭据的原因：宿主那行 URL 上的 browser-trust token
 * 不是这条通道的凭据，栅栏在 Node 半那一侧按 Origin/Referer 判）。
 */
export function createHttpRemote(prefix: string = SESSION_DELETE_API_PREFIX): RawSessionDeleteRemote {
  const post = (body: Record<string, unknown>): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return {
    list: () => requestEnvelope<TrashEntryLike[]>(prefix + ROUTES.list, { method: 'GET' }),
    delete: (sessionId) =>
      requestEnvelope<TrashEntryLike>(prefix + ROUTES.delete, post({ [PARAMS.sessionId]: sessionId })),
    restore: (entryId) =>
      requestEnvelope<TrashEntryLike>(prefix + ROUTES.restore, post({ [PARAMS.entryId]: entryId })),
    purge: (entryId) =>
      requestEnvelope<PurgeResultLike>(
        prefix + ROUTES.purge,
        post(entryId === undefined ? {} : { [PARAMS.entryId]: entryId }),
      ),
  }
}

/**
 * 取数通道探测：一次 `list` 走通（或走到）就是"通道在"。
 *
 * 判据是**「拿到信封」而不是「操作成功」**：`{ok:false, error}` 也是一次成功的往返（路由在、依赖接上了、
 * 错误映射也生效了），那时该做的是把入口显示出来、让原文上屏；只有往返本身失败才算通道缺席 ⇒
 * 一个槽位贡献都不注册（设计稿 §7「未接通态」）。
 */
export async function probeChannel(raw: RawSessionDeleteRemote): Promise<boolean> {
  try {
    await raw.list()
    return true
  } catch {
    return false
  }
}

/** 组件面（展开后）：同一个面，失败以 throw 表达。成员与上面一字不差。 */
export interface SessionDeleteRemote {
  list(): Promise<TrashEntryLike[]>
  delete(sessionId: string): Promise<TrashEntryLike>
  restore(entryId: string): Promise<TrashEntryLike>
  purge(entryId?: string): Promise<PurgeResultLike>
}

/**
 * 注入面的**唯一一处适配**：`RemoteResult` → 裸值。
 *
 * **为什么必须有这一步**：通道那头的调用 resolve 成 `RemoteResult<T>`（`{ ok: true, value }` /
 * `{ ok: false, error }`），失败是**返回**而不是 reject。组件面要的是「拿到值 / 抛异常」，
 * 所以在这里展开一次：`ok ? value : throw`。放在这一处而不是组件里，是为了让三个组件的 props 契约
 * （以及钉住它们的用例）保持裸值形状不变。
 */
export function buildDeps(raw: RawSessionDeleteRemote): SessionDeleteRemote {
  return {
    list: () => raw.list().then((result) => unwrapRemoteResult(result)),
    delete: (sessionId) => raw.delete(sessionId).then((result) => unwrapRemoteResult(result)),
    restore: (entryId) => raw.restore(entryId).then((result) => unwrapRemoteResult(result)),
    purge: (entryId) => raw.purge(entryId).then((result) => unwrapRemoteResult(result)),
  }
}

/** 「删除」确认框的宿主只需要「删除」这一件（撤销提示要的 `restore` 在 `undo-toast.tsx` 自己的 deps 里）。 */
export type DeleteConfirmDeps = Pick<SessionDeleteRemote, 'delete'>
