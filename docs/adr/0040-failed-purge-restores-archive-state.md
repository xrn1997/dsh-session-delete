# ADR-0040 — 失败的永久删除要把归档态放回去（目录仍不回滚）

Status: accepted

永久删除在任何删除之前先把整批会话 `unarchive`（免得留下「会话没了、归档集还挂着」的幽灵 id）。执行中途失败时目录还在回收站，归档位却已经摘了；而恢复路径只为旧条目迁移取消归档、从不补归档，于是用户删除前自己归档的会话在「失败的彻底删除」之后恢复就成了未归档。执行器现在先读一遍归档实况，失败出口把**还没删掉**的那些重新归档。

## 背景

ADR-0027 定下永久删除的顺序：退归档集 → 摘账本 → 删目录 → 通告，且「目录删掉就没有退回去这回事，中途失败不回滚」。不回滚对目录成立，对归档态不成立：归档只是 registry 上的一位，条目还在回收站、目录也还在，完全可以放回去。不放回去的代价落在恢复路径上——`restore-session.ts` 只为旧条目（`wasArchived:false` 且当前仍归档）做一次迁移式 `unarchive`，对「删除前自己归档过的」条目保持归档态；它不会替一次失败的 purge 补归档。结果是 `entry.wasArchived` 说「原本归档着」，盘上却已经不是。

失败点不只一种：`unarchive` 自己失败（前面几条已摘）、`detach` 失败、`removeDir` 撞 EBUSY / 杀软占用、`ledger.remove` 失败。前两种发生时一个目录都还没删，整批都该放回去；后两种只该放回还没删掉的那些——给已经删掉的会话补归档只会在 registry 里留一条没有会话的幽灵 id。计划时就缺席的行 / 成员同理：它们进 `unarchive` 名单是为了清掉挂着的幽灵 id，本体已经不在盘上，失败时也不该再挂回去。

## 决定

1. 执行器在动第一笔写之前读一遍 `plan.unarchive` 的归档实况（`isArchived`），把「确实归档着」的 id 记进回滚名单。不按 `wasArchived` 猜：那是删除那一刻的清册事实，旧条目与盘上成员的当前归档态都可能与它不同。
2. 失败出口按反向顺序对两种 id 重新 `archive`：走到过 `unarchive` 这一步的、且目录还在的（这一趟没删掉、也不是计划时就缺席）。目录不在的跳过（见上）。
3. 回滚自己的失败不吞：走 `withRollbackFailures`，原文接在消息后面、明细进 `details.rollbackFailures`，码仍按原错误的动词码。
4. 目录、账本、通告仍不回滚：目录删了就是删了；账本摘了由恢复路径按条目里的 `workspaceId` 重新挂；已经发过的「已移除」通告不撤回（会话目录没了，那是事实）。

## 边界

- 只覆盖 `src/verbs/permanent-removal.ts` 的执行器；删除 / 恢复的逐步 journal 回滚不变。
- `detach` 不回滚：恢复时 `restore-session.ts` 会按清册里的 `workspaceId` 重新 `attach`，没有用户可见的损失；归档不同，恢复不补。
- 不改计划：`plan.unarchive` 的名单与顺序、`planTrashRemoval` / `planOrphanRemoval` 的测量都不动。
- 多读一次 `isArchived` 是已知代价：名单长度 = 这趟真要碰的会话数；一次性、只读、在零写之前。

## 后果

- 一趟成功路径多 N 次 `isArchived` 只读调用（N = `plan.unarchive` 长度）；失败路径多最多 N 次 `archive`。
- 失败回执可能多出一段「回滚未完成：恢复归档失败：…」——它和目录不回滚的现状并存，不伪装成整批没动。
- 测试钉住五条：删到一半失败只放回未删的、删目录之前失败放回整批、原本没归档的不凭空归档、计划时就缺席的行不回滚、回滚失败进 `details.rollbackFailures`。

## 被否掉的替代

- **把 `unarchive` 挪到删目录之后**：`unarchive` 失败时目录已经没了，反而制造「会话没了、归档集还挂着」的幽灵 id——那正是把它前置的原因。
- **只按 `entry.wasArchived` 回滚**：旧条目（`wasArchived:false` 但盘上仍归档）与盘上成员的当前归档态都不在清册这一格里；按它回滚会漏放或错放。
- **不回滚，让用户之后自己再归档**：用户看到的是「彻底删除失败」，没有任何一处告诉他归档态已经没了；恢复后会话出现在列表里，状态变化静默且不可归因。
- **失败后把整批 `archive` 一遍**：会把删除前没归档的会话也归档，制造另一种静默状态变化。

锚点：`src/verbs/permanent-removal.ts`；`src/verbs/errors.ts` 的 `withRollbackFailures`；`src/verbs/restore-session.ts`；`tests/permanent-removal.test.ts`；ADR-0008（回收站与归档解耦）；ADR-0027（永久删除计划与执行）
