import type { CoreFsPort, RemovalFsPort } from './ports/fs-port.js'
import type { HostCorePort } from './ports/host-port.js'
import type { AttachmentsPort } from './ports/attachments-port.js'
import type { PresenceCapability } from './ports/presence-port.js'
import type { SessionDeleteConfig } from './config.js'
import type { TrashLedger } from './trash/ledger.js'

/** Node 半的基础依赖面：组合根只装配这一颗；动词之间不互相 import 依赖面 interface。
 *  `fs` 不含 `removeDir` / `removeFile`，`host` 不含在场三件——两条危险能力各走 {@link RemovalDeps} 与
 *  {@link CoreDeps.presence}。`config` 是 `apply` 归一后的只读快照：读方从 deps 读，不 import 模块级单例。 */
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

/** 永久删除的执行面：执行器及其分发拿得到 `removeDir` 与 `removeFile`；计划函数仍只收 `CoreDeps`（它们不写）。 */
export type RemovalDeps = CoreDeps & { fs: RemovalFsPort }

/** 宿主 `configEditor` 的窄面：`edit(entry, change)` 把完整 raw config 落盘并让 Loader 重启这一行。
 *  `entry` 是 `ctx.fiber.entry`（Loader 挂在 fiber 上，Cordis 类型不声明它，组合根按窄镜像取）。 */
export interface ConfigEditorLike {
  edit(entry: unknown, change: (current: Record<string, unknown>) => Record<string, unknown>): Promise<void>
}

/** 组合根装出的全量面：`/apply` 的分发同时够到删除的时钟与永久删除的 `removeDir` / `removeFile`
 *  （后者也供孤儿附件清理段使用）。`attachments` 只给 `attachment` 读段（ADR-0035）；动词不拿它。
 *  `configEditor` / `entry` 只给 `/config` 的写支；宿主没有这套面时写支回 `io`，读支照常。 */
export type DeleteDeps = DeleteSessionDeps & RemovalDeps & {
  readonly attachments: AttachmentsPort
  readonly configEditor?: ConfigEditorLike
  readonly entry?: unknown
}
