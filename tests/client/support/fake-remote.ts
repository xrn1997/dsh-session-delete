/**
 * 浏览器半的**第二个 adapter**：一份实现 `SessionDeleteRemote` 的内存假件。
 *
 * 生产 adapter 是 `src/client/remote.ts` 的同源 fetch；这里补齐测试那一个。用例只交**操作本来该给
 * 什么**（裸值）；假件负责把它抬成 `RemoteOutcome`、把抛出的失败按同一口径归一——与生产 adapter
 * 同一条契约。用例只翻自己关心的那一格，不再各自拿对象字面量凑依赖、也不再用 `as never` 跨过
 * interface——打洞意味着这个 interface 没被验证。
 */
import { vi } from 'vitest'
import { DEFAULT_CONFIG } from '../../../src/config.js'
import {
  type ArchiveDetailLike,
  type ArchiveListLike,
  type AttachmentOrphanReportWire,
  type OrphanReportWire,
  type PurgeResultLike,
  type RemoteOutcome,
  type SessionDeleteRemote,
  type TrashDetailLike,
  type TrashEntryLike,
} from '../../../src/client/remote.js'
import { CLIENT_UNKNOWN_CODE } from '../../../src/client/receipt.js'
import type {
  ApplyAction,
  ApplyOutcome,
  AttachmentCleanupWire,
  ProjectionCacheCleanupWire,
  ProjectionCacheOrphanReportWire,
  RemoteFailure,
  SessionDeleteConfigWire,
} from '../../../src/shared/wire.js'
import { isDSHRemoteError } from '../../../src/shared/wire.js'
import { outcomes } from './outcomes.js'
import type { Mocked } from '../../support/mocked.js'

/** 用例要交的「操作本来该给什么」：成功给裸值，失败直接抛（假件按 `failureOf` 归一）。 */
export interface BareSessionDeleteRemote {
  ping(signal?: AbortSignal): Promise<string>
  list(): Promise<TrashEntryLike[]>
  config(): Promise<SessionDeleteConfigWire>
  saveConfig(next: SessionDeleteConfigWire): Promise<SessionDeleteConfigWire>
  scanOrphans(): Promise<OrphanReportWire>
  scanAttachmentOrphans(): Promise<AttachmentOrphanReportWire>
  cleanAttachmentOrphans(): Promise<AttachmentCleanupWire>
  scanProjectionCacheOrphans(): Promise<ProjectionCacheOrphanReportWire>
  cleanProjectionCacheOrphans(): Promise<ProjectionCacheCleanupWire>
  detail(entryId: string, before?: number): Promise<TrashDetailLike>
  archiveList(): Promise<ArchiveListLike>
  archiveDetail(sessionId: string, before?: number, rootSessionId?: string): Promise<ArchiveDetailLike>
  applyOutcomes(action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]>
  emptyTrash(): Promise<PurgeResultLike>
}

/** 覆盖表与旧假件同形：每个方法一枚 `vi.fn`（参数与**裸值**返回类型保持不变，用例不必改写法）。 */
export type FakeRemoteMethods = Mocked<BareSessionDeleteRemote>

export type FakeRemote = Mocked<SessionDeleteRemote>

export const EMPTY_ORPHANS: OrphanReportWire = {
  roots: [], totalSessions: 0, totalBytes: 0, missingParents: 0, groups: [],
}

/** 最安静的一份详情：只服务"面板能读出来"的缺省，具体用例自己覆盖字段。 */
const DETAIL_FIXTURE: TrashDetailLike = {
  entryId: 'fake', cwd: '', createdAt: 0, lastActivity: 0, logTitle: '', models: [],
  turnCount: 0, userMessageCount: 0, assistantMessageCount: 0, toolCallCount: 0,
  injectedCount: 0, blocks: [], olderCursor: null,
}

/** 归档详情的同款缺省（基座 + sessionId，没有清册身份格与子会话段）。 */
const ARCHIVE_DETAIL_FIXTURE: ArchiveDetailLike = {
  sessionId: 'fake', archived: true, cwd: '', createdAt: 0, lastActivity: 0, logTitle: '', models: [],
  turnCount: 0, userMessageCount: 0, assistantMessageCount: 0, toolCallCount: 0,
  injectedCount: 0, blocks: [], olderCursor: null,
}

const DEFAULTS: BareSessionDeleteRemote = {
  ping: async () => 'pong',
  list: async () => [],
  config: async () => ({ ...DEFAULT_CONFIG }),
  saveConfig: async (next) => ({ ...next }),
  scanOrphans: async () => EMPTY_ORPHANS,
  scanAttachmentOrphans: async () => ({ count: 0, totalBytes: 0, items: [] }),
  cleanAttachmentOrphans: async () => ({ removed: 0, freedBytes: 0, failed: 0 }),
  scanProjectionCacheOrphans: async () => ({ count: 0 }),
  cleanProjectionCacheOrphans: async () => ({ removed: 0, failed: 0 }),
  detail: async () => DETAIL_FIXTURE,
  archiveList: async () => ({ available: true, rows: [], totalBytes: 0, missingSizeCount: 0 }),
  archiveDetail: async () => ARCHIVE_DETAIL_FIXTURE,
  applyOutcomes: async (action, ids) => outcomes(action, ids),
  emptyTrash: async () => ({ removed: 0, freedBytes: 0 }),
}

/** 任意抛出的东西 → 失败面：带官方标记位的原样带出自己的 `code` / `message`（和 `details` 第三件），
 *  其余按原文兜底成 `client/unknown`。生产通道**不抛**（`requestOutcome` 自己把网络层与非信封诊断
 *  归一成失败），所以这份归一只活在假件里：用例可以直接 `mockRejectedValue` 一个失败来模拟线上失败。 */
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

/** 裸值 / 抛出的失败 → 通道的唯一下落。 */
async function lift<T>(run: () => Promise<T>): Promise<RemoteOutcome<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (reason) {
    return { ok: false, failure: failureOf(reason) }
  }
}

/** 只需要一段 `/apply` 的座位测试：裸值 / 抛出的失败 → 通道落地面（断言仍打原来那枚裸值 mock）。 */
export function applyDeps(
  applyOutcomes: (action: ApplyAction, ids: readonly string[]) => Promise<ApplyOutcome[]>,
): Pick<SessionDeleteRemote, 'applyOutcomes'> {
  return { applyOutcomes: (action, ids) => lift(() => applyOutcomes(action, ids)) }
}

/** 只造**裸值**假件：用例直接操纵它的 mock（`mockImplementationOnce` 等）时用它，
 *  再把 `channelOf` 的结果交给组件——两边问的是同一份现场。 */
export function createBareFakeRemote(over: Partial<FakeRemoteMethods> = {}): FakeRemoteMethods {
  const defaults: FakeRemoteMethods = {
    ping: vi.fn(async () => DEFAULTS.ping()),
    list: vi.fn(async () => DEFAULTS.list()),
    config: vi.fn(async () => DEFAULTS.config()),
    saveConfig: vi.fn(async (next: SessionDeleteConfigWire) => DEFAULTS.saveConfig(next)),
    scanOrphans: vi.fn(async () => DEFAULTS.scanOrphans()),
    scanAttachmentOrphans: vi.fn(async () => DEFAULTS.scanAttachmentOrphans()),
    cleanAttachmentOrphans: vi.fn(async () => DEFAULTS.cleanAttachmentOrphans()),
    scanProjectionCacheOrphans: vi.fn(async () => DEFAULTS.scanProjectionCacheOrphans()),
    cleanProjectionCacheOrphans: vi.fn(async () => DEFAULTS.cleanProjectionCacheOrphans()),
    detail: vi.fn(async (entryId: string, before?: number) => DEFAULTS.detail(entryId, before)),
    archiveList: vi.fn(async () => DEFAULTS.archiveList()),
    archiveDetail: vi.fn(async (sessionId: string, before?: number, rootSessionId?: string) =>
      DEFAULTS.archiveDetail(sessionId, before, rootSessionId)),
    applyOutcomes: vi.fn(async (action: ApplyAction, ids: readonly string[]) =>
      DEFAULTS.applyOutcomes(action, ids)),
    emptyTrash: vi.fn(async () => DEFAULTS.emptyTrash()),
  }
  return { ...defaults, ...over }
}

/** 把裸值假件抬成通道（组件只认这一面）；每个方法都保留一枚可断言的 mock。 */
export function channelOf(methods: FakeRemoteMethods): FakeRemote {
  return {
    ping: vi.fn((signal?: AbortSignal) => lift(() => methods.ping(signal))),
    list: vi.fn(() => lift(() => methods.list())),
    config: vi.fn(() => lift(() => methods.config())),
    saveConfig: vi.fn((next: SessionDeleteConfigWire) => lift(() => methods.saveConfig(next))),
    scanOrphans: vi.fn(() => lift(() => methods.scanOrphans())),
    scanAttachmentOrphans: vi.fn(() => lift(() => methods.scanAttachmentOrphans())),
    cleanAttachmentOrphans: vi.fn(() => lift(() => methods.cleanAttachmentOrphans())),
    scanProjectionCacheOrphans: vi.fn(() => lift(() => methods.scanProjectionCacheOrphans())),
    cleanProjectionCacheOrphans: vi.fn(() => lift(() => methods.cleanProjectionCacheOrphans())),
    detail: vi.fn((entryId: string, before?: number) =>
      lift(() => (before === undefined ? methods.detail(entryId) : methods.detail(entryId, before)))),
    archiveList: vi.fn(() => lift(() => methods.archiveList())),
    archiveDetail: vi.fn((sessionId: string, before?: number, rootSessionId?: string) =>
      lift(() => methods.archiveDetail(sessionId, before, rootSessionId))),
    applyOutcomes: vi.fn((action: ApplyAction, ids: readonly string[]) =>
      lift(() => methods.applyOutcomes(action, ids))),
    emptyTrash: vi.fn(() => lift(() => methods.emptyTrash())),
  }
}

export function createFakeRemote(over: Partial<FakeRemoteMethods> = {}): FakeRemote {
  return channelOf(createBareFakeRemote(over))
}
