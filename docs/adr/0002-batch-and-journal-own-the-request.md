# ADR-0002 — 「这一批」与「一次移动」各有自己的 module

Status: accepted

## 背景

`POST /apply` 已经是「一段管所有动作、一组 id 进、逐条结果出」（2026-10-17 `c66f082`），但那条判据只落在**路由层**；
再往下，批量的性质长在了**三个动词的 interface** 上：

| 动词 | 批量塞进 interface 的东西 |
| --- | --- |
| `deleteSession` | `options.onMembers`——批量层借动词的手记「哪些 id 这次被带走了」 |
| `restoreSession` | `options.snapshot` + `options.suppressAnnounce`——批量层把整批这一次清册读抬进来，并让动词别逐条通告 |
| `purgeTrash` | `options.snapshot`——**动词就地 `splice` 调用方的数组**（这是一条写在注释里的契约） |

后果有三层：

1. **调用方必须知道自己是第几个**：`apply.ts` 里三个动作各写了一遍「去重保序 → 查快照 → 判断是不是
   『已被同批前一条带走』 → try/catch 折成信封」的循环；
2. **同一件事有三种机制**：`onMembers` 回调、调用方 `taken` 集合、动词就地收缩快照；
3. **正反动作各手写一遍**：`delete-session.ts` 的 `moveOneIn` / `undoOneIn` 与
   `restore-session.ts` 的 `restoreOne`（含它的反向闭包）互为镜像，`rollbackReason(` **22 处**、
   `withRollbackFailures(` **8 处**，`evict + announce` 这一对 **5 份**、`diskPlans`
   （`{sessionId, dir, bytes, workspaceId?}`）建了**两遍**。

第 3 层本来被排到「以后另开一条候选」。那是打补丁的排法：**重复的根因不是「回滚值得自己的候选」，
而是三个动词各自手写了一条正反动作对**。

## 决定

### 一、`src/verbs/batch.ts` 拥有「这一批」

interface 收一组 id 与一个**单条动作**，产出 `ApplyOutcome[]`；它独占三件：去重保序、逐条信封、
一批一次通告。三个动词回到**一个请求 id 对应一条结果**，`onMembers` / `suppressAnnounce` 从它们的
interface 上消失，就地收缩快照的契约也一并消失。
（`verbs/apply.ts` 改名 `verbs/batch.ts`：名字说的就是这个 module 拥有什么。）

**同批已带走集**住 `src/verbs/batch-carried.ts`：
entry / session 两种 id 域各一个 adapter——entry 的三态判据读 `trash/groups.ts` 的 `claimOf`，
session 只记 `take` 过的会话 id（fresh / carried 两态）。`batch.ts` 消费它的 `claim` / `take`，
purge 那一路另取 entry 域交回的当前只读视图（盘上后代要按清册里还在的 id 排除）；
删除动词的结果仍是 `{ entry, movedSessionIds }`，session adapter 从这份结果长出
集合，不在每条删除后重读清册。它不是回调——一条请求 id 仍只产出一条结果。

### 一点五、动词收到的是**只读的组 / 清册**

批量路径上，`restoreSession(entryId, group)` 与 `purgeTrash(targets, rows, requestedId?)` 收的是由
`batch-carried.ts` 按组语义算好的只读目标（`targets === undefined` = 清空）。它不是批量语义，是
**性能契约**：整批只读一次清册，读者把那一份递下去；收缩留在 `batch-carried.ts`，
「已被同批前一条带走」的判据读 `trash/groups.ts` 的 `claimOf`（动词只读目标、绝不改它）。
直调路径要自备这一组（一次清册读 + `trash/groups.ts` 的 `groupOf`）；批量层交给 `claimOf`，
直调者自己按组语义算。ghost 父（父行已摘、只剩孩子）的组只有孩子：restore 照旧报 `trash-empty`，
purge 照旧清这一组；其余目标按组整体处理。
不带这份目标就得让每个动词各读一遍清册（100 条 = 100 次读），那正是这一层要消灭的成本；
批量路径由 `batch.ts` 读一次清册，交给 `batch-carried.ts` 持有收缩视图与只读快照。

### 二、`src/verbs/member-journal.ts` 拥有「一次移动」

- 一次成员的搬入或搬出 = 一串**步骤**，每步自带反向动作与一个标签（标签就是原来那些
  `rollbackReason('摘账本失败', e)` 里的那个词）；
- journal 独占：**相反顺序**退化、逐条失败收集、以及「某一步退不干净时不许让原错误独走」这条语义；
  `details.rollbackFailures` 的**合并与措辞**住在 `src/verbs/errors.ts` 的 `withRollbackFailures`，
  journal 是它唯一的调用方（**2026-10-20 就地订正**：本行原文把"合并"也记在 journal 名下，与代码、
  `member-journal.ts` 头注③ 和 `docs/architecture.md` §4 都不同源——按本仓口径，翻案个别条目就地补括注）；
- 三个动词变成三条**策略**：各自只声明「这个成员要按什么顺序做哪几步」，
  不再各自手写嵌套 `try/catch` 与 `failures` 数组。

组级的**成员顺序、组根结果的交回与整组逆序回滚**住 `src/verbs/move-group.ts`：根先跑，跟随者按序拿到
根结果，调用方直接拿返回的根结果、不按位置索引结果数组；journal 仍只服务单个成员。
它的 `undo()` 交回失败串与 `restored(key)`（每一步到底退回去了没有），动词不再自己累计布尔。

## 明确的边界

- **可观察语义一律不变**：步骤顺序、回滚顺序、错误码、`rollbackFailures` 的措辞与合并规则
  （内层已带的失败要并进来、消息里不许出现第二个「回滚未完成」）全部照旧。
- **不**在这一轮改「哪些成员算一组」——那是 ADR-0001 的地盘。
- **不**把 `journal` 做成通用的撤销框架：它只服务「成员在 `sessions/` 与 `session-trash/` 之间搬」
  这一件事，超出它的步骤说明设计错了。

## 后果

- 删除的 interface 仍是一个 id；恢复收「id + 只读组」，purge 收「只读目标 + 只读清册」。
  删除的结果是 `{ entry, movedSessionIds }`；批量请求仍归 `batch.ts`，同批已带走集与组级顺序
  分别住 `batch-carried.ts` / `move-group.ts`。
- 22 处 `rollbackReason(` 变成步骤标签（数据），8 处 `withRollbackFailures(` 收进 `member-journal.ts`
  （`journalFailure` 与组级 `rollbackJournals` 各一处）。
- 测试落点前移：**步骤顺序**与**回滚顺序**可以拿一个假 journal 直接断言（现有测试已经在用
  `calls.push(...)` 记顺序，形态不用改），不必每次都跑完整动词。
- 验收断言（`tests/client/remote.test.ts` 的「注入面 · 一个动作只有一条路」）：回收站面板的依赖面里不再同时出现 `applyOutcomes` 与 `restore`。

## 被否掉的替代

- **只把 `apply.ts` 三个循环抽成 `runBatch`**：解决了第 1 层，第 2、3 层原样——正是这次要拆的东西。
- **把回滚语义留到下一轮**：等于承认「同一条正反动作对写两遍」长期合法。
- **让浏览器半也用批量 module**：浏览器半不需要同批已带走集，它只要单条写入的判读
  （单条也走同一段，口径在 `src/shared/wire.ts` 的段名那本账）。

锚点：`CONTEXT.md`（同批已带走集）；`src/verbs/batch.ts`、`src/verbs/batch-carried.ts`、
`src/verbs/move-group.ts`、`src/verbs/member-journal.ts`
