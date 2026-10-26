# ADR-0007 — 宿主端口按角色切成三片：身份、在场、语料（缺席显式成 `CorpusRead`）

Status: superseded by 0019

## 背景

2026-10-20 之前，宿主能力是一个 **19 个方法平铺**的 `HostPort`；三种概念混在同一张 interface 上：

| 概念（当时没有名字） | 方法 | 缺席那一眼的形状 |
| --- | --- | --- |
| 身份与归属 | `workspaceOf`、`workspaceExists`、`projectDirOf`、`titleOf`、`isLive`、`isArchived`、`archive`、`unarchive`、`attach`、`detach`（10 个） | —— |
| 在场通告 | `evictLive`、`announceRemoved`、`announceRestored`、`restoredSummariesOf`、`announceRestoredBatch`（5 个） | —— |
| 会话语料 | `listSessions`、`subagentMembersBatch`、`subagentCounts`、`subagentMembers`（4 个） | `undefined` / `{}` / `[]` 三种 |

三处摩擦：

1. **缺席有三种形状，各方法各写一套**：`listSessions` 用 `undefined` 说"看不见语料"；`subagentMembersBatch` 与 `subagentCounts` 用 `{}`；`subagentMembers` 用 `[]`。`{}` 尤其糟糕——"语料看不见"与"这个父没有后代"是同一个返回值，`subagentCounts` 还会把零条数的父整个省掉，于是"扫描说零条"无法被证明是读数而不是缺席。每个调用方都得记住这张表，再各自把它折成自己的策略。

2. **三个 BFS 口共用同一次遍历**：`subagentMembersBatch`（父集合 → 成员表）、`subagentCounts`（父集合 → 条数）、`subagentMembers`（单个父 → 成员表）背后都是同一份 `membersFor`（`descendantsByParent` + `subtreeOf` + `bareSessionId` 去前缀）。三个名字、三份缺席约定，只是同一件事的三种投影；每加一个消费方，就可能多出第四种投影。

3. **每个动词都拿着整颗端口**：`DeleteDeps.host` 的类型是 `HostPort`，动词里一次删除要先用语料点出孩子、再用身份面问项目目录与活体、最后经在场通告面收尾；`member-presence` 与恢复侧的两个辅助函数虽然用 `Pick<HostPort, …>` 收窄了自己那几笔，但动词与装配处传递的仍是 19 个方法的整颗对象——只用一个方法的调用方在类型上照样依赖另外 18 个，假件也必须把 19 个全实现一遍。

## 决定

1. **按角色切成三张 interface**，同住 `src/ports/host-port.ts`：
   - `HostIdentityPort`（**10**）：`workspaceOf`、`workspaceExists`、`projectDirOf`、`titleOf`、`isLive`、`isArchived`、`archive`、`unarchive`、`attach`、`detach`——会话是谁、落在哪个项目/工作区、活不活/归档没有，以及账本与归档的写面。
   - `HostPresencePort`（**3**）：`evictLive`、`announceRemoved`、`announceRestored(ids)`——摘活体三态与 `api-session/*` 如实通告（ADR-0005 的用法不变）。
   - `HostCorpusPort`（**2**）：`listSessions`、`subagentMembersOf`——整表身份与子会话闭包。
2. **`HostPort` 变成复合别名**：`HostPort = HostIdentityPort & HostPresencePort & HostCorpusPort`（15 个方法）。生产 adapter 仍只有一颗——`createHostPort` 返回的对象同时满足三个角色，**不拆成三个对象**。`DeleteDeps.host` 保持 `HostPort`：一个动词的流程本来就跨角色（删除读语料 → 问身份 → 发通告），拆成三个依赖字段只是把装配搬到每个调用点。
3. **缺席显式成 `CorpusRead<T>`**：`{ available: true; value: T } | { available: false }`。`available:false` 说的是"这一趟看不见语料"（`sessionQuery` 服务没挂，或它的读面方法缺席 / 不是函数），与"看见了、里面是空的"是两件事。**不带原因串**：处理策略由调用方定，带一个字就会有人去断言那个字。
4. **缺席之后怎么办仍归调用方**，一处不搬：
   - `delete`：只删父（写侧只许静默降级，盘上残留留给 `GET /orphans` 兜底）；
   - `count`（删除确认框那句「含 N 个子会话」）：报 0；
   - `/list` 与 purge：静默降级（这次没有盘上后代可算），不折成失败；
   - `/orphans`（以及经 `loadOrphanGroups` 的 `orphan-clean`）：**响亮失败**（`io`），绝不拿零条假报告冒充。
5. **`subagentMembersOf` 取代三个 BFS 口**：一个签名（父集合进、按调用方写法回键的成员表出），背后仍是同一次 `membersFor` 遍历。**缺席判在空入参短路之前**：语料看不见时，哪怕入参是空的，也回 `{ available: false }`——"没有后代"这句话此刻不该被说出口。
6. 只切**类型**（外加把三个 BFS 口并成一个 `subagentMembersOf`）：除两个语料读面的返回形状（`CorpusRead` 信封）外，其余方法的宿主调用次数不变；恢复通告的取数（一次预取）收在 adapter 内部（ADR-0014）。

## 边界

- **无可观察行为变化**：线上形状、失败码、宿主调用顺序与次数都不变；第 4 条列出的四个策略逐字保留。
- **不拆 adapter 对象**：仍是一颗对象、一次 `createHostPort`。
- **不加 availability 探针**：不新增"先问一句服务在不在、再读"的方法。
- **不做 required/optional 双语料接口**：不按"宿主有没有 `sessionQuery`"发放两种 `HostCorpusPort`。
- **不拆 `DeleteDeps` 的角色字段**：不加 `identity` / `presence` / `corpus` 三个字段。

## 后果

- 端口从 19 个方法收到 **15 个**；`tests/host-roles.test.ts` 把三张表的键集合与 10 / 3 / 2 的边界、adapter 的 15 个方法逐一钉住（编译期 `ExactKeys` + 运行期键比较）。
- **假件变窄**：`tests/support/fake-deps.ts` 只需用 `membersAvailable: false` / `corpus: undefined` 表达语料缺席，`members` 与 `counts` 表达看得见时的读数；用例里只关心一个角色的地方可以只拿那个角色的类型。
- **缺席可测**：`{ available: false }` 与 `{ available: true, value: [] }` / `value: {}` 在类型上就分得开，用例不再从"空"反推"没挂"。
- **调用方拿到自己那个角色**：`member-presence.ts` 的 `MemberPresenceHost` 是 `Pick<HostPresencePort, 'evictLive' | 'announceRemoved' | 'announceRestored'>`——`Pick` 恰好钉住这条单成员协议用到的三条方法。批量恢复调的是同一个 `announceRestored(ids)`，摘要预取住 adapter 实现（ADR-0014）。`attachableWorkspaceId` / `isWorkspaceMissing` 收 `Pick<HostIdentityPort, 'workspaceExists'>`。
- **新语料调用方必须当场选策略**：读 `CorpusRead` 就得写 `available` 分支——这是有意的摩擦，防止再出现一个"空表兼表两意"的读面。
- **`evictLive` 的完整 teardown**（2026-10-21 就地订正）：方法签名与角色计数不变；内部除
  `liveEntryFor(...).detach()` 外，还会 dispose 从 `ctx.agents.resume/create` 捕获到的 `AgentHandle`
  （ADR-0008）——否则恢复后旧 agent 会拦住 prompt。捕获只在 adapter 内部，不进端口类型。

## 被否掉的替代

- **availability 探针**（例如 `hasCorpus()`，先问再读）：一次读变成两次宿主调用，而且两次之间服务可能变（TOCTOU）——探针说是，读仍可能缺席；探针说不是，读的那份数据也已经过时。缺席是**这次读**的属性，就该由这次读交回。
- **保留 `undefined` / `{}` / `[]`**：缺席仍是各方法各写一套的隐式约定，`{}` 继续兼表"看不见"与"没有后代"，"扫描说零条"永远无法被证明是读数。策略会继续住在每个调用方对形状的记忆里，而不是它的分支里。
- **required / optional 双语料 interface**（`HostCorpusPort` 与一个可选变体）：服务在不在是运行期事实，不是 adapter 的类型；那样会把"这一趟有没有语料"提前固化到装配期选中的接口上，调用方仍要分支，还多一层"我拿到的是哪一种"。
- **拆成三个 adapter 对象**：三者共享同一个 ctx，且彼此调用（`announceRestored` 要会话表，语料 BFS 要用 `projectKey` 与 `bareSessionId`）——拆开要么变成对象间自调、要么再抽第四个共享对象；假件也得为每条用例拼三个对象，比一个复合面更重。

锚点：`docs/architecture.md` §2（角色端口 / 语料缺席）；`src/ports/host-port.ts`；ADR-0002（批量归 `src/verbs/batch.ts`）、ADR-0005（成员通告归 `src/verbs/member-presence.ts`）、ADR-0006（永久删除计划与执行）、ADR-0014（恢复通告收成一条按 id 的方法）
