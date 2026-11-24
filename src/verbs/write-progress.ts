/** 写入进度记录器：一趟写动作的遥测快照，`GET /progress` 纯读段就是读它。
 *
 *  模块单例、**不进 `CoreDeps`**——它是遥测不是世界依赖。全局只留一份就够：写动作在到达序链上
 *  串行 ⇒ 全局一份无歧义。生命周期随进程：宿主重启天然回 idle，不留残留。
 *
 *  **步骤码→动作点的唯一映射**（tick 只加观测：每格都在动作点进前一行写，不动步骤顺序、回滚与失败语义）：
 *  - delete（`delete-session.ts` 的 `memberMove`）：`read` 步进前 `measuring`、`workspace` 步进前 `ledger`、
 *    `dir` 步进前 `moving`、写清册行前 `ledger`、`memberGone` 前 `finishing`。
 *  - restore（`restore-session.ts` + `batch.ts` 批尾）：搬回目录前 `moving`、挂账本前 `ledger`、
 *    旧条目取消归档前 `ledger`、摘清册行前 `ledger`、批尾通告前 `finishing`（元数据三步同码：都是「元数据写」）。
 *  - purge / orphan-clean（`permanent-removal.ts`）：写路径计划函数进门 `measuring`（只在 `planTrashRemoval`
 *    / `planOrphanRemoval` 进门处；`planVisibleTrash` / `loadOrphanGroups` 是读路径共用面，**不许 tick**
 *    ——纯读跑到别人的在飞写记录上乱 tick 就是假进度）、首笔写前复查后 `checking`、退归档集段 `deleting`
 *    （归档摘除属于删除准备，不单设码）、摘账本 `ledger`、删目录 `deleting`、摘清册行 `ledger`、
 *    清缓存 `finishing`、批级附件尾 `attachments`（`executeAttachmentTail` 进门 tick 一次——唯一映射，
 *    执行器里不再有这一步）。
 *  - unarchive（`batch.ts` 的 `applyUnarchive`）：**没有动作点**，记录停在 `begin` 的初值 `checking`；
 *    界面也还没有认领面（归档档不走确认框），这一格只为 `/apply` 的写动作统一报进度而存在。
 */
import type { WriteProgressAction, WriteProgressStep, WriteProgressWire } from '../shared/wire.js'

/** 写动作往记录上 tick 的面：步骤进入与条目完成两个粒度，各动自己那一格。 */
export interface WriteProgressRecorder {
  /** 覆盖式置 running：新的一趟身份与总数进来，进度从 0 起步。 */
  begin(action: WriteProgressAction, ids: readonly string[], total: number): void
  /** 只改步骤码；k/N 那两格归 `advance` 与 `begin`。 */
  step(step: WriteProgressStep): void
  /** 完成条目加一；并发下一次 tick 也只增一，越过 `total` 封顶（done 与已处理条数同义）。 */
  advance(): void
  /** 落定回 idle；成败都收尾——失败面另有信封，进度不是第二本账。 */
  finish(): void
}

let current: WriteProgressWire = { status: 'idle' }

export const writeProgress: WriteProgressRecorder = {
  begin(action, ids, total) {
    // 身份收下副本：这趟记录不跟调用方手里的可变数组走。
    current = { status: 'running', action, ids: [...ids], done: 0, total, step: 'checking', startedAt: Date.now() }
  },
  step(next) {
    // 只在跑着的那趟上动格：收尾后迟到的 tick 不许把记录复活。
    if (current.status === 'running') current = { ...current, step: next }
  },
  advance() {
    // 封顶：多出来的 tick 不把 done 撑过 total——k/N 越界就是假进度。
    if (current.status === 'running') current = { ...current, done: Math.min(current.done + 1, current.total) }
  },
  finish() {
    current = { status: 'idle' }
  },
}

/** 当前快照：`/progress` 行只从这一面取数，写面归 {@link writeProgress}。
 *  交出的快照在**结构上**不可变：running 支连 `ids` 一起拷贝，读方改到的只是自己那份。 */
export function readWriteProgress(): WriteProgressWire {
  return current.status === 'running' ? { ...current, ids: [...current.ids] } : current
}

/** 回 idle：测试每例复位用（生产靠进程生命周期自然回 idle，组合根不调用）。 */
export function resetWriteProgress(): void {
  current = { status: 'idle' }
}
