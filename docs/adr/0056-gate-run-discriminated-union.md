# 写闸的落地面用判别联合，不用 `undefined` 兼职「没跑」

Status: accepted

`BusyGate.around` 的返回值从 `T | undefined` 改成 `GateRun<T>`（`{kind:'blocked'} | {kind:'ran',value:T}`）。「这一趟被闸挡回、什么都没跑」与「这一趟跑完了」在类型面是两支，调用方按 `kind` 分派，写不出「拿没跑当跑完」的分支。

## 背景

闸的既有判据（ADR-0030 收编的那枚）是：同一实例同一时刻只跑一趟，连点的第二下被同步挡回、**不执行**。挡回的那一趟什么都没落地，它的界面后果归在飞的那一趟——框不收、失败不追加、详情账本不丢。

`T | undefined` 形状下这个语义只能靠「`undefined` 表示没跑」兼职表达，两处吃亏：

- 当 `T` 自己可空时（`runWrite` 的 `string | null` 收 id、`emptyTrash` 的布尔），`undefined` 与「跑过、结果恰是空值」要在每个调用点靠约定分开，类型不替你分；`Promise<T | undefined>` 在解构后就只剩「可能是没跑」这一句注释在撑。
- 「没跑」是一支**独立的下落**，不是值域的一个特殊值：把它画成值域的一格，下一个写 `T | undefined` 判等的人就可能写出 `run === undefined ? 成功 : …` 的反向分支，把没跑宣布成跑完。

## 决定

1. **`GateRun<T>` 收在 `src/client/busy-gate.ts`，与闸同一处**：`{kind:'blocked'}` 与 `{kind:'ran',value}` 两支判别联合。`around` 交回 `Promise<GateRun<T>>`，挡回仍发生在同步侧（`busy` 是 state、要等下一拍，同一 tick 的连点拦不住）。
2. **调用方一律按 `kind` 分派**：写入座位（`write-seats.ts`）、整趟写入（`write.ts` 的 `runWrite`）、清空（`use-trash-query.ts` 的 `emptyTrash`）、确认框与控制器（`delete-confirm.tsx` / `batch-confirm.tsx` / `use-trash-panel-controller.ts`）拿到 `blocked` 时这一趟什么都不落地——框不收、不追加失败、不清快照，界面后果等在飞那一趟的结论。
3. **失败原文与 `blocked` 不混**：`false` / `value` 只说「跑过、结果如何」，`blocked` 只说「没跑」；`emptyTrash` 的两支判别（清了 / 没清成）因此不需要再借 `undefined`。

## 边界

- 闸只拥有 busy 生命周期与同实例防重：不排队、不防抖、不重读（那是 `runWrite` 的整趟），本篇只翻返回值的形状，不翻这些判据（归 ADR-0030）。
- 这是浏览器半的本地类型：不进 `src/shared/wire.ts`，不是线上形状，Node 半无感。

## 后果

- `runWrite` 及三个写座、`emptyTrash`、四处确认框/控制器的返回值形状一起改；「挡回」在所有调用点显式成一支，新增写动作照抄 `kind` 分派即可。
- 测试对挡回的断言从 `toBeUndefined()` 变成 `toEqual({kind:'blocked'})`，读得出是哪一支。

## 被否方案

- **保留 `T | undefined`、靠注释约定**：类型不参与，写错方向（把没跑当跑完）编译照过；这正是要消灭的那类错。
- **挡回时抛错**：连点是常态交互不是异常，抛错会把「点快了」渲染成错误面，还要在每个调用点 try/catch。
- **挡回时排队执行**：连点的第二下会真发第二次请求，与「同一 tick 只发一次」的既有判据冲突，且把闸做成了队列（边界里明确不拥有）。

锚点：`src/client/busy-gate.ts`（`GateRun` / `BusyGate.around`）；`src/client/write-seats.ts`；`src/client/write.ts`（`runWrite`）；`src/client/use-trash-query.ts`（`emptyTrash`）；`tests/client/busy-gate.test.tsx`；`tests/client/write-seats.test.ts`；ADR-0030（闸的判据与 `gates` 总门）。
