/**
 * `/apply` 六个动作的**索引**：每行只列 Node 半可判定的三格事实——静态纯度、成功值形状族、
 * 是否慢请求。两半都能 import（零运行时依赖，只 type-import wire 的动作联合）。
 *
 * 为什么要有它：一个动作的口径散在六家（`wire.ts` 的 `ApplyValueByAction`、`route-table.ts` 的
 * 路由纯度、`remote.ts` 的超时分档、`receipt.ts` 的回执读法、`write-seats.ts` 的写后收尾、
 * `copy.ts` 的上屏文案）。`wire.ts` 的动作清单只指路、不复制各家表达式；这里补的是**可枚举的
 * 最小公共事实**，把三件「一个动作一行就能说完」的静态判据收成一份，免得每加一个动作都要在
 * 两半各改一字面量：
 * - `purity` 由 `src/api/route-table.ts` 的 `APPLY_ACTION_TABLE` 从这里投影（路由纯度只读这一份）；
 * - `slow` 由 `src/client/remote.ts` 的 `/apply` 超时分档从这里投影（聚合写走 120s 档）；
 * - `value` 是成功值的形状族：`tests/apply-actions-matrix.test.ts` 拿它逐动作喂
 *   `WIRE_VALUE_GUARDS.apply` 与回执读法，钉住「新动作不许漏」。
 *
 * 它**不是运行时判据**：其余三家（回执判读 / 写后收尾 / 文案）不读这张表，由矩阵测试按各自的
 * 公开 interface 行为双向核对——索引漂了测试先红，不会是运行时两套口径。改动前先读
 * `docs/architecture.md` §4 的段名 / 路由 / 浏览器半取数三行。
 *
 * 放在 `shared/` 而不是某一半里：它同时被 Node 半（路由纯度）与浏览器半（超时分档）投影，
 * 放任何一半都会逼另一半向上 import（同 `wire.ts` 的理由）。
 */
import type { ApplyAction } from './wire.js'

/**
 * 成功值的形状族（判别键与 `wire.ts` 的 `ApplyValueByAction` 同一套）：
 * - `trash-entry-or-null`：回收站那一行；`null` = 被同批前一条带走的幂等 no-op（只有 delete / restore）；
 * - `stats`：`{ removed, freedBytes, attachments? }` 聚合回执（purge / orphan-clean）；
 * - `number`：一个数（count / unarchive，两个数的语义各归各的动词）。
 */
export type ApplyValueShape = 'trash-entry-or-null' | 'stats' | 'number'

/** 动作索引的一行：三格都是静态事实，运行时不按它分派。 */
export interface ApplyActionFacts {
  /** 静态纯度：`pure` 不进到达序链（纯读），`chained` 进链（写）。 */
  readonly purity: 'pure' | 'chained'
  /** 成功值的形状族（见 {@link ApplyValueShape}）。 */
  readonly value: ApplyValueShape
  /** 是否按慢请求档取超时（聚合写 / 清空按盘上全量数据线性变长）。 */
  readonly slow: boolean
}

/** 规范动作序：`/apply` 的拒否原文按它念（`route-table.ts` 的 `APPLY_ACTIONS` 从索引投影）；
 *  与 `wire.ts` 的 `ApplyAction` 同集，漏一个由下面的 `satisfies` 之外的矩阵用例双向核对。 */
export const APPLY_ACTIONS = [
  'delete',
  'restore',
  'purge',
  'count',
  'orphan-clean',
  'unarchive',
] as const satisfies readonly ApplyAction[]

/**
 * 动作索引：键 = `ApplyAction` 全六支。`satisfies Record<ApplyAction, …>` 是编译闸——
 * 类型面新增一个动作而这里没登记，编译不过；多写一个不存在的键同样过不了（对象字面量的多余键检查）。
 *
 * 键序即 {@link APPLY_ACTIONS} 的序：路由表的 `APPLY_ACTIONS` 与拒否原文都按它念。
 */
export const APPLY_ACTION_INDEX = {
  delete: { purity: 'chained', value: 'trash-entry-or-null', slow: false },
  restore: { purity: 'chained', value: 'trash-entry-or-null', slow: false },
  purge: { purity: 'chained', value: 'stats', slow: true },
  count: { purity: 'pure', value: 'number', slow: false },
  'orphan-clean': { purity: 'chained', value: 'stats', slow: true },
  unarchive: { purity: 'chained', value: 'number', slow: false },
} as const satisfies Record<ApplyAction, ApplyActionFacts>
