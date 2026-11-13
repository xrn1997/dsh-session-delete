/**
 * 浏览器半的**第二个 adapter**：一份实现 `SessionDeleteRemote` 的内存假件。
 *
 * 生产 adapter 是 `src/client/remote.ts` 的同源 fetch；这里补齐测试那一个。用例与假件说**同一种语言**：
 * 每个方法直接交 `RemoteOutcome`（成功 {@link remoteOk} / 失败 {@link remoteFail}），与生产通道同一条
 * 契约——没有「裸值 + 抛出」的第二套口径，也没有假件自己的抬升 / 归一层（通道不抛，失败是数据）。
 * 用例只翻自己关心的那一格，不再各自拿对象字面量凑依赖、也不再用 `as never` 跨过 interface——
 * 打洞意味着这个 interface 没被验证。
 */
import { vi } from 'vitest'
import { DEFAULT_CONFIG } from '../../../src/config.js'
import {
  type ArchiveDetailLike,
  type RemoteOutcome,
  type SessionDeleteRemote,
  type TrashDetailLike,
} from '../../../src/client/remote.js'
import type {
  ApplyAction,
  ApplyOutcome,
  OrphanReportWire,
  RemoteFailure,
  SessionDeleteConfigWire,
} from '../../../src/shared/wire.js'
import { outcomes } from './outcomes.js'
import type { Mocked } from '../../support/mocked.js'

/** 成功支：操作本来该给的值 → 通道的落地面。 */
export function remoteOk<T>(value: T): RemoteOutcome<T> {
  return { ok: true, value }
}

/** 失败支：一条生产 `RemoteFailure` → 通道的落地面。通道不抛，失败是数据——假件既不把它
 *  改写成异常，也不替调用方归一 `code` / `message`（那是 Node 半 `toRemoteFailure` 的活）。 */
export function remoteFail(failure: RemoteFailure): RemoteOutcome<never> {
  return { ok: false, failure }
}

/** 唯一的假件类型：每个方法一枚可断言的 `vi.fn`，交回 `Promise<RemoteOutcome<T>>`（与生产同形）。 */
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

/** 缺省实现：安静成功，每个方法都交通道的落地面；`applyOutcomes` 的逐条回执仍由 `outcomes.ts`
 *  组装（那一层是批量接口的判据，住回执自己的家），假件只把它包进成功信封。 */
const DEFAULTS: SessionDeleteRemote = {
  ping: async () => remoteOk('pong'),
  list: async () => remoteOk([]),
  config: async () => remoteOk({ ...DEFAULT_CONFIG }),
  saveConfig: async (next) => remoteOk({ ...next }),
  scanOrphans: async () => remoteOk(EMPTY_ORPHANS),
  scanAttachmentOrphans: async () => remoteOk({ count: 0, totalBytes: 0, items: [] }),
  cleanAttachmentOrphans: async () => remoteOk({ removed: 0, freedBytes: 0, failed: 0 }),
  scanProjectionCacheOrphans: async () => remoteOk({ count: 0 }),
  cleanProjectionCacheOrphans: async () => remoteOk({ removed: 0, failed: 0 }),
  detail: async () => remoteOk(DETAIL_FIXTURE),
  archiveList: async () => remoteOk({ available: true, rows: [], totalBytes: 0, missingSizeCount: 0 }),
  archiveDetail: async () => remoteOk(ARCHIVE_DETAIL_FIXTURE),
  applyOutcomes: async (action, ids) => remoteOk(outcomes(action, ids)),
  emptyTrash: async () => remoteOk({ removed: 0, freedBytes: 0 }),
}

/** 只需要一段 `/apply` 的座位测试：通道形状的函数直接就是 deps（断言仍打原来那枚 mock）。 */
export function applyDeps(
  applyOutcomes: (action: ApplyAction, ids: readonly string[]) => Promise<RemoteOutcome<ApplyOutcome[]>>,
): Pick<SessionDeleteRemote, 'applyOutcomes'> {
  return { applyOutcomes }
}

/** 覆盖表与旧假件同形：每个方法一枚 `vi.fn`（参数与落地面类型与生产 interface 保持不变，用例不必
 *  改写法）。用例直接操纵它的 mock（`mockResolvedValueOnce` 等），再把结果交给组件——两边问的是
 *  同一份现场。 */
export function createFakeRemote(over: Partial<FakeRemote> = {}): FakeRemote {
  const defaults: FakeRemote = {
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
