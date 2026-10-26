# 写入收尾按 action 收进 settlement

Status: accepted

五个逐条 `/apply` 写入面曾各自把 receipt、主视图收尾、回收站失效与撤销通告拼一遍；把顺序按 action 收进 `src/client/write-settlement.ts` 后，写入面只交呈现材质，顺序与 `anySuccess` 门只有一个家。

## 决定

1. `runWrite` 在拿到 `WriteSuccess` 后调用 `settleWrite`，再调用 refresh。
2. delete / restore / purge 各有一条固定顺序；撤销那一格按动作分方向——delete 发布、purge 与面板恢复熄灭指向这些条目的横幅（留着就是一条注定失败的「撤销」；外部撤销座位由 `src/client/undo-toast.tsx` 在恢复成功后调 `undo-notices.ts` 的熄灭，见边界）；`count` 与 `orphan-clean` 不结算——orphan-clean 没有跨槽位收尾，它的写后刷新归 `use-trash-query.ts`。
3. 写入面通过 `WritePresentation` 交撤销、失效、缓存与座位标记（`panelSeat`），不再自己拼顺序；restore 的条目查找（already-gone 回执补 `sessionId`）由 `WriteInput.sessionIdOfEntry` 交给回执摘要。材质现在由 `src/client/write-seats.ts` 按座位交（ADR-0017）。
4. 恢复有两个座位：外部恢复（撤销横幅）不带 `panelSeat`，由 settlement 调 `afterRestore` 重开；面板恢复带 `panelSeat: true`，由 settlement 只调 `forgetMainView`、不重开、不抢焦点（判据住 `src/client/main-view.ts`）。
5. 跨槽位收尾（`afterDelete` / 外部恢复的 `afterRestore` / `invalidate`）在信封成功时就跑，逐条全失败也跑——回滚失败可能留下半套，清单不能继续摆旧行；呈现钩子（撤销、面板恢复的遗忘、清详情缓存）才受 `anySuccess` 门。delete 的撤销另要求落地名单非空：全部被同批前一条带走时没有可撤销的条目。

## 边界

- 不改 `/apply` 的线上形状、逐条信封与失败码。
- 面板写仍用自己的 `refreshAfterWrite`；外部写用 `invalidateTrash`。
- 面板恢复仍只遗忘主视图记录、不重开；撤销恢复仍重开。两条座位语义不合并。
- 外部撤销座位**不交** `dismissUndo`：部分失败的回滚会让 settlement 先熄灭横幅，随后失败原文无处可落；成功后的熄灭仍住 `src/client/undo-notices.ts`（`ownsNotice` 门）。
- `settleWrite` 不直接读 DOM、不问宿主：主视图收尾只经 `src/client/main-view.ts` 的 `afterDelete` / `afterRestore`（服务缺席或抛错都静默退回），重读仍归 `src/client/use-trash-query.ts` 与各调用方的 `refresh`。
- `/empty` 不进 settlement：它是聚合回执、没有逐条 outcome，「清空成功后把撤销横幅整条收掉」这一步仍住 `src/client/use-trash-query.ts` 的 `emptyTrash`。判据与 purge 支同一条——落点全没了，留着就是一条注定失败的「撤销」。

## 被否掉的替代

- **保留 `commit` 回调**：每个调用方仍要知道先 afterDelete 还是先 invalidate，顺序会继续分叉。
- **只让外部写走旧的 `commit` 回调**：面板写与外部写是同一个动作的两种座位，不是两套语义。
- **把 refresh 也塞进 settlement**：重读策略依赖面板的最新票与在飞的那次读，属于 `use-trash-query.ts`。
- **让面板恢复也走 `afterRestore`**：它会在恢复后把主视图抢到那条会话上，与 main-view 的“只遗忘、不重开”冲突。

锚点：`src/client/write-settlement.ts`；`src/client/write.ts`；`src/client/write-seats.ts`；`tests/client/write-settlement.test.ts`；`tests/client/write-seats.test.ts`；ADR-0017。
