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

**归档**（archive）
宿主「从分组面藏掉」那一档。删除时用它把会话藏起来（否则它掉进「未分组」）；恢复按 `wasArchived`
反推可见性：原本已归档的一个字节都不动。

**通告**（announce）
让客户端**当场**删掉/加回一行的两条宿主事件（`api-session/removed` / `api-session/added`）。
冷会话没有活体可摘，通告照样必须发。

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
| 详情正文给谁看、给多少（`source.kind` 过滤与载荷闸） | `src/trash/detail.ts` |
| 回滚失败的措辞与合并（码本身住 `wire.ts`） | `src/verbs/errors.ts` |
| 「这一批」 | `src/verbs/batch.ts` |
| 宿主能力的唯一适配 | `src/ports/host-port.ts` |
| 文案 | `src/client/copy.ts`（命名空间字典） |
| 宿主槽位与注册 | `src/client/index.tsx` |

**跨插件一律 `import type`**；浏览器半一条 `@deepseek-ai/*` 的 import 都不许有（type-only 也不留）。
