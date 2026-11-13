/**
 * 浏览器半的取数通道：同源 fetch 宿主 `connection.fetch` 的 exact Fetch 路由（`/api` + 插件前缀）。
 * **一次调用只有一种落地面**：`RemoteOutcome<T>`（成功带值 / 失败带 `RemoteFailure`）。信封解析、
 * 401/403 原文、非信封诊断与网络失败归一都在这里一次完成——没有 raw 层、没有 make-it-throw 的适配层、
 * 也没有调用点各自的 try/catch。
 *
 * - 每段的**路径与方法**从 `src/shared/wire.ts` 的 `ROUTES` 投影（`{ path, method, body }`）；本文件不写
 *   段名或方法的第二份字面量，请求字段只由上面 interface 的签名决定（`body` 那一格是给 Node 半决定
 *   「要不要预读 JSON」的，见 `src/api/route-table.ts`）。取数地址（官方 `/api` 前缀 + 文档挂载点）归
 *   `src/client/api-base.ts`（根部署下与旧版逐字相同）。
 * - 全部段名注册在宿主 `connection.fetch.register` 上，鉴权归宿主 `/api` bridge（ADR-0033）；
 *   没有旧前缀 fallback——支持面是 web UI 与桌面端，二者的标准组合都装 `client-connection`。
 *   官方 remote.<namespace> 仍不可用（第三方拿不到 Typert 描述符的动态发现挂载点）。
 * - 写动作统一走 apply；`attachment` 是唯一二进制段，由 `src/client/attachment-view.tsx` 经同一投影
 *   拼地址，不经过本文件的 JSON 通道；`attachment-orphans`（纯读）与 `attachment-clean`（聚合写）是
 *   孤儿附件的两段，`projection-orphans`（纯读）与 `projection-clean`（聚合写）是投影缓存的两段。
 * - 失败在线上是 {code,message,details?} 普通对象；本通道把它原样当数据交回，既不补标记位也不抛
 *   （标记位判别 isDSHRemoteError 的家在 src/shared/wire.ts，读它的是 Node 半），这里不 import 任何宿主客户端包。
 */
import {
  PARAMS,
  ROUTES,
  isRemoteResult,
  type ApplyAction,
  type ApplyOutcome,
  type ApplyValueByAction,
  type ArchiveDetailWire,
  type ArchiveListWire,
  type AttachmentCleanupWire,
  type AttachmentOrphanReportWire,
  type OrphanReportWire,
  type ProjectionCacheCleanupWire,
  type ProjectionCacheOrphanReportWire,
  type PurgeStatsWire,
  type RemoteFailure,
  type SessionDeleteConfigWire,
  type TrashDetailWire,
  type TrashRowWire,
} from '../shared/wire.js'
import { apiPath } from './api-base.js'
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
 * 它们的清册事实只能随详情过线（issue #7；单级判据现由 ADR-0055 的「沿用」节承接）。
 */
export type TrashDetailLike = TrashDetailWire

/** 归档清单（`ArchiveListWire`）：形状的家同在 `shared/wire.ts`，这里只是别名。 */
export type ArchiveListLike = ArchiveListWire

/** 归档单条详情（`ArchiveDetailWire`）：基座 + sessionId，没有清册身份格（`entryId`）；
 *  子会话段是**只读投影**（宿主闭包 + 四路读数），与回收站那份不是同一来源。 */
export type ArchiveDetailLike = ArchiveDetailWire

/* 信封（`RemoteResult`）与失败形状（`RemoteFailure`）住在 `../shared/wire.js`——两半的共同契约只有
 * 那一份家。浏览器半**不补标记位、也不抛失败**：信封原样当数据交回，所以这里没有「异常 → 失败面」
 * 的转换器（那是 Node 半 `src/remote/map-error.ts` 的 `toRemoteFailure` 的活）。这里只管通道实现。 */

/** 一次远程调用的落地面：要么值，要么失败——所有操作都交这一种形状，调用方只做状态检查。
 *  失败**不抛**：抛出来的失败面会让每个调用点再学一套 try/catch，也会让「返回的失败」与
 *  「抛出的失败」变成两种落地。 */
export type RemoteOutcome<T> = { ok: true; value: T } | { ok: false; failure: RemoteFailure }

/**
 * 浏览器半的**唯一取数 interface**：每个操作交回同一种落地面 `RemoteOutcome<T>`。
 *
 * 两个 adapter 是真的：生产是同源 fetch（{@link createHttpRemote}），测试是内存假件
 * （`tests/client/support/fake-remote.ts`）。没有第二条「raw 信封」interface，也没有把信封
 * 再展开成 throw 的中间层——失败形状从三种收成一种。
 */
export interface SessionDeleteRemote {
  /** 通道的"在不在"：一次零成本的 GET（探测专用，见 `src/api/dispatch.ts` 的 `ping` 支）。
   *  `signal` 由探测方给：半开连接不能把 `activate` 永远吊在这里。 */
  ping(signal?: AbortSignal): Promise<RemoteOutcome<string>>
  list(): Promise<RemoteOutcome<TrashEntryLike[]>>
  /** 三只可调项的当前值：空体 POST（与 `/detail` 的“POST 表达读”同法）。 */
  config(): Promise<RemoteOutcome<SessionDeleteConfigWire>>
  /** 写回三只可调项：走宿主 `configEditor.edit`，这一行会重启；失败以 `io` 落地。 */
  saveConfig(config: SessionDeleteConfigWire): Promise<RemoteOutcome<SessionDeleteConfigWire>>
  /** 纯读：回收站之外的无主子会话扫描。它**不清理**——清理是 `apply` 的 `orphan-clean` 动作。
   *  读不到是失败，调用方不许把它折成"零条残留"。 */
  scanOrphans(): Promise<RemoteOutcome<OrphanReportWire>>
  /** 纯读：`.dsh` 内无引用图片对象的数量、字节与预览清单（引用源读不出是失败，不折成 0）。 */
  scanAttachmentOrphans(): Promise<RemoteOutcome<AttachmentOrphanReportWire>>
  /** 聚合写：只删上一条报告那一刻无引用的图片对象，回 `AttachmentCleanupWire`。 */
  cleanAttachmentOrphans(): Promise<RemoteOutcome<AttachmentCleanupWire>>
  /** 纯读：宿主 `session_projcache` 里找不到会话痕迹的记录条数（判据住 `src/trash/projection-cache.ts`）。
   *  读不出是失败，调用方不许把它折成"零条残留"。 */
  scanProjectionCacheOrphans(): Promise<RemoteOutcome<ProjectionCacheOrphanReportWire>>
  /** 聚合写：现扫一遍，只删这一刻仍找不到会话痕迹的投影缓存记录，回 `ProjectionCacheCleanupWire`。 */
  cleanProjectionCacheOrphans(): Promise<RemoteOutcome<ProjectionCacheCleanupWire>>
  detail(entryId: string, before?: number): Promise<RemoteOutcome<TrashDetailLike>>
  /** 纯读：归档清单。`{ available: false }` 是成功信封里的显式「语料不可见」，不是失败。 */
  archiveList(): Promise<RemoteOutcome<ArchiveListLike>>
  /** 纯读：归档单条详情（目标自己已归档，或是 `rootSessionId` 那条已归档会话的 subagent
   *  闭包成员；寻址红线：只传 id）。 */
  archiveDetail(sessionId: string, before?: number, rootSessionId?: string): Promise<RemoteOutcome<ArchiveDetailLike>>
  /** 一组 id 上的同一个动作。顶层 `ok:false` 只表示**整次调用**没办成（路由自检、栅栏之外）；
   *  单条动作的成败住在 `ApplyOutcome` 里——这是批量接口的判据，别在信封层找它。 */
  applyOutcomes(action: ApplyAction, ids: readonly string[]): Promise<RemoteOutcome<ApplyOutcome[]>>
  /** 清空回收站：聚合回执，不按条回。 */
  emptyTrash(): Promise<RemoteOutcome<PurgeResultLike>>
}

/** 插件设置页「可调项」卡只要这两件。 */
export type ConfigDeps = Pick<SessionDeleteRemote, 'config' | 'saveConfig'>

/** 需要那一段 `/apply` 的组件只要这一段 deps（单条非写调用见 {@link applyOne}，写动作走 `./write-seats.ts` 的六个座位）。 */
export type OneShotDeps = Pick<SessionDeleteRemote, 'applyOutcomes'>

/* ── 通道实现：同源 fetch，基础路径由 `api-base.ts` 投影 ───────────── */
/* 路径与方法只从 `wire.ts` 的 `ROUTES` 投影；请求字段由上面 interface 的签名决定，段的 `body` 那一格
 * 是给 Node 半读的（`route-table.ts` 的 `bodyOf`）。地址的 `/api` 前缀与文档挂载点归 `api-base.ts`。 */

/** 段名表里的那一格（`{ path, method, body }`）；本通道只投影 path 与 method，`body` 由 Node 半读。 */
type RouteSeg = (typeof ROUTES)[keyof typeof ROUTES]

/** 宿主 `/api` 的 401/403 是纯文本，不是本插件信封：固定中文原文只住这里（浏览器半唯一消费者）。 */
const UNTRUSTED_MESSAGE = '非受信来源'
const UNAUTHENTICATED_MESSAGE = '需要宿主的 Web 身份：请用 dsh web 打印的那一行 URL 打开页面后重试'

/** 请求体：GET 不带体；POST 一律 JSON（无字段的段发空对象，与其余写段同一形状）。 */
function requestInit(route: RouteSeg, payload: Record<string, unknown>): RequestInit {
  if (route.method === 'GET') return { method: 'GET' }
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }
}

/** 非信封响应 → 一条失败。401/403 的纯文本是身份/归属失败，不是「回的不是信封」。 */
function diagnostic(status: number): RemoteFailure {
  if (status === 401) return { code: CLIENT_UNKNOWN_CODE, message: UNAUTHENTICATED_MESSAGE }
  if (status === 403) return { code: CLIENT_UNKNOWN_CODE, message: UNTRUSTED_MESSAGE }
  return { code: CLIENT_UNKNOWN_CODE, message: `取数通道回的不是信封（HTTP ${String(status)}）` }
}

/**
 * 一次 HTTP 往返 → 落地面。**永不抛**：打不通（宿主没起来 / 路由没挂）、超时（AbortSignal）、
 * 回的不是信封（中间层回 `{}` / `{"error":"…"}` 这类 JSON，或 SPA 兜底的 index.html）都归一成
 * `{ ok:false, failure }`；业务失败（`ok:false` 信封）原样返回，`code` / `message` / `details` 三件不丢。
 */
async function requestOutcome<T>(
  route: RouteSeg,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<RemoteOutcome<T>> {
  let response: Response
  try {
    response = await fetch(apiPath(route.path), {
      ...requestInit(route, payload),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (reason) {
    const cause = reason instanceof Error ? reason.message : String(reason)
    return { ok: false, failure: { code: CLIENT_UNKNOWN_CODE, message: `取数通道打不通：${cause}` } }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    // 非 JSON：落成下面同一个「不是信封」诊断。
    body = undefined
  }
  if (!isRemoteResult(body)) return { ok: false, failure: diagnostic(response.status) }
  return body.ok
    ? { ok: true, value: body.value as T }
    : { ok: false, failure: body.error }
}

/**
 * 唯一生产 adapter：同源 fetch。**同源、带挂载点前缀**：不拼 host、不认 origin——页面本身就是从
 * 宿主页面加载的，同源是这条通道的全部前提；路径只由 `api-base.ts` 从 `document.baseURI` 的目录
 * 与官方 `/api` 前缀拼出（根部署下与旧版逐字相同，反代到 `/dsh/` 时得到 `/dsh/api/...`）。
 * 鉴权归宿主 `/api` bridge（ADR-0033）。所以这条通道**只对**宿主页面打开过、带宿主身份的客户端
 * 成立（凭据是那次访问换来的 cookie，不是插件自己的秘密）。
 */
export function createHttpRemote(): SessionDeleteRemote {
  return {
    // 每段的路径与方法从段名表投影；地址由 `api-base.ts` 投影。
    ping: (signal) => requestOutcome<string>(ROUTES.ping, {}, signal),
    list: () => requestOutcome<TrashEntryLike[]>(ROUTES.list, {}),
    config: () => requestOutcome<SessionDeleteConfigWire>(ROUTES.config, {}),
    saveConfig: (next) => requestOutcome<SessionDeleteConfigWire>(ROUTES.config, { ...next }),
    scanOrphans: () => requestOutcome<OrphanReportWire>(ROUTES.orphans, {}),
    scanAttachmentOrphans: () => requestOutcome<AttachmentOrphanReportWire>(ROUTES.attachmentOrphans, {}),
    cleanAttachmentOrphans: () => requestOutcome<AttachmentCleanupWire>(ROUTES.attachmentClean, {}),
    scanProjectionCacheOrphans: () => requestOutcome<ProjectionCacheOrphanReportWire>(ROUTES.projectionOrphans, {}),
    cleanProjectionCacheOrphans: () => requestOutcome<ProjectionCacheCleanupWire>(ROUTES.projectionClean, {}),
    detail: (entryId, before) => requestOutcome<TrashDetailLike>(ROUTES.detail, {
      [PARAMS.entryId]: entryId,
      ...(before === undefined ? {} : { [PARAMS.before]: before }),
    }),
    archiveList: () => requestOutcome<ArchiveListLike>(ROUTES.archiveList, {}),
    archiveDetail: (sessionId, before, rootSessionId) => requestOutcome<ArchiveDetailLike>(ROUTES.archiveDetail, {
      [PARAMS.sessionId]: sessionId,
      ...(before === undefined ? {} : { [PARAMS.before]: before }),
      ...(rootSessionId === undefined ? {} : { [PARAMS.rootSessionId]: rootSessionId }),
    }),
    applyOutcomes: (action, ids) => requestOutcome<ApplyOutcome[]>(ROUTES.apply, {
      [PARAMS.action]: action,
      [PARAMS.ids]: [...ids],
    }),
    emptyTrash: () => requestOutcome<PurgeResultLike>(ROUTES.empty, {}),
  }
}

/** 探测默认上限：5s。超时经 `AbortController` 打断 fetch，`activate` 不会永远吊在一条半开连接上。 */
export const PROBE_TIMEOUT_MS = 5000

/**
 * 探测的可选覆盖。**生产调用方不传**：注册路径只用 {@link PROBE_TIMEOUT_MS}。
 * 这一格存在是为了让「超时算探测不过」这条支能在测试里真的跑到——不然它要等 5 秒墙上时间。
 */
export interface ProbeOptions {
  /** 单次往返的上限；超时经 `AbortController` 打断 fetch。 */
  readonly timeoutMs?: number
}

/**
 * 探测唯一通道：一次 `GET /ping` 回成功信封（`pong`）才注册入口。
 *
 * - 401/403 是宿主 `/api` 的纯文本身份/归属失败：入口不出现，不装禁用态。
 * - 失败信封 / 404 / 非信封同样按不可用处理：`/api` 网关对未知路径也可能回错误形状，
 *   不能据此把入口摆出来让每个动作都失败。
 * - **往返有 5s 上限**：半开连接或宿主没起来时 `activate` 不悬着；超时与网络失败同样是
 *   「这一代不可用」，不自动重试（一次探测一个结论，刷新页面才会再探）。三种失败都在
 *   console 留下原因——入口不出现是有意的，但"为什么没出现"不能只活在脑子里。
 */
export async function probeChannel(
  deps: SessionDeleteRemote,
  options: ProbeOptions = {},
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROBE_TIMEOUT_MS)
  try {
    const result = await deps.ping(controller.signal)
    if (!result.ok) {
      console.warn('[dsh-session-delete] 取数通道探测失败，入口不注册：', result.failure.code, result.failure.message)
      return false
    }
    if (result.value !== 'pong') {
      console.warn('[dsh-session-delete] 取数通道回的不是 pong，入口不注册：', result.value)
      return false
    }
    return true
  } catch (error) {
    console.warn('[dsh-session-delete] 取数通道打不通，入口不注册：', error)
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * N=1 的成功支：`null` 已被 `receipt.ts` 的单条读法折成协议错，所以 `value` 必然非空。
 * 不再需要条件类型把 `delete` / `restore` 的 null 抠掉——那份判据只住回执读法一处。
 * 成败判别只住外层 `RemoteOutcome.ok`（ADR-0053 唯一落地面），这里不再叠第二枚 ok。
 */
export type OneShotSuccess<A extends ApplyAction> = {
  readonly id: string
  readonly action: A
  readonly value: Exclude<ApplyValueByAction[A], null>
}

/**
 * **N=1 的 `apply`**：一个动作 + 一个 id → 那一条的成功支（`value` 必然非空）。
 *
 * 三件事各归一个家：
 * - **按发出去的那个 id** 取结果（取"第一条"会把别条的成败安在这条头上）；
 * - 成/败/幂等/缺失与「单条 null 是协议错」的判读只走 {@link readSingleReceipt}；
 * - 这里只把 verdict 折成同一落地面（拿到值 / 失败），不抛——与通道的其余操作同一条契约。
 */
export async function applyOne<A extends ApplyAction>(
  deps: OneShotDeps,
  action: A,
  id: string,
): Promise<RemoteOutcome<OneShotSuccess<A>>> {
  const outcome = await deps.applyOutcomes(action, [id])
  if (!outcome.ok) return outcome
  const verdict = readSingleReceipt(action, id, outcome.value).byId.get(id)
  // `readSingleReceipt` 保证每个请求 id 都有一条 verdict；这一支只为类型收窄（别删）。
  if (verdict === undefined) {
    return { ok: false, failure: { code: CLIENT_UNKNOWN_CODE, message: missingOutcomeMessage(action, id) } }
  }
  if (verdict.kind === 'failed' || verdict.kind === 'neutral') return { ok: false, failure: verdict.error }
  if (verdict.kind === 'missing') {
    return { ok: false, failure: { code: CLIENT_UNKNOWN_CODE, message: verdict.message } }
  }
  return { ok: true, value: { id, action, value: verdict.value } }
}
