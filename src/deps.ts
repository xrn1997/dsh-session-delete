import type { CoreFsPort, RemovalFsPort } from './ports/fs-port.js'
import type { HostCorePort, HostRemovalPort } from './ports/host-port.js'
import type { AttachmentsPort } from './ports/attachments-port.js'
import type { PresenceCapability } from './ports/presence-port.js'
import type { SessionDeleteConfig } from './config.js'
import type { TrashLedger } from './trash/ledger.js'

/** Node 半的基础依赖面：`fs` 不含删除，`host` 不含在场三件与删除面——删目录走 {@link RemovalDeps}，
 *  在场三件走 {@link CoreDeps.presence}。`config` 是归一后的只读快照，读方从 deps 读。 */
export interface CoreDeps {
  fs: CoreFsPort
  host: HostCorePort
  ledger: TrashLedger
  home: string
  presence: PresenceCapability
  config: SessionDeleteConfig
}

/** 会话删除动词的依赖面：只多读时钟；它不删目录（回滚只把搬走的搬回）。 */
export type DeleteSessionDeps = CoreDeps & { now(): number }

/** 永久删除的执行面：多 `removeDir` / `removeFile` 与投影缓存删除面；计划函数仍只收 `CoreDeps`（它们不写）。 */
export type RemovalDeps = CoreDeps & { host: HostRemovalPort; fs: RemovalFsPort }

/** 宿主 `configEditor` 的窄面：`edit(entry, change)` 落盘并让 Loader 重启这一行；`entry` 是 `ctx.fiber.entry`。 */
export interface ConfigEditorLike {
  edit(entry: unknown, change: (current: Record<string, unknown>) => Record<string, unknown>): Promise<void>
}

/** 全量面：`/apply` 够到删除时钟与永久删除能力；`attachments` 只给附件读段（ADR-0035）。
 *  `configEditor` / `entry` 只给 `/config` 的写支；宿主没有时写支回 `io`，读支照常。 */
export type DeleteDeps = DeleteSessionDeps & RemovalDeps & {
  readonly attachments: AttachmentsPort
  readonly configEditor?: ConfigEditorLike
  readonly entry?: unknown
}
