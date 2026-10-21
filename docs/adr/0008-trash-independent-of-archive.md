# ADR-0008 — 回收站与归档解耦：删除完整摘除活体，恢复走冷 resume

- **状态**：已接受（2026-10-21）
- **相关**：ADR-0005（成员在场通告）；ADR-0007（宿主端口角色）；`src/ports/host-port.ts` 的 `evictLive` / `src/ports/agent-handles.ts` 的 `captureAgentHandles`；`src/verbs/delete-session.ts`；`src/verbs/restore-session.ts`

## 背景

2026-10-21 在真机上发现：从回收站恢复一个**打开过**的会话后，会话打不开对话——prompt 回
`accepted`，但会话日志不再增长，直到宿主重启才恢复。

原因不在归档门，也不在恢复的目录/账本步骤：

1. 旧删除先用 `archiveSession` 把会话藏起来，再调 `evictLive`。
2. `evictLive` 只做 `SessionStore.liveEntryFor(session).detach()`，只摘 `ctx.sessions` 这一层；
   宿主那具 **agent 和它的写句柄仍在 `ctx.agents` 里**（插件没有 per-agent dispose）。
3. 恢复只把文件搬回、挂账本、取消归档，没有重建 agent。`SessionController.resolve` 先
   `liveAgent(sessionId)` 命中这具旧 agent，prompt 被塞进一具 session 已被摘掉的壳，日志不动。

同时，用归档来藏回收站会话本身也把两套状态混在一起：会话在回收站期间仍出现在宿主的归档集里，
恢复时要靠 `wasArchived` 反推取消归档。仓库的产品约束是「归档是归档，回收站是回收站」。

## 决定

1. **可逆删除不碰归档集**：`deleteSession` 不再调用 `archiveSession`。回收站的隐藏完全由
   `evictLive` 把会话（session + agent）从宿主内存摘掉完成；清册条目照旧记录删除前的
   `wasArchived` **事实**，但它不用来藏这次删除。
2. **`evictLive` 完整摘除活体**：除 `liveEntryFor(session).detach()` 外，还调用该会话
   **agent handle 的 `dispose()`**。宿主 `AgentService.resume` / `create` 返回的 `AgentHandle`
   带 per-agent teardown（宿主的 `agentLoop` 外层 teardown：关写句柄、摘 agent/session）——
   `SessionController` 只取 `.agent`、把 handle 丢掉了。插件在 `createHostPort` 里给
   `ctx.agents` 的 `resume` / `create` 包一层，按会话 id 留住 handle；删除时先摘 session，
   再 `await handle.dispose()`。**服务晚于插件激活**时用 `ctx.inject(['agents'])` 等它就绪再装，
   不依赖 profile 的插件加载顺序（2026-10-21 live 复测的缺口：只 `get` 一次时捕获会静默缺席）。
3. **恢复走冷 resume**：新清单的条目在删除时没有进归档集，恢复不调用 `unarchive`；
   文件回来、账本挂回、清册行摘除后，客户端由 `api-session/added` 重新拿到这一行，
   宿主按需要冷 resume。
4. **旧清单只做一次迁移**：2026-10-21 之前的删除用归档藏会话，那些条目
   `wasArchived:false` 但盘上仍在归档集里。恢复时若 `!wasArchived && isArchived`，
   做一次 `unarchive`；`wasArchived:true` 是用户删除前自己归档的，保持归档态不动。
5. `api-session/removed` 仍由 `member-presence` 统一发；完整摘除后宿主列表确实不含它，
   通告仍是如实的。

## 边界

- 不改组语义（`src/trash/groups.ts`）、批量（`src/verbs/batch.ts`）、线上形状与段名
  （`src/shared/wire.ts`）。`TrashEntry.wasArchived` 字段继续存在，含义是**删除前的事实**。
- **捕获不到 handle 的 agent**（插件激活前已启动的配置 agent，或 `ctx.agents` 形状变化）：
  只摘 session，旧 agent 仍可能拦住恢复；这是已知的残留限制，不拿归档当兜底。用户会话在
  插件激活后 `resume/create`，会被捕获。
- 永久的 `purge` / `orphan-clean` 仍走 `evictLive`，因此同样受益于 agent handle 的完整 teardown；
  没有恢复路径。
- `evictLive` 的 `unknown`（live store 缺失 / 形状不符 / detach 抛）仍不通告；宿主代次由
  `engines.dsh` 约束，支持的宿主有 live store。没有归档兜底。
- **删除期间有一小段「账本已摘、活体未摘」的窗口**（2026-10-21 评审登记）：`memberGone`（摘活体）必须在
  搬目录与写清册之后，所以 `detach` 与 `evictLive` 之间活体会短暂无主，客户端可能把它派生成「未分组」。
  旧实现用归档挡住这段窗口；去掉归档后它仍在。当前按"先保证失败可回滚"接受这个窗口；若要消除，需要另行
  设计（客户端在删除开始时乐观隐藏，或重排 `detach` / `evictLive` 并重做回滚序）。

## 客户端主视图：宿主 `removed` 是粘性的（2026-10-21 真机补充）

删掉正在看的会话后，宿主客户端把它的常驻 `Session` 标成 `removed`，输入框禁用、占位文案是
「会话不可用」。这不是旧的 agent 事故，恢复也修不好它：

- `dsh-api-session-controller/lib/client.js`（0.2.1-rc.2）的 `handleRemoved()` 只做
  `this.removed = true`；`handleSessionAdded()` 只 merge 摘要、调用 `handleBlank` / 投影，
  **从不清 `removed`**。`InputBar` 的 `disabled = removed || inert || !live || blocked || parentOffline`，
  `placeholder.unavailable` 就是「会话不可用」。
- 所以 `api-session/added` 回来之后，正在看的那一页仍然是禁用状态；只有丢掉常驻实例
  （切到别的会话再回来、或重载页面）才会重新从 `removed=false` 开始。

决定：

1. **删除成功后，如果当前主视图正是被删的会话，关掉主视图**。宿主自己的归档走的就是这条路：
   `dsh-client-ui-workspace/lib/client.js` 的 `clearArchivedCurrent()` 发现当前会话进了归档集就
   `clearMain()`。`clearMain()` 释放 `mainReference`，常驻 `Session` 的引用计数归零后由客户端
   `drop` 掉——不再有粘住的 `removed`。
2. **撤销恢复成功后重新打开它**：等客户端摘要表出现该会话（最多 2 秒）再 `openSession`，
   新实例的 `removed` 从 false 开始；期间用户选了别的会话就不抢焦点。
3. 通过浏览器半的 `ctx.get('uiWorkspace')` **可选读**服务（不 import 宿主客户端包，不进 `inject`；
   缺席/形状不符都安静退回）。形状依据住 `src/client/main-view.ts` 的头注。

被否掉的替代：直接改宿主 `Session.removed` 字段（那是更深一层内部状态，且删除后事件流已经断了，
还得补 `resync`）；只在恢复时发 `api-session/added`（截图证明它不清粘性位）；让用户重载页面
（把收尾成本转给用户，且会丢掉当前导航）。

## 后果

- 删除后宿主列表**不含**该会话；新删除不把会话放进归档集，用户删除前自己归档过的仍保留在归档集
  （`wasArchived:true`）。回收站是独立的第三处状态。
- 恢复是冷 resume；已打开过的会话恢复后继续对话（2026-10-21 在隔离宿主 0.2.0-rc.2 / 0.2.1-rc.2 +
  mock 模型上验证：删除后列表为空、新删除的 id 不在归档集；恢复后 prompt 继续落盘）。
- `createHostPort` 增加一个按会话 id 的 handle 表，挂在 `agents` 服务的 symbol 上（同一个服务上的
  第二个端口复用同一张表，否则第二个端口的 `evictLive` 看不到第一层 wrapper 捕获的 handle）；
  目前不主动清理正常 dispose 的条目，规模随宿主进程内出现过的会话增长，属于宿主生命周期内的少量闭包。
  若宿主的 `agent/disposed` 事件可全局订阅，再补清理。
- **捕获安装不依赖激活顺序**：`createHostPort` 先用 `ctx.get('agents')`，缺席时走
  `ctx.inject(['agents'])` 等服务就绪；`resume` / `create` **各自独立安装**，一个装不上不拖死另一个。
  核对是否真的换上必须读**目标对象上的自有属性**（`Object.getOwnPropertyDescriptor(proxy, name)`），
  **不能拿 `service[name]` 读回比身份**：cordis 的 traceable 服务代理每次读函数都会新包一层
  （`createShadowMethod`），读回永远不等于刚写进去的函数。2026-10-21 的首版修复就在这条假警报上
  中止了安装（`resume` 已包上、`create` 从未包上），新建会话因此仍会在恢复后不可用；回归用例
  `tests/assembly.test.ts` 用同一个“读回是新代理”的形状钉住两条路都必须捕获。
- 依赖 `ctx.agents.resume/create` 的返回形状（`AgentHandle.agent.id` + `dispose`）；
  这是内部适配，和 `liveEntryFor` 一样属于偏离公开面的内部适配（不数处数），升级宿主代次时先核形状。

## 被否掉的替代

- **归档 + 保留活体（可逆删除不摘 session）**：恢复能对话，但回收站会话一直躺在宿主的归档集里，
  归档视图可见；回收站与归档耦合，产品上不接受。
- **`agent.scope.dispose()` 只关内层 scope**：agent 仍在 `ctx.agents` 里，恢复后 prompt 仍被旧 agent
  收下、日志不动（实测）。
- **恢复时把旧 session `ctx.sessions.enter(...)` 挂回去**：会话变回可见，但旧 driver 不跑，
  prompt 仍不落盘（实测）。
- **删除时拒绝有活 agent 的会话**：安全但让“刚用过的会话”删不掉；没有关闭会话的官方 UI。
- **继续用归档藏回收站**：恢复仍要猜 `wasArchived`，且用户明确要求回收站与归档分离。
