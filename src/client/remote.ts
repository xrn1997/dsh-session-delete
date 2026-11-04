/**
 * 浏览器半的取数通道：同源 fetch 宿主 `connection.fetch` 的 exact Fetch 路由（`/api` + 插件前缀）。
 * 信封与失败原文在这一层收口。
 *
 * - 九段注册在宿主 `connection.fetch.register` 上，鉴权归宿主 `/api` bridge（ADR-0033）；
 *   没有旧前缀 fallback——支持面是 web UI 与桌面端，二者的标准组合都装 `client-connection`。
 *   官方 remote.<namespace> 仍不可用（第三方拿不到 Typert 描述符的动态发现挂载点）。
 * - 九段的**段名与方法**住 `src/shared/wire.ts` 的结构化段名表（`ROUTES` 每项 `{ path, method }`），
 *   本文件只投影路径（`prefix + ROUTES.x.path`）与方法（GET 段直接取 `ROUTES.x.method`，写段把它
 *   交给 `post()`）——方法字面量不在本文件出现第二份；
 *   写动作统一走 apply；`attachment` 是唯一二进制段，由 `src/client/attachment-view.tsx` 直接拼地址，
 *   不经过本文件的信封通道；`attachment-orphans`（纯读）与 `attachment-clean`（聚合写）是孤儿附件的两段。
 * - 信封与官方 unary 面同形：{ok:true,value} / {ok:false,error}。HTTP 往返本身失败才 reject；
 *   业务失败以信封返回，由 unwrapRemoteResult 在注入面抛出。
 * - error 在线上是 {code,message,details?} 普通对象；判别依据 isDSHRemoteError 住在
 *   src/shared/wire.ts，这里不 import 任何宿主客户端包。
 */
import {
  PARAMS,
  ROUTES,
  OFFICIAL_SESSION_DELETE_API_PREFIX,
  isDSHRemoteError,
  isRemoteResult,
  type ApplyAction,
  type ApplyOutcome,
  type ApplyValueByAction,
  type AttachmentCleanupWire,
  type AttachmentOrphanReportWire,
  type OrphanReportWire,
  type PurgeStatsWire,
  type RemoteFailure,
  type RemoteResult,
  type TrashDetailWire,
  type TrashRowWire,
} from '../shared/wire.js'
import { CLIENT_UNKNOWN_CODE, missingOutcomeMessage, readSingleReceipt } from './receipt.js'

/**
 * 回收站条目（`/list` 那一行）。**形状的家在 `shared/wire.ts`**（ADR-0003）：这里只是别名，
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
 * 例外只有一格：`subagents`（孩子摘要）。孩子不在客户端清单里、无从配对，
 * 它们的清册事实只能随详情过线（issue #7，ADR-0029）。
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
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- 镜像是谎：带标记的失败可能是过线 JSON，message 未必真是 string；String() 是运行时归一，不是类型噪音。
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
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- 故意的非 Error 抛出物：原样抛才不丢 code/details；包成 Error 就是第二套失败面。
    throw candidate
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- 同 `failureOf`：过线 JSON 的 message 未必是 string，运行时归一不能省。
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
 *  每个方法 resolve 成 `RemoteResult<T>`。九个段名里这层走八个 JSON 段：`list` / `ping` / `orphans` / `detail` / `apply` / `empty` /
 *  `attachment-orphans` / `attachment-clean`；写动作统一走 `apply`（一组 id 进、逐条结果出）；
 *  `/attachment` 是二进制段，由 `src/client/attachment-view.tsx` 直接拼地址。 */
export interface RawSessionDeleteRemote {
  list(): Promise<RemoteResult<TrashEntryLike[]>>
  /** 通道的"在不在"：一次零成本的 GET（探测专用，见 `src/api/dispatch.ts` 的 `ping` 支）。 */
  ping(): Promise<RemoteResult<string>>
  /** 纯读：回收站之外的无主子会话扫描。它**不清理**——清理是 `apply` 的 `orphan-clean` 动作，
   *  这一段只交回"有多少、在哪、多大"（读不到语料时报 `io`，调用方不许把它折成"零条残留"）。 */
  orphans(): Promise<RemoteResult<OrphanReportWire>>
  /** 纯读：`.dsh` 内无引用图片对象的数量、字节与预览清单（引用源读不出时报 `io`，不折成 0）。 */
  attachmentOrphans(): Promise<RemoteResult<AttachmentOrphanReportWire>>
  /** 聚合写：只删上一条报告那一刻无引用的图片对象，回 `AttachmentCleanupWire`。 */
  attachmentClean(): Promise<RemoteResult<AttachmentCleanupWire>>
  detail(entryId: string, before?: number): Promise<RemoteResult<TrashDetailLike>>
  /** 一组 id 上的同一个动作。顶层信封的 `ok:false` 只表示**整次调用**没办成（路由自检、栅栏之外）；
   *  单条动作的成败住在 `ApplyOutcome` 里——这是批量接口的判据，别在信封层找它。 */
  apply(action: ApplyAction, ids: readonly string[]): Promise<RemoteResult<ApplyOutcome[]>>
  /** 清空回收站：聚合回执，不按条回。 */
  empty(): Promise<RemoteResult<PurgeResultLike>>
}

/* ── 通道实现：同源 fetch，单一 /api 基础路径 ───────────── */
/* `OFFICIAL_SESSION_DELETE_API_PREFIX` 只从 `wire.ts` 投影；本文件不另写 `/api`、段名或基础路径。 */

/** 宿主 `/api` 的 401/403 是纯文本，不是本插件信封：固定中文原文只住这里（浏览器半唯一消费者）。 */
const UNTRUSTED_MESSAGE = '非受信来源'
const UNAUTHENTICATED_MESSAGE = '需要宿主的 Web 身份：请用 dsh web 打印的那一行 URL 打开页面后重试'

/**
 * 一次 HTTP 往返 → 信封。**`ok:false` 也是落地**（返回，不抛）；只有往返本身失败才抛：
 * 打不通（宿主没起来 / 路由没挂）或回的不是信封（中间层回 `{}` / `{"error":"…"}` 这类非信封 JSON，
 * 或 SPA 兜底的 index.html——判形住 `isRemoteResult`，几种都落同一条诊断）。两种抛都带原文，
 * 组件侧的 `failureOf` 会把它们显示成 `client/unknown` + 原因。
 */
async function requestEnvelope<T>(path: string, init: RequestInit): Promise<RemoteResult<T>> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (reason) {
    // 消息一字不变；只补 `cause`，与 `src/ports/fs-port.ts` 的 EXDEV 那支同一处方。
    throw new Error(`取数通道打不通：${reason instanceof Error ? reason.message : String(reason)}`, { cause: reason })
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    // 非 JSON：落成下面同一个「不是信封」诊断。
    body = undefined
  }
  // 判形不过（中间层回 `{}` / `{"error":"…"}` 这类垃圾）与解析失败同诊断：失败路径正是最需要可读性的地方。
  // 宿主 `/api` bridge 的 401/403 是纯文本：那是身份/归属失败，不是「回的不是信封」；固定原文上屏。
  if (!isRemoteResult(body)) {
    if (response.status === 401) throw new Error(UNAUTHENTICATED_MESSAGE)
    if (response.status === 403) throw new Error(UNTRUSTED_MESSAGE)
    throw new Error(`取数通道回的不是信封（HTTP ${String(response.status)}）`)
  }
  return body as RemoteResult<T>
}

/**
 * exact Fetch 路由的 fetch 实现。**相对路径**：不拼 host、不认 origin——页面本身就是从宿主页面
 * 加载的，同源是这条通道的全部前提；鉴权归宿主 `/api` bridge（ADR-0033）。所以这条通道**只对**
 * 宿主页面打开过、带宿主身份的客户端成立（凭据是那次访问换来的 cookie，不是插件自己的秘密）。
 */
export function createHttpRemote(): RawSessionDeleteRemote {
  const post = (route: { readonly method: 'GET' | 'POST' }, body: Record<string, unknown>): RequestInit => ({
    method: route.method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return {
    // 每段的方法都从段名表投影：GET 段直接取，写段交给 `post()` 带上同一格。
    list: () => requestEnvelope<TrashEntryLike[]>(OFFICIAL_SESSION_DELETE_API_PREFIX + ROUTES.list.path, { method: ROUTES.list.method }),
    ping: () => requestEnvelope<string>(OFFICIAL_SESSION_DELETE_API_PREFIX + ROUTES.ping.path, { method: ROUTES.ping.method }),
    orphans: () =>
      requestEnvelope<OrphanReportWire>(OFFICIAL_SESSION_DELETE_API_PREFIX + ROUTES.orphans.path, { method: ROUTES.orphans.method }),
    attachmentOrphans: () =>
      requestEnvelope<AttachmentOrphanReportWire>(OFFICIAL_SESSION_DELETE_API_PREFIX + ROUTES.attachmentOrphans.path, {
        method: ROUTES.attachmentOrphans.method,
      }),
    // 这一段没有入参；空 JSON 体只是让 POST 与其余写段同一形状（路由表声明 body: none，不读它）。
    attachmentClean: () => requestEnvelope<AttachmentCleanupWire>(
      OFFICIAL_SESSION_DELETE_API_PREFIX + ROUTES.attachmentClean.path,
      post(ROUTES.attachmentClean, {}),
    ),
    detail: (entryId, before) =>
      requestEnvelope<TrashDetailLike>(OFFICIAL_SESSION_DELETE_API_PREFIX + ROUTES.detail.path, post(ROUTES.detail, {
        [PARAMS.entryId]: entryId,
        ...(before === undefined ? {} : { [PARAMS.before]: before }),
      })),
    apply: (action, ids) =>
      requestEnvelope<ApplyOutcome[]>(OFFICIAL_SESSION_DELETE_API_PREFIX + ROUTES.apply.path, post(ROUTES.apply, {
        [PARAMS.action]: action,
        [PARAMS.ids]: [...ids],
      })),
    empty: () => requestEnvelope<PurgeResultLike>(OFFICIAL_SESSION_DELETE_API_PREFIX + ROUTES.empty.path, post(ROUTES.empty, {})),
  }
}

/**
 * 探测唯一通道：一次 `GET /ping` 回成功信封（`pong`）才注册入口。
 *
 * - 401/403 是宿主 `/api` 的纯文本身份/归属失败：入口不出现，不装禁用态。
 * - 失败信封 / 404 / 非信封同样按不可用处理：`/api` 网关对未知路径也可能回错误形状，
 *   不能据此把入口摆出来让每个动作都失败。
 */
export async function probeChannel(raw: RawSessionDeleteRemote): Promise<boolean> {
  try {
    const result = await raw.ping()
    return result.ok && result.value === 'pong'
  } catch {
    return false
  }
}

/** `shared/wire.ts` 的 `ApplyOutcome`、扫描报告与附件回执从这里转出去——浏览器半只认 `remote.js` 这一扇门。 */
export type {
  ApplyAction,
  ApplyOutcome,
  AttachmentCleanupWire,
  AttachmentOrphanReportWire,
  OrphanReportWire,
} from '../shared/wire.js'

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
 * 注入面（`deps`）的 interface：**七个方法**（raw 层另有 `ping` 供探测；九段里的 `/attachment` 由
 * `src/client/attachment-view.tsx` 直接拼地址，也不在这层）。
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
  /** `.dsh` 内无引用图片对象的报告（纯读；预览清单条数由 Node 半配置，默认 200）。读不到就是 throw，同样不许折成 0。 */
  scanAttachmentOrphans(): Promise<AttachmentOrphanReportWire>
  /** 清掉报告那一刻无引用的图片副本（聚合回执）。 */
  cleanAttachmentOrphans(): Promise<AttachmentCleanupWire>
  detail(entryId: string, before?: number): Promise<TrashDetailLike>
  /** 一段管所有写动作：一次调用把整批办完，逐条结果原样交回组件。 */
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
  return { id, action, ok: true, value: verdict.value }
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
    scanAttachmentOrphans: () => raw.attachmentOrphans().then((result) => unwrapRemoteResult(result)),
    cleanAttachmentOrphans: () => raw.attachmentClean().then((result) => unwrapRemoteResult(result)),
    detail: (entryId, before) => raw.detail(entryId, before).then((result) => unwrapRemoteResult(result)),
    applyOutcomes: applyOnce,
    emptyTrash: () => raw.empty().then((result) => unwrapRemoteResult(result)),
  }
}

/** 「删除」确认框的宿主只需要那一段 `/apply`：删除前那一次计数走 {@link applyOne}；
 *  提交删除走 `src/client/write.ts` 的 `runWrite`。 */
export type DeleteConfirmDeps = OneShotDeps
