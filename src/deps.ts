import type { CoreFsPort, FsPort } from './ports/fs-port.js'
import type { HostCorePort } from './ports/host-port.js'
import type { PresenceCapability } from './ports/presence-port.js'
import type { TrashLedger } from './trash/ledger.js'

/** Node 半的基础依赖面：组合根只装配这一颗；动词之间不互相 import 依赖面 interface。
 *  `fs` 不含 `removeDir`，`host` 不含在场三件——两条危险能力各走 {@link RemovalDeps} 与
 *  {@link CoreDeps.presence}。 */
export interface CoreDeps {
  fs: CoreFsPort
  host: HostCorePort
  ledger: TrashLedger
  home: string
  presence: PresenceCapability
}

/** 会话删除动词的依赖面：只多读时钟；它不删目录（回滚只把搬走的搬回）。 */
export type DeleteSessionDeps = CoreDeps & { now(): number }

/** 永久删除的执行面：执行器及其分发拿得到 `removeDir`；计划函数仍只收 `CoreDeps`（它们不写）。 */
export type RemovalDeps = CoreDeps & { fs: CoreFsPort & Pick<FsPort, 'removeDir'> }

/** 组合根装出的全量面：`/apply` 的分发同时够到删除的时钟与永久删除的 `removeDir`。 */
export type DeleteDeps = DeleteSessionDeps & RemovalDeps
