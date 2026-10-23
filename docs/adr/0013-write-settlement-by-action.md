# 写入收尾按 action 收进 settlement

Status: accepted

五个逐条 `/apply` 写入面曾各自把 receipt、主视图收尾、回收站失效与撤销通告拼一遍；把顺序按 action 收进 `src/client/write-settlement.ts` 后，写入面只交呈现素材，顺序与 `anySuccess` 门只有一个家。

## 决定

1. `runWrite` 在拿到 `WriteSuccess` 后调用 `settleWrite`，再调用 refresh。
2. delete / restore / purge 各有一条固定顺序；`count` 与 `orphan-clean` 不结算——orphan-clean 没有跨槽位收尾，它的写后刷新归 `use-trash-query.ts`。
3. 写入面通过 `WritePresentation` 交撤销、主视图、缓存与失效回调，不再自己拼顺序。
4. 恢复有两个座位：外部恢复（撤销横幅）没有 `forgetMainView`，由 settlement 调 `afterRestore` 重开；面板恢复自带 `forgetMainView`，只遗忘、不重开、不抢焦点（判据住 `src/client/main-view.ts`）。
5. 跨槽位收尾（`afterDelete` / 外部恢复的 `afterRestore` / `invalidate`）在信封成功时就跑，逐条全失败也跑——回滚失败可能留下半套，清单不能继续摆旧行；呈现钩子（撤销、面板恢复的遗忘、清详情缓存）才受 `anySuccess` 门。

## 边界

- 不改 `/apply` 的线上形状、逐条信封与失败码。
- 面板写仍用自己的 `refreshAfterWrite`；外部写用 `invalidateTrash`。
- 面板恢复仍只遗忘主视图记录、不重开；撤销恢复仍重开。两条座位语义不合并。
- `settleWrite` 不直接读 DOM、不问宿主：主视图收尾只经 `src/client/main-view.ts` 的 `afterDelete` / `afterRestore`（服务缺席或抛错都静默退回），重读仍归 `src/client/use-trash-query.ts` 与各调用方的 `refresh`。

## 被否掉的替代

- **保留 `commit` 回调**：每个调用方仍要知道先 afterDelete 还是先 invalidate，顺序会继续分叉。
- **只让外部写走旧的 `commit` 回调**：面板写与外部写是同一个动作的两种座位，不是两套语义。
- **把 refresh 也塞进 settlement**：重读策略依赖面板的到达序链与在飞序号，属于 `use-trash-query.ts`。
- **让面板恢复也走 `afterRestore`**：它会在恢复后把主视图抢到那条会话上，与 main-view 的“只遗忘、不重开”冲突。

锚点：`src/client/write-settlement.ts`；`src/client/write.ts`；`tests/client/write-settlement.test.ts`。
