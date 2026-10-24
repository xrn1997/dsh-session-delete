# 写后要不要重扫残留，由这次的写入结果派生

Status: accepted

「无主子会话」那一块在写入之后要不要重扫，此前由调用方传 `rescan: true` 决定：漏传就留下盘上不露面的新孤儿，全传则每次写都付一次全量扫描。`src/client/use-trash-query.ts` 的 `needsOrphanRescan` 把这条判据收成一处——调用方只交这次的 `WriteOutcome`，要不要扫由动作、请求的 id 与发读前的清单自己算。

## 决定

1. `refreshAfterWrite(outcome?)` 收这次的写入结果，成功支与失败支都带 `action` 与 `ids`：失败也要判，因为半套现场同样可能留下新孤儿。要不要扫只认 `needsOrphanRescan`。
2. `purge` 与 `orphan-clean` 总要扫：语料缺席时故意留下的盘上后代、被带走的父行留下的孩子，报告为空也只是这一拍为空。
3. `delete` 不扫：孩子跟着父走，报告为空时扫了也只会得到一份空报告。
4. `restore` 只在清单未知（不知道恢复的是什么）、清单里已经找不到这个 id（这一拍不能断言它不是孩子），或恢复的是孩子行（父可能仍不在语料里，回到语料后可能无主）时扫；组根恢复把孩子一起带回，不新增孤儿。
5. 失效通告没有 outcome（不是这个面板发起的写）：仍按「报告未知或非空才扫」。
6. `ApplyAction` 多出一个动作时必须在这里选一条，不许静默落到「不扫」。

## 边界

- 重读策略（最新票、在飞旧响应不盖新态、清单读失败清空报告与提示）仍归 `src/client/use-trash-query.ts`；settlement 不决定重读，也不把 refresh 收进自己（ADR-0013）。
- `/empty` 是聚合回执，没有逐条 outcome，`emptyTrash` 自己强制扫。
- 强制重扫的标记先记再读清单：这一读输给后发的读时由赢家补扫，强制不丢。
- 「报告 `null` 不等于空报告」这条判据不变：它讲的是未知，不是零。

## 被否掉的替代

- **调用方继续传 `rescan` 标记**：义务仍在调用方，每加一个写入面就要重新回答一遍「这个动作到底要不要扫」，漏答的那一路静默留下隐形孤儿。
- **写后一律重扫**：面板每次删除/恢复都付一次全量扫描，而 `delete` 那一路不会新增孤儿。
- **刷新完清单之后再反推**：判据要看的是「这次动作动了谁」，而清单已经是动作的后果。
- **把判定搬进 settlement**：那里没有当前清单，也不该知道最新票与在飞的那次读。

锚点：`src/client/use-trash-query.ts` 的 `needsOrphanRescan`；`src/client/write.ts` 的 `WriteOutcome`；`tests/client/use-trash-query.test.tsx`；`docs/architecture.md` §4；ADR-0013。
