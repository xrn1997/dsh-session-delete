/**
 * 浏览器半的**第二个 adapter**：一份实现 `SessionDeleteRemote` 的内存假件。
 *
 * 生产 adapter 是 `src/client/remote.ts` 的同源 fetch；这里补齐测试那一个。用例只翻自己关心的那一格，
 * 不再各自拿对象字面量凑依赖、也不再用 `as never` 跨过 interface——打洞意味着这个 interface 没被验证。
 */
import { vi } from 'vitest'
import type {
  AttachmentOrphanReportWire,
  OrphanReportWire,
  PurgeResultLike,
  SessionDeleteRemote,
  TrashDetailLike,
  TrashEntryLike,
} from '../../../src/client/remote.js'
import type { ApplyAction, ApplyOutcome, AttachmentCleanupWire } from '../../../src/shared/wire.js'
import { outcomes } from './outcomes.js'
import type { Mocked } from '../../support/mocked.js'

export type FakeRemote = Mocked<SessionDeleteRemote>

export const EMPTY_ORPHANS: OrphanReportWire = {
  roots: [], totalSessions: 0, totalBytes: 0, missingParents: 0, groups: [],
}

/** 最安静的一份详情：只服务"面板能读出来"的缺省，具体用例自己覆盖字段。 */
const DETAIL_FIXTURE: TrashDetailLike = {
  entryId: 'fake', cwd: '', createdAt: 0, lastActivity: 0, logTitle: '', models: [],
  turnCount: 0, userMessageCount: 0, assistantMessageCount: 0, toolCallCount: 0,
  injectedCount: 0, omittedByPayloadCap: 0, messages: [],
}

export function createFakeRemote(over: Partial<FakeRemote> = {}): FakeRemote {
  const remote: FakeRemote = {
    list: vi.fn(async (): Promise<TrashEntryLike[]> => []),
    scanOrphans: vi.fn(async (): Promise<OrphanReportWire> => EMPTY_ORPHANS),
    detail: vi.fn(async (): Promise<TrashDetailLike> => DETAIL_FIXTURE),
    applyOutcomes: vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]> =>
      outcomes(action, ids)),
    emptyTrash: vi.fn(async (): Promise<PurgeResultLike> => ({ removed: 0, freedBytes: 0 })),
    scanAttachmentOrphans: vi.fn(async (): Promise<AttachmentOrphanReportWire> => ({ count: 0, totalBytes: 0, items: [] })),
    cleanAttachmentOrphans: vi.fn(async (): Promise<AttachmentCleanupWire> => ({ removed: 0, freedBytes: 0, failed: 0 })),
  }
  return Object.assign(remote, over)
}
