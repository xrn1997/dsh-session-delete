# CONTEXT.md — dsh-session-delete

一个 DeepSeek Harness（DSH）插件的**领域词表**。这里只放「这个词在本仓指什么」与「哪条事实只住哪个家」；
架构形状、模块归属与界面规格住 `docs/architecture.md`（界面规格在 §3.1），跨批次的裁决住在 `docs/adr/`，
代码与测试是最终真相；批次账与实测证据不再另存日志，历史留在 git。

探索代码前先读这一份：代码里的命名以它为准；要引入一个这里没有的词，先想清楚是不是在发明本仓不用的语言。

---

## 这是什么

在宿主里**删除会话**：删除 = 移入回收站（可恢复），另设显式的彻底删除；回收站之外还收留一批
**无主子会话**。两半：**Node 半**（动盘、动清册、动宿主服务）与**浏览器半**（槽位里的界面）。

## 名词

**数据根**（home）
宿主运行时数据根：显式配置 > `$DSH_HOME`（空白视为未设）> `~/.dsh`。插件只镜像后两级；解析只住
`src/ports/home.ts`。

**会话**（session）
宿主持久化的一条对话。落盘为 `sessions/<项目目录>/<会话目录>/session.vN.jsonl.zstd`——zstd **多帧**，
第一行是 header（含 `id` 与 `cwd`）；一个目录里可以并存多代日志，只读版本号最大的那代。

**项目目录**（`projectDir`）
宿主 `projectKey(cwd)` 的产物（`--…--` 裹边、分隔符折成 `-`、非分隔符走 `~XXXX` 转义）。
**有损**：分隔符那段拆不回真实路径。

**条目**（trash entry）
回收站里的一行。`id` = `<删除时刻 UTC>-<原目录名>`，**回收站目录名就是它**，恢复也靠它反推原目录名。

**清册**（manifest）
条目的索引，住在宿主 storage 域（`~/.dsh/storages/`）。它是**内部索引、不用手碰**；
外部真正的事实来源是 `~/.dsh/session-trash/` 里那些目录，两者由**对账**拉平。

**对账**（reconcile）
每次读清单前，把清册与 `session-trash/` 的目录修回一致：多出的目录重建出行、目录没了的行摘掉、
认不出的当外人（不动也不列）。幂等，且**零漂移零写入**。

**组**（group） / **组根**（group root）
一次删除搬进来的父会话与**在盘上、进了回收站**的孩子。孩子那行记 `parentEntryId` 指向父那行的 id。
判据只有一条：**接得住孩子的只有组根**——自己不记 `parentEntryId` 的那一行。父行不在、或父行自己
也是孩子时，孩子必须自己占一行，否则它的字节会被头部合计数两遍。
**组的闭包按组根算，不按直接孩子算**（`kind:'parent'` 一次问一层，问到问空为止）。

**盘上后代**（stranded descendants）
跟着父被删、但**没进回收站**、仍留在 `sessions/` 上的后代（级联落地之前删掉的那些存量）。
与「组里带进来的孩子」是两件事，界面上各说各的，不许一个冒充另一个。

**无主子会话**（orphan subagent）
`origin:"subagent"`、且父**既不在语料也不在清册**的会话。清理是永久删除——**不搬进回收站**、
**不自动**跑，且一次只清会话目录（投影缓存与附件不在范围内）。

**活体**（live session）
宿主内存里 attach 着的会话。删除 / 彻底删除 / 孤儿清理遇到成员在跑 ⇒ **整组拒绝、零副作用**。

**永久删除计划**（permanent removal plan）
一次永久删除之前要记下的全部事实：哪些**成员**（含盘上后代）与目录要删、各自**实测**多少字节、
哪些会话要退归档集 / 摘账本，以及**活体准入**。计划函数**只读**（`/list` 上「这次会释放多少」念的是
`planVisibleTrash`，与 purge 的 `planTrashRemoval` 共用同一套测量 / 筛选口径）；拿到计划之后才按它动盘的
是**执行器**——只写、不再量、不再判活体。purge 与 orphan-clean 共用这一对，`/list` 只用只读那半。
**journal 不参与永久删除**：journal 只服务"有反向动作的一次成员移动"，永久删除没有可回滚的那一半；
步骤顺序与部分回执都住 `src/verbs/permanent-removal.ts`。回执**由 `kind` 决定**：`kind:'trash'`（purge）
的删目录阶段失败不带 details，`kind:'orphan'`（orphan-clean）带 `{removed, freedBytes, failedSessionId}`；
更早的 `unarchive` / `detach` 一步不在回执范围内：purge 照旧折成带标签的 `io`，orphan-clean 照旧原样抛出，
都不带 details。

**成员在场**（member presence）
一个成员在宿主可见列表里的状态。**离场** = 摘活体并如实发 `api-session/removed`（`evictLive` 回
`unknown` 时不通告）；**归位** = 目录 / 账本 / 可见性三件写都回去后才发 `api-session/added`。
判据与成对通告只住 `src/verbs/member-presence.ts`；批量恢复的 `announceRestoredBatch` 仍归
`src/verbs/batch.ts`。

**归档**（archive）
宿主「从分组面藏掉」那一档。删除时用它把会话藏起来（否则它掉进「未分组」）；恢复按 `wasArchived`
反推可见性：原本已归档的一个字节都不动。

**通告**（announce）
让客户端**当场**删掉/加回一行的两条宿主事件（`api-session/removed` / `api-session/added`）。
冷会话没有活体可摘，通告照样必须发。

**跨槽位现场**（cross-slot state）
浏览器半挂在**互不相邻的座位**上（`shell.overlay`、`main`、会话行菜单）的模块级快照：同一个宿主进程里
跨组件卸载存活。快照 / 订阅 / 每实例 seq / `reset` 的脚手架只有一份，住 `src/client/store.ts`；
现场语义各自住调用方——多选模式与勾选集合住 `src/client/batch-selection-store.ts`，宿主行登记与整行点击守卫住
`src/client/host-rows.ts`。

**角色端口**（role ports）
宿主能力端口的三个切面，同住 `src/ports/host-port.ts`：**身份与归属**（`HostIdentityPort`，10 个方法：
会话是谁、落在哪个项目/工作区、活不活/归档没有，以及账本与归档的写面）、**在场通告**（`HostPresencePort`，
5 个：摘活体三态与 `api-session/*` 如实通告）、**会话语料**（`HostCorpusPort`，2 个：`listSessions` 与
`subagentMembersOf`）。`HostPort` 是三者相交的**复合别名**，生产 adapter 只有一颗（`createHostPort`），
`DeleteDeps.host` 仍是复合面。裁决在 ADR-0007。

**语料缺席**（corpus absence）
「这一趟看不见语料」（`sessionQuery` 没挂，或它的读面方法缺席 / 不是函数）与「看见了、里面是空的」是两件事。
两个语料读面都交 `CorpusRead<T>`：`{ available: true, value }` | `{ available: false }`，**不带原因串**；
形状的家是 `src/ports/host-port.ts`。**缺席之后怎么办归调用方**：删除只删父、count 报 0、`/list` 与 purge
静默降级、`/orphans` 与经 `loadOrphanGroups` 的 `orphan-clean` 响亮失败。裁决在 ADR-0007。

**薄线**
插件专属的宿主前缀路由 `/dsh-session-delete-api`。为什么不用官方 `remote.<namespace>`：第三方拿不到
Typert 描述符的动态发现挂载点；现行形状（六个段名、同源栅栏）住 `docs/architecture.md` §1，
状态语义（请求不对用它自己的 4xx、操作失败回 200 + 信封）住 `src/api/dispatch.ts`。

---

## 架构词

用这套词，别换成 component / service / boundary / wrapper。

- **module**：有 interface 与 implementation 的任何东西（函数、类、包、跨层切片）。
- **interface**：调用方要知道的全部——类型、不变量、顺序约束、错误形状、必需配置、性能特征。
- **implementation**：module 里面那具躯体。
- **seam**：可以不改这里就换掉行为的位置；module 的 interface 住在哪儿。
- **adapter**：满足某个 seam 上 interface 的具体东西。说**角色**，不说里面是什么。
- **depth**：interface 上的杠杆。薄的 interface 后面压着一大坨行为 = **deep**；interface 几乎与
  implementation 一样复杂 = **shallow**。
- **leverage**：调用方从 depth 得到的东西（一份实现，N 个调用点）。
- **locality**：维护者从 depth 得到的东西（改动、bug、知识、验证都集中在一处）。

本仓的具体化（这些是 module，不是层）：

- **wire**：`src/shared/wire.ts`——两半共同的线上契约：段名、动作、形状、失败码。**零运行时依赖**。
- **groups module**：`src/trash/groups.ts`——组语义的唯一家（谁能接住孩子、这一组有谁、谁已被同批带走）。
- **批量层**（batch layer）：`src/verbs/batch.ts`——「这一批」的唯一拥有者：去重保序、清册快照、
  已带走账本、逐条信封。
- **成员在场**：`src/verbs/member-presence.ts`——成员离场 / 归位通告的唯一家。
- **journal**：一次成员移动 = 一串步骤，每步**自带反向动作**；journal 拥有顺序反转、失败收集与
  `details.rollbackFailures` 的合并。
- **路由表**（route table）：`src/api/route-table.ts`——段名 → `{ 方法, body, 纯度, 处理 }`；`dispatch` 的
  方法 / 纯度 / 请求体预读三件事都读它。
- **行投影**（`toWire`）：清册那一行（`TrashEntry`）→ 线上那一行（`TrashRowWire`）的唯一投影处。

---

## 一条事实只住一个家

改这些之前，先找到它们的家：

| 事实 | 家 |
| --- | --- |
| 六个段名、五个动作、线上形状、失败码 | `src/shared/wire.ts` |
| 段名的方法 / 纯度 / 处理 | `src/api/route-table.ts` |
| 组语义（根行才接得住孩子、闭包） | `src/trash/groups.ts` |
| 条目 id 的形状与路径闸（单段校验） | `src/trash/entry.ts` |
| 清册与目录的对账 | `src/trash/reconcile.ts` |
| 宿主 storage domain 的绑定（域 open/close、条目校验器） | `src/trash/storage-manifest.ts` |
| 详情正文给谁看、给多少（`source.kind` 过滤与载荷闸） | `src/trash/detail.ts` |
| 回滚失败的措辞与合并（码本身住 `wire.ts`） | `src/verbs/errors.ts` |
| 「这一批」 | `src/verbs/batch.ts` |
| 成员离场 / 归位通告（摘活体、三态、成对事件） | `src/verbs/member-presence.ts` |
| 永久删除的计划与执行（成员 / 目录 / 字节 / live 准入 / 部分回执） | `src/verbs/permanent-removal.ts` |
| 宿主能力的唯一适配：三个角色切面与复合别名 `HostPort` | `src/ports/host-port.ts` |
| 语料缺席的形状（`CorpusRead`；缺席之后怎么办归调用方） | `src/ports/host-port.ts` |
| 数据根的解析（env → home） | `src/ports/home.ts` |
| 文案 | `src/client/copy.ts`（命名空间字典） |
| 回收站面板状态机（选中 / 详情缓存 / 行失败 / 确认派发 / 自动选中 / 下钻回退） | `src/client/use-trash-panel-controller.ts` |
| 跨槽位现场脚手架（快照 / 订阅 / 每实例 seq / `reset`） | `src/client/store.ts` |
| 批量选择面（多选模式 / 勾选集合 / 追加与收缩） | `src/client/batch-selection-store.ts` |
| 宿主行读取与整行点击守卫（可见行 / 全选判定 / 捕获阶段拦行点击） | `src/client/host-rows.ts` |
| 宿主槽位与注册 | `src/client/index.tsx` |

**跨插件一律 `import type`**；浏览器半一条 `@deepseek-ai/*` 的 import 都不许有（type-only 也不留）。
