# ADR-0003 — 线上形状的家是 `src/shared/wire.ts`，投影显式写一遍

Status: accepted

## 背景

`shared/wire.ts` 自称是「两半之间唯一的那份真相」，它确实独占段名、动作与信封。**但它不拥有形状**：

| 形状 | 当时写在哪些地方 |
| --- | --- |
| 回收站那一行 | `trash/entry.ts` `TrashEntry` · `api/dispatch.ts` `TrashRow` · `client/remote.ts` `TrashEntryLike` · `shared/wire.ts` `TrashEntryWire`（**并行的第四份**） |
| 清空回执 | `shared/wire.ts` `PurgeStatsWire` · `client/remote.ts` `PurgeResultLike` · `verbs/purge-trash.ts` 的内联返回类型 |
| 单条详情 | `trash/detail.ts` `TrashDetail` · `client/remote.ts` `TrashDetailLike` |
| 条目必填字段（运行期） | `index.ts` `TRASH_ENTRY_FIELDS` |

两条事实让这个问题不是「风格」：

1. **`TrashEntryWire` 与 `PurgeStatsWire` 在 `wire.ts` 之外零引用**——seam 上声明了两个没有实现者的形状，
   「已经有唯一一份家了」是假信心；真正的契约在四个调用点旁边各写一遍。
2. **加一个字段要改四处，其中一处永远不会报错**：`TRASH_ENTRY_FIELDS` 只列必填项，新加的可选读数字段
   与它无关，于是「运行期校验」对最常变的那些格子完全失明。

浏览器半还硬编码了两件只有 Node 半才该知道的事：失败码字面量 `'sessiondelete/not-found'`
（`trash-panel.tsx` 判「这一组已经不在了」）与数据根下的目录名 `'session-trash/'`（页脚那句话）。

## 决定

1. **线上形状住 `wire.ts`**：`TrashRowWire`（含必填的 `releaseBytes` 与五个可选只读：
   `subagentCount` / `subagentBytes` / `strandedSubagents` / `strandedBytes` / `workspaceMissing`）、
   `PurgeStatsWire`、`TrashDetailWire` 及其消息形状、以及 `SESSION_DELETE_*` 的失败码常量表。浏览器半只 import 这一份
   （`TrashEntryLike` 等旧名保留为**类型别名**，避免无意义的 rename 噪音）。
2. **落地形状仍住 `trash/entry.ts`**：`TrashEntry` 是清册那一行，与线上那一行**不是同一个东西**
   （线上多了六个现算现给的读数，其中 `releaseBytes` 是必填的那一个）。两者由一个**显式投影** `toWire(row, readouts)` 连接
   （**2026-10-20 就地订正**：本节原文写的是 `toWire(row)`；`readouts` 现在是必填入参，`releaseBytes` 由只读计划
   实测后递进来，投影不再拿 `row.sizeBytes` 现加——字节口径归 ADR-0027。其余五个只读数缺席仍表示"这次没算"。）。
3. **投影不许用 spread 继承**：`const wire: TrashRowWire = { id: row.id, sessionId: row.sessionId, … }`
   ——显式字面量让「线上多一个必填字段」变成一次编译错误；`...row` 会把它悄悄带过去。
4. **运行期必填清单搬回 `entry.ts`**，紧贴接口，并由一条骨架测试拿完整样本对象比对键集；
   接口加必填字段而清单没跟 ⇒ 测试红。
5. 浏览器半**不再**出现失败码与数据根目录名的字面量。

## 边界

- **不合并 `TrashEntry` 与 `TrashRowWire`**：一个字段是可选的到底因为「老行没有」，还是因为「这次没算」，
  在类型上必须分得开。
- **不动 `data-row-key` 那条读宿主 DOM 的路**：AGENTS.md 实测宿主没有「别切会话」的官方面，
  读 DOM 是唯一路径；这一轮只把它的私货（`rowInfo` 旁路表 + DOM 查询）收进一个 module 的私有状态。

## 后果

- 加一个**必填**字段 = wire 一处 + 投影一处 = 两次编译错误指路，不再有第四份手抄；可选只读数（`?`）不会触发这两处编译错误，它们要同时写进 `TrashRowReadouts` 的可选名单（`Pick<TrashRowWire, …>`）与 `toWire` 的逐格展开才能过线，缺席与在场的口径由 `tests/wire-shape.test.ts` 的键集断言守住。
- `wire.ts` 从「声明了没人用的形状」变成真契约；两半的类型检查会互相顶住。
- 测试落点：`toWire` 的键集、必填清单与接口键集的一致性，各一条。

## 被否掉的替代

- **让 `wire.ts` 从 `TrashEntry` 派生**（`TrashEntry & {…}`）：能跑，但线上形状与落地形状的分歧会被
  `&` 藏起来——哪天清册里多一个只在 Node 半用得上的字段，它会自动过线。
- **只修浏览器半的镜像、不建投影**：`/list` 仍然可能发出镜像里没有的键，契约依旧靠自觉。

锚点：`CONTEXT.md`（wire / 行投影）；`src/shared/wire.ts`、`src/api/trash-rows.ts`
