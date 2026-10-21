# 架构与形状

这份文档只回答两个问题：**系统分成哪几块、为什么这么切；某条语义的主人在谁头上**。它是 explanation——给读懂代码提供地图，不给代码充当副本。

不在这里的东西，各有各的家：**术语**在 `CONTEXT.md`（词表）；**难逆的裁决与被否决的替代**在 `docs/adr/`（索引见 `docs/adr/README.md`）；**用户可见的事实**在 `README.md`；**构建、门控与发版**在 `docs/developing.md`；**界面规格**在 `docs/ui-spec.md`；**"怎么做"**在代码自己。这里一条读数都不列——列了就是第二份抄本，且必然腐烂。批次账与实测证据不再另存日志，历史留在 git。

## 设计词

用这套词，别换成 component / service / boundary / wrapper。

- **module**：有 interface 与 implementation 的任何东西（函数、类、包、跨层切片）。
- **interface**：调用方要知道的全部——类型、不变量、顺序约束、错误形状、必需配置、性能特征。
- **implementation**：module 里面那具躯体。
- **seam**：可以不改这里就换掉行为的位置；module 的 interface 住在哪儿。
- **adapter**：满足某个 seam 上 interface 的具体东西。说**角色**，不说里面是什么。
- **depth**：interface 上的杠杆。薄的 interface 后面压着一大坨行为 = **deep**；interface 几乎与 implementation 一样复杂 = **shallow**。
- **leverage**：调用方从 depth 得到的东西（一份实现，N 个调用点）。
- **locality**：维护者从 depth 得到的东西（改动、bug、知识、验证都集中在一处）。

## 1. 双半形态

同一个仓库产两半，运行在两个地方，靠一份契约对齐：

```
      浏览器（宿主前端）                     Node（宿主进程）
  ┌────────────────────────┐            ┌──────────────────────────┐
  │ src/client  槽位界面    │  HTTP/JSON │  src/api    前缀路由      │
  │  回收站面板 · 详情 ·    │ ─────────▶ │  src/verbs  删除/恢复/    │
  │  宿主列表批量删除       │            │            彻底删除/清理  │
  │  只有视图与可丢弃投影    │            │  src/trash  清册与对账    │
  └────────────────────────┘            │  src/log    日志走帧      │
           ▲                            └──────────────────────────┘
           │  值形状、段名、失败码：src/shared/wire.ts（两半 import 同一份）
```

- **通道是自建薄线，不是官方 `remote.<namespace>`**：官方 remote 只能由生成的 Typert 描述符经 `ctx.remote.$mount(...)` 挂上，第三方没有动态发现这一步（裁决与被否掉的替代见 ADR-0009）。所以走宿主 web server 上的插件专属前缀路由 `/dsh-session-delete-api`——`src/api/dispatch.ts` ↔ `src/client/remote.ts` 同源 fetch，信封与官方 unary 面同形（`{ok:true,value}` / `{ok:false,error:{code,message,details?}}`）。
- **段名只有六个**（`src/shared/wire.ts`）：`GET /list`、`GET /ping`、`POST /detail`、`POST /apply`、`POST /empty`、`GET /orphans`。五个动作全部走 `POST /apply`（`delete` / `restore` / `purge` / `count` / `orphan-clean`），其中 `count` 是纯读、其余四个是写动作。一组 id 进、逐条结果出，**单条就是长度为 1 的批量，不留第二条执行路径**。
- **状态语义**：请求本身不对用它自己的 4xx（400 请求体 / 405 方法 / 404 未知路由，栅栏拒 403）；**操作失败**回 200 + 信封——浏览器半先解信封再看状态，别把这两类混成一个 200。
- **同源栅栏认得桌面壳那条路**：桌面壳 `forwardWebRequest` 转发前删掉 `host`/`origin`/`cookie`/`sec-fetch-site` ⇒ 真机请求没有 `Origin`、只有 `Referer: dsh-app://app/`。判据按 `protocol` + `host` 比，**不能比 `URL.origin`**（`dsh-app:` 不是 WHATWG special scheme，`new URL('dsh-app://app/').origin` 是字符串 `"null"`）；漏认它 = 真机探测永远 403、所有入口都不出现，而 headless 直连 http 的过门读数完全看不出来。判据住 `src/api/dispatch.ts`。
- 改动生效分两条路：浏览器半靠宿主 HMR 热推；Node 半必须重启宿主。
- **浏览器半一条 `@deepseek-ai/*` 的 import 都不许有**（type-only 也不留）：宿主客户端包随宿主换代而变、不过类型检查，一个抛错的组件会把整个槽位条目打空。要用的控件/图标按官方处方抄进 `src/client/ui/*`（类名 `sd-` 前缀、`@keyframes` 改名、只留 `--dsw-*` token），来源表在 `src/client/ui/ui.css` 文件头。

## 2. Node 半的分层与依赖方向

```
ports/     端口与适配（HostPort / FsPort / Home）
   ▲
trash/  ·  log/          ← 领域部件：条目形状、清册对账、storage-manifest（宿主 storage 域绑定）、组语义、日志走帧
   ▲
verbs/     动词：delete / restore / purge / orphan-clean + permanent-removal + batch + member-journal + member-presence
   ▲
api/       两个投影面里的那个 Node 面：路由表 + dispatch + 行投影
   ▲
index.ts   组合根：装配、注册（前缀路由 / 槽位 / effect）——只导出插件模块面（name / inject / apply）
```

- deps.ts 的 CoreDeps 是动词与 API 共享的四项基础（fs / host / manifest / home）；DeleteDeps = CoreDeps & { now } 只给删除；装配只在 index.ts 一处；动词之间不再互相 import 依赖面 interface。
- **宿主端口按角色切三片**：身份与归属（`HostIdentityPort`）、在场通告（`HostPresencePort`）、会话语料（`HostCorpusPort`），同住 `src/ports/host-port.ts`；`HostPort` 是三者相交的复合别名，生产 adapter 只有 `createHostPort`。`evictLive` 的 agent handle 捕获住 `src/ports/agent-handles.ts`（adapter 内部，不进端口类型）。裁决见 ADR-0007。
- **语料缺席是显式的**：两个语料读面都交 `CorpusRead<T>` = `{ available: true, value }` | `{ available: false }`，不带原因串；形状住 `src/ports/host-port.ts`。**缺席之后怎么办归调用方**：删除只删父、count 报 0、`/list` 与 purge 静默降级、`/orphans` 与经 `loadOrphanGroups` 的 `orphan-clean` 响亮失败。裁决见 ADR-0007。
- **`verbs` 不 import `api`**：路由层只搬运，业务判据全在动词与部件。
- **宿主类型面用本地窄镜像**（`src/ports/host-port.ts` 与 `src/ports/agent-handles.ts` 各只声明用到的成员 + 一次强转）：不装宿主类型包、不做 `declare module` 增强——npm 上的宿主包与运行中的宿主不同代，引包等于拿错了契约。
- **跨插件一律 `import type`**，值 import 是与生态的红线。

## 3. 浏览器半：槽位贡献与可丢弃投影

- 注册处只有一处：`src/client/index.tsx`（菜单行、行首勾选、行尾兜底、overlay 浮条/确认框、面板行 + 中央面板）。**槽位只挂官方已声明的**——向未声明槽位注册在插件激活时响亮失败。
- **通道探测决定入口出现与否**：注册任何贡献之前先探 `GET /ping`；探测不过 ⇒ 一个入口都不注册（"不可用"以入口不出现表达，不新造禁用态 UI——半吊子 UI 比没有 UI 更糟）。探测**过了**（哪怕回的是失败信封）就照常注册。
- **客户端条目 pending = 宿主进程死**：可选服务（locale）走 `ctx.get` 而不是 `inject`。
- 文案住 `src/client/copy.ts` 的命名空间字典（zh 真源 + en 逐键镜像），经宿主 locale 服务可选读，缺席降级内置 zh。**渠道错误原文除外**：`src/client/receipt.ts` 的 missing-id、`src/client/remote.ts` 的幂等空值与取数通道错误是固定中文，不随 locale；它们是协议诊断原文，不是界面标签。
- **跨槽位现场**：浏览器半挂在互不相邻的座位上（`shell.overlay`、`main`、会话行菜单），模块级快照跨组件卸载存活；脚手架（快照 / 订阅 / 每实例 seq / `reset`）住 `src/client/store.ts`，各现场语义住调用方（多选与勾选集合住 `src/client/batch-selection-store.ts`，宿主行登记与整行点击守卫住 `src/client/host-rows.ts`）。
- 浏览器半**不持任何真相**：失败码与数据根目录名从 `wire.ts` 取常量，"这次会释放多少"念服务端算好的 `releaseBytes`——它只做呈现。

界面规格住 `docs/ui-spec.md`：入口与面板、六个基础状态、面板与清单、批量删除四态、残留维护三块。像素值、断点、文案键的唯一定义在 `src/client/` 与 `tests/client/`，那里不抄读数。

## 4. 唯一主人清单

某条语义"该去哪改"的对照表。**这是唯一一份主人清单**；`CONTEXT.md` 只定义词，不重复归属。写第二份之前先查这里。

| 语义 | 唯一主人 | 它不回答什么 |
| --- | --- | --- |
| 段名 / 线上形状 / 失败码 / 回收站目录名 | `src/shared/wire.ts` | 业务判据 |
| /apply 回执的读法（缺 id / null 幂等 / 逐条失败 / orphan-clean 的 not-found 中性） | `src/client/receipt.ts` | 各写入面的呈现；线上形状归 `src/shared/wire.ts` |
| 段名的方法 / 纯度 / body 预读 | `src/api/route-table.ts` | 怎么处理 |
| 清册行 → 线上行的投影 | `src/api/trash-rows.ts` 的 `toWire`（显式字面量，不 `...row`） | 组语义 |
| 组语义（谁能接住孩子、这一组有谁、谁已被同批带走） | `src/trash/groups.ts` | 步骤与回滚 |
| 「这一批」（去重保序 / 清册快照 / 已带走账本 / 逐条信封 / 一批一次通告；delete 的已带走账本由动词结果长出，restore / purge 仍读 `src/trash/groups.ts` 的 `takenByEarlierInBatch`） | `src/verbs/batch.ts` | 单条动词的步骤 |
| 成员离场 / 归位通告（摘 session + agent、三态、成对事件） | `src/verbs/member-presence.ts` | 批量通告（`announceRestoredBatch` 归 `src/verbs/batch.ts`） |
| 一次成员移动的步骤与反向动作（含逐条失败收集） | `src/verbs/member-journal.ts` | 哪些成员算一组；失败句子的措辞与合并（那是 `src/verbs/errors.ts`） |
| 永久删除的计划与执行（成员 / 目录 / 字节 / live 准入 / 部分回执） | `src/verbs/permanent-removal.ts` | 组语义归 `src/trash/groups.ts`；通告归 `src/verbs/member-presence.ts`；批量归 `src/verbs/batch.ts` |
| 条目 id 的形状与路径闸（单段校验） | `src/trash/entry.ts` | 对账 |
| 清册与 `session-trash/` 目录的对账 | `src/trash/reconcile.ts` | 目录里读哪一代日志 |
| 会话日志的选代与走帧（多帧 zstd） | `src/log/session-log.ts` + `src/log/zstd-frames.ts` | 正文该显示什么 |
| 详情给谁看、给多少（`source.kind` 过滤、载荷闸、计数与正文同源） | `src/trash/detail.ts` | 帧怎么切（那是 `log/`） |
| 正文怎么排版成 DOM（裸 HTML、链接与图片的收口） | `src/client/markdown.tsx` + `src/client/ui/markdown.css` | 抄来的宿主消息行样式 |
| 宿主 storage domain 的绑定（域 open/close、条目校验器） | `src/trash/storage-manifest.ts` | 清册的读法（`src/trash/manifest.ts`） |
| 清册的读法（动词只认这个端口，不认 storage 域形状） | `src/trash/manifest.ts` | 与目录怎么对账 |
| 盘与路径的适配（`FsPort`） | `src/ports/fs-port.ts` | 该删哪些目录（各动词的判据） |
| 数据根的解析（`$DSH_HOME` / `~/.dsh`） | `src/ports/home.ts` | 宿主的显式配置（插件不可得） |
| 恢复时「挂不挂账本」与那句「归入未分组」 | `src/verbs/restore-session.ts` 的 `attachableWorkspaceId` / `isWorkspaceMissing` | 工作区还在时的挂接失败 |
| 宿主身份与归属（会话是谁、落哪个项目/工作区、活不活/归档没有、账本与归档的写面） | `src/ports/host-port.ts` 的 `HostIdentityPort` | 通告（`api-session/*`，归 `HostPresencePort`） |
| 宿主在场通告（摘 session + agent 三态、`api-session/*` 如实通告） | `src/ports/host-port.ts` 的 `HostPresencePort` | 什么时候算「已离开 / 已回来」（归 `src/verbs/member-presence.ts`） |
| agent handle 捕获（安装时机 / symbol 表 / 按会话 dispose） | `src/ports/agent-handles.ts` | 摘活体三态（host-port.ts）与通告（member-presence） |
| 会话语料读（整表身份 `listSessions`、子会话闭包 `subagentMembersOf`） | `src/ports/host-port.ts` 的 `HostCorpusPort` | 看不见语料时怎么办（**缺席策略归调用方**；形状见本文 §2 的「语料缺席」） |
| 宿主能力的生产 adapter（一颗对象同时满足三个角色） | `src/ports/host-port.ts` 的 `createHostPort` | 各动词的调用顺序 |
| Node 半的依赖面（CoreDeps / DeleteDeps） | `src/deps.ts` | 各动词的调用顺序 |
| 删除/恢复时宿主**主视图**的收尾（删除当前会话关视图、撤销后重开） | `src/client/main-view.ts` | 什么时候该删/该恢复（动词与批量） |
| 外部写入收尾的顺序（主视图收尾 → 失效回收站 → 撤销通告） | `src/client/write-commit.ts` | 关/开主视图怎么算（`src/client/main-view.ts`）、谁重读（`src/client/trash-store.ts`）、各写入面的交互与本地 refresh（面板归 controller/query） |
| 无主子会话的扫描与分组（谁算孤儿、传递闭包与去重） | `src/verbs/orphan-subagents.ts` | 删哪些目录、报多少字节、谁挡活体（归 `src/verbs/permanent-removal.ts`）；回收站里的组 |
| 失败码的措辞与映射、回滚失败的措辞与合并（`details.rollbackFailures`；码本身住 `wire.ts`） | `src/verbs/errors.ts` + `src/remote/map-error.ts` | 上屏文案 |
| 同源栅栏（桌面壳那条只留 Referer 的路） | `src/api/dispatch.ts` | 操作失败的信封（那是 `map-error`） |
| 客户端可见文案 | `src/client/copy.ts` | 服务端错误原文；渠道错误原文除外（`src/client/receipt.ts` 的 missing-id、`src/client/remote.ts` 的幂等空值与取数通道错误是固定中文，不随 locale） |
| 清册与残留的取数编排（到达序号、在飞的旧响应不许盖新态） | `src/client/use-trash-query.ts` | 服务端算的那个数 |
| 清单的选择面（多选态、勾选集合、组头三态派生） | `src/client/use-trash-selection.ts` | 谁能接住孩子（`src/trash/groups.ts`） |
| 动过回收站之后谁重读（失效通告台，只有一个修订号） | `src/client/trash-store.ts` | 动了什么、谁动的（清单本体永远问宿主） |
| 跨槽位现场脚手架（快照 / 订阅 / 每实例 seq / `reset`） | `src/client/store.ts` | 选择面语义（那是 `src/client/batch-selection-store.ts`）；各现场自己的初值与不变量 |
| 批量选择面（多选模式 / 勾选集合 / 追加与收缩） | `src/client/batch-selection-store.ts` | 页面上有哪些行、点行算不算选中（那是 `src/client/host-rows.ts`）；不读 DOM |
| 宿主行读取与整行点击守卫（可见行 / 全选判定 / 捕获阶段拦行点击） | `src/client/host-rows.ts` | 选中集怎么变（归 `src/client/batch-selection-store.ts`）；不拥有选择变更 |
| 回收站面板状态机（选中 / 详情缓存 / 行失败 / 确认派发 / 自动选中 / 下钻回退） | `src/client/use-trash-panel-controller.ts` | 布局（`src/client/trash-panel.tsx`）、取数（`src/client/use-trash-query.ts`）、选择面（`src/client/use-trash-selection.ts`） |
| 槽位贡献与注册 | `src/client/index.tsx` | 各贡献自己的渲染 |
| 现行界面规格（状态、布局、危险层级） | `docs/ui-spec.md`；像素/断点/文案键的唯一定义在 `src/client/` 与 `tests/client/` | 各状态的实现细节 |
| 抄来的官方控件样式（`sd-` 前缀）与点名的自造差异 | `src/client/ui/ui.css` 文件头那张来源表 | token 的取值 |

## 5. 数据与生命周期

- 运行时数据全住数据根（`~/.dsh/`）：会话本体 `sessions/<项目目录>/<会话目录>/`（宿主的），回收站本体 `session-trash/<条目 id>/` 与清册（宿主 storage 域，介质在 `storages/`）。**回收站必须与 `sessions/` 同卷**（搬移靠整目录 `rename`，原子）。
- **`session-trash/` 目录是唯一需要手动动的地方**：每次读清单都先与目录对账（多出的目录重建出行、目录没了摘行、认不出的当外人）；`storages/` 那份是内部索引，外面改它要重启宿主才生效。
- **清册只记文件里真有的事实**：随盘上随时变的数（还剩几个孩子、这次释放多少）一律现算现给、不落清册。
- **会话列表不是磁盘投影**：`sessionQuery.listSessions()` 是磁盘持久化 **∪** 宿主内存里 attach 着的活体会话；摘账本挡不住活体，客户端会把它归入「未分组」。删除必须 `evictLive` 把 session 与 agent handle 一起摘掉（ADR-0008）。
- **删除 = 移入回收站**（可恢复，不自动过期）；**永久删除**只有三条路：purge（单条或一批）、清空回收站、无主子会话清理，都要二次确认；界面文案可以叫「彻底删除」。
- **有成员在跑 ⇒ 整组拒绝、零副作用**：删除 / 永久删除 / 孤儿清理都先过活体准入；插件不替用户终止正在进行的活。
- **回收站与归档解耦**（ADR-0008）：删除**不调** `archiveSession`；`evictLive` 把 session 与它的 agent handle 一起摘掉，恢复走冷 resume。`wasArchived` 只记删除前用户自己的归档事实；旧版本删除留下的归档态条目在恢复时迁移式 `unarchive`。
- **工作区账本缺席不是恢复失败**：宿主「删除工作区」只删注册、保留目录与每一份会话日志；恢复照常回盘、跳过 `attach`、归入未分组。`sessions/<projectDir>` 不在仍是硬拒绝，绝不静默建目录。判据住 `src/verbs/restore-session.ts`。
- **无主子会话维护只走官方面**：扫描用 `GET /orphans`，清理是 `/apply` 的 `orphan-clean`；永久删除、不自动跑，只清会话目录。`sessionQuery` 缺席时 `/orphans` 响亮失败，purge 只清清册里的那部分。判据住 `src/verbs/orphan-subagents.ts` 与 `src/verbs/permanent-removal.ts`。
- 会话日志是**多帧 zstd**：只读版本号最大的那代，绝不拼代（判据与用例住 `src/log/session-log.ts`、`src/log/zstd-frames.ts` 与 `tests/session-log.test.ts`、`tests/zstd-frames.test.ts`）。
- 附件是全局内容寻址的，与会话不是父子关系——删除不连坐、不回收。
