/**
 * 浏览器半的取数通道：同源 fetch 宿主 `connection.fetch` 的 exact 路由。一次调用只有一种落地面
 * `RemoteOutcome<T>`——信封解析、401/403 原文、非信封诊断与网络失败都在这里收口（无 raw 层、不抛）。
 *
 * 路径与方法只从 `src/shared/wire.ts` 的 `ROUTES` 投影，地址归 `api-base.ts`；鉴权归宿主 `/api`（ADR-0033）。
 */
import { APPLY_ACTION_INDEX } from '../shared/apply-actions.js'
import {
  PARAMS,
  ROUTES,
  WIRE_VALUE_GUARDS,
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
  type WireValueGuard,
} from '../shared/wire.js'
import { apiPath } from './api-base.js'
import { CLIENT_UNKNOWN_CODE, missingOutcomeMessage, readSingleReceipt } from './receipt.js'

/** 下面这些只读面都是 `shared/wire.ts` 的别名：形状的家只在那边（ADR-0003）。 */
export type TrashEntryLike = TrashRowWire

export type PurgeResultLike = PurgeStatsWire

/** 回收站单条详情：线上只有日志里读出来的那几件，清册已有字段不过线（组件按 `entryId` 与手上清单配对）；
 *  例外是 `subagents`——孩子不在客户端清单里，只能随详情过线（ADR-0055「沿用」）。 */
export type TrashDetailLike = TrashDetailWire

export type ArchiveListLike = ArchiveListWire

/** 归档单条详情：基座 + sessionId，无 `entryId`；子会话段是只读投影，来源与回收站不同。 */
export type ArchiveDetailLike = ArchiveDetailWire

/** 信封与失败形状的家在 `shared/wire.js`：浏览器半不补标记位、不抛失败（异常 → 失败面是 Node 半的活）。 */
export type RemoteOutcome<T> = { ok: true; value: T } | { ok: false; failure: RemoteFailure }

/** 唯一取数 interface：生产是同源 fetch（{@link createHttpRemote}），测试是内存假件；没有第二条 raw 信封面。 */
export interface SessionDeleteRemote {
  /** 探测专用零成本 GET；`signal` 由探测方给——半开连接不能把 `activate` 吊住。 */
  ping(signal?: AbortSignal): Promise<RemoteOutcome<string>>
  list(): Promise<RemoteOutcome<TrashEntryLike[]>>
  config(): Promise<RemoteOutcome<SessionDeleteConfigWire>>
  /** 写回三只可调项：走宿主 `configEditor.edit`，这一行会重启；失败以 `io` 落地。 */
  saveConfig(config: SessionDeleteConfigWire): Promise<RemoteOutcome<SessionDeleteConfigWire>>
  /** 纯读：扫描无主子会话；不清理（清理是 `apply` 的 `orphan-clean`），读不到是失败，不折成「零条残留」。 */
  scanOrphans(): Promise<RemoteOutcome<OrphanReportWire>>
  /** 纯读：`.dsh` 内无引用图片对象的数量、字节与预览清单（引用源读不出是失败，不折成 0）。 */
  scanAttachmentOrphans(): Promise<RemoteOutcome<AttachmentOrphanReportWire>>
  /** 聚合写：只删上一条报告那一刻无引用的图片对象，回 `AttachmentCleanupWire`。 */
  cleanAttachmentOrphans(): Promise<RemoteOutcome<AttachmentCleanupWire>>
  /** 纯读：`session_projcache` 里找不到会话痕迹的记录条数（判据住 `src/trash/projection-cache.ts`）；读不出是失败。 */
  scanProjectionCacheOrphans(): Promise<RemoteOutcome<ProjectionCacheOrphanReportWire>>
  /** 聚合写：现扫一遍，只删这一刻仍找不到会话痕迹的投影缓存记录，回 `ProjectionCacheCleanupWire`。 */
  cleanProjectionCacheOrphans(): Promise<RemoteOutcome<ProjectionCacheCleanupWire>>
  detail(entryId: string, before?: number): Promise<RemoteOutcome<TrashDetailLike>>
  /** 纯读：归档清单。`{ available: false }` 是成功信封里的显式「语料不可见」，不是失败。 */
  archiveList(): Promise<RemoteOutcome<ArchiveListLike>>
  /** 纯读：归档单条详情（subagent 闭包成员也行；寻址红线：只传 id）。 */
  archiveDetail(sessionId: string, before?: number, rootSessionId?: string): Promise<RemoteOutcome<ArchiveDetailLike>>
  /** 一组 id 上的同一动作：顶层 `ok:false` 只表示整次调用没办成，单条成败住在 `ApplyOutcome` 里。 */
  applyOutcomes(action: ApplyAction, ids: readonly string[]): Promise<RemoteOutcome<ApplyOutcome[]>>
  emptyTrash(): Promise<RemoteOutcome<PurgeResultLike>>
}

/** 插件设置页「可调项」卡只要这两件。 */
export type ConfigDeps = Pick<SessionDeleteRemote, 'config' | 'saveConfig'>

/** 需要那一段 `/apply` 的组件只要这一段 deps（单条非写调用见 {@link applyOne}，写动作走 `./write-seats.ts` 的六个座位）。 */
export type OneShotDeps = Pick<SessionDeleteRemote, 'applyOutcomes'>

type RouteSeg = (typeof ROUTES)[keyof typeof ROUTES]

/** 宿主 `/api` 的 401/403 是纯文本，不是本插件信封：固定中文原文只住这里（浏览器半唯一消费者）。 */
const UNTRUSTED_MESSAGE = '非受信来源'
const UNAUTHENTICATED_MESSAGE = '需要宿主的 Web 身份：请用 dsh web 打印的那一行 URL 打开页面后重试'

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

/** 一次普通请求的时长上限（探针另有更短的 5s 上限，见 {@link PROBE_TIMEOUT_MS}）。 */
export const REQUEST_TIMEOUT_MS = 30_000

/** 聚合读 / 批量写 / 清空的上限：工作量随盘上全量数据线性变长，共用 30s 会把「宿主还在干活」误判成超时。 */
export const SLOW_REQUEST_TIMEOUT_MS = 120_000

/** 超时的固定中文原文：通道诊断是协议原文，不随 locale（见 `docs/architecture.md` §3）。 */
export const REQUEST_TIMEOUT_MESSAGE = '取数通道超时：宿主没有在时限内回应'

/** 调用方自己中止这一趟（探测的 5s 上限）时的原文：与宿主超时分开，诊断才能指对人。 */
export const CALLER_ABORT_MESSAGE = '取数通道打不通：请求已被调用方中止'

/** 成功信封里的值形状不对时的固定中文原文（判形住 `src/shared/wire.ts` 的 `WIRE_VALUE_GUARDS`）。 */
export const CHANNEL_SHAPE_MESSAGE = '取数通道回的值形状不对'

/** 超时竞速的哨兵值：`Promise.race` 里与 `Response` 区分开（真实的 fetch 不会回这个字符串）。 */
const TIMED_OUT = 'session-delete-request-timed-out'

/** 一次 HTTP 往返 → 落地面，**永不抛**：打不通、超时、非信封、值形状不对都归 `{ ok:false, failure }`；业务失败原样返回。
 *  超时用**自己的** `AbortController`，从发出算到正文读完；调用方 `signal` 与之联动，谁先 abort 都打断这一趟。 */
async function requestOutcome<T>(
  route: RouteSeg,
  payload: Record<string, unknown>,
  guard: WireValueGuard,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RemoteOutcome<T>> {
  const controller = new AbortController()
  /** 超时标记放对象里：只由定时器回调写、请求体里读，`let` 布尔会被控制流收窄成"永远 false"。 */
  const clock: { timedOut: boolean; abortedByCaller: boolean } = { timedOut: false, abortedByCaller: false }
  /** 上限到了：标超时 + 打断 fetch；就算底层 fetch 不认 `signal`，竞速那一边也保证这一趟按时落地。 */
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      clock.timedOut = true
      controller.abort()
      resolve(TIMED_OUT)
    }, timeoutMs)
  })
  const relayAbort = (): void => {
    clock.abortedByCaller = true
    controller.abort()
  }
  if (signal === undefined) {
    // 没有调用方的 signal：这一趟只归超时管。
  } else if (signal.aborted) {
    clock.abortedByCaller = true
    controller.abort()
  } else {
    signal.addEventListener('abort', relayAbort, { once: true })
  }
  const timedOutFailure = (): RemoteOutcome<T> =>
    ({ ok: false, failure: { code: CLIENT_UNKNOWN_CODE, message: REQUEST_TIMEOUT_MESSAGE } })
  const callerAbortFailure = (): RemoteOutcome<T> =>
    ({ ok: false, failure: { code: CLIENT_UNKNOWN_CODE, message: CALLER_ABORT_MESSAGE } })
  /** 打断的唤醒面：`fetch`/`json()` 可能**不认** signal（桩件、旧中间层），不能让竞速只等它们自己醒。 */
  const CALLER_ABORTED = 'session-delete-request-caller-aborted'
  let onCallerAbort: (() => void) | undefined
  const callerAborted = new Promise<typeof CALLER_ABORTED>((resolve) => {
    onCallerAbort = () => resolve(CALLER_ABORTED)
    if (controller.signal.aborted) onCallerAbort()
    else controller.signal.addEventListener('abort', onCallerAbort, { once: true })
  })
  try {
    let response: Response
    try {
      const first = await Promise.race([
        fetch(apiPath(route.path), {
          ...requestInit(route, payload),
          signal: controller.signal,
        }),
        timeout,
        callerAborted,
      ])
      if (first === TIMED_OUT) return timedOutFailure()
      if (first === CALLER_ABORTED) {
        return clock.timedOut ? timedOutFailure() : callerAbortFailure()
      }
      response = first
    } catch (reason) {
      if (clock.timedOut) return timedOutFailure()
      if (clock.abortedByCaller) return callerAbortFailure()
      const cause = reason instanceof Error ? reason.message : String(reason)
      return { ok: false, failure: { code: CLIENT_UNKNOWN_CODE, message: `取数通道打不通：${cause}` } }
    }
    let body: unknown
    // 正文也必须在同一颗计时器下：`AbortController` 不保证拿到响应头后的 `response.json()` 会及时 rejection，
    // 不把「响应头到了、正文永远不结束」留给调用方吊死（`Promise.resolve().then` 把同步抛错也折成 rejection）。
    const readBody = Promise.resolve()
      .then(() => response.json())
      .then((value: unknown) => ({ kind: 'json' as const, value }))
      .catch(() => ({ kind: 'invalid' as const }))
    const bodyOutcome = await Promise.race([
      readBody,
      timeout.then(() => ({ kind: 'timeout' as const })),
      callerAborted.then(() => ({ kind: 'aborted' as const })),
    ])
    if (bodyOutcome.kind === 'timeout' || clock.timedOut) return timedOutFailure()
    if (bodyOutcome.kind === 'aborted' || clock.abortedByCaller) return callerAbortFailure()
    if (bodyOutcome.kind === 'json') body = bodyOutcome.value
    if (!isRemoteResult(body)) return { ok: false, failure: diagnostic(response.status) }
    if (!body.ok) return { ok: false, failure: body.error }
    // 信封对、值不对：形状漂移不许喂给组件（少一格就是 `undefined` 上屏 / 渲染炸掉）。
    if (!guard(body.value)) {
      console.warn('[dsh-session-delete] 取数通道回的值形状不对，按失败处理：', route.path)
      return { ok: false, failure: { code: CLIENT_UNKNOWN_CODE, message: CHANNEL_SHAPE_MESSAGE } }
    }
    return { ok: true, value: body.value as T }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', relayAbort)
    if (onCallerAbort !== undefined) controller.signal.removeEventListener('abort', onCallerAbort)
  }
}

/** `createHttpRemote` 的可选覆盖：**生产不传**（按段用两档上限）。存在只为让超时支在测试里真的跑到，不必等 30/120 秒。 */
export interface HttpRemoteOptions {
  readonly timeoutMs?: number
}

/**
 * 唯一生产 adapter：同源 fetch，不拼 host、不认 origin——页面本身从宿主加载，同源是这条通道的全部前提；
 * 路径由 `api-base.ts` 从 `document.baseURI` 目录与 `/api` 前缀拼出（反代到 `/dsh/` 时得到 `/dsh/api/...`）。
 * 鉴权归宿主 `/api` bridge（ADR-0033），凭据是宿主页面访问换来的 cookie，不是插件自己的秘密。
 */
export function createHttpRemote(options: HttpRemoteOptions = {}): SessionDeleteRemote {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const slowTimeoutMs = options.timeoutMs ?? SLOW_REQUEST_TIMEOUT_MS
  return {
    ping: (signal) => requestOutcome<string>(ROUTES.ping, {}, WIRE_VALUE_GUARDS.ping, timeoutMs, signal),
    list: () => requestOutcome<TrashEntryLike[]>(ROUTES.list, {}, WIRE_VALUE_GUARDS.list, timeoutMs),
    config: () => requestOutcome<SessionDeleteConfigWire>(ROUTES.config, {}, WIRE_VALUE_GUARDS.config, timeoutMs),
    saveConfig: (next) => requestOutcome<SessionDeleteConfigWire>(
      ROUTES.config, { ...next }, WIRE_VALUE_GUARDS.config, slowTimeoutMs),
    scanOrphans: () => requestOutcome<OrphanReportWire>(
      ROUTES.orphans, {}, WIRE_VALUE_GUARDS.orphans, slowTimeoutMs),
    scanAttachmentOrphans: () => requestOutcome<AttachmentOrphanReportWire>(
      ROUTES.attachmentOrphans, {}, WIRE_VALUE_GUARDS.attachmentOrphans, slowTimeoutMs),
    cleanAttachmentOrphans: () => requestOutcome<AttachmentCleanupWire>(
      ROUTES.attachmentClean, {}, WIRE_VALUE_GUARDS.attachmentClean, slowTimeoutMs),
    scanProjectionCacheOrphans: () => requestOutcome<ProjectionCacheOrphanReportWire>(
      ROUTES.projectionOrphans, {}, WIRE_VALUE_GUARDS.projectionOrphans, slowTimeoutMs),
    cleanProjectionCacheOrphans: () => requestOutcome<ProjectionCacheCleanupWire>(
      ROUTES.projectionClean, {}, WIRE_VALUE_GUARDS.projectionClean, slowTimeoutMs),
    detail: (entryId, before) => requestOutcome<TrashDetailLike>(ROUTES.detail, {
      [PARAMS.entryId]: entryId,
      ...(before === undefined ? {} : { [PARAMS.before]: before }),
    }, WIRE_VALUE_GUARDS.detail, timeoutMs),
    archiveList: () => requestOutcome<ArchiveListLike>(ROUTES.archiveList, {}, WIRE_VALUE_GUARDS.archiveList, timeoutMs),
    archiveDetail: (sessionId, before, rootSessionId) => requestOutcome<ArchiveDetailLike>(ROUTES.archiveDetail, {
      [PARAMS.sessionId]: sessionId,
      ...(before === undefined ? {} : { [PARAMS.before]: before }),
      ...(rootSessionId === undefined ? {} : { [PARAMS.rootSessionId]: rootSessionId }),
    }, WIRE_VALUE_GUARDS.archiveDetail, timeoutMs),
    // 慢请求分档由 `apply-actions.ts` 的 `slow` 投影：purge / orphan-clean 是聚合写，其余很快。
    applyOutcomes: (action, ids) => requestOutcome<ApplyOutcome[]>(ROUTES.apply, {
      [PARAMS.action]: action,
      [PARAMS.ids]: [...ids],
    }, WIRE_VALUE_GUARDS.apply, APPLY_ACTION_INDEX[action].slow ? slowTimeoutMs : timeoutMs),
    emptyTrash: () => requestOutcome<PurgeResultLike>(ROUTES.empty, {}, WIRE_VALUE_GUARDS.empty, slowTimeoutMs),
  }
}

/** 探测默认上限：5s。超时经 `AbortController` 打断 fetch，`activate` 不会永远吊在一条半开连接上。 */
export const PROBE_TIMEOUT_MS = 5000

/** 探测的可选覆盖：**生产不传**（只用 {@link PROBE_TIMEOUT_MS}）；存在只为让「超时算探测不过」在测试里跑到。 */
export interface ProbeOptions {
  readonly timeoutMs?: number
}

/**
 * 探测唯一通道：一次 `GET /ping` 回成功信封（`pong`）才注册入口；401/403 与任何失败都不装禁用态。
 * 往返有 5s 上限，超时与网络失败同样是「这一代不可用」，不自动重试（刷新才会再探）；失败在 console 留原因。
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

/** N=1 的成功支：`value` 必然非空（null 已由 `readSingleReceipt` 折成协议错）；成败只认 `RemoteOutcome.ok`（ADR-0053）。 */
export type OneShotSuccess<A extends ApplyAction> = {
  readonly id: string
  readonly action: A
  readonly value: Exclude<ApplyValueByAction[A], null>
}

/** **N=1 的 `apply`**：按发出去的那个 id 取结果（取「第一条」会把别条成败安在这条头上），
 *  判读只走 {@link readSingleReceipt}；这里只把 verdict 折成同一落地面，不抛。 */
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
