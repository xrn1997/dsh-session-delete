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
  │ src/client  槽位界面    │  HTTP/JSON │  src/api    路由         │
  │  回收站面板 · 详情 ·    │ ─────────▶ │  src/verbs  删除/恢复/    │
  │  宿主批量删除 · 设置卡片│            │  彻底删除/清理             │
  │  只有视图与可丢弃投影    │            │  src/trash  清册与附件    │
  └────────────────────────┘            │  src/log    日志走帧      │
           ▲                            └──────────────────────────┘
           │  值形状、段名、失败码：src/shared/wire.ts（两半 import 同一份）
```

- **通道只有一条：宿主 `connection` 的 exact Fetch 路由**：全部段名注册到 `connection.fetch.register` 的 `/api/dsh-session-delete-api/*`，Host/Origin/浏览器认证由宿主 `/api` bridge 完成（ADR-0033）。支持面是 web UI 与桌面端，二者的标准组合都装 `client-connection`；没有自建前缀、没有插件请求栅栏、没有旧前缀 fallback。官方 `remote.<namespace>` 仍不可用（生成的 Typert 描述符没有第三方动态发现）。两半仍从 `src/shared/wire.ts` 取段名与基础路径，`src/api/dispatch.ts` ↔ `src/client/remote.ts` 同源 fetch，信封与官方 unary 面同形（`{ok:true,value}` / `{ok:false,error:{code,message,details?}}`）。
- **段名只有一张表**（`src/shared/wire.ts` 的结构化段名表 `ROUTES`：每个段名恰有 `{ path, method, body }` 三键，那是唯一的**定义**处——两半的代码只从这张表投影，文档与注释里再写段名是给读者指路，不另立一份映射）。清单、详情与探测这几段：`/list` 对账并读回收站清单，`/detail` 用 POST 表达单条详情读，`/empty` 清空回收站（聚合回执，不按条回），`/orphans` 报无主子会话的扫描报告（纯读；清理走 `/apply`），`/ping` 是最便宜的在/不在（不碰清册、不碰盘，供客户端探测）。六个动作全部走 `/apply`（`delete` / `restore` / `purge` / `count` / `orphan-clean` / `unarchive`），其中 `count` 是纯读、其余五个是写动作。`/attachment` 是唯一的二进制段：只发附件字节，失败仍回 JSON 信封；`/attachment-orphans` 是孤儿附件报告（纯读），`/attachment-clean` 是它的聚合清理（写动作）；`/projection-orphans` 是孤儿投影缓存报告（纯读），`/projection-clean` 是它的聚合清理（写动作）。`/archive-list` 是归档清单（纯读：registry 归档集 ∩ 语料），`/archive-detail` 用 POST 表达归档单条的详情读（寻址边界见 ADR-0060 / ADR-0061）。`/config` 空体读三只可调项、带字段写回 profile 的 patch 层（写经宿主 `configEditor.edit`，这一行会重启；ADR-0043）。一组 id 进、逐条结果出，**单条就是长度为 1 的批量，不留第二条执行路径**。
- **状态语义**：**请求体不对**由插件分发器回 400 + 信封；**方法或路径不在 exact route 声明内**时宿主在 handler 之前回纯文本 404（插件的 405 / 404 只是适配器直调时的防御分支）；**401/403**：宿主 `/api` 的 401/403 是纯文本鉴权/归属失败，客户端映射固定原文；附件同源闸回的是 **403 + 失败信封**（走插件错误面）；**操作失败**回 200 + 信封——浏览器半先解信封再看状态，别把这几类混成一个 200。
- **鉴权归宿主 `/api`**：exact Fetch 路由由宿主 `/api` bridge 做 Host/Origin/浏览器认证（ADR-0033）；插件不重建身份，也没有回环免身份分支。唯一的插件侧闸是附件字节段的**同源取数闸**（路由记录声明 `fetchGate`）：拒 `Sec-Fetch-Site: same-site / cross-site` 与 authority 和 `Host` 不符的 http(s) `Origin` / `Referer`（ADR-0033 边界）。绑定策略归宿主 webserver 配置（只接受具体接口 IP、拒绝 wildcard），插件不替它决定可达性，也不建立身份。
- 改动生效分两条路：浏览器半靠宿主 HMR 热推；Node 半必须重启宿主。
- **浏览器半一条 `@deepseek-ai/*` 的 import 都不许有**（type-only 也不留）：宿主客户端包随宿主换代而变、不过类型检查，一个抛错的组件会把整个槽位条目打空。要用的控件/图标按官方处方抄进 `src/client/ui/*`（类名 `sd-` 前缀、`@keyframes` 改名、配色与几何只走 token——宿主私有的那批经本插件的 `--sd-*` 别名层带公开兜底），来源表在 `src/client/ui/ui.css` 文件头。

## 2. Node 半的分层与依赖方向

```
domain/    零依赖纯部件：会话闭包与 bare 归一（不 import 任何仓内模块）
   ▲
ports/     端口与适配（HostPort / FsPort / Home / PresenceCapability / ConnectionPort）
   ▲
trash/  ·  log/          ← 领域部件：条目形状、清册 ledger（真相读 = 对账 + 读；pure 读面读 raw）与对账、storage-manifest（宿主 storage 域绑定）、组语义、日志走帧
   ▲
verbs/     动词：delete / restore / purge（清册作用域）/ orphan-clean + permanent-removal + batch + batch-carried + trash-scope + move-group + member-journal + member-presence + live-admission
   ▲
api/       两个投影面里的那个 Node 面：路由表 + dispatch + 行投影
   ▲
index.ts   组合根：装配、注册（exact Fetch 路由 / 槽位 / effect）——只导出插件模块面（name / Config / inject / apply）
```

- **`domain/` 是零依赖纯部件**：不 import 任何仓内模块，端口与动词都可依赖它；会话闭包与 bare 归一住这里（见 CONTEXT.md「会话闭包」）——端口不再反向 import `trash/`。
- deps.ts 的 CoreDeps 是动词与 API 共享的六项基础（fs / host / ledger / home / presence / config）；`fs` 是 `CoreFsPort`（不含 `removeDir` / `removeFile`），`host` 是 `HostCorePort`（不含在场三件与投影缓存删除面）；`config` 是 `apply` 归一后的只读快照，读方从 deps 读，不 import 模块级单例。`DeleteSessionDeps = CoreDeps & { now }` 只给会话删除；`RemovalDeps = CoreDeps & { host: HostRemovalPort; fs: RemovalFsPort }` 只给永久删除的执行与分发（`CoreDeps.fs` 由 `dispatch.ts` 的 `coreDepsOf` 按 `FS_CORE_METHODS` 现切——运行期真的只带基础面方法，见 ADR-0032）（`executeRemoval` 及把能力交给它的 purge / orphan-clean）；`DeleteDeps = DeleteSessionDeps & RemovalDeps & { attachments; configEditor?; entry? }` 是组合根装出的全量面（`/apply` 分发同时够到删除的时钟与永久删除能力；`attachment` 读段另走第四片 `SliceDeps['attachment']` = `CoreDeps & { attachments }`，`config` 段走第五片 `CoreDeps & { configEditor?; entry? }`，都不把危险能力塞进读段）。装配只在 index.ts 一处；动词之间不再互相 import 依赖面 interface。路由行按 `slice` 只取自己声明的那一格，运行期收窄见 ADR-0032。
- **失败措辞是横切词汇，家在顶层 `src/errors.ts`**：抛错与回滚措辞被 `api/`、`verbs/`、`trash/` 三层共用，与 `src/deps.ts`、`src/config.ts` 同级——放进任何一层都会逼其余层向上 import，所以它住在所有消费者之下。
- **宿主端口按角色切四片**：身份与归属（`HostIdentityPort`）、在场通告（`HostPresencePort`）、会话语料（`HostCorpusPort`）、投影缓存（`HostProjectionPort`），同住 `src/ports/host-port.ts`；`HostPort` 是四者相交的复合别名，这四片的适配只由 `createHostPort` 提供。**动词只拿 `HostCorePort`**（不含在场三件与投影缓存删除面）：核心面里的投影缓存只到读面，`dropProjectionCache` 只进 `HostRemovalPort` / `RemovalDeps`；在场能力由 `CoreDeps.presence` 提供，端口形状住 `src/ports/presence-port.ts`、实现住 `src/verbs/member-presence.ts`。宿主服务的另外两个窄镜像各按用处分家：agent handle 捕获住 `src/ports/agent-handles.ts`（adapter 内部，不进端口类型），附件读取面住 `src/ports/attachments-port.ts`（ADR-0035）；exact Fetch 注册面住 `src/api/connection-route.ts`。裁决见 ADR-0019（角色切分与在场协议一个家承 ADR-0007 / ADR-0005；投影缓存读/写分面承 ADR-0062）。归档档的宿主读面同住这一层：`archivedSessionIds` / `labelOf`（身份面），`readSession` / `readTitleSnapshots` / `sessionActivity`（`sessionController.list` 的 `updatedAt`）/ `persistedSizes` / `persistenceMounted`（`sessionPersistence.list` 的 `sizeBytes` 与在场探测）（语料面）；它们的缺席 / 抛错各有三条不同降级，口径归调用方（`assembleArchiveRows` / `readArchiveDetail`，见本文 §4）。
- **语料缺席是显式的**：可缺席的读面都交 `CorpusRead<T>` = `{ available: true, value }` | `{ available: false }`，不带原因串；`persistedSizes` 的服务缺席同样折成缺席（调用方逐行缺大小），只有整本读 `readSession` 用抛错表达「读不了」（调用方折 `io` / `not-found`）。形状住 `src/ports/host-port.ts`。**缺席之后怎么办归调用方**：删除只删父、count 报 0、`/list` 与 purge 静默降级、`/orphans` 与经 `loadOrphanGroups` 的 `orphan-clean` 响亮失败、归档清单逐行缺大小而整档照常。裁决见 ADR-0019（语料面承 ADR-0007，未翻）。
- **读面是路由记录的一格**：`read` 与 `RouteRead` 的词义与读法见 `CONTEXT.md`「路由读面」，段名归属见 `docs/architecture.md` §4；裁决见 ADR-0004 / ADR-0012。
- **`verbs` 不 import `api`**：路由层只搬运，业务判据全在动词与部件。
- **活体准入的判据住 `src/verbs/live-admission.ts` 的 `assertNoLive`**：逐个问、任一在跑就整组拒绝、短路；**什么时候查、查哪些 id 归调用方**——永久删除的时机住 `docs/architecture.md` §4 的「永久删除的计划与执行」行（ADR-0027），删除与孤儿清理各自交自己的名单。
- **宿主类型面用本地窄镜像**（`src/ports/host-port.ts` 与 `src/ports/agent-handles.ts` 各只声明用到的成员 + 一次强转）：不装宿主类型包、不做 `declare module` 增强——npm 上的宿主包与运行中的宿主不同代，引包等于拿错了契约。
- **跨插件一律 `import type`**，值 import 是与生态的红线。
- **配置只有一个家**：`src/config.ts` 只放默认值、归一与本地 Standard Schema；`index.ts` 在 `apply` 第一步归一，结果作为 `CoreDeps.config` 注入，`api/` 与 `trash/` 的读方从 deps 读；浏览器半只在插件设置页的「可调项」卡经 `/config` 读/写（ADR-0037、ADR-0043）。

## 3. 浏览器半：槽位贡献与可丢弃投影

- 注册处只有一处：`src/client/index.tsx` 的贡献表（槽位 / 注册元数据 / 注入面 / 组件各一格）+ 一个注册循环；菜单两行的双轨协商（数据动作 / legacy + 迟到切换）与 `contextMenu.icon` 归 `src/client/context-menu-actions.tsx` 的 `installSessionMenus`（`AGENTS.md` 同条记这个唯一例外；为什么分出去见 ADR-0059）。勾选行的 live 读法不跟菜单模块走，住 `src/client/session-live.ts`。**槽位只挂官方已声明的**——向未声明槽位注册在插件激活时响亮失败。
- **通道探测决定入口出现与否**：注册任何贡献之前先探 `/ping`；只有成功信封（`pong`）才算通道在。打不通 / 回的不是信封 / 401·403（页面没有宿主身份）/ 失败信封 / 半开连接在探测上限处被 `AbortController` 打断，都按探测不过处理，一个入口都不注册（"不可用"以入口不出现表达，不新造禁用态 UI——半吊子 UI 比没有 UI 更糟），也不回退旧前缀（ADR-0033）。上限与三种失败都留 console 原文：入口不出现是有意的，"为什么没出现"不能只活在脑子里。
- **客户端条目 pending = 宿主进程死**：可选服务（locale、0.2.2+ 的 contextMenus/sessions）不进条目的 `inject`；一次性读走 `ctx.get`，可能迟到的服务（contextMenus）用 `ctx.inject([...])` 的 scoped 等待切过去——entry 本身始终 active。context-menu 包在 `dsh.client.inject` 里只排**模块到达**（`arriveGraphRow`），不保证服务已 `provide`；服务的就绪顺序只由 Cordis `inject` 决定。
- 文案住 `src/client/copy.ts` 的命名空间字典（zh 真源 + en 逐键镜像），经宿主 locale 服务可选读，缺席降级内置 zh。**渠道错误原文除外**：`src/client/receipt.ts` 的 missing-id 与单条幂等空值、`src/client/remote.ts` 的取数通道错误是固定中文，不随 locale；它们是协议诊断原文，不是界面标签。
- **跨槽位现场**：浏览器半挂在互不相邻的座位上（`shell.overlay`、`main`、会话行菜单），模块级快照跨组件卸载存活；脚手架（值 store 的快照 / 订阅 / 每实例 seq / `reset`；懒读快照的订阅骨架与脏标记）住 `src/client/store.ts`，各现场语义住调用方（多选与勾选集合住 `src/client/batch-selection-store.ts`，宿主行登记与快照住 `src/client/host-rows.ts`，全选 / 判定 / 整行点击守卫住 `src/client/batch-pick.ts`）；测试复位口住 `src/client/reset-client-state.ts`（只给测试，不引入运行期状态）。
- **重开等待住一个可取消句柄**：`src/client/main-view.ts` 只决定关谁、开谁；票、订阅、放弃 timer 与 settle 住 `src/client/pending-open.ts` 的 `createPendingOpen`（ADR-0036）。
- **写入座位、busy 闸、清单导航与残留维护各有自己的 module**：`src/client/write-seats.ts` 把每个调用点的呈现材质、闸与重读通道绑在一处，`src/client/busy-gate.ts` 只拥有「这一趟还算忙」的生命周期，`src/client/trash-nav.ts` 拥有清单的键盘契约与焦点意图，`src/client/ui/top-layer.ts` 拥有 Modal 与清单共用的顶层浮层名单与 Escape 判据，`src/client/use-maintenance-section.ts` 拥有三段共用的维护状态机（检查 / 清理 / 确认框 / 最新票 / 清完必重查）、`src/client/orphan-maintenance.tsx` 拥有无主子会话维护块的呈现、`src/client/config-settings.tsx` 拥有设置页的「可调项」卡、`src/client/maintenance-settings.tsx` 拥有「维护」卡、`src/client/settings-cards.tsx` 拥有那个槽位的占用者（两张卡的先后与 `summary` 守卫）、`src/client/settings-view.ts` 拥有两张卡共用的外壳配方；回收站面板只留页面骨架、清单行与确认框开合。
- **归档档的三台现场与回收站档互不相通**：清单状态与失效链住 `src/client/use-archive-query.ts`（四态、M 惰性、latest-wins、active 门、唯一重读入口 `reload`），失效台住 `src/client/archive-store.ts`，A1 旁路观察住 `src/client/host-archive-watch.ts`（`workspaces` 窄镜像、形状不符安静降级）；选择面是第二台 `useListSelection`（键 = 会话 id），详情账本是挂载内 Map（键 = 会话 id）——两者都不进 `trash-snapshot`（首帧快照是回收站的，ADR-0048）。面板的接线（键盘光标 / 下钻包装 / 活动行 / `detailNav`）住 `src/client/use-archive-panel-controller.ts`，面板只剩布局。
- **撤销通知台与 Toast 组件分家**：现场、seq、发布与熄灭住 `src/client/undo-notices.ts`；`src/client/undo-toast.tsx` 只做组件，组合通知台与恢复座位（`restoreFromUndo`）。因此 `undo-toast ↔ write-seats` 的 import 环不再存在；裁决与被否掉的替代见 ADR-0018。
- 浏览器半**不持任何真相**：线上失败码与数据根目录名从 `wire.ts` 取常量（自己的未分类诊断码住 `receipt.ts`），"这次会释放多少"念服务端算好的 `releaseBytes`——它只做呈现。

界面规格住 `docs/ui-spec.md`：入口与面板、六个基础状态、面板与清单、批量删除四态、设置页的「可调项」与「维护」两张卡。像素值、断点、文案键的唯一定义在 `src/client/` 与 `tests/client/`，那里不抄读数。

## 4. 唯一主人清单

某条语义"该去哪改"的对照表。**这是唯一一份主人清单**；`CONTEXT.md` 只定义词，不重复归属。写第二份之前先查这里。

| 语义 | 唯一主人 | 它不回答什么 |
| --- | --- | --- |
| 段名 / **请求字段组描述**（`BODY_GROUPS`：段名表 `body` 那一格有哪些字段、什么种类，`RouteBody` 六值各一格）/ 线上形状 / 线上失败码与它的读法（前缀判定 `isSessionDeleteCodeError`、取动词词 `verbCodeOf`）/ 信封的运行期判形 `isRemoteResult` / 回收站目录名 / 唯一取数基础路径常量 | `src/shared/wire.ts` | 业务判据 |
| 浏览器半取数通道（一个 interface 交 `RemoteOutcome`：信封解析 / 401·403 固定原文 / 非信封诊断 / 网络失败归一 / 探测） | `src/client/remote.ts` 的 `SessionDeleteRemote` / `requestOutcome` | 段名 / 方法 / 请求体形状（`src/shared/wire.ts`）；鉴权（宿主 `/api`）；地址的挂载点（`src/client/api-base.ts`） |
| 取数地址的挂载点投影（官方 `/api` 前缀 + 当前文档所在目录；根部署下与旧版逐字相同） | `src/client/api-base.ts` | 前缀常量与段名（`src/shared/wire.ts`）；鉴权（宿主 `/api` bridge）；段名表的方法归属 |
| 写 `/apply` 回执的读法与**摘要**（缺 id / null 幂等 / 单条 null 的协议错 / 逐条失败 / orphan-clean 的 not-found 中性；成功 / 中性 / 失败 / 部分计数与**按动作取**的落地 id 一次派生） | `src/client/receipt.ts` | 各写入面的呈现；线上形状归 `src/shared/wire.ts` |
| 附件清理读数在回执里的聚合（跨 `ok` 相加、`skipped` 取第一条）与「跳过半句」的拼装判据（面板与维护卡共用） | `src/client/receipt.ts`；面板后半句在 `src/client/use-trash-query.ts`、维护卡后半句在 `src/client/use-maintenance.ts` | 独占判定（归 `src/trash/attachments.ts`）；服务端算的字节 |
| 纯度 / **读面**（读面同时定 `run` 的形：`none` 行只拿请求体、拿不到 `RouteRead`，`list` / `raw` 行多拿读面）/ body 的**预读投影**（`bodyOf`：哪一格要读 JSON）/ **字段解析**（通用解析手 `parseBody` 按字段组描述读出 typed 字段，五种拒绝原文住它）/ 同源取数闸声明（`fetchGate`）/ deps 切片 / 处理（run 接线；JSON 与 binary 两种 run 形）/ method 与 body 的派生（`defineRoute` 从段名表那一格取，行里不写投影） | `src/api/route-table.ts` | 业务判据（归 verbs 与部件）；wire 机制与 body 字节读（归 `src/api/connection-route.ts`）；段名、方法、请求体形状与字段组描述——它的家是 `src/shared/wire.ts` 的结构化段名表（`ROUTES` 每项 `{ path, method, body }`，路由记录的 method / body 由 `defineRoute` 从这一格派生；`body` 那一格的字段描述是 `BODY_GROUPS`） |
| 全部段名到宿主 `connection.fetch.register` 的 exact Fetch 投影、`Request` / `Response` 适配与 wire 机制（body 字节闸 / JSON 解析 / 二进制头 / JSON 响应统一 `private, no-store` / 失败信封 / `fetchGate` 的判据 `isSameOriginFetch`） | `src/api/connection-route.ts` | 路由记录的纯度 / 读面 / body 的预读判定 / `fetchGate` 声明（归 `src/api/route-table.ts`）；鉴权（归宿主 `/api` bridge） |
| 附件二进制读取（query 一次解析成 typed request、id / kind 闸；有宿主 `attachments` 时走 `readImage` / `readFileStream`，缺服务或引用元数据不够统一成一次 miss 才直接 fs + 魔数；所有路径共用一道上限（`deps.config.maxAttachmentBytes`，ADR-0037）、下载头） | `src/api/attachment.ts` | 什么算独占（归 `src/trash/attachments.ts`）、什么时候清（归 `src/verbs/permanent-removal.ts` 与设置页维护卡）；非附件的读面；宿主服务的字节校验（归 `src/ports/attachments-port.ts`，ADR-0035） |
| 宿主 `attachments` 服务的窄镜像（`available` / `readImage` / `readFileStream`，每次调用惰性解析） | `src/ports/attachments-port.ts` | 什么算独占（`src/trash/attachments.ts`）；什么时候删；孤儿扫描（`src/trash/attachments.ts`） |
| 清册行 → 线上行的投影 | `src/api/trash-rows.ts` 的 `toWire`（显式字面量，不 `...row`） | 组语义 |
| 组语义（谁能接住孩子、这一组有谁、`claimOf` 三态、按组收缩 `withoutGroup`） | `src/trash/groups.ts` | 步骤与回滚；同批已带走集（`src/verbs/batch-carried.ts`）**持有**哪份视图、什么时候收缩 |
| 收缩视图的持有机制（原始快照捕获 + 当前视图的持有；`claim` / `take` / `takeAll` / `view`） | `src/trash/shrinking-view.ts` 的 `createShrinkingView` | 三态与按组收缩的判据（`src/trash/groups.ts`）；谁持有实例、什么时候收缩（`src/verbs/batch-carried.ts` 与 `src/verbs/trash-scope.ts` 各自那份） |
| 「这一批」（去重保序 / 写动作共用一个循环与逐条信封 / 一批一次通告） | `src/verbs/batch.ts` | 单条动词的步骤；同批已带走集归 `src/verbs/batch-carried.ts`，三态谓词归 `src/trash/groups.ts`；`count` 是纯读、没有逐条失败，不走那个循环 |
| 同批已带走集（entry / session 两种 id 域，各有 `claim` / `take`；entry 的 fresh 支带组，session 只回 fresh / carried；entry 适配是 `src/trash/shrinking-view.ts` 的 `createShrinkingView` 薄壳，session 适配自持会话 id 集合） | `src/verbs/batch-carried.ts` | 组语义与收缩判据（`src/trash/groups.ts`）、收缩视图的持有机制（`src/trash/shrinking-view.ts`）；单个动词的步骤；purge 的同批带走与收缩视图实例归「清册作用域」行 |
| 清册作用域（purge 的「拿目标」：一份调用方选好读面的快照上的选组与收缩视图；`purge(id)` 只收一个 id，carried 幂等回 `{removed:0,freedBytes:0}`、absent 抛 trash-empty 且原文点名 id；`purgeAll()` 清全部行。**能力面**：作用域收 `CoreDeps` 与注入的执行器（`RemovalExecutor`）——计划只吃 `CoreDeps`，删的动作只经注入的执行器，作用域手里没有删除能力） | `src/verbs/trash-scope.ts` 的 `createTrashScope` | 读面选哪一格（路由行 / 批量层，ADR-0012）；三态与按组收缩的判据（`src/trash/groups.ts`）；计划、执行器（`RemovalExecutor`）与执行顺序（`src/verbs/permanent-removal.ts`）；无主子会话的扫描与清理不经过作用域（`src/verbs/batch.ts` 的 `applyOrphanClean` 直调 `src/verbs/orphan-subagents.ts`） |
| 成员离场 / 归位通告（摘 session + agent、三态、成对事件）与动词的在场尾巴（`withPresenceTail`：`run` / `undo` 之后补一条通告的形状） | `src/verbs/member-presence.ts` | 批量恢复由 `src/verbs/batch.ts` 调同一个 `announceRestored(ids)` |
| 在场能力的动词面（成员离场 / 归位 / 一批归位的三条签名） | `src/ports/presence-port.ts` 的 `PresenceCapability` | 三态与真值表、宿主调用顺序（归 `src/verbs/member-presence.ts`）；宿主端口的角色切分（归 `src/ports/host-port.ts`） |
| 一次成员移动的步骤、反向动作与逐步 undo 结果（`restored(key)`） | `src/verbs/member-journal.ts` | 哪些成员算一组；失败句子的措辞与合并（那是 `src/errors.ts`） |
| 组级成员移动的顺序、组根结果与整组回滚。调用方直接拿根结果，不索引数组；跟随者按序拿根结果。 | `src/verbs/move-group.ts` | 单成员步骤（`src/verbs/member-journal.ts`）；谁算一组（`src/trash/groups.ts`） |
| 永久删除的计划与执行（成员 / 目录 / 字节 / 部分回执；成功回执的字节念计划、执行期只记进度；失败时回滚归档态，ADR-0040；附件计划在删对象前复核，ADR-0041） | `src/verbs/permanent-removal.ts` | 活体准入的判据归 `src/verbs/live-admission.ts`（这里只决定时机与名单：计划期查 targets 与枚举到的盘上后代，执行器第一笔写前用 `plan.unarchive` 再查一次）；组语义归 `src/trash/groups.ts`；purge 的拿目标（读面 / 选组 / 收缩视图）归 `src/verbs/trash-scope.ts`；通告归 `src/verbs/member-presence.ts`；批量归 `src/verbs/batch.ts` |
| 附件内容块提取 / ID 与路径闸 / 剩余引用扫描 / 独占计划与执行期复核 | `src/trash/attachments.ts` | 什么时候删（归 `src/verbs/permanent-removal.ts`）；附件读取（归 `src/api/attachment.ts` 与宿主 `attachments` 服务，ADR-0035）；源文件与普通文件的删除（目前不删） |
| 活体准入的判据与那句原文（逐个问、任一在跑整组拒绝、短路） | `src/verbs/live-admission.ts` 的 `assertNoLive` | 什么时候查、查哪些 id（调用方给：永久删除见「永久删除的计划与执行」行，删除与孤儿清理各交名单） |
| 条目 id 的形状与路径闸（单段校验） | `src/trash/entry.ts` | 对账 |
| 清册读的两个读面（`list()` = 对账 + 读，供 `/list`、`/empty` 与写动词；`raw()` = 不对账、不写行，供 pure 的 `/orphans`、`/detail`、`/projection-orphans` 与 chained 的 `/projection-clean`） | `src/trash/ledger.ts` | 存储域绑定、对账的具体目录判据；哪一段拿哪一面归 `src/api/route-table.ts` |
| 清册与 `session-trash/` 目录的对账 | `src/trash/reconcile.ts` | 目录里读哪一代日志 |
| 会话日志的选代与走帧（多帧 zstd） | `src/log/session-log.ts` + `src/log/zstd-frames.ts` | 正文该显示什么 |
| 详情给谁看、给多少（块投影：user/assistant/reasoning/tool/injection/system/compaction；`source.kind` 分 user/injection；工具 call/result 按 `callId` 配对；单块字符闸、每页块数 + 页级字符闸 + `olderCursor` 游标；附件每块/每页两道闸；计数不过闸；子会话摘要=折进这一条的孩子按清册原序过线，超 `SUBAGENT_SUMMARY_LIMIT` 只列前 N 条并给总数；子会话行的 label 兜底也在这里——被读日志的 `subagent/catalog` 行折出、随行过线；没有 catalog 且标题撞名的 fork 行与独立子会话由 `src/trash/display-name.ts` 从自己的日志取名字，ADR-0058） | `src/trash/detail.ts` + `src/trash/display-name.ts` | 帧怎么切（那是 `log/`）；折叠怎么画（`src/client/session-detail.tsx`；块怎么分组归 `src/client/detail-blocks.ts`）；「谁露面、折进谁」（`src/trash/groups.ts`，详情不折）；自绘/读盘是受约束偏离（宿主无只读渲染口，ADR-0026） |
| 正文怎么排版成 DOM（裸 HTML、链接与图片的收口） | `src/client/markdown.tsx` + `src/client/ui/markdown.css` | 抄来的宿主消息行样式 |
| 回收站详情投影（七行信息表、子会话段的数据投影与徽标入口；行集与选中行配对） | `src/client/trash-detail.tsx` | 通用壳与块折叠呈现 / 工作步骤四档 / 提问轨 / 分页（`src/client/session-detail.tsx`、`src/client/detail-blocks.ts`、`src/client/use-detail-pager.ts`）；子会话段呈现（`src/client/subagent-section.tsx`，两档共用）；详情读路（`src/client/use-trash-detail-reader.ts`）；受约束偏离见 ADR-0026 |
| 详情右缘的提问轨（一句提问一格、悬停预览、点一下跳到那句、补页与落位不画高亮框、当前哪句跟着滚动走；**两档的接线一份**：从一台详情读路状态算出 prompts / 已加载块 / 有没有轨 / 保持期顶住） | `src/client/prompt-rail.tsx`（画）+ `src/client/use-prompt-rail.ts`（补页循环、落位与当前句）+ `src/client/use-detail-rail.ts`（两档共用的接线） | 整条会话的提问索引怎么产出（归 `src/trash/detail.ts` 的 `createDetailFold`，两档共用）；正文滚动锚点（归 `src/client/use-detail-pager.ts`）；详情栏在不在 DOM（归面板的挂载判据） |
| 详情与维护卡预览的附件渲染 / 放大 / 失败占位 | `src/client/attachment-view.tsx` | 什么时候出清理提示（面板归 `src/client/use-trash-query.ts`、维护卡归 `src/client/use-maintenance.ts`）；附件二进制怎么读（归 `src/api/attachment.ts`）；回执行外观（归 `src/client/notice.tsx`） |
| 清理回执行的呈现（图标 / 色彩 / 下边距；面板与维护卡共用，warning / success 两档） | `src/client/notice.tsx` 的 `Notice` | 什么时候该有这句话、失败与跳过怎么拼（面板归 `src/client/use-trash-query.ts`、维护卡归 `src/client/use-maintenance.ts`） |
| 宿主 storage domain 的绑定（域 open/close、条目校验器） | `src/trash/storage-manifest.ts` | 清册的读法（真相读归 `src/trash/ledger.ts`；`src/trash/manifest.ts` 只是 raw 端口） |
| 清册的 raw 端口（只给 ledger 与对账实现，不认 storage 域形状） | `src/trash/manifest.ts` | 与目录怎么对账（`src/trash/reconcile.ts`） |
| 盘与路径的适配（`FsPort`；`exists` 只把 ENOENT / ENOTDIR 当缺席、其余读错误照抛，ADR-0039；`statFile` 只读）与**按角色的能力切片**（`FS_*_METHODS` 一族方法名单、由名单派生的 `Pick` 别名 `CoreFsPort` / `RemovalFsPort` / `FsAttachmentPort` / `FsDetailPort` / `FsReferenceScanPort` / `FsReferenceScanRemovalPort`，以及运行期现切用的 `fsSlice`；删目录 / 删单文件只挂在 `RemovalFsPort` 这一层，`CoreFsPort` 不含，ADR-0032） | `src/ports/fs-port.ts` | 该删哪些目录/文件（各动词与 `src/trash/attachments.ts` 的判据）；哪个角色配哪份名单（归各 deps 面与 `src/api/route-table.ts` 的 `slice`） |
| 数据根的解析（`$DSH_HOME` / `~/.dsh`） | `src/ports/home.ts` | 宿主的显式配置（插件不可得） |
| 恢复时「挂不挂账本」与那句「归入未分组」 | `src/verbs/restore-session.ts` 的 `attachableWorkspaceId` / `isWorkspaceMissing` | 工作区还在时的挂接失败 |
| 宿主身份与归属（会话是谁——含删除时的显示名取名：子会话 label 优先，判据 `titleOf`，ADR-0058；落哪个项目/工作区、活不活/归档没有、账本与归档的写面） | `src/ports/host-port.ts` 的 `HostIdentityPort` | 通告（`api-session/*`，归 `HostPresencePort`） |
| 宿主在场通告（摘 session + agent 三态、`api-session/*` 如实通告） | `src/ports/host-port.ts` 的 `HostPresencePort` | 什么时候算「已离开 / 已回来」（归 `src/verbs/member-presence.ts`） |
| agent handle 捕获（安装时机 / symbol 表 / 按会话 dispose） | `src/ports/agent-handles.ts` | 摘活体三态（host-port.ts）与通告（member-presence）；受约束偏离：`agents` 无按会话 dispose（ADR-0008） |
| 会话语料读（整表身份 `listSessions`、子会话闭包 `subagentMembersOf`、标题快照 `titleSnapshots`、提问时间 `sessionActivity`、持久化字节 `persistedSizes`、整本读 `readSession`） | `src/ports/host-port.ts` 的 `HostCorpusPort` | 看不见语料时怎么办（**缺席策略归调用方**；形状见本文 §2 的「语料缺席」）；成员判据 = `origin:'subagent'`（ADR-0038） |
| 一批会话的**行读数装配**（标题 / 最后活动 / 大小 / 子会话 label 四路读面的一次预读；缺席与失败的落点口径；合计只加已知大小） | `src/trash/session-rows.ts` 的 `projectSessionRows` + `sizeTotals` | 哪一批 id、哪些格过线（归档清单 `src/api/archive-rows.ts`、详情子会话段 `src/trash/archive-detail.ts`）；语料可见性（`src/ports/host-port.ts` 的 `CorpusRead`） |
| 归档列表投影（归档集 ∩ 语料按 id 原样交集、ghost 过滤、`wantsLabel` 只随子会话行、大小失败取整档 `io`） | `src/api/archive-rows.ts` 的 `assembleArchiveRows` | 四路读面的口径（归 `src/trash/session-rows.ts`）；分组（归浏览器半的项目分组层）；详情（归 `readArchiveDetail`） |
| 归档单条详情读路（寻址边界：目标自己已归档，或已归档根的 subagent 闭包成员（ADR-0061）；`readSession` 事件流 + 合成 `session` 头喂块折叠；`SESSION_QUERY_SESSION_NOT_FOUND` 折 `not-found`；主体归档态随详情过线（`ArchiveDetailWire.archived`）；子会话段走宿主闭包 + 只读投影，**这一段读不出只让它自己不画**） | `src/trash/archive-detail.ts` 的 `readArchiveDetail` | 块 / 分页 / 计数（归 `src/trash/detail.ts` 的 `createDetailFold`，两档共用）；四路读面的口径（归 `src/trash/session-rows.ts`）；子会话段的呈现（归 `src/client/subagent-section.tsx`，两档共用）；孩子视图的导航态（归 `src/client/use-archive-panel-controller.ts`） |
| `unarchive` 动作（`/apply` 第六个动作：写 registry 归档集、成功值恒为 1、幂等、纯度 chained） | `src/verbs/batch.ts` 的 `applyUnarchive` | 回执读法（归 `src/client/receipt.ts`）；收尾顺序（归 `src/client/write-seats.ts`） |
| 归档档客户端状态与失效链（四态清单、M 惰性读数、latest-wins、active 门；A1 旁路观察与 trash 修订 / 自救动作的同轮合并；归档修订同时作废挂载内详情账本，子会话归档态不拿旧快照） | `src/client/use-archive-query.ts` 的 `useArchiveQuery`；失效台 `src/client/archive-store.ts`；A1 观察 `src/client/host-archive-watch.ts` | 行读数 / 页脚 / 状态面呈现（归 `src/client/archive-pane.tsx`，DOM 归 `src/client/session-list.tsx`）；动作面（归 `src/client/use-archive-panel-controller.ts`） |
| 归档档面板状态机（孩子视图（离清单单级导航）、详情读路实例（挂载内账本，键 = 会话 id）、光标与活动行 `activeId`、下钻包装 `selectRow`、导航面 `detailNav`（含保持期的导航/跳转守卫 `canNavigate`）、解除归档、删除座位。归档档没有独立的 `drilled` 位（选中即窄档下钻），所以 `selectRow` 吃布局事实 `split`；回收站的 `select` 由调用方交 `drill`——两台控制器的 select 契约因此不同） | `src/client/use-archive-panel-controller.ts` | 选中面（`src/client/use-panel-selection.ts` 的归档那一台）；清单四态（归 `useArchiveQuery`）；删除确认框（归 `src/client/delete-confirm.tsx` / `src/client/batch-confirm.tsx`） |
| 详情视图的通用壳（标题排与返回键——显示名次序归 `src/client/trash-view.ts` 的 `detailNameOf`；状态壳 / 块视图 / 计量行 / 工作步骤 / 提问轨数据面 / 分页；三个投影口 `head` / `infoRows` / `subagents`） | `src/client/session-detail.tsx` 的 `SessionDetail` + `src/client/detail-blocks.ts`（哪些块算过程内容、标准档怎么收组）+ `src/client/use-detail-pager.ts`（连翻预算；prepend 补偿的唯一主人——翻页入口不止一个，按发起方各补一次会让同一页补两遍） | 两档的行集与选中行配对（回收站归 `src/client/trash-detail.tsx`、归档归 `src/client/archive-detail.tsx`）；提问轨的渲染归 `src/client/prompt-rail.tsx`（面板层） |
| 两档共用的**栏外壳与几何**（详情栏 = 滚动容器 + 贴右缘的提问轨；清单栏 = 滚动容器；滚动条档位两栏一份配方；正文收口宽度、轨的右槽与右缘都从 TS 派生，样式表不写死） | `src/client/detail-pane.tsx` 的 `DetailPane` / `ListPane` / `SCROLL_COLUMN` / `DETAIL_TEXT_MAX_WIDTH` | 栏里画什么（回收站归 `src/client/trash-detail.tsx`、归档归 `src/client/archive-detail.tsx`）；轨本体与轨宽（`src/client/prompt-rail.tsx`）；两栏/下钻的断点与列宽（`src/client/trash-panel.tsx`）；滚动条槽的 CSS（`src/client/ui/layout.css`） |
| 详情子会话段（摘要条 / 展开体 / 锚点 / 意图预取 / 可点与只读两种行；**段里三样派生读数由它自己算**：徽标条数、「已列 N / 共 M」、合计那格文案；两档共用） | `src/client/subagent-section.tsx` 的 `useSubagentSection` | 孩子的原始事实（回收站归 `src/client/trash-detail.tsx`、归档归 `src/client/archive-detail.tsx`）；显示名次序（前两格归 `src/client/trash-view.ts` 的 `preferredNameOf`，兜底句归 `rowName` / `displayNameOf`，见 `CONTEXT.md`「条目显示名」）；全量合计与总数**怎么算**（归 Node 半：`src/trash/detail.ts` 的清册合计、`src/trash/archive-detail.ts` 的闭包合计）；开合状态只活在这一条详情里 |
| 宿主能力的生产 adapter（一颗对象同时满足四个角色） | `src/ports/host-port.ts` 的 `createHostPort` | 各动词的调用顺序 |
| 宿主 `projectKey(cwd)` 的**编码与解码一对**（字母表、`~XXXX` 转义与 `--…--` 裹边只有一份；无 cwd 的目录名字面量 `NO_CWD_PROJECT_DIR` 也在这里，两半共用） | `src/shared/project-key.ts` 的 `escapeProjectKey` / `unescapeProjectKey` / `NO_CWD_PROJECT_DIR` | 项目目录这个词的语义（`CONTEXT.md`）；cwd → 目录名的判据与 `_no-cwd` 兜底（`src/ports/host-port.ts` 的 `projectDirOfCwd`，删除计划 / 列表投影 / 对账重建共用）；组头怎么念（`src/client/trash-view.ts`） |
| 可调项（Config 默认值 / 归一 / 本地 Standard Schema；孤儿预览条数、附件响应上限、JSON 扫描上限）；归一结果由 `index.ts` 注入 `CoreDeps.config`，读方从 deps 读 | `src/config.ts` | 业务判据（附件独占、孤儿判定、删除）；宿主怎样读 profile 配置（归宿主 plugin manager 与 `cordis.patch.yml`） |
| 可调项的读/写段与设置页表单（`/config` 空体读、带字段写；写经宿主 `configEditor.edit` 落 profile 的 patch 层并让这一行重启；表单校验与 Node 半归一共用 `CONFIG_LIMITS`；ADR-0043） | `src/verbs/config.ts`（Node 写支）、`src/client/config-settings.tsx`（表单） | 默认值 / 归一 / Standard Schema（归 `src/config.ts`）；宿主怎样串行化 profile 写（归宿主 `configEditor`） |
| Node 半的依赖面（CoreDeps 六项 fs / host / ledger / home / presence / config；DeleteSessionDeps / RemovalDeps / DeleteDeps 全量面 + `attachments` / `configEditor` / `entry`；`attachment` 段走 `CoreDeps & { attachments }`、`config` 段走 `CoreDeps & { configEditor?; entry? }` 切片；`CoreFsPort` 不含 `removeDir` / `removeFile`，`HostCorePort` 不含在场三件与投影缓存删除面，`presence` 是能力面） | `src/deps.ts` | 各动词的调用顺序 |
| 删除/恢复时宿主**主视图**的收尾（删除当前会话关视图、撤销后重开、面板恢复后忘掉；重开等摘要用 snapshot subscribe，等待状态机住 `src/client/pending-open.ts`，ADR-0036） | `src/client/main-view.ts` | 什么时候该删/该恢复（动词与批量）；重开等待的票 / 订阅 / 放弃边界（`src/client/pending-open.ts`） |
| 重开等待（票 / 订阅 / 放弃边界 / settle 与 cleanup；订阅优先、不轮询） | `src/client/pending-open.ts` 的 `createPendingOpen` | 什么时候该重开、重开哪一条（`src/client/main-view.ts`）；宿主服务形状（`src/client/main-view.ts` 的窄镜像） |
| 撤销横幅的现场、seq、停留时长、按条目熄灭与整条清空（`clearUndoNotice`） | `src/client/undo-notices.ts` | 何时发布（发布决定归 `src/client/write-seats.ts` 的收尾；`anySuccess` 与落地名单由 `src/client/receipt.ts` 的摘要给出）、发布的形与标题（归 `src/client/write-seats.ts` 的座位）；Toast 呈现归 `src/client/undo-toast.tsx` |
| 撤销横幅的呈现（Toast 宿主与撤销动作的组合；每条通知以 seq 为 key 各持一枚闸，旧撤销在飞不按灰新横幅；闸包整趟、座位不再传闸，双套会让外层 busy 提前落下） | `src/client/undo-toast.tsx` | 现场 / seq / 发布与熄灭（归 `src/client/undo-notices.ts`）；恢复座位（归 `src/client/write-seats.ts`）；busy 的生命周期与同实例防重（归 `src/client/busy-gate.ts`） |
| 逐条 `/apply` 的**写入链**（六个界面位置的座位——菜单单删 / 批量删除 / 外部撤销恢复 / 面板恢复 / 面板永久删除 / 归档档解除归档，各绑呈现材质、闸与重读通道；一次写入的生命周期 apply（`RemoteOutcome`）→ 回执摘要 → settlement → refresh（`runWrite` 收按 action 切开的呈现材质，并把 `apply → settle → refresh` 整趟包进传入的闸）；按 action 的收尾顺序与 `WritePresentationByAction` 的判别形状——main-view 收尾 → 失效回收站（delete / restore）→ 撤销通告 / 详情账本（settlement 按 `anySuccess` 交 `writeSucceeded` 丢成功条目），含 `anySuccess` 门与恢复的两个座位；`count` / `orphan-clean` 不是座位（不进 `SeatedAction`），`unarchive` 没有呈现材质、settlement 不为它做事，`/empty` 聚合回执仍归 `use-trash-query.ts`） | `src/client/write-seats.ts`（六个座位是导出面；`runWrite` / `settleWrite` 模块私有） | 回执判读（`src/client/receipt.ts`）、关/开/忘主视图怎么算（`src/client/main-view.ts`）、谁重读（失效通告台 `src/client/trash-store.ts`、重读策略 `src/client/use-trash-query.ts`，归档档失效链 `src/client/archive-store.ts`）、各面的本地状态；孤儿清理不走座位（归设置页维护卡，ADR-0021） |
| 「这一趟还算忙」的 busy 生命周期（开闸 / 落地或抛错都放回 / 各实例互不影响 / 同一实例在飞时再包一趟同步挡回、那一趟不执行，不做引用计数） | `src/client/busy-gate.ts` 的 `useBusyGate` | 防抖、排队、重读（那些是 `src/client/write-seats.ts` 写入链的整趟）；谁该禁用（各面自己）；挡回来的那一趟怎么收尾（`runWrite` 与座位交回 `GateRun` 的 blocked 支，各面自己决定不改什么） |
| 无主子会话的扫描与分组（谁算孤儿：known 的口径 = 语料里的父 + 清册里的父） | `src/verbs/orphan-subagents.ts` | 传递闭包、防环与 bare 去重的核心（归 `src/domain/closure.ts` 的 `orphanRootsOf`，见 CONTEXT.md 的「会话闭包」）；删哪些目录、报多少字节、谁挡活体（归 `src/verbs/live-admission.ts`）；回收站里的组；组员只收 `origin:'subagent'` 的后代（ADR-0038） |
| 失败码的措辞与映射、回滚失败的措辞与合并（`details.rollbackFailures`；码本身住 `wire.ts`） | `src/errors.ts` + `src/remote/map-error.ts` | 上屏文案 |
| 客户端可见文案 | `src/client/copy.ts` | 服务端错误原文；渠道错误原文除外（`src/client/receipt.ts` 的 missing-id 与单条幂等空值、`src/client/remote.ts` 的取数通道错误是固定中文，不随 locale） |
| 清册的取数编排与清空的聚合回执（清单状态的词义见 `CONTEXT.md`「清单状态」；对外只有 `reload` 一个重读意图（挂载、显式重试、写后与失效同一条读），`reload` 的清单读失败把清单置为 `unknown`；最新票（`createLatestWins`，词表见 `CONTEXT.md`）、在飞的旧响应不许盖新态、输给后发读的读不清场；**请求属于发起它的那次挂载**：卸载后晚到的成功或失败都不写首帧快照；清空失败同样落 `unknown`、作废在飞读并收掉旧附件提示；清空的附件读数上屏归本模块，行为见 `docs/ui-spec.md` §3；写动作与清空走调用方传入的同一枚 `gate`，不另造第二枚闸；清空成功按发起时在场名单熄灭撤销横幅（`dismissUndoNotice`，不误熄期间新删除的那条；现场归 `src/client/undo-notices.ts`）、经 `emptiedTrash` 丢整份详情账本并保留空清单快照；清单读失败走 `reloadFailed` 整份丢） | `src/client/use-trash-query.ts` | 服务端算的那个数；busy 的生命周期（`src/client/busy-gate.ts`）；孤儿检查/清理（归 `src/client/use-maintenance.ts`，ADR-0021） |
| 清单的选择面（多选态、勾选集合、组头三态派生、`ordered` 的可见顺序；回收站档与归档档各一台实例） | `src/client/use-list-selection.ts` | 谁能接住孩子（`src/trash/groups.ts`）；键盘与焦点（`src/client/trash-nav.ts`） |
| 清单上的选中面（选中行从**全量行**里找、清单换版清场、宽档自动选中在 layout 阶段收口（ADR-0050）、动作失败原文按行存）——回收站档与归档档各一台实例、互不共享状态 | `src/client/use-panel-selection.ts` | 勾选集合与折叠组（`src/client/use-list-selection.ts`）、详情账本与在飞读数的作废（各档控制器经 `onGone` 接走）、键盘与焦点（`src/client/trash-nav.ts`） |
| 清单分组列的 DOM（grid 与它的一串 aria、组头、行的三格与底色、加载/打断块/空态三张卡）——两档只交**行读数**与**那一排动作** | `src/client/session-list.tsx` 的 `SessionList` + `ListLoading` / `ListNotice` / `ListEmpty` + `useRowFocus`（行的 DOM 查询） | 行读数与动作（回收站档在 `src/client/trash-panel.tsx`、归档档在 `src/client/archive-pane.tsx`）；勾选与折叠（`src/client/use-list-selection.ts`）；活动行与键盘焦点意图（`src/client/trash-nav.ts`）；视觉配方（`src/client/trash-view.ts` 的 `CARD` / `ROW` / `ROW_SELECTED` 与 `src/client/ui/layout.css` 的 `.sd-session-row`） |
| 清单的键盘契约与焦点意图（活动行 `aria-activedescendant` 与唯一 tab 落点、方向键走环、Enter / Space 的双重语义、Esc 只在下钻期间生效且顶层有 dialog/menu 时让路、退出下钻后交还一次焦点） | `src/client/trash-nav.ts` | 可见顺序（`src/client/use-list-selection.ts`）、详情 / 缓存 / 确认框（`src/client/use-trash-panel-controller.ts`）、行的 DOM 查询（由调用方注入 `focusRow`）；顶层浮层名单与判据（`src/client/ui/top-layer.ts`） |
| 顶层浮层（`[role="dialog"][aria-modal="true"]` 与 `[role="menu"]`）的名单与「谁在最上层收 Escape」判据 | `src/client/ui/top-layer.ts` | Modal 何时关、清单何时退下钻（由各自决定并调用） |
| 无主子会话维护块的呈现（警告条、失败块、中性提示、预览与清理确认），唯一使用方是设置页维护卡 | `src/client/orphan-maintenance.tsx` | 检查/清理的状态与回执判读（段视图归 `src/client/use-maintenance-section.ts`，各段 glue 与拼句归 `src/client/use-maintenance.ts`）；busy 由段自己给（`MaintenanceSectionView.busy`） |
| 设置页维护卡三段的状态机（报告 / 失败 / 中性提示 / **第二回执** / 确认框开合 / 在飞档位 / 最新票 / 清完必重查；三段各实例化一次，`busy` 由段自己给） | `src/client/use-maintenance-section.ts` 的 `useMaintenanceSection` | 各段的远程调用、判据与回执拼句（`src/client/use-maintenance.ts`）；呈现（`src/client/maintenance-settings.tsx` / `src/client/orphan-maintenance.tsx`） |
| 设置页维护卡三段的 glue：各段的远程调用、「没活可干」判据与回执拼句（含附件回执句子与孤儿段的第二回执） | `src/client/use-maintenance.ts` | 状态机与不变量（`src/client/use-maintenance-section.ts`）；呈现（`src/client/maintenance-settings.tsx`）；段名与线上形状（`src/shared/wire.ts`）；什么算孤儿（`src/verbs/orphan-subagents.ts` / `src/trash/attachments.ts` / `src/trash/projection-cache.ts`） |
| 设置页维护卡的呈现（卡片外壳、三个 section、状态行的固定优先级、孤儿附件与投影缓存的横幅/失败/确认框） | `src/client/maintenance-settings.tsx` | 段视图与动作（`src/client/use-maintenance-section.ts`）；各段 glue 与拼句（`src/client/use-maintenance.ts`）；无主子会话块的呈现（`src/client/orphan-maintenance.tsx`） |
| 孤儿附件的报告段（报告把扫描折成数量/字节 + 对象清单 `id`/`bytes`，清单上限读 `deps.config.orphanPreviewLimit`（ADR-0037）供设置页预览、读不出就抛 `io`） | `src/api/attachment-orphans.ts` | 什么算孤儿、删哪些对象（`src/trash/attachments.ts`）；什么时候清（设置页维护卡手动触发，ADR-0021）；清理段直接由路由接 `src/trash/attachments.ts` |
| 孤儿附件的扫描与聚合清理（只认 `attachments/v1/objects` 下 `<2 hex>/<64 hex>`；引用源读不出就整份跳过） | `src/trash/attachments.ts` 的 `scanOrphanImageAttachments` / `cleanOrphanImageAttachments` | 什么时候清（归设置页维护卡，ADR-0021）；普通文件与缓存的处置（不碰，见 ADR-0020） |
| 孤儿投影缓存的判据与清理、永久删除的逐会话缓存收尾（缓存 id − 语料/持久化 − 清册行 − 回收站目录，bare 归一；只读 raw 行 + 目录名，不清册、不丢幽灵行；失败关闭口径见 ADR-0062） | `src/trash/projection-cache.ts` 的 `orphanProjectionCacheIds` / `reportProjectionCacheOrphans` / `cleanProjectionCacheOrphans` / `dropDeletedSessionCache` | 缓存的介质与删除面（`src/ports/host-port.ts` 的 `HostProjectionReadPort` / `HostProjectionWritePort`，经 `storageDomain.get('session_projcache')` 的同一条写链）；什么时候清（设置页维护卡手动触发 + 永久删除的逐条收尾，ADR-0062） |
| 动过回收站之后谁重读（失效通告台，只有一个修订号；回收站 / 归档各一条模块级修订号） | `src/client/trash-store.ts`（归档那台住 `src/client/archive-store.ts`） | 动了什么、谁动的（清单本体永远问宿主） |
| 详情账本的**容量与淘汰**（留多少条、重写挪队尾后按最近写入淘汰；两档同一条口径，账本 seam 也在这里） | `src/client/detail-ledger.ts` 的 `DETAIL_LEDGER_LIMIT` / `writeDetail` / `DetailLedger` | 账本存在哪、活多久（回收站归 `src/client/trash-snapshot.ts` 的模块级 Map、归档归 `src/client/use-archive-detail-reader.ts` 的挂载内 Map）；什么时候丢（归各档的写后收尾与清单修剪；回收站侧的意图名与判据住 `src/client/trash-snapshot.ts`） |
| 跨面板挂载的首帧快照与详情账本（上次成功的清单、选中与已读详情；挂载读一次、不订阅；「何时丢什么」收在意图名里——成功重读 `reloadSucceeded` 写回并修剪、失败 `reloadFailed` 整份丢、清空成功 `emptiedTrash` 只丢账本保空清单、行没了 `rowGone`、写成功 `writeSucceeded` 按名单丢；ADR-0048） | `src/client/trash-snapshot.ts` | 账本上限与淘汰口径（`src/client/detail-ledger.ts`）、清单三态与刷新中（`src/client/use-trash-query.ts`）、选中/详情读路（`src/client/use-trash-panel-controller.ts` / `src/client/use-trash-detail-reader.ts`）、写回归属（清单、选中、详情各由调用方在写后收尾里调上述意图名）；折叠集、列宽、孩子视图不进快照 |
| 意图预取的延时触发（hover / focus 过预设延时 `PREFETCH_DELAY_MS` 才读、连续划过只认最后一次、卸载清定时器；ADR-0051） | `src/client/use-prefetch.ts` 的 `useDelayedPrefetch` / `intentPrefetchHandlers` | 读什么、去重与账本（`src/client/use-detail-reader.ts` 的 `prefetch`，两档各一台实例）；hover / focus 接线（`src/client/session-list.tsx` / `src/client/subagent-section.tsx`） |
| 跨槽位现场脚手架（值 store 的快照 / 订阅 / 每实例 seq / `reset`；懒读快照的订阅骨架与脏标记；latest-wins 句柄 `createLatestWins` 的 compare-and-set；输入引用归一 `useLatest`） | `src/client/store.ts` | 选择面语义（那是 `src/client/batch-selection-store.ts`）；各现场自己的初值、不变量与读法；防抖 / 轮询 / 定时器 / 焦点策略（latest-wins 只做 CAS，策略仍是调用方的现场） |
| 浏览器半全部模块级现场的**测试复位口**（新增现场只改这一处） | `src/client/reset-client-state.ts` 的 `resetClientState` | 各现场自己的复位实现与不变量（各 module 自己）；生产生命周期（没有生产调用点） |
| 宿主会话列表的批量选择面（多选模式 / 勾选集合 / 追加与收缩） | `src/client/batch-selection-store.ts` | 页面上有哪些行（归 `src/client/host-rows.ts`）、点行算不算选中（归 `src/client/batch-pick.ts`）；不读 DOM |
| 宿主行可见集（**slot 组件挂载登记**，渲染侧只读快照）与按 id 的可选行查找（`pickableRowOf`；ADR-0034） | `src/client/host-rows.ts` | 选中集怎么变（归 `src/client/batch-selection-store.ts`）；全选 / 判定 / 整行点击守卫（归 `src/client/batch-pick.ts`）；DOM 行枚举（已删，见 ADR-0034） |
| 批量的全选 / 全选判定 / 模式内整行点击守卫（DOM 只把指针映射成 sessionId，再查登记） | `src/client/batch-pick.ts` | 可见行的事实源（`src/client/host-rows.ts`）；选中集本身（`src/client/batch-selection-store.ts`） |
| 回收站面板状态机（孩子视图（离清单单级导航）/ 首帧快照恢复与写回（`noteSelection`，ADR-0048）/ 待确认动作与 request 意图 / 窄档下钻状态与返回） | `src/client/use-trash-panel-controller.ts` | 选中面（`src/client/use-panel-selection.ts` 的回收站那一台：选中行、清场、自动选中、行失败）、布局（`src/client/trash-panel.tsx`）、取数（`src/client/use-trash-query.ts`）、详情读路（`src/client/use-trash-detail-reader.ts`）、首帧快照与详情账本本体（`src/client/trash-snapshot.ts`）、预取延时（`src/client/use-prefetch.ts`）、选择面（`src/client/use-list-selection.ts`）、清单的键盘与焦点（`src/client/trash-nav.ts`）、写入生命周期、收尾顺序与面板恢复的呈现材质（`src/client/write-seats.ts`） |
| 面板内两档平级分段（档位 `trash` / `archive`、切档双向清空勾选、归档查询/选择面/控制器常驻挂载、归档键盘 / Esc 交还仍归面板，光标与活动行归控制器 `activeId` / `selectRow`） | `src/client/trash-panel.tsx` | 各档自己的状态机（`src/client/use-trash-panel-controller.ts` / `src/client/use-archive-panel-controller.ts`）；归档取数（`src/client/use-archive-query.ts`）；键盘契约（`src/client/trash-nav.ts`） |
| 详情读路的通用机制（账本 seam + 失败不记账 / 在飞去重（`/detail` 与更早一页两条时间线）/ `reset` 作废该条在飞读数 / 保持与静默窗口（ADR-0049）/ 版本信号 / `olderCursor` 合并与晚到丢弃 / 分页失败） | `src/client/use-detail-reader.ts` 的 `useDetailReader` | 账本本体（回收站 `src/client/trash-snapshot.ts`；归档是挂载内 Map）；两档实例（`src/client/use-trash-detail-reader.ts` / `src/client/use-archive-detail-reader.ts`）；分页滚动锚点（`src/client/use-detail-pager.ts`）；意图预取的延时触发（`src/client/use-prefetch.ts`） |
| 回收站详情读路实例（账本键 = 条目 id，对外状态主体键 `subject`） | `src/client/use-trash-detail-reader.ts` 的 `useTrashDetailReader` | 通用机制（`src/client/use-detail-reader.ts`）；账本本体（`src/client/trash-snapshot.ts`） |
| 归档详情读路实例（挂载内账本，键 = 会话 id；顶层行与单级孩子视图共用，孩子读带已归档根） | `src/client/use-archive-detail-reader.ts` 的 `useArchiveDetailReader` | 通用机制（`src/client/use-detail-reader.ts`）；孩子视图的开关与失效（`src/client/use-archive-panel-controller.ts`） |
| 确认框的页脚壳（`Modal` + 取消/确认 + 关框规则 + 危险层级） | `src/client/confirm-dialog.tsx` 的 `ConfirmDialog` | 各框的标题 / 正文 / 确认键文案与状态机 |
| 槽位贡献与注册（一张贡献表 + 一个注册循环；含设置页按 bundle 包名寻址的 keyed 槽位、0.2.2+ 的 contextMenus 数据动作与图标） | `src/client/index.tsx`（注册前缀 `PLUGIN_ID` 与点号前缀住 `src/client/plugin.ts`；菜单两行的贡献与双轨协商在 `src/client/context-menu-actions.tsx`；勾选行与菜单行共用的 live 读法住 `src/client/session-live.ts`） | 各贡献自己的渲染 |
| 现行界面规格（状态、布局、危险层级） | `docs/ui-spec.md`；像素/断点/文案键的唯一定义在 `src/client/` 与 `tests/client/` | 各状态的实现细节 |
| 抄来的官方控件样式（`sd-` 前缀）与点名的自造差异（含 `--sd-*` 别名层） | `src/client/ui/ui.css` 文件头那张来源表 | token 的取值 |

## 5. seam：可测性怎么落

- **路由层是纯构造器**：`src/api/dispatch.ts` 的 `createDispatcher(deps)` 与 `src/api/connection-route.ts` 的 `registerConnectionRoutes(service, dispatch)` 不依赖 Cordis，用真 `node:http` server + 测试桥承载——`tests/api.test.ts` 钉每一段的 method / 形状 / 信封 / 失败码原文，`tests/connection-route.test.ts` 钉 exact 注册与 `Request` / `Response` 适配。
- **动词层走记录型世界**：`tests/support/world.ts` 的 `createLogWorld` 用声明式读数描述盘与宿主，并按**发生顺序**记 fs / host 两端调用——删除的「摘账本 → 搬目录 → 摘活体 → 通告」是一条顺序断言，不是散点断言。
- **领域纯函数直接喂结构**：`src/trash/groups.ts`、`src/trash/reconcile.ts`、`src/trash/entry.ts`、`src/shared/wire.ts` 的判据各有一条不起服务、不碰盘的钉子。
- **宿主端口用本地窄镜像 + 假 adapter**：`tests/ports.test.ts` / `tests/host-roles.test.ts` 钉角色切分，`tests/support/fake-deps.ts` 是动词用例共用的一份内存 adapter。
- **装配只在 `index.ts`，由 `tests/assembly.test.ts` 端到端钉**：插件模块面、exact Fetch 路由、槽位与 effect 的注册形状。
- **客户端是假 adapter 驱动真实组件**：`tests/client/index.test.tsx` 用假 `ctx` 与假 `fetch` 跑真 `apply`，其余客户端用例按读者分的依赖束注入；不是渲染快照。
- **重开等待句柄直接喂树**：`tests/client/pending-open.test.ts` 用假 store 与假 timer 钉订阅 / 放弃 / 取消；`tests/client/main-view.test.ts` 仍钉主视图收尾判据。
- **日志读面用真 zstd 帧**：`tests/session-log.test.ts` 与 `tests/zstd-frames.test.ts` 直接造多帧数据，不替身编解码。
- **门的分工**见 `AGENTS.md` 的「必须过的门」；真机验证的走法见 `docs/development.md` 的「真机验证」。

## 6. 数据与生命周期

- 运行时数据全住数据根（`$DSH_HOME/`，默认 `~/.dsh/`）：会话本体 `sessions/<项目目录>/<会话目录>/`（宿主的），回收站本体 `session-trash/<条目 id>/` 与清册（宿主 storage 域，介质在 `storages/`）。**回收站必须与 `sessions/` 同卷**（搬移靠整目录 `rename`，原子）。
- **`session-trash/` 目录是唯一需要手动动的地方**：真相读（`list()`）先与目录对账（多出的目录重建出行、目录没了摘行、认不出的当外人），由 `src/trash/ledger.ts` 保证；纯读面 `/orphans`、`/detail`、`/projection-orphans` 与 chained 的 `/projection-clean` 只读 `raw()`，不对账、不写行（`/detail` 遇到“行在、目录不在”照旧判 `io`，不靠对账摘行；投影缓存清理要保幽灵行，更不能先对账），`orphan-clean` 等写动作先 `list()` 再扫。`storages/` 那份是内部索引，外面改它要重启宿主才生效。
- **清册只记文件里真有的事实**：随盘上随时变的数（还剩几个孩子、这次释放多少）一律现算现给、不落清册。
- **会话列表不是磁盘投影**：`sessionQuery.listSessions()` 是磁盘持久化 **∪** 宿主内存里 attach 着的活体会话；摘账本挡不住活体，客户端会把它归入「未分组」。删除必须 `evictLive` 把 session 与 agent handle 一起摘掉（ADR-0008）。
- **删除 = 移入回收站**（可恢复，不自动过期）；**永久删除**只有三条路：purge（单条或一批）、清空回收站、无主子会话清理，都要二次确认；界面文案可以叫「彻底删除」。
- **有成员在跑 ⇒ 整组拒绝、零副作用**：删除 / 永久删除 / 孤儿清理都先过活体准入；插件不替用户终止正在进行的活。
- **回收站与归档解耦**（ADR-0008）：删除**不调** `archiveSession`；`evictLive` 把 session 与它的 agent handle 一起摘掉，恢复走冷 resume。`wasArchived` 只记删除前用户自己的归档事实；旧版本删除留下的归档态条目在恢复时迁移式 `unarchive`。**彻底删除失败时归档态要放回去**：执行器先读 `isArchived`，只回滚还没删掉的会话（ADR-0040）。**`unarchive`（`/apply` 的 `unarchive` 动作）是用户显式动作**：它写 registry 归档集，不是删除 / 恢复的副作用（ADR-0060）。
- **工作区账本缺席不是恢复失败**：宿主「删除工作区」只删注册、保留目录与每一份会话日志；恢复照常回盘、跳过 `attach`、归入未分组。`sessions/<projectDir>` 不在仍是硬拒绝，绝不静默建目录。判据住 `src/verbs/restore-session.ts`。
- **无主子会话维护只走官方面、只由插件设置页的维护卡手动触发**：扫描用 `/orphans`，清理是 `/apply` 的 `orphan-clean`；永久删除、不自动跑——回收站面板的挂载、写后重读与清空都不发这一问（ADR-0021），只清会话目录、会话独占的图片附件副本与这些会话自己的投影缓存记录（共享副本保留，判据见 ADR-0020 与 ADR-0062）。`sessionQuery` 缺席时 `/orphans` 响亮失败，purge 只清清册里的那部分。判据住 `src/verbs/orphan-subagents.ts` 与 `src/verbs/permanent-removal.ts`。
- 会话日志是**多帧 zstd**：只读版本号最大的那代，绝不拼代（判据与用例住 `src/log/session-log.ts`、`src/log/zstd-frames.ts` 与 `tests/session-log.test.ts`、`tests/zstd-frames.test.ts`）。
- **附件库在 `$DSH_HOME/attachments/v1`**：图片在 `objects/`，普通文件在 `file-objects/` + `files/`，宿主所有、没有删除接口。永久删除只清**独占图片副本**——被删会话引用、且剩余任何会话/派生存储都不再引用；共享副本保留，`$DSH_HOME` 之外的源文件不受影响；普通文件只渲染、不代删。剩余引用源读不出就整体跳过（宁可留孤儿也不删共享）；**删对象之前再复核一次**（目录已删、新引用可能已产生，ADR-0041）。判据住 `src/trash/attachments.ts`，裁决见 ADR-0020。**读取优先走宿主 `attachments` 的 `readImage` / `readFileStream`（ADR-0035）**，直接 fs 只留没有服务/引用元数据时的 fallback 与孤儿扫描/删除。
- **孤儿附件也只有手动这一条路**：`/attachment-orphans` 报告、`/attachment-clean` 聚合清理，都由设置页维护卡在用户点「检查 / 清理」时发起；没有自动检测、没有定时器，面板挂载不读它。报告与清理共用同一套引用扫描（全部会话日志 + 全部 `session-trash` 目录 + `storages` / `cache` JSON），但每次调用各自现扫：任一读不出就报告失败、清理零删，不折成 0。判据住 `src/trash/attachments.ts`，裁决见 ADR-0021。
- **投影缓存跟会话一起走、存量手动清**：宿主的 `session_projcache` 只写不删。永久删除在**逐条**删掉会话目录/清册行之后，删这一条会话的缓存（不是按计划名单批量；盘子目录本来就不在的成员留给维护卡）；缓存删除失败只留 warning，不翻会话删除。缓存域里找不到会话痕迹的记录由设置页维护卡第三段手动检查 / 清理，判据是「缓存 id − 语料/持久化 − 清册 raw 行 − 回收站目录」：只读路由交来的 **raw 行**与目录名（含目录不在的幽灵行），**不对账、不改写清册**；语料缺席或读不出、持久化服务在场但列表读不出、或缓存存储域不可用 ⇒ `io`。删除只经 `storageDomain.get('session_projcache')` 的同一条写链，不直接删 `storages/` 文件；裁决见 ADR-0062。

## 7. 改动面 → 先读什么

表只指路，不复制口径：真正的主人在本文 §4、ADR 与代码注释。

| 改动面 | 先读 |
| --- | --- |
| 段名 / 线上形状 / 失败码 | 本文 §4 的 `src/shared/wire.ts` 行；ADR-0003；`src/api/route-table.ts` |
| 路由 / 鉴权 / 远程身份 | 本文 §1、§4；`src/api/connection-route.ts`；ADR-0033（取代 ADR-0009、ADR-0022、ADR-0023） |
| 删除 / 恢复 / 归档语义 | 本文 §6；`src/verbs/delete-session.ts`、`src/verbs/restore-session.ts`；ADR-0008 |
| 批量与逐步撤销 | 本文 §4 的 `batch` / `member-journal` / `batch-carried` 行；ADR-0002；可见行来源见 ADR-0034 |
| 永久删除 / 活体准入 | 本文 §4 的 `permanent-removal` / `live-admission` 行；ADR-0027、ADR-0040 |
| 附件与孤儿清理 | 本文 §6；`src/api/attachment.ts`、`src/ports/attachments-port.ts`、`src/trash/attachments.ts`；ADR-0020、ADR-0021、ADR-0035、ADR-0041；上限/条数默认值见 `src/config.ts`（ADR-0037） |
| 可调项 / 设置页表单 | `src/config.ts`、`src/verbs/config.ts`、`src/client/config-settings.tsx`；ADR-0037、ADR-0043 |
| 清册 / 对账 | `src/trash/ledger.ts`、`src/trash/reconcile.ts`；ADR-0012 |
| 会话日志读取 | `src/log/session-log.ts`、`src/log/zstd-frames.ts` |
| 面板 / 交互 / 写入座位 | 本文 §3；`docs/ui-spec.md`；`src/client/write-seats.ts` |
| 回收站详情 / 对话全量 | 本文 §4 的 `detail` / `trash-detail` 行；`docs/ui-spec.md` ⑥；ADR-0026；`src/trash/detail.ts`、`src/client/trash-detail.tsx` |
| 插件页维护卡 | 本文 §3；`docs/ui-spec.md` §5；ADR-0021 |
| 宿主接入 / 打包 / 发版 | 本文 §1；`docs/development.md`；ADR-0025 |
| 文档 / ADR / 发布流程 | `docs/AGENTS.md`；`docs/adr/README.md`、`docs/adr/ADR-FORMAT.md`；`CONTRIBUTING.md`、`CHANGELOG.md` |
