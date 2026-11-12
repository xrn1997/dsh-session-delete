# 回收站面板承载归档档：只读展示 + 显式解除归档 + 删除进回收站

Status: accepted

回收站面板内加一个与回收站**平级**的「归档」档（平级分段 `回收站 N | 归档 M`，不开侧栏第二面板、不进设置页卡）：看得到已归档会话与正文、一步解除归档、也能删除（进回收站、可反悔）。归档只做**只读展示 + 解除 + 删除**三件事；删除 / 恢复仍不碰归档（ADR-0008 不动），`unarchive` 是**用户显式动作**。详情正文走 `sessionQuery.readSession` 的事件流 + 合成 `session` 头喂既有块折叠（`DetailFold`），只读自己已归档、或已归档根 subagent 闭包成员的 id（闭包放宽见 ADR-0061）。与 archive-manager 之类的归档插件叠加安装不打架：状态解耦，删除链、附件红线（ADR-0020）与孤儿维护（ADR-0021）一概不动。

## 背景

本插件此前只覆盖"不要了怎么办"（删除 → 回收站 → 彻底删除），不覆盖"藏起来 / 找回来"。市面上的会话治理插件没有一家只做归档——全是全家桶，而归档功能面上自带永久删除（不可逆、无回收站）；只做删除的本插件反而是"顺手可替代"的那个。归档档让一个插件覆盖"藏-找-扔"全程，且与删除语义正交：归档藏的是**还在的**会话，回收站收的是**删掉的**会话。

## 决定

1. **不动 ADR-0008 的案**：删除仍不调 `archiveSession`；`unarchive` 是用户显式动作（`/apply` 的第六个动作，写 registry 归档集、进到达序链），不是删除/恢复的副作用。已归档会话删除后 `wasArchived` 照记，恢复时保持归档态——撤销一条"已归档会话的删除"是**回到归档**，不是回到会话列表（撤销横幅如实说）。
2. **边界：只读展示 + 解除 + 删除**。解除与删除可**批量执行**（复用回收站的多选语义与确认框；它们没有新增动作，只是同一动作作用于多条），批量归档仍不做。不做其他策展（全文搜索、收藏、空闲清理、自动归档、turn 统计、原生"继续聊"入口）——那是归档全家桶插件的主场，档 2 若来另立裁决。`archive-detail` 只读目标自己已归档、或已归档根 subagent 闭包成员的 id（闭包放宽见 ADR-0061），不做通用会话正文通道（寻址红线：客户端只传 id，路径字段不过线）。
3. **受约束偏离**（升级宿主代次先核这些形状）：
   - `sessionQuery.readSession` 的 `{ session, inheritedEventCount, events }`——**events 不含 header 记录**，归档详情的薄适配必须把 `session` 头合成一条 raw 同形的 `{"type":"session",…}` 记录喂块折叠。合成头**只带折叠消费的三格**（`cwd` / `createdAt` / `parentSession`）：`origin` 虽是子会话的权威判据，折叠认的却是 `parentSession` 非空，投影 `origin` 没有消费方；把 label 兜底改成按 `origin` 判是两档共用的行为改动（ADR-0058 语义），另立裁决。事件流**逐条判形状**（`type` 是字符串、`time` 是数），不符就抛 ⇒ 上层折 `io`，不静默折成空正文；
   - `readTitleSnapshots` 的逐条 `fulfilled`/`rejected` 结果（单条 rejected 只空该行，不失败整张清单）；
   - `SessionPersistenceSnapshot.sizeBytes` **可选**（JSONL 后端给物理工件字节，其他后端可能不给）——缺席不拿 0 冒充；`sessionPersistence` 服务缺席 ⇒ 逐行缺大小、整档照常，只有 `list()` 抛错才折整档 `io`；
   - `sessionController.list()` 的 `updatedAt` 口径与**冷无 cwd 会话被跳过**（这类行回退 `header.createdAt` 并标 `created`）；
   - A1 新鲜度的 `workspaces` 客户端模型（`list.getSnapshot().archivedSessionIds` / `list.subscribe`，窄镜像可选读、形状不符安静降级）；
   - 子会话段的数据来自 `subagentMembersOf` 的闭包，标题 / 时间 / 大小 / label / 归档态分别走 `readTitleSnapshots` / `sessionActivity` / `sessionPersistence` / `labelOf` / `isArchived`——任一读面缺席只是该字段或该段降级，不拖垮正文。
4. **两档状态完全独立**：归档档的清单状态（四态，含 `corpus-missing` 显式缺席）、选择面（键 = 会话 id）、详情账本（挂载内、键 = 会话 id）与回收站档（键 = 条目 id）互不相通；归档不进 `trash-snapshot` 首帧快照。失效链唯一入口是 `reload`：A1 旁路观察宿主归档集、插件自己的回收站动作（`trash-store` 修订）、自救动作三个来源同轮合并、latest-wins，不轮询（沿 ADR-0036 的路子）。

## 边界

- 归档集与 `listSessions` 按 **id 原样**交集（与 `isArchived` 的精确判据一致）；ghost id（归档集有、语料已无）宁可少显示；删除不改 `archivedSessionIds`，回收站里那条靠交集自动消失。
- 归档行的两本账与回收站行**不是一个数**：大小 = `sessionPersistence.sizeBytes`（宿主持久化日志工件字节，不含附件、不含子会话闭包）；时间 = 「最后活动」（`sessionController` 的 `updatedAt`），无提问时间回退「创建于」。详情信息表的日志末条另用标签，不与列表共名。
- 归档仍是**单会话粒度**（宿主 `archiveSession` 不带子会话闭包）：孤儿子会话以独立行显示并带「子代理」标签；详情画**只读子会话段**（宿主闭包 + 标题/大小/时间/label/归档态），未归档孩子可随已归档父会话只读查看（闭包放宽见 ADR-0061）——不提供随父归档/恢复。
- **归档修订也作废挂载内的归档详情账本**：子会话段的 `archived` 与主体状态都是读时快照；A1 / 自救 / 回收站动作让归档集变化后，不拿旧账本冒充，当前主体重读、其余条目等重新选中时再读。这不新增读源，清单的唯一失效入口仍是 `reload`。
- 详情正文沿用回收站详情的块/分页/字符闸（`DetailFold` 唯一实现）；v1 每次翻页重走整本 `readSession`，慢的话另立缓存裁决。

## 被否方案

- **侧栏第二面板（B）/ 设置页卡（C）**：用户已定形态 A——回收站面板内部一档。
- **面板改名（P1 伞名）/ 侧栏标签随档位变（P2）**：入口名是容器名不是内容枚举；宿主 label 是槽位 thunk，P2 要重注册或 hack DOM。用户已否。
- **逐条 `sessionPersistence.stat` 回退清单**：造"半真"清单。
- **子会话随父一起归档/恢复**：宿主 `archiveSession` 不级联；详情只做只读展示，孩子的归档状态与动作各归自己。
- **A2 Node 推送**（宿主归档集变化经我们通道下发）：现有 exact Fetch 通道没有 SSE/WebSocket 下发面，A2 要扩传输或退化轮询；A1 旁路读已在地板可用。
- **挂载即预取归档清单**：默认档是回收站，不为可能不打开的档付一次全语料读（M 惰性）。
- **`archive-detail` 不校验归档集**：把详情段扩成可读任意会话的正文通道。
- **子会话标题只走 `readTitleSnapshots`**：丢 ADR-0058 的 label 优先（用 `titleOf` 的投影缓存路径补 `label`）。
- **归档档复用回收站首帧快照/详情账本**：跨档状态串味、账本按 64 条上限互相挤兑。

锚点：`src/api/archive-rows.ts`（`assembleArchiveRows`）；`src/trash/archive-detail.ts`（`readArchiveDetail`）；`src/shared/wire.ts`（`ArchiveListWire` / `ArchiveDetailWire` / `ApplyAction` 的 `unarchive`）；`src/ports/host-port.ts`（`HostIdentityPort` 的 `archivedSessionIds` / `labelOf` 与 `HostCorpusPort` 的 `titleSnapshots` / `sessionActivity` / `persistedSizes` / `readSession`）；`src/client/use-archive-query.ts`（`useArchiveQuery` / `reload`）；`src/client/host-archive-watch.ts`（`installArchiveHostWatch`）；`src/client/use-archive-panel-controller.ts`；`src/client/use-detail-reader.ts`（`useDetailReader`，两档详情读路的通用机制）；`src/client/session-detail.tsx`（`SessionDetail`）；`src/client/trash-nav.ts`（`useTrashNav`，两档清单共用的键盘契约）；`src/trash/detail.ts`（`createDetailFold`）；`tests/archive-rows.test.ts`；`tests/archive-detail.test.ts`；`docs/ui-spec.md` §3.1（归档档）；ADR-0008（删除/恢复不碰归档）；ADR-0036（订阅不轮询）；ADR-0061（子会话闭包只读）。
