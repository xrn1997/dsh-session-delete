# 架构与形状

这份文档只回答两个问题：**系统分成哪几块、为什么这么切；某条语义的主人在谁头上**。它是 explanation——给读懂代码提供地图，不给代码充当副本。

不在这里的东西，各有各的家：**术语**在 `CONTEXT.md`（词表）；**难逆的裁决与被否决的替代**在 `docs/adr/`（索引见 `docs/adr/README.md`）；**用户可见的事实**在 `README.md`；**构建、门控与发版**在 `docs/development.md`；**提交与发布边界**在 `CONTRIBUTING.md`；**发布历史**在 `CHANGELOG.md`；**界面规格**在 `docs/ui-spec.md`；**文档分层与生命周期**在 `docs/AGENTS.md`；**"怎么做"**在代码自己。这里一条读数都不列——列了就是第二份抄本，且必然腐烂。批次账与实测证据不再另存日志，历史留在 git。

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
  │  宿主批量删除 · 维护卡  │            │  彻底删除/清理             │
  │  只有视图与可丢弃投影    │            │  src/trash  清册与附件    │
  └────────────────────────┘            │  src/log    日志走帧      │
           ▲                            └──────────────────────────┘
           │  值形状、段名、失败码：src/shared/wire.ts（两半 import 同一份）
```

- **通道是自建薄线，不是官方 `remote.<namespace>`**：官方 remote 只能由生成的 Typert 描述符经 `ctx.remote.$mount(...)` 挂上，第三方没有动态发现这一步（裁决与被否掉的替代见 ADR-0009）。所以走宿主 web server 上的插件专属前缀路由 `/dsh-session-delete-api`——`src/api/dispatch.ts` ↔ `src/client/remote.ts` 同源 fetch，信封与官方 unary 面同形（`{ok:true,value}` / `{ok:false,error:{code,message,details?}}`）。
- **段名只有九个**（`src/shared/wire.ts`）：`GET /list`、`GET /ping`、`POST /detail`、`POST /apply`、`POST /empty`、`GET /orphans`、`GET /attachment`、`GET /attachment-orphans`、`POST /attachment-clean`。五个动作全部走 `POST /apply`（`delete` / `restore` / `purge` / `count` / `orphan-clean`），其中 `count` 是纯读、其余四个是写动作。`GET /attachment` 是唯一的二进制段：只发附件字节，失败仍回 JSON 信封；`GET /attachment-orphans` 是孤儿附件报告（纯读），`POST /attachment-clean` 是它的聚合清理（写动作）。一组 id 进、逐条结果出，**单条就是长度为 1 的批量，不留第二条执行路径**。
- **状态语义**：请求本身不对用它自己的 4xx（400 请求体 / 405 方法 / 404 未知路由，栅栏拒 403）；**操作失败**回 200 + 信封——浏览器半先解信封再看状态，别把这两类混成一个 200。
- **请求栅栏分「归属」与「身份」两件事**：归属看 Host 是否属于本次部署（回环名 / 监听 bind 字面量），头栅栏另外否决 `sec-fetch-site: cross-site`、要求 Origin / Referer 与 Host 同 authority（桌面壳的 `dsh-app://app/` 是唯一例外）；远程客户端再要过宿主 `connection.requestRejection`（宿主的 Host 白名单 + 已认证 live peer），服务缺席时远程一律拒。绑定策略归宿主 webserver 配置（只接受具体接口 IP、拒绝 wildcard），栅栏不替它决定可达性，也不建立身份。判据住 `src/api/request-trust.ts`，裁决见 ADR-0022 / ADR-0023。
- 改动生效分两条路：浏览器半靠宿主 HMR 热推；Node 半必须重启宿主。
- **浏览器半一条 `@deepseek-ai/*` 的 import 都不许有**（type-only 也不留）：宿主客户端包随宿主换代而变、不过类型检查，一个抛错的组件会把整个槽位条目打空。要用的控件/图标按官方处方抄进 `src/client/ui/*`（类名 `sd-` 前缀、`@keyframes` 改名、只留 `--dsw-*` token），来源表在 `src/client/ui/ui.css` 文件头。

## 2. Node 半的分层与依赖方向

```
ports/     端口与适配（HostPort / FsPort / Home / PresenceCapability / ConnectionPort）
   ▲
trash/  ·  log/          ← 领域部件：条目形状、清册 ledger（真相读 = 对账 + 读；pure 读面读 raw）与对账、storage-manifest（宿主 storage 域绑定）、组语义、日志走帧
   ▲
verbs/     动词：delete / restore / purge / orphan-clean + permanent-removal + batch + batch-carried + move-group + member-journal + member-presence + live-admission
   ▲
api/       两个投影面里的那个 Node 面：路由表 + dispatch + 行投影
   ▲
index.ts   组合根：装配、注册（前缀路由 / 槽位 / effect）——只导出插件模块面（name / inject / apply）
```

- deps.ts 的 CoreDeps 是动词与 API 共享的五项基础（fs / host / ledger / home / presence）；`fs` 是 `CoreFsPort`（不含 `removeDir` / `removeFile`），`host` 是 `HostCorePort`（不含在场三件）。`DeleteSessionDeps = CoreDeps & { now }` 只给会话删除；`RemovalDeps = CoreDeps & { fs: CoreFsPort & Pick<FsPort,'removeDir' | 'removeFile'> }` 只给永久删除的执行与分发（`executeRemoval` 及把能力交给它的 purge / orphan-clean）；`DeleteDeps = DeleteSessionDeps & RemovalDeps` 是组合根装出的全量面（`/apply` 分发同时够到两者）。装配只在 index.ts 一处；动词之间不再互相 import 依赖面 interface。
- **宿主端口按角色切三片**：身份与归属（`HostIdentityPort`）、在场通告（`HostPresencePort`）、会话语料（`HostCorpusPort`），同住 `src/ports/host-port.ts`；`HostPort` 是三者相交的复合别名，这三片的适配只由 `createHostPort` 提供。**动词只拿 `HostCorePort`**（不含在场三件）；在场能力由 `CoreDeps.presence` 提供，端口形状住 `src/ports/presence-port.ts`、实现住 `src/verbs/member-presence.ts`。宿主服务的另外两个窄镜像各按用处分家：agent handle 捕获住 `src/ports/agent-handles.ts`（adapter 内部，不进端口类型），请求栅栏用的 Web 身份面住 `src/ports/connection-port.ts`（ADR-0022）。裁决见 ADR-0019（角色切分与在场协议一个家承 ADR-0007 / ADR-0005）。
- **语料缺席是显式的**：两个语料读面都交 `CorpusRead<T>` = `{ available: true, value }` | `{ available: false }`，不带原因串；形状住 `src/ports/host-port.ts`。**缺席之后怎么办归调用方**：删除只删父、count 报 0、`/list` 与 purge 静默降级、`/orphans` 与经 `loadOrphanGroups` 的 `orphan-clean` 响亮失败。裁决见 ADR-0019（语料面承 ADR-0007，未翻）。
- **读面是路由记录的一格**：`read` 与 `RouteRead` 的词义与读法见 `CONTEXT.md`「路由读面」，段名归属见 `docs/architecture.md` §4；裁决见 ADR-0004 / ADR-0012。
- **`verbs` 不 import `api`**：路由层只搬运，业务判据全在动词与部件。
- **活体准入的判据住 `src/verbs/live-admission.ts` 的 `assertNoLive`**：逐个问、任一在跑就整组拒绝、短路；**什么时候查、查哪些 id 归调用方**——永久删除仍把准入放在计划里、在任何写之前（ADR-0006），删除与孤儿清理各自交自己的名单。
- **宿主类型面用本地窄镜像**（`src/ports/host-port.ts` 与 `src/ports/agent-handles.ts` 各只声明用到的成员 + 一次强转）：不装宿主类型包、不做 `declare module` 增强——npm 上的宿主包与运行中的宿主不同代，引包等于拿错了契约。
- **跨插件一律 `import type`**，值 import 是与生态的红线。

## 3. 浏览器半：槽位贡献与可丢弃投影

- 注册处只有一处：`src/client/index.tsx`（菜单行、行首勾选、行尾兜底、overlay 浮条/确认框、面板行 + 中央面板、插件设置页的维护卡）。**槽位只挂官方已声明的**——向未声明槽位注册在插件激活时响亮失败。
- **通道探测决定入口出现与否**：注册任何贡献之前先探 `GET /ping`；探测不过 ⇒ 一个入口都不注册（"不可用"以入口不出现表达，不新造禁用态 UI——半吊子 UI 比没有 UI 更糟）。探测**过了**（哪怕回的是失败信封）就照常注册。
- **客户端条目 pending = 宿主进程死**：可选服务（locale）走 `ctx.get` 而不是 `inject`。
- 文案住 `src/client/copy.ts` 的命名空间字典（zh 真源 + en 逐键镜像），经宿主 locale 服务可选读，缺席降级内置 zh。**渠道错误原文除外**：`src/client/receipt.ts` 的 missing-id 与单条幂等空值、`src/client/remote.ts` 的取数通道错误是固定中文，不随 locale；它们是协议诊断原文，不是界面标签。
- **跨槽位现场**：浏览器半挂在互不相邻的座位上（`shell.overlay`、`main`、会话行菜单），模块级快照跨组件卸载存活；脚手架（值 store 的快照 / 订阅 / 每实例 seq / `reset`；懒读快照的订阅骨架与首个 / 末个订阅者生命周期）住 `src/client/store.ts`，各现场语义住调用方（多选与勾选集合住 `src/client/batch-selection-store.ts`，宿主行登记与整行点击守卫住 `src/client/host-rows.ts`）。
- **写入座位、busy 闸、清单导航、确认框关框与残留维护各有自己的 module**：`src/client/write-seats.ts` 把每个调用点的呈现材质、闸与重读通道绑在一处，`src/client/busy-gate.ts` 只拥有「这一趟还算忙」的生命周期，`src/client/confirm-close.ts` 拥有各张确认框共用的 busy 关框规则，`src/client/trash-nav.ts` 拥有清单的键盘契约与焦点意图，`src/client/ui/top-layer.ts` 拥有 Modal 与清单共用的顶层浮层名单与 Escape 判据，`src/client/orphan-maintenance.tsx` 拥有无主子会话维护块的呈现、`src/client/maintenance-settings.tsx` 拥有设置页的维护卡；回收站面板只留页面骨架、清单行与确认框开合。
- **撤销通知台与 Toast 组件分家**：现场、seq、发布与熄灭住 `src/client/undo-notices.ts`；`src/client/undo-toast.tsx` 只做组件，组合通知台与恢复座位（`restoreFromUndo`）。因此 `undo-toast ↔ write-seats` 的 import 环不再存在；裁决与被否掉的替代见 ADR-0018。
- 浏览器半**不持任何真相**：线上失败码与数据根目录名从 `wire.ts` 取常量（自己的未分类诊断码住 `receipt.ts`），"这次会释放多少"念服务端算好的 `releaseBytes`——它只做呈现。

界面规格住 `docs/ui-spec.md`：入口与面板、六个基础状态、面板与清单、批量删除四态、设置页维护卡。像素值、断点、文案键的唯一定义在 `src/client/` 与 `tests/client/`，那里不抄读数。

## 4. 唯一主人清单

某条语义"该去哪改"的对照表。**这是唯一一份主人清单**；`CONTEXT.md` 只定义词，不重复归属。写第二份之前先查这里。

| 语义 | 唯一主人 | 它不回答什么 |
| --- | --- | --- |
| 段名 / 线上形状 / 线上失败码与它的读法（前缀判定 `isSessionDeleteCodeError`、取动词词 `verbCodeOf`）/ 回收站目录名 | `src/shared/wire.ts` | 业务判据 |
| 写 `/apply` 回执的读法与**摘要**（缺 id / null 幂等 / 单条 null 的协议错 / 逐条失败 / orphan-clean 的 not-found 中性；成功 / 中性 / 失败 / 部分计数与**按动作取**的落地 id 一次派生） | `src/client/receipt.ts` | 各写入面的呈现；线上形状归 `src/shared/wire.ts` |
| 附件清理读数在回执里的聚合（跨 `ok` 相加、`skipped` 取第一条）与「跳过半句」的拼装判据（面板与维护卡共用） | `src/client/receipt.ts`；面板后半句在 `src/client/use-trash-query.ts`、维护卡后半句在 `src/client/use-maintenance.ts` | 独占判定（归 `src/trash/attachments.ts`）；服务端算的字节 |
| 段名的方法 / 纯度 / **读面** / body 预读 | `src/api/route-table.ts` | 怎么处理 |
| 附件二进制读取（id / kind 闸、20 MiB 上限、魔数、下载头） | `src/api/attachment.ts` | 什么算独占（归 `src/trash/attachments.ts`）、什么时候清（归 `src/verbs/permanent-removal.ts` 与设置页维护卡）；非附件的读面 |
| 清册行 → 线上行的投影 | `src/api/trash-rows.ts` 的 `toWire`（显式字面量，不 `...row`） | 组语义 |
| 组语义（谁能接住孩子、这一组有谁、`claimOf` 三态） | `src/trash/groups.ts` | 步骤与回滚；同批已带走集（`src/verbs/batch-carried.ts`） |
| 「这一批」（去重保序 / 写动作共用一个循环与逐条信封 / 一批一次通告） | `src/verbs/batch.ts` | 单条动词的步骤；同批已带走集归 `src/verbs/batch-carried.ts`，三态谓词归 `src/trash/groups.ts`；`count` 是纯读、没有逐条失败，不走那个循环 |
| 同批已带走集（entry / session 两种 id 域，各有 `claim` / `take`；entry 的 fresh 支带组，session 只回 fresh / carried；只读视图 `rows` 只在 entry 域） | `src/verbs/batch-carried.ts` | 组语义（`src/trash/groups.ts`）；单个动词的步骤 |
| 成员离场 / 归位通告（摘 session + agent、三态、成对事件）与动词的在场尾巴（`withPresenceTail`：`run` / `undo` 之后补一条通告的形状） | `src/verbs/member-presence.ts` | 批量恢复由 `src/verbs/batch.ts` 调同一个 `announceRestored(ids)` |
| 在场能力的动词面（成员离场 / 归位 / 一批归位的三条签名） | `src/ports/presence-port.ts` 的 `PresenceCapability` | 三态与真值表、宿主调用顺序（归 `src/verbs/member-presence.ts`）；宿主端口的角色切分（归 `src/ports/host-port.ts`） |
| 一次成员移动的步骤、反向动作与逐步 undo 结果（`restored(key)`） | `src/verbs/member-journal.ts` | 哪些成员算一组；失败句子的措辞与合并（那是 `src/verbs/errors.ts`） |
| 组级成员移动的顺序、组根结果与整组回滚。调用方直接拿根结果，不索引数组；跟随者按序拿根结果。 | `src/verbs/move-group.ts` | 单成员步骤（`src/verbs/member-journal.ts`）；谁算一组（`src/trash/groups.ts`） |
| 永久删除的计划与执行（成员 / 目录 / 字节 / 部分回执；成功回执的字节念计划、执行期只记进度） | `src/verbs/permanent-removal.ts` | 活体准入归 `src/verbs/live-admission.ts`（这里只决定它在计划里、任何写之前跑）；组语义归 `src/trash/groups.ts`；通告归 `src/verbs/member-presence.ts`；批量归 `src/verbs/batch.ts` |
| 附件内容块提取 / ID 与路径闸 / 剩余引用扫描 / 独占计划与执行 | `src/trash/attachments.ts` | 什么时候删（归 `src/verbs/permanent-removal.ts`）；源文件与普通文件的删除（目前不删） |
| 活体准入的判据与那句原文（逐个问、任一在跑整组拒绝、短路） | `src/verbs/live-admission.ts` 的 `assertNoLive` | 什么时候查、查哪些 id（调用方给：永久删除在计划里，删除与孤儿清理各交名单） |
| 条目 id 的形状与路径闸（单段校验） | `src/trash/entry.ts` | 对账 |
| 清册读的两个读面（`list()` = 对账 + 读，供 `/list`、`/empty` 与写动词；`raw()` = 不对账、不写行，供 pure 的 `/orphans` 与 `/detail`） | `src/trash/ledger.ts` | 存储域绑定、对账的具体目录判据；哪一段拿哪一面归 `src/api/route-table.ts` |
| 清册与 `session-trash/` 目录的对账 | `src/trash/reconcile.ts` | 目录里读哪一代日志 |
| 会话日志的选代与走帧（多帧 zstd） | `src/log/session-log.ts` + `src/log/zstd-frames.ts` | 正文该显示什么 |
| 详情给谁看、给多少（`source.kind` 过滤、正文两个载荷闸、附件每消息 20 个与总量 200 个两道闸、计数不过闸） | `src/trash/detail.ts` | 帧怎么切（那是 `log/`） |
| 正文怎么排版成 DOM（裸 HTML、链接与图片的收口） | `src/client/markdown.tsx` + `src/client/ui/markdown.css` | 抄来的宿主消息行样式 |
| 详情与维护卡预览的附件渲染 / 放大 / 失败占位 / 清理提示的呈现 | `src/client/attachment-view.tsx` | 什么时候出清理提示（面板归 `src/client/use-trash-query.ts`、维护卡归 `src/client/use-maintenance.ts`）；附件二进制怎么读（归 `src/api/attachment.ts`） |
| 宿主 storage domain 的绑定（域 open/close、条目校验器） | `src/trash/storage-manifest.ts` | 清册的读法（真相读归 `src/trash/ledger.ts`；`src/trash/manifest.ts` 只是 raw 端口） |
| 清册的 raw 端口（只给 ledger 与对账实现，不认 storage 域形状） | `src/trash/manifest.ts` | 与目录怎么对账（`src/trash/reconcile.ts`） |
| 盘与路径的适配（`FsPort`；`statFile` 只读；`removeFile` 在 `RemovalDeps` 这一层提供、`CoreFsPort` 不含，附件执行面另收更窄的 `AttachmentRemovalDeps` Pick） | `src/ports/fs-port.ts` | 该删哪些目录/文件（各动词与 `src/trash/attachments.ts` 的判据） |
| 数据根的解析（`$DSH_HOME` / `~/.dsh`） | `src/ports/home.ts` | 宿主的显式配置（插件不可得） |
| 恢复时「挂不挂账本」与那句「归入未分组」 | `src/verbs/restore-session.ts` 的 `attachableWorkspaceId` / `isWorkspaceMissing` | 工作区还在时的挂接失败 |
| 宿主身份与归属（会话是谁、落哪个项目/工作区、活不活/归档没有、账本与归档的写面） | `src/ports/host-port.ts` 的 `HostIdentityPort` | 通告（`api-session/*`，归 `HostPresencePort`） |
| 宿主在场通告（摘 session + agent 三态、`api-session/*` 如实通告） | `src/ports/host-port.ts` 的 `HostPresencePort` | 什么时候算「已离开 / 已回来」（归 `src/verbs/member-presence.ts`） |
| agent handle 捕获（安装时机 / symbol 表 / 按会话 dispose） | `src/ports/agent-handles.ts` | 摘活体三态（host-port.ts）与通告（member-presence） |
| 会话语料读（整表身份 `listSessions`、子会话闭包 `subagentMembersOf`） | `src/ports/host-port.ts` 的 `HostCorpusPort` | 看不见语料时怎么办（**缺席策略归调用方**；形状见本文 §2 的「语料缺席」） |
| 宿主能力的生产 adapter（一颗对象同时满足三个角色） | `src/ports/host-port.ts` 的 `createHostPort` | 各动词的调用顺序 |
| Node 半的依赖面（CoreDeps 五项 / DeleteSessionDeps / RemovalDeps / DeleteDeps 全量面；`CoreFsPort` 不含 `removeDir` / `removeFile`，`HostCorePort` 不含在场三件，`presence` 是能力面） | `src/deps.ts` | 各动词的调用顺序 |
| 删除/恢复时宿主**主视图**的收尾（删除当前会话关视图、撤销后重开、面板恢复后忘掉） | `src/client/main-view.ts` | 什么时候该删/该恢复（动词与批量） |
| 撤销横幅的现场、seq、停留时长、按条目熄灭与整条清空（`clearUndoNotice`） | `src/client/undo-notices.ts` | 何时发布（发布决定归 `src/client/write-settlement.ts`；`anySuccess` 与落地名单由 `src/client/receipt.ts` 的摘要给出）、发布的形与标题（归 `src/client/write-seats.ts`）；Toast 呈现归 `src/client/undo-toast.tsx` |
| 撤销横幅的呈现（Toast 宿主与撤销动作的组合） | `src/client/undo-toast.tsx` | 现场 / seq / 发布与熄灭（归 `src/client/undo-notices.ts`）；恢复座位（归 `src/client/write-seats.ts`） |
| 逐条 `/apply` 的写入座位（每个界面位置的呈现材质、闸与重读通道：菜单单删 / 批量删除 / 外部撤销恢复 / 面板恢复 / 面板永久删除） | `src/client/write-seats.ts` | 收尾顺序（`src/client/write-settlement.ts`）、重读策略（`src/client/use-trash-query.ts`）、各面的本地状态；孤儿清理不走座位（归设置页维护卡，ADR-0021） |
| 「这一趟还算忙」的 busy 生命周期（开闸 / 落地或抛错都放回 / 各实例互不影响，不做引用计数） | `src/client/busy-gate.ts` 的 `useBusyGate` | 防抖、排队、重读（那些是 `src/client/write.ts` 的 `runWrite` 的整趟）；谁该禁用（各面自己） |
| 一次逐条 `/apply` 写入的生命周期（apply → 信封 → 回执摘要 → settlement → refresh；`count` / `orphan-clean` 没有呈现材质，settlement 不为它们做事；`/empty` 聚合回执仍归 `use-trash-query.ts`）；座位绑定归 `src/client/write-seats.ts`，`runWrite` 收按 action 切开的呈现材质，并把 `apply → settle → refresh` 整趟包进传入的闸 | `src/client/write.ts` 的 `runWrite` | 回执判读（`src/client/receipt.ts`）、按 action 的收尾顺序（`src/client/write-settlement.ts`）、各面的本地状态 |
| 逐条 `/apply` 写入的收尾顺序与 `WritePresentation` 的按 action 判别形状（main-view 收尾 → 失效回收站（delete / restore）→ 撤销通告 / 详情缓存，按 action 各一条，含 `anySuccess` 门与恢复的两个座位） | `src/client/write-settlement.ts` | 关/开/忘主视图怎么算（`src/client/main-view.ts`）、谁重读（`src/client/trash-store.ts`）、什么时机跑（`src/client/write.ts`） |
| 无主子会话的扫描与分组（谁算孤儿、传递闭包与去重） | `src/verbs/orphan-subagents.ts` | 删哪些目录、报多少字节、谁挡活体（归 `src/verbs/live-admission.ts`）；回收站里的组 |
| 失败码的措辞与映射、回滚失败的措辞与合并（`details.rollbackFailures`；码本身住 `wire.ts`） | `src/verbs/errors.ts` + `src/remote/map-error.ts` | 上屏文案 |
| 请求栅栏（归属：Host / Origin / Referer 与桌面壳那条只留 Referer 的路；身份：远程客户端过宿主 `connection`） | `src/api/request-trust.ts` | 操作失败的信封（那是 `map-error`）；绑定与 TLS（宿主 webserver 配置）；身份凭据本身（宿主 `dsh-client-connection`） |
| 客户端可见文案 | `src/client/copy.ts` | 服务端错误原文；渠道错误原文除外（`src/client/receipt.ts` 的 missing-id 与单条幂等空值、`src/client/remote.ts` 的取数通道错误是固定中文，不随 locale） |
| 清册的取数编排与清空的聚合回执（清单状态的词义见 `CONTEXT.md`「清单状态」；对外只有 `refreshAll` / `refreshAfterWrite` 两个重读意图，`reloadRows` 只是 implementation 细节；最新票（`createLatestWins`，词表见 `CONTEXT.md`）、在飞的旧响应不许盖新态、输给后发读的读不清场；`refreshAll` / `refreshAfterWrite` 的清单读失败把清单置为 `unknown`；清空失败同样落 `unknown`、作废在飞读并收掉旧附件提示；清空的附件读数上屏归本模块，行为见 `docs/ui-spec.md` §3；写动作与清空走调用方传入的同一枚 `gate`，不另造第二枚闸；清空成功顺带调用撤销通知台的整条清空（落点全没了；现场归 `src/client/undo-notices.ts`）） | `src/client/use-trash-query.ts` | 服务端算的那个数；busy 的生命周期（`src/client/busy-gate.ts`）；孤儿检查/清理（归 `src/client/use-maintenance.ts`，ADR-0021） |
| 回收站清单的选择面（多选态、勾选集合、组头三态派生、`ordered` 的可见顺序） | `src/client/use-trash-selection.ts` | 谁能接住孩子（`src/trash/groups.ts`）；键盘与焦点（`src/client/trash-nav.ts`） |
| 清单的键盘契约与焦点意图（活动行 `aria-activedescendant` 与唯一 tab 落点、方向键走环、Enter / Space 的双重语义、Esc 只在下钻期间生效且顶层有 dialog/menu 时让路、退出下钻后交还一次焦点） | `src/client/trash-nav.ts` | 可见顺序（`src/client/use-trash-selection.ts`）、详情 / 缓存 / 确认框（`src/client/use-trash-panel-controller.ts`）、行的 DOM 查询（由调用方注入 `focusRow`）；顶层浮层名单与判据（`src/client/ui/top-layer.ts`） |
| 顶层浮层（`[role="dialog"][aria-modal="true"]` 与 `[role="menu"]`）的名单与「谁在最上层收 Escape」判据 | `src/client/ui/top-layer.ts` | Modal 何时关、清单何时退下钻（由各自决定并调用） |
| 无主子会话维护块的呈现（警告条、失败块、中性提示、预览与清理确认），唯一使用方是设置页维护卡 | `src/client/orphan-maintenance.tsx` | 检查/清理的状态与回执判读（`src/client/use-maintenance.ts`）；busy 的读数（调用方传入） |
| 设置页维护卡的两段读数与动作（手动检查、清理、清理后必重查、附件回执句子、最新票） | `src/client/use-maintenance.ts` | 呈现（`src/client/maintenance-settings.tsx`）；段名与线上形状（`src/shared/wire.ts`）；什么算孤儿（`src/verbs/orphan-subagents.ts` / `src/trash/attachments.ts`） |
| 设置页维护卡的呈现（卡片外壳、两个 section、状态行的固定优先级、孤儿附件横幅/失败/确认框） | `src/client/maintenance-settings.tsx` | 读数与动作（`src/client/use-maintenance.ts`）；无主子会话块的呈现（`src/client/orphan-maintenance.tsx`） |
| 孤儿附件的报告段（报告把扫描折成数量/字节 + 对象清单 `id`/`bytes`，清单最多 200 条供设置页预览、读不出就抛 `io`） | `src/api/attachment-orphans.ts` | 什么算孤儿、删哪些对象（`src/trash/attachments.ts`）；什么时候清（设置页维护卡手动触发，ADR-0021）；清理段直接由路由接 `src/trash/attachments.ts` |
| 孤儿附件的扫描与聚合清理（只认 `attachments/v1/objects` 下 `<2 hex>/<64 hex>`；引用源读不出就整份跳过） | `src/trash/attachments.ts` 的 `scanOrphanImageAttachments` / `cleanOrphanImageAttachments` | 什么时候清（归设置页维护卡，ADR-0021）；普通文件与缓存的处置（不碰，见 ADR-0020） |
| 动过回收站之后谁重读（失效通告台，只有一个修订号） | `src/client/trash-store.ts` | 动了什么、谁动的（清单本体永远问宿主） |
| 跨槽位现场脚手架（值 store 的快照 / 订阅 / 每实例 seq / `reset`；懒读快照的订阅骨架与首个 / 末个订阅者生命周期；latest-wins 句柄 `createLatestWins` 的 compare-and-set） | `src/client/store.ts` | 选择面语义（那是 `src/client/batch-selection-store.ts`）；各现场自己的初值、不变量与读法；防抖 / 轮询 / 定时器 / 焦点策略（latest-wins 只做 CAS，策略仍是调用方的现场） |
| 宿主会话列表的批量选择面（多选模式 / 勾选集合 / 追加与收缩） | `src/client/batch-selection-store.ts` | 页面上有哪些行、点行算不算选中（那是 `src/client/host-rows.ts`）；不读 DOM |
| 宿主行快照订阅（DOM 观察 + 行登记；渲染侧只读快照）与整行点击守卫 | `src/client/host-rows.ts` | 选中集怎么变（归 `src/client/batch-selection-store.ts`）；不拥有选择变更 |
| 回收站面板状态机（选中 / 详情缓存 / 行失败 / 待确认动作与 request 意图 / 自动选中 / 窄档下钻状态与返回） | `src/client/use-trash-panel-controller.ts` | 布局（`src/client/trash-panel.tsx`）、取数（`src/client/use-trash-query.ts`）、选择面（`src/client/use-trash-selection.ts`）、清单的键盘与焦点（`src/client/trash-nav.ts`）、写入生命周期与收尾顺序（`src/client/write.ts`、`src/client/write-settlement.ts`）、面板恢复的呈现材质（`src/client/write-seats.ts`） |
| 各张确认框的 busy 关框规则 | `src/client/confirm-close.ts` 的 `useIdleClose` | 各框的按钮文案与禁用呈现 |
| 槽位贡献与注册（含设置页按 bundle 包名寻址的 keyed 槽位） | `src/client/index.tsx` | 各贡献自己的渲染 |
| 现行界面规格（状态、布局、危险层级） | `docs/ui-spec.md`；像素/断点/文案键的唯一定义在 `src/client/` 与 `tests/client/` | 各状态的实现细节 |
| 抄来的官方控件样式（`sd-` 前缀）与点名的自造差异 | `src/client/ui/ui.css` 文件头那张来源表 | token 的取值 |

## 5. seam：可测性怎么落

- **路由层是纯构造器**：`src/api/dispatch.ts` 的 `createApiHandler(deps, trust)` 不依赖 Cordis，用真 `node:http` server 承载——`tests/api.test.ts` 钉每一段的 method / 形状 / 信封 / 失败码原文。
- **动词层走记录型世界**：`tests/support/world.ts` 的 `createLogWorld` 用声明式读数描述盘与宿主，并按**发生顺序**记 fs / host 两端调用——删除的「摘账本 → 搬目录 → 摘活体 → 通告」是一条顺序断言，不是散点断言。
- **领域纯函数直接喂结构**：`src/trash/groups.ts`、`src/trash/reconcile.ts`、`src/trash/entry.ts`、`src/shared/wire.ts` 的判据各有一条不起服务、不碰盘的钉子。
- **宿主端口用本地窄镜像 + 假 adapter**：`tests/ports.test.ts` / `tests/host-roles.test.ts` 钉角色切分，`tests/support/fake-deps.ts` 是动词用例共用的一份内存 adapter。
- **装配只在 `index.ts`，由 `tests/assembly.test.ts` 端到端钉**：插件模块面、前缀路由、槽位与 effect 的注册形状。
- **客户端是假 adapter 驱动真实组件**：`tests/client/index.test.tsx` 用假 `ctx` 与假 `fetch` 跑真 `apply`，其余客户端用例按读者分的依赖束注入；不是渲染快照。
- **日志读面用真 zstd 帧**：`tests/session-log.test.ts` 与 `tests/zstd-frames.test.ts` 直接造多帧数据，不替身编解码。
- **门的分工**见 `AGENTS.md` 的「必须过的门」；真机验证的走法见 `docs/development.md` 的「真机验证」。

## 6. 数据与生命周期

- 运行时数据全住数据根（`$DSH_HOME/`，默认 `~/.dsh/`）：会话本体 `sessions/<项目目录>/<会话目录>/`（宿主的），回收站本体 `session-trash/<条目 id>/` 与清册（宿主 storage 域，介质在 `storages/`）。**回收站必须与 `sessions/` 同卷**（搬移靠整目录 `rename`，原子）。
- **`session-trash/` 目录是唯一需要手动动的地方**：真相读（`list()`）先与目录对账（多出的目录重建出行、目录没了摘行、认不出的当外人），由 `src/trash/ledger.ts` 保证；纯读面 `/orphans` 与 `/detail` 只读 `raw()`，不对账、不写行（`/detail` 遇到“行在、目录不在”照旧判 `io`，不靠对账摘行），`orphan-clean` 等写动作先 `list()` 再扫。`storages/` 那份是内部索引，外面改它要重启宿主才生效。
- **清册只记文件里真有的事实**：随盘上随时变的数（还剩几个孩子、这次释放多少）一律现算现给、不落清册。
- **会话列表不是磁盘投影**：`sessionQuery.listSessions()` 是磁盘持久化 **∪** 宿主内存里 attach 着的活体会话；摘账本挡不住活体，客户端会把它归入「未分组」。删除必须 `evictLive` 把 session 与 agent handle 一起摘掉（ADR-0008）。
- **删除 = 移入回收站**（可恢复，不自动过期）；**永久删除**只有三条路：purge（单条或一批）、清空回收站、无主子会话清理，都要二次确认；界面文案可以叫「彻底删除」。
- **有成员在跑 ⇒ 整组拒绝、零副作用**：删除 / 永久删除 / 孤儿清理都先过活体准入；插件不替用户终止正在进行的活。
- **回收站与归档解耦**（ADR-0008）：删除**不调** `archiveSession`；`evictLive` 把 session 与它的 agent handle 一起摘掉，恢复走冷 resume。`wasArchived` 只记删除前用户自己的归档事实；旧版本删除留下的归档态条目在恢复时迁移式 `unarchive`。
- **工作区账本缺席不是恢复失败**：宿主「删除工作区」只删注册、保留目录与每一份会话日志；恢复照常回盘、跳过 `attach`、归入未分组。`sessions/<projectDir>` 不在仍是硬拒绝，绝不静默建目录。判据住 `src/verbs/restore-session.ts`。
- **无主子会话维护只走官方面、只由插件设置页的维护卡手动触发**：扫描用 `GET /orphans`，清理是 `/apply` 的 `orphan-clean`；永久删除、不自动跑——回收站面板的挂载、写后重读与清空都不发这一问（ADR-0021），只清会话目录与会话独占的图片附件副本（共享副本保留，判据见 ADR-0020）。`sessionQuery` 缺席时 `/orphans` 响亮失败，purge 只清清册里的那部分。判据住 `src/verbs/orphan-subagents.ts` 与 `src/verbs/permanent-removal.ts`。
- 会话日志是**多帧 zstd**：只读版本号最大的那代，绝不拼代（判据与用例住 `src/log/session-log.ts`、`src/log/zstd-frames.ts` 与 `tests/session-log.test.ts`、`tests/zstd-frames.test.ts`）。
- **附件库在 `$DSH_HOME/attachments/v1`**：图片在 `objects/`，普通文件在 `file-objects/` + `files/`，宿主所有、没有删除接口。永久删除只清**独占图片副本**——被删会话引用、且剩余任何会话/派生存储都不再引用；共享副本保留，`$DSH_HOME` 之外的源文件不受影响；普通文件只渲染、不代删。剩余引用源读不出就整体跳过（宁可留孤儿也不删共享）。判据住 `src/trash/attachments.ts`，裁决见 ADR-0020。
- **孤儿附件也只有手动这一条路**：`GET /attachment-orphans` 报告、`POST /attachment-clean` 聚合清理，都由设置页维护卡在用户点「检查 / 清理」时发起；没有自动检测、没有定时器，面板挂载不读它。报告与清理共用同一套引用扫描（全部会话日志 + 全部 `session-trash` 目录 + `storages` / `cache` JSON），但每次调用各自现扫：任一读不出就报告失败、清理零删，不折成 0。判据住 `src/trash/attachments.ts`，裁决见 ADR-0021。

## 7. 改动面 → 先读什么

表只指路，不复制口径：真正的主人在本文 §4、ADR 与代码注释。

| 改动面 | 先读 |
| --- | --- |
| 段名 / 线上形状 / 失败码 | 本文 §4 的 `src/shared/wire.ts` 行；ADR-0003；`src/api/route-table.ts` |
| 路由 / 请求栅栏 / 远程身份 | 本文 §1、§4；`src/api/request-trust.ts`；ADR-0009、ADR-0022、ADR-0023 |
| 删除 / 恢复 / 归档语义 | 本文 §6；`src/verbs/delete-session.ts`、`src/verbs/restore-session.ts`；ADR-0008 |
| 批量与逐步撤销 | 本文 §4 的 `batch` / `member-journal` / `batch-carried` 行；ADR-0002 |
| 永久删除 / 活体准入 | 本文 §4 的 `permanent-removal` / `live-admission` 行；ADR-0006 |
| 附件与孤儿清理 | 本文 §6；`src/trash/attachments.ts`；ADR-0020、ADR-0021 |
| 清册 / 对账 | `src/trash/ledger.ts`、`src/trash/reconcile.ts`；ADR-0012 |
| 会话日志读取 | `src/log/session-log.ts`、`src/log/zstd-frames.ts` |
| 面板 / 交互 / 写入座位 | 本文 §3；`docs/ui-spec.md`；`src/client/write-seats.ts`、`src/client/write-settlement.ts` |
| 插件页维护卡 | 本文 §3；`docs/ui-spec.md` §5；ADR-0021 |
| 宿主接入 / 打包 / 发版 | 本文 §1；`docs/development.md`；ADR-0025 |
| 文档 / ADR / 发布流程 | `docs/AGENTS.md`；`docs/adr/README.md`、`docs/adr/ADR-FORMAT.md`；`CONTRIBUTING.md`、`CHANGELOG.md` |
