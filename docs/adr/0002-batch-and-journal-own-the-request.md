# ADR-0002 — 「这一批」与「一次移动」各有自己的 module

- **状态**：已接受（2026-10-19）
- **相关**：`CONTEXT.md`（批量层 / journal）；`src/verbs/batch.ts`、`src/verbs/member-journal.ts`

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

interface 收一组 id 与一个**单条动作**，产出 `ApplyOutcome[]`；它独占四件：去重保序、清册快照、
「已被同批前一条带走」的账本、逐条信封。三个动词回到**一个 id 进、一条结果出**，
`onMembers` / `suppressAnnounce` 从它们的 interface 上消失，就地收缩快照的契约也一并消失。
（`verbs/apply.ts` 改名 `verbs/batch.ts`：名字说的就是这个 module 拥有什么。）

### 一点五、一个**保留**的参数，以及它为什么不算残留

`restoreSession` / `purgeTrash` 仍收一个**只读**的 `snapshot?: readonly TrashEntry[]`。
它不是批量语义，是**性能契约**：整批只读一次清册，读者把那一份递下去；收缩与「已被同批前一条带走」
的判据都留在批量层（动词只读它、绝不改它）。不传就自己读一次——单条调用者因此没有任何额外义务。
不带这个参数就得让每个动词各读一遍清册（100 条 = 100 次读），那正是这一层要消灭的成本。

### 二、`src/verbs/member-journal.ts` 拥有「一次移动」

- 一次成员的搬入或搬出 = 一串**步骤**，每步自带反向动作与一个标签（标签就是原来那些
  `rollbackReason('摘账本失败', e)` 里的那个词）；
- journal 独占：**相反顺序**退化、逐条失败收集、以及「某一步退不干净时不许让原错误独走」这条语义；
  `details.rollbackFailures` 的**合并与措辞**住在 `src/verbs/errors.ts` 的 `withRollbackFailures`，
  journal 是它唯一的调用方（**2026-10-20 就地订正**：本行原文把"合并"也记在 journal 名下，与代码、
  `member-journal.ts` 头注③ 和 `docs/architecture.md` §4 都不同源——按本仓口径，翻案个别条目就地补括注）；
- 三个动词变成三条**策略**：各自只声明「这个成员要按什么顺序做哪几步」，
  不再各自手写嵌套 `try/catch` 与 `failures` 数组。

## 明确的边界

- **可观察语义一律不变**：步骤顺序、回滚顺序、错误码、`rollbackFailures` 的措辞与合并规则
  （内层已带的失败要并进来、消息里不许出现第二个「回滚未完成」）全部照旧。
- **不**在这一轮改「哪些成员算一组」——那是 ADR-0001 的地盘。
- **不**把 `journal` 做成通用的撤销框架：它只服务「成员在 `sessions/` 与 `session-trash/` 之间搬」
  这一件事，超出它的步骤说明设计错了。

## 后果

- 三个动词的 interface 缩到「一个 id」；批量语义只有一个拥有者。
- 22 处 `rollbackReason(` 变成步骤标签（数据），8 处 `withRollbackFailures(` 收进 `member-journal.ts`
  （`journalFailure` 与组级 `rollbackJournals` 各一处）。
- 测试落点前移：**步骤顺序**与**回滚顺序**可以拿一个假 journal 直接断言（现有测试已经在用
  `calls.push(...)` 记顺序，形态不用改），不必每次都跑完整动词。
- 验收断言（`tests/client/remote.test.ts` 的「注入面 · 一个动作只有一条路」）：回收站面板的依赖面里不再同时出现 `applyOutcomes` 与 `restore`。

## 被否掉的替代

- **只把 `apply.ts` 三个循环抽成 `runBatch`**：解决了第 1 层，第 2、3 层原样——正是这次要拆的东西。
- **把回滚语义留到下一轮**：等于承认「同一条正反动作对写两遍」长期合法。
- **让浏览器半也用批量 module**：浏览器半不需要「这一批」的账本，它只要 N=1 的便捷支
  （N=1 也走同一段，口径在 `src/shared/wire.ts` 的段名那本账）。
