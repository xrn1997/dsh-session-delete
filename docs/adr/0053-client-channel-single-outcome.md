# 浏览器半的取数通道只有一种落地面

Status: accepted

浏览器半的取数通道收成一个 interface（`SessionDeleteRemote`）：每个操作直接交 `RemoteOutcome<T>`（成功带值 / 失败带 `RemoteFailure`）。段的路径与方法从 `src/shared/wire.ts` 的 `ROUTES` 投影，请求体字段只由这个 interface 的签名决定；raw 信封层、`buildDeps` 与四个失败转换器收进唯一的生产 adapter。

## 背景

原来的取数通道有四层：raw interface 交 `RemoteResult` 信封、`buildDeps` 把信封展开成裸值或抛出、`callRemote` 再把抛出的失败折回 `RemoteOutcome`，调用点还要在三种失败形状里挑一种。段名表已经记录了每段的 path 与 method，客户端却把它手抄成四层投影；加一个读段要改七处，其中五处在客户端。失败在通道里换三次形状，每个新调用点都得同时学会这三种。

## 决定

1. **一个 interface，一种落地面。** `SessionDeleteRemote` 的每个操作（含探测用的 `ping`）都交 `RemoteOutcome<T>`；失败**不抛**。生产 adapter 是同源 fetch，测试 adapter 是内存假件；两者同契约，调用点只做状态检查。
2. **传输描述从段名表投影。** 段名、方法与请求体形状的唯一家是 `src/shared/wire.ts` 的 `ROUTES`（ADR-0003）；Node 半的路由记录投影 `method` 与 `bodyOf(ROUTES.x)`（ADR-0004），浏览器半的 `requestOutcome` 只投影 path 与 method，请求字段由 interface 的签名决定——两半都不逐段手写一份字面量。
3. **失败归一只有一处。** 信封解析、401/403 固定原文、非信封诊断、网络失败与探测超时全在 `requestOutcome` 里一次完成；`applyOne` 也交 `RemoteOutcome`。`callRemote`、`unwrapRemoteResult`、`throwRemoteFailure` 与 raw interface 一起删除。

## 边界

- 信封形状（`RemoteResult` / `RemoteFailure` / `isRemoteResult` / `isDSHRemoteError`）仍住 `src/shared/wire.ts`；这条通道只是它的**浏览器半解析者**。
- `/attachment` 仍是二进制段：它由 `src/client/attachment-view.tsx` 从同一张表拼地址，不经过 JSON 通道。
- 鉴权仍归宿主 `/api` bridge（ADR-0033）；`ROUTES` 只描述传输，不描述权限。
- 测试假件与生产 adapter 同说一种语言：方法直接交落地面（用例设成什么样，组件收到什么），没有抬升 / 归一层；生产适配器不替调用方兜业务失败。（**2026-11-14 就地订正**：本行原文把「抬升」记成假件的职责，与 `tests/client/support/fake-remote.ts` 的现状相反；按本仓口径，事实漂移就地改正文。）

## 后果

- `callRemote` / raw 层删除后，维护卡状态机不再包一层失败转换：`scan` 直接吃 `RemoteOutcome`，`afterClean` 一次判读 `preset` / `plan`；孤儿会话清理的第二份回执（顺带清掉的图片副本）改走 `secondaryNotice`，不再由 glue 另存一份状态。
- 测试假件与生产 adapter 同说 `RemoteOutcome`；生产 adapter 不替调用方兜业务失败。

## 被否方案

- **保留 raw + `buildDeps` 两层**：raw 只有一个生产 adapter，是假想 seam；保留它只让每个新段多两次投影。
- **让调用点各自 `try/catch`**：`callRemote` 证明失败归一是通道的职责；把它推给七个调用点，等于把同一条判据抄七遍。
- **只改命名、不动分层**：失败仍在三种形状里换手，类型面仍允许把「没跑 / 跑失败 / 幂等」混成一个 `undefined`。

锚点：`src/client/remote.ts` 的 `SessionDeleteRemote` / `RemoteOutcome` / `requestOutcome` / `applyOne`；`src/shared/wire.ts` 的 `ROUTES` / `RouteBody`；`src/api/route-table.ts` 的 `bodyOf`；`src/client/use-maintenance-section.ts` 的 `afterClean` / `secondaryNotice`；`src/client/use-maintenance.ts`；`tests/client/remote.test.ts`；`tests/client/support/fake-remote.ts`。相关 ADR-0003、ADR-0033。
