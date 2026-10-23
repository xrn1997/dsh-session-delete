import type { FsPort } from './ports/fs-port.js'
import type { HostPort } from './ports/host-port.js'
import type { TrashLedger } from './trash/ledger.js'

/** Node 半的基础依赖面：组合根只装配这一颗；动词之间不互相 import 依赖面 interface。 */
export interface CoreDeps {
  fs: FsPort
  host: HostPort
  ledger: TrashLedger
  home: string
}

/** 只有删除读时钟；其余读 / 计划 / 恢复 / 永久删除只用 CoreDeps。 */
export type DeleteDeps = CoreDeps & { now(): number }
