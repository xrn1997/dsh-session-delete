/** `/apply` 六个动作的**索引**：每行只列 Node 半可判定的静态事实——静态纯度、是否慢请求。
 *  一个动作的口径散在六家，这里收可枚举的最小公共事实：`purity` 由路由表投影，`slow` 由浏览器半
 *  超时分档投影；成功值形状住 `src/shared/apply-values.ts`。放 `shared/` 是因为两半都要投影。 */
import type { ApplyAction } from './wire.js'

/** 动作索引的一行：两格都是静态事实，运行时不按它分派。 */
export interface ApplyActionFacts {
  /** 静态纯度：`pure` 不进到达序链（纯读），`chained` 进链（写）。 */
  readonly purity: 'pure' | 'chained'
  /** 是否按慢请求档取超时（聚合写 / 清空按盘上全量数据线性变长）。 */
  readonly slow: boolean
}

/** 规范动作序：`/apply` 的拒否原文按它念；与 `wire.ts` 的 `ApplyAction` 同集。 */
export const APPLY_ACTIONS = [
  'delete',
  'restore',
  'purge',
  'count',
  'orphan-clean',
  'unarchive',
] as const satisfies readonly ApplyAction[]

/** 动作索引：键 = `ApplyAction` 全六支（`satisfies` 是编译闸）；键序即 {@link APPLY_ACTIONS} 的序。 */
export const APPLY_ACTION_INDEX = {
  delete: { purity: 'chained', slow: false },
  restore: { purity: 'chained', slow: false },
  purge: { purity: 'chained', slow: true },
  count: { purity: 'pure', slow: false },
  'orphan-clean': { purity: 'chained', slow: true },
  unarchive: { purity: 'chained', slow: false },
} as const satisfies Record<ApplyAction, ApplyActionFacts>
