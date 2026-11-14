# 归档详情为什么允许只读已归档根的子会话闭包

Status: accepted

宿主不允许打开已归档会话（子会话也没有自己的会话行），而归档档要承担「看得到正文」这件事；因此 `archive-detail` 的寻址从「目标自己已归档」放宽为「目标自己已归档，或目标是请求里那条已归档根的 subagent 闭包成员」。放宽只加只读读路，不新增归档入口、不改宿主归档状态，也不碰子会话生命周期。

## 背景

ADR-0060 把归档档做成「只读展示 + 解除归档 + 删除」，但当时子会话段只给已归档孩子开正文：宿主 `archiveSession` 单会话粒度、不级联，宿主 UI 又把子会话从会话列表里过滤掉，所以子会话实际上没有归档入口。结果是归档父会话的详情能看到孩子元信息，却打不开孩子的正文——归档用户最常想核对的「父会话当时到底委派了什么」反而看不到。

宿主侧没有任何可以改的地方：归档动作只挂在会话行上，子会话没有行；`archivedSessionIds` 也不应由本插件代写。能改的只有本插件自己的只读正文通道。

## 决定

1. **寻址按闭包放行，失败关闭**。`POST /archive-detail` 的请求体在 `sessionId` 之外可带可选的 `rootSessionId`：目标自己已归档 ⇒ 直接放行；否则要求 `rootSessionId` 已归档，且目标在该根的 `subagentMembersOf` 闭包里 ⇒ 放行。闭包读不出时回 `io`，不把「证明不了」当成「可以读」；路径形字符串仍只是一个不满足条件的 id，永远到不了文件系统。
2. **只读，不碰生命周期**。新通道只走宿主 `readSession`（replay 校验、不 make live）与只读投影；不调用 `archive` / `unarchive` / `stopActivity` / `evictLive` / 恢复 / 删除，也不把子会话交给宿主主视图 `retain`。读一个正在收尾的子会话只是读当时的日志快照。
3. **孩子视图是归档档自己的导航态**。共享的是 `SessionDetail` / `useSubagentSection` / `DetailPane` 这层视图；`childView`、选中面、详情账本仍各档一份（ADR-0060 决定第 4 条）。孩子视图单级：进入后不再交出下一层入口；`parentContext` 只在这时出现，返回父详情后再回清单。父行被清单收走（解除归档 / 删除 / 语料消失）时关闭孩子视图并丢掉它的账本。
4. **展示如实说来源**。状态行认**主体自己的归档态**（`ArchiveDetailWire.archived`，宿主归档集的精确判据，id 原样；子会话行另有 `ArchiveSubagentWire.archived`），**不认导航道**：已归档主体（清单行、以及进了孩子视图的已归档孩子）说「已归档」；未归档孩子说「随归档父会话查看」，不冒充「已归档」。已归档孩子优先开成清单行；不在清单行里的落进孩子视图时照实说「已归档」——归档清单是归档集 ∩ `listSessions` 的交集投影，冷无 cwd 之列会被 `list()` 跳过，「找不到清单行」不等于「未归档」。子会话段文案改成「子会话随归档父会话只读查看；它们不会随之归档或取消归档。」。
5. **宿主归档功能不动**。不新增子会话归档入口、不级联归档、不改 `archivedSessionIds`；本插件仍然只在用户显式动作里 `unarchive`，删除仍不碰归档（ADR-0008）。

## 边界

- 闭包只收 `origin:"subagent"` 的传递后代：fork 的 `parentSession` 只是来源记录，不是子代理，不能借归档父会话读。
- 放行不等于归档：孩子仍是未归档会话，不进入归档清单、不改变大小合计、不参与回收站的组语义；删除 / 恢复仍按原判据走。
- 子会话正文里的附件引用随正文一起可见；`/attachment` 仍只按 sha256 id 寻址，不新增路径入口。这是「正文可见」的必然结果，不是单独开的面。
- 回收站档不受影响：`/detail`、清册、条目 id 与 `childView` 都没动；详情账本实例仍各档一份，只是容量与逐出规则抽进 `detail-ledger.ts` 两档共用。除此之外两档只共用表现层。
- **仅凭根放行的读不装配子会话段**：这种主体（自己未归档、只进得来孩子视图）的详情只有正文——孩子视图单级，客户端对它整段不画，一趟只付寻址校验那一次闭包 BFS 与正文的整本 `readSession`（后者与 `/detail` 同量级），不另付第二次闭包与逐孩子行读数。主体自己已归档的读照常装配那一段；「段缺席」的两义（没有孩子 / 根放行）在 `ArchiveDetailWire` 注释里明写。
- 放宽不改变活体准入：归档运行中的会话仍由宿主 `workspace/session-activity` / `session-stop` 处理（见 ADR-0060 的背景与宿主实现），本插件不提供归档动作。

## 被否方案

- **拿导航道或「在不在清单行里」推状态行**：`parentContext` 在场与否、`find` 命中与否都会把「看不见」当成「未归档」——清单是交集投影（冷无 cwd 被 `list()` 跳过、ghost 少显示），已归档孩子会照错说「随归档父会话查看」。状态行只认主体自己的归档态这一格。
- **给子会话补归档入口**：宿主 UI 没有子会话行，入口只能活在本插件里；这会把子会话写进一个宿主界面看不见的归档集，语义和可发现性都坏。
- **只放宽到任意 subagent 会话**：不看根就直接读，等于把详情端点变成通用会话正文通道，踩 ADR-0060 的寻址红线。
- **继续只给元信息**：实现最稳，但归档父会话的真正内容（委派与子任务过程）永远看不到，归档档只剩目录。
- **复用回收站那台 `childView`**：两档状态会串，且违反 ADR-0060 决定第 4 条；共享视图不等于共享状态。

锚点：`src/trash/archive-detail.ts`（`readArchiveDetail` / `assertArchiveReadable` / `readArchiveSubagents`）；`src/shared/wire.ts`（`ArchiveDetailWire` / `ArchiveDetailWire.archived` / `ArchiveSubagentWire.archived` / `PARAMS.rootSessionId`）；`src/api/route-table.ts`（通用解析手 `parseBody` 的 `sessionId` 字段组）；`src/client/use-archive-panel-controller.ts`（`ArchiveChildView` / `openChild` / `closeChild` / `detailNav`）；`src/client/use-archive-detail-reader.ts`（`ArchiveDetailSubject` / `topLevel` / `rootOf`）；`src/client/detail-ledger.ts`（`writeDetail`）；`src/client/archive-detail.tsx`；`src/client/subagent-section.tsx`；`tests/archive-detail.test.ts`；`tests/api.test.ts`；`tests/client/use-archive-panel-controller.test.tsx`；`tests/client/archive-detail.test.tsx`；`tests/client/trash-panel.test.tsx`；`docs/ui-spec.md` §3.1（归档档）；ADR-0060（归档档决定与两档状态独立）；ADR-0008（删除/恢复不碰归档）。
