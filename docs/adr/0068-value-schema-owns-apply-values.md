# `/apply` 成功值由本地 schema 声明一次，wire 只派生类型与判形

Status: accepted

ADR-0003 把线上形状收进 `wire.ts` 后，`/apply` 的成功值仍是「接口 + 手写判形」两份；清册行、聚合回执与数字三族各写一遍，字段一改两处漂。这里把成功值形状收进 `src/shared/apply-values.ts` 的三族 schema，`wire.ts` 从 schema 派生类型与判形，线上形状仍只有一个家。

## 背景

`wire.ts` 曾同时声明 `TrashEntryWire` 与 `PurgeStatsWire` 的接口，再在 `WIRE_VALUE_GUARDS` 旁边手写一份逐字段判形。清册行加一个可选读数、聚合回执加一格附件读数，都要同时改接口与判形；两处漏一处，线上多发的字段就会在浏览器半被静默丢掉。ADR-0003 的显式投影、禁 spread 与必填清单仍成立，问题只在成功值形状被抄了两遍。

## 决定

1. **`/apply` 成功值形状住 `apply-values.ts`**：清册行 `TRASH_ENTRY_SCHEMA`、聚合回执 `PURGE_STATS_SCHEMA` / `ATTACHMENT_CLEANUP_SCHEMA`、数字 `NUMBER_SCHEMA` 各一枚；动作 → 形状的唯一映射是 `APPLY_VALUE_SCHEMAS`，`satisfies Record<ApplyAction, …>` 是编译闸。
2. **`value-schema.ts` 只做那一枚极小 DSL**：`check` 与 `Infer` 同源，字段清单只写一次；零宿主依赖、不引第三方包，浏览器半仍只 import `shared/`。
3. **`wire.ts` 保留请求面与信封**：段名表 / 请求字段组 / 信封类型 / 失败码仍是它的；成功值类型从 `APPLY_VALUE_SCHEMAS` 派生（`ApplyValueByAction`），`WIRE_VALUE_GUARDS.apply` 按同一张表判形。
4. **矩阵测试的期望表独立于 schema**：动作 → 允许的成功值与落地 id 在 `tests/apply-actions-matrix.test.ts` 里写死，不从被测 schema 反推；schema 与期望错位先在这里红。

## 边界

- 请求形状、段名、路由纯度 / body 预读 / 同源闸的归属不动（仍是 `wire.ts` 与 `route-table.ts`）。
- **回执的附件读数归值形状、不归动作表**：`receipt.ts` 的 `RECEIPT_SHAPE` 不再列 `attachmentCleanup`，`summarizeAttachmentCleanup` 只按 `PURGE_STATS_ATTACHMENTS_SCHEMA` 读；delete / restore 的读数缺席由「成功值不带这一格」保证，动作表不再兜这一条。
- 落地形状仍住 `trash/entry.ts`；显式投影、禁止 spread 继承、必填清单贴着接口这几条仍成立。
- 三族 schema 只管已知格：未知键不拒；缺席与在场的口径由 `optional` 表达，不拿零冒充。
- 浏览器半不 import 宿主包；值 DSL 不依赖运行期库。

## 后果

- 改一个成功值字段 = `apply-values.ts` 一处；`wire.ts` 的类型与判形跟随，矩阵测试的独立期望表若没跟就红。
- 加一个 `/apply` 动作 = 动作索引 + `APPLY_VALUE_SCHEMAS` 一格 + 矩阵期望表一格；三处漏一处先红。
- `wire.ts` 不再把成功值形状与判形各写一份，消除「接口改了判形没改」的漂移。

## 被否方案

- **保留接口 + 手写判形两份**：正是这次要消掉的漂移源；新字段只改一处不会报错。
- **引入 zod 或宿主 schema 库**：浏览器半要 inline `wire.ts`，第三方运行期依赖与「零宿主依赖、两半共用一份」冲突。
- **把全部线上形状（含请求 / 信封）搬进 `apply-values.ts`**：段名表、请求字段组与信封是通道契约，搬家只会让 `route-table.ts` 与 `wire.ts` 的投影链出现第二个名字。

锚点：`src/shared/apply-values.ts` 的 `APPLY_VALUE_SCHEMAS`；`src/shared/value-schema.ts` 的 `ValueSchema` / `Infer`；`src/shared/wire.ts` 的 `ROUTES` / `WIRE_VALUE_GUARDS`；`src/shared/apply-actions.ts` 的 `APPLY_ACTION_INDEX`；`tests/apply-actions-matrix.test.ts`；ADR-0003（已被本篇取代）。
