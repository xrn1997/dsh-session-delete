/**
 * 浏览器半的**取数通道**：同源 fetch 宿主 web server 上的 `/dsh-session-delete-api`，
 * 加上信封判别与注入面那一处「展开成裸值」的适配。
 *
 * 通道形状（裁决）：真相/账本/判据全在宿主那边，Node 半用宿主**自己的 web server** 开一条
 * 插件专属前缀路由把六个段名（`list` / `ping` / `orphans` / `detail` / `apply` / `empty`）搬出来
 * （`src/api/dispatch.ts`），浏览器半同源调用。**不是重造后端**：
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
 * 2. **不许值 import 跨插件包**。`error` 在线上就是一段 JSON（`{code, message, details?}`），不是
 *    `RemoteError` 实例——所以判别**所依据的那一个标记位**只镜一份，家在两半共用的
 *    `src/shared/wire.ts`（`isDSHRemoteError`）。浏览器半落到本地时用 `throwRemoteFailure` 就地补上
 *    Error 本体与标记位；Node 半（`src/remote/map-error.ts`）只用它做「这已经是一次远程失败」的判别，
 *    产出的是线上那三件（`details` 可缺席）、不造任何 Error，更不 import 宿主那个类。
 * 3. **失败原文必须能上屏**。调用方（`callRemote`）只把**抛出来的失败**收成判别式状态——
 *    `{ ok: false, error }` 不是第三种落地：它在注入面那一处已经被 `unwrapRemoteResult` 抛成了异常，
 *    所以到了组件面前只剩「裸值 / throw」两支，调用方只写 `if (!outcome.ok)`，正常流里没有 try/catch；
 *    非本信封形状的异常（网络层、TypeError…）也不丢原文（见 `failureOf`）。
 *
 * 面（`list` / `ping` / `orphans` / `detail` / `apply` / `empty`）与 Node 半路由的六个段名一一对应（段名本身的家是
 * `src/shared/wire.ts`）；`list` 回一行行的条目，`ping` 只回一个探针值，`orphans` 回一份**纯读**的
 * 残留扫描报告，`detail` 回单条正文，
 * `apply` 回**一组逐条结果**，`empty` 回聚合回执。2026-10-17 之前是六个动作段（一条一段），
 * 批量只能由调用方循环拼——那正是「恢复 100 条很慢」的形状来源，收成一段之后这条通道不再有
 * "第二条执行路径"。**清理无主子会话也不另开一段**：它是 `apply` 的第五个动作，`orphans` 只负责
 * "有多少、在哪、多大"。
 */
import {
  PARAMS,
  ROUTES,
  SESSION_DELETE_API_PREFIX,
  isDSHRemoteError,
  type ApplyAction,
  type ApplyOutcome,
  type ApplyValueByAction,
  type OrphanReportWire,
  type PurgeStatsWire,
  type RemoteFailure,
  type RemoteResult,
  type TrashDetailWire,
  type TrashRowWire,
} from '../shared/wire.js'
import { CLIENT_UNKNOWN_CODE, missingOutcomeMessage, readSingleReceipt } from './receipt.js'

/**
 * 回收站条目（`/list` 那一行）。**形状的家在 `shared/wire.ts`**（ADR-0003）：这里只是旧名的别名，
 * 所以浏览器半不再自己抄一遍字段；下面几处"只读面"的镜像同理。
 */
export type TrashEntryLike = TrashRowWire

/** 彻底删除的回执（`PurgeStatsWire`）。 */
export type PurgeResultLike = PurgeStatsWire

/**
 * 回收站单条详情（`TrashDetailWire`）。
 *
 * **线上只有"日志里读出来的那几件"**：`deletedAt` / `sizeBytes` / `wasArchived` / 清册 `title` 这些
 * 清册已有的字段一律不过线——组件按 `entryId` 与自己手上那份清单配对，这样"清单里的大小"和
 * "详情里的大小"永远是同一个数，不会因为两次读数不同而各说各话。
 */
export type TrashDetailLike = TrashDetailWire

/* 信封（`RemoteResult`）与失败形状（`RemoteFailure`）、以及标记位判别（`isDSHRemoteError`）都住在
 * `../shared/wire.js`——两半的共同契约只有那一份家。这里只管通道实现。 */

/** 任意异常 → 失败面。非带标记的失败（网络层、TypeError…）也保留原文，绝不吞；带标记的失败把
 *  `details` 第三件一起带出。 */
export function failureOf(reason: unknown): RemoteFailure {
  if (isDSHRemoteError(reason)) {
    return {
      code: reason.code,
      message: String(reason.message),
      ...(reason.details === undefined ? {} : { details: reason.details }),
    }
  }
  if (reason instanceof Error) return { code: CLIENT_UNKNOWN_CODE, message: reason.message }
  return { code: CLIENT_UNKNOWN_CODE, message: String(reason) }
}

/**
 * 信封的失败支 → 一个**抛出来的**失败。
 *
 * 后半句与网关客户端面同形：那边 `error` 是活的 `RemoteError`、`throw result.error` 保持 throw 语义，
 * 网关自己的重建函数 `rebuiltFailure(error) { return new RemoteError(error.code, error.message,
 * error.details) }` 就干这件事。这里多一层：线上递过来的失败必然是**普通对象**（JSON）而不是本 bundle
 * 的 Error 实例，所以就地造一个并打上同一个标记位——**code 与 message 都不丢**，`details` 可选地
 * 跟着走（`code` 是判别依据，`message` 是上屏的原文，`details` 是结构化附带物，见 `shared/wire.ts`）。
 */
function throwRemoteFailure(error: RemoteFailure): never {
  // 过一遍 `unknown` 再判别：判别的收窄若直接落在已具型的 `error` 上，假支会被 TS 窄成 `never`。
  const candidate: unknown = error
  if (isDSHRemoteError(candidate)) {
    // 带标记位的失败**原样抛**——`details` 那件也跟着走（官方 `rebuiltFailure` 同样三件不丢）
    throw candidate
  }
  throw Object.assign(new Error(String(error.message)), {
    code: error.code,
    ...(error.details === undefined ? {} : { details: error.details }),
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

/** 本插件前缀路由那套**响应信封**的窄镜像（不是宿主服务 `ctx.remote.*`——那条 typert 通道为什么用不了，见 `AGENTS.md` 的 `remote.<namespace>` 那条）：
 *  每个方法 resolve 成 `RemoteResult<T>`。
 *
 * 2026-10-17 批量重构：写动词收成**一个 `apply`**（一段管所有动作、一组 id 进、逐条结果出），
 * 再加一段**纯探测** `ping`；2026-10-19 又加一段**纯读扫描** `orphans` ⇒ 面是六段：
 * `list` / `ping` / `orphans` / `detail` / `apply` / `empty`（原先六个动作段）。 */
export interface RawSessionDeleteRemote {
  list(): Promise<RemoteResult<TrashEntryLike[]>>
  /** 通道的"在不在"：一次零成本的 GET（探测专用，见 `src/api/dispatch.ts` 的 `ping` 支）。 */
  ping(): Promise<RemoteResult<string>>
  /** 纯读：回收站之外的无主子会话扫描。它**不清理**——清理是 `apply` 的 `orphan-clean` 动作，
   *  这一段只交回"有多少、在哪、多大"（读不到语料时报 `io`，调用方不许把它折成"零条残留"）。 */
  orphans(): Promise<RemoteResult<OrphanReportWire>>
  detail(entryId: string): Promise<RemoteResult<TrashDetailLike>>
  /** 一组 id 上的同一个动作。顶层信封的 `ok:false` 只表示**整次调用**没办成（路由自检、栅栏之外）；
   *  单条动作的成败住在 `ApplyOutcome` 里——这是批量接口的判据，别在信封层找它。 */
  apply(action: ApplyAction, ids: readonly string[]): Promise<RemoteResult<ApplyOutcome[]>>
  /** 清空回收站：聚合回执，不按条回。 */
  empty(): Promise<RemoteResult<PurgeResultLike>>
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
    ping: () => requestEnvelope<string>(prefix + ROUTES.ping, { method: 'GET' }),
    orphans: () => requestEnvelope<OrphanReportWire>(prefix + ROUTES.orphans, { method: 'GET' }),
    detail: (entryId) =>
      requestEnvelope<TrashDetailLike>(prefix + ROUTES.detail, post({ [PARAMS.entryId]: entryId })),
    apply: (action, ids) =>
      requestEnvelope<ApplyOutcome[]>(prefix + ROUTES.apply, post({ [PARAMS.action]: action, [PARAMS.ids]: [...ids] })),
    empty: () => requestEnvelope<PurgeResultLike>(prefix + ROUTES.empty, post({})),
  }
}

/**
 * 取数通道探测：一次 `GET /ping` 走通（或走到）就是"通道在"。
 *
 * 判据是**「拿到信封」而不是「操作成功」**：`{ok:false, error}` 也是一次成功的往返（路由在、依赖接上了、
 * 错误映射也生效了），那时该做的是把入口显示出来、让原文上屏；只有往返本身失败才算通道缺席 ⇒
 * 一个槽位贡献都不注册（docs/architecture.md §3「通道探测决定入口出现与否」）。
 *
 * 2026-10-17：探测从"读一遍清单"改成这一问——**每次页面加载都跑全表对账**是白付的钱，
 * 而"信封到不到"这件事一次零成本的 GET 就答得出来。
 */
export async function probeChannel(raw: RawSessionDeleteRemote): Promise<boolean> {
  try {
    await raw.ping()
    return true
  } catch {
    return false
  }
}

/** `shared/wire.ts` 的 `ApplyOutcome` 与那份扫描报告从这里转出去——浏览器半只认 `remote.js` 这一扇门。 */
export type { ApplyAction, ApplyOutcome, OrphanReportWire } from '../shared/wire.js'

/**
 * N=1 的成功支：`null` 已被 `receipt.ts` 的单条读法折成协议错，所以 `value` 必然非空。
 * 不再需要条件类型把 `delete` / `restore` 的 null 抠掉——那份判据只住回执读法一处。
 */
export type OneShotSuccess<A extends ApplyAction> = {
  readonly id: string
  readonly action: A
  readonly ok: true
  readonly value: Exclude<ApplyValueByAction[A], null>
}

/**
 * 注入面（`deps`）的 interface：**与六个段名一一对应的五个方法**（`ping` 只给探测用，留在 raw 层）。
 *
 * **不再有 N=1 的便捷方法**：`delete` / `restore` / `countSubagents` 曾是同一段
 * `/apply` 的三种写法，于是一个 `module` 里同一个动作有两条路（回收站面板的 deps 同时躺着
 * `applyOutcomes` 与 `restore`）。现在单条非写调用（如 `count`）走自由函数 {@link applyOne}；
 * 写动作走 `src/client/write.ts` 的 `runWrite`，而不是让 interface 多背三个方法。
 */
export interface SessionDeleteRemote {
  list(): Promise<TrashEntryLike[]>
  /** 回收站之外的无主子会话报告（纯读）。读不到就是 throw —— 界面上那是**一次失败的检查**，
   *  不是"零条残留"（把 `io` 折成空报告等于把"不知道"说成"没有"）。 */
  scanOrphans(): Promise<OrphanReportWire>
  detail(entryId: string): Promise<TrashDetailLike>
  /** 一段管所有写动作（2026-10-17 批量重构）：一次调用把整批办完，逐条结果原样交回组件。 */
  applyOutcomes(action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]>
  /** 清空回收站（聚合回执）。 */
  emptyTrash(): Promise<PurgeResultLike>
}

/** 需要那一段 `/apply` 的组件只要这一段 deps（单条非写调用见 {@link applyOne}，写动作走 `./write.js` 的 `runWrite`）。 */
export type OneShotDeps = Pick<SessionDeleteRemote, 'applyOutcomes'>

/**
 * **N=1 的 `apply`**：一个动作 + 一个 id → 那一条的成功支（`value` 必然非空）。
 *
 * 三件事各归一个家：
 * - **按发出去的那个 id** 取结果（取"第一条"会把别条的成败安在这条头上）；
 * - 成/败/幂等/缺失与「单条 null 是协议错」的判读只走 {@link readSingleReceipt}；
 * - 这里只把 verdict 折成「拿到值 / 抛失败」。
 */
export async function applyOne<A extends ApplyAction>(deps: OneShotDeps, action: A, id: string): Promise<OneShotSuccess<A>> {
  const outcomes = await deps.applyOutcomes(action, [id])
  const verdict = readSingleReceipt(action, id, outcomes).byId.get(id)
  // `readSingleReceipt` 保证每个请求 id 都有一条 verdict；这一支只为类型收窄（别删）。
  if (verdict === undefined) throw new Error(missingOutcomeMessage(action, id))
  if (verdict.kind === 'failed' || verdict.kind === 'neutral') throwRemoteFailure(verdict.error)
  if (verdict.kind === 'missing') throw new Error(verdict.message)
  return { id, action, ok: true, value: verdict.value } as OneShotSuccess<A>
}

/**
 * 注入面的**唯一一处适配**：`RemoteResult` → 裸值。
 *
 * **为什么必须有这一步**：通道那头的调用 resolve 成 `RemoteResult<T>`（`{ ok: true, value }` /
 * `{ ok: false, error }`），失败是**返回**而不是 reject。组件面要的是「拿到值 / 抛异常」，
 * 所以在这里展开一次：`ok ? value : throw`。
 */
export function buildDeps(raw: RawSessionDeleteRemote): SessionDeleteRemote {
  /** 一次 `apply`：顶层信封先展开（那是"这次调用办没办成"），逐条结果原样交给调用方。 */
  const applyOnce = async (action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]> => {
    const result = await raw.apply(action, ids)
    if (!result.ok) throwRemoteFailure(result.error)
    return result.value
  }
  return {
    list: () => raw.list().then((result) => unwrapRemoteResult(result)),
    scanOrphans: () => raw.orphans().then((result) => unwrapRemoteResult(result)),
    detail: (entryId) => raw.detail(entryId).then((result) => unwrapRemoteResult(result)),
    applyOutcomes: applyOnce,
    emptyTrash: () => raw.empty().then((result) => unwrapRemoteResult(result)),
  }
}

/** 「删除」确认框的宿主只需要那一段 `/apply`：删除前那一次计数走 {@link applyOne}；
 *  提交删除走 `src/client/write.ts` 的 `runWrite`。 */
export type DeleteConfirmDeps = OneShotDeps
