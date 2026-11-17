# 架构与形状

这份文档只回答两个问题：**系统分成哪几块、为什么这么切；某条语义的主人在谁头上**。它是 explanation——给读懂代码提供地图，不给代码充当副本。

不在这里的东西，各有各的家：**术语**在 `CONTEXT.md`；**难逆的裁决与被否决的替代**在 `docs/adr/`（索引见 `docs/adr/README.md`）；**用户可见的事实**在 `README.md`；**构建、门控与发版**在 `docs/development.md`；**提交与发布边界**在 `CONTRIBUTING.md`；**发布历史**在 `CHANGELOG.md`；**界面规格**在 `docs/ui-spec.md`；**文档分层与生命周期**在 `docs/AGENTS.md`；**"怎么做"**在代码自己。这里不列读数——列了就是第二份抄本。历史留在 git。

## 设计词

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

- **通道只有一条：宿主 `connection` 的 exact Fetch 路由**。全部段名注册到 `connection.fetch.register` 的 `/api/dsh-session-delete-api/*`，Host / Origin / 浏览器认证由宿主 `/api` bridge 完成（ADR-0033）。支持面是 web UI 与桌面端；没有自建前缀、没有插件请求栅栏、没有旧前缀 fallback。`src/api/dispatch.ts` ↔ `src/client/remote.ts` 同源 fetch，信封与官方 unary 面同形（`{ok:true,value}` / `{ok:false,error:{code,message,details?}}`）。
- **段名只有一张表**（`src/shared/wire.ts` 的 `ROUTES`：每段恰有 `{ path, method, body }`，两半只从这张表投影）。十四段：`/ping`（通道在不在，不碰清册与盘）、`/list`（对账后读回收站清单）、`/detail`（POST 读单条详情）、`/empty`（清空回收站，聚合回执）、`/orphans`（无主子会话报告，纯读）、`/attachment`（唯一二进制段）、`/attachment-orphans`（孤儿附件报告，纯读）、`/attachment-clean`（孤儿附件聚合清理）、`/projection-orphans`（孤儿投影缓存报告，纯读）、`/projection-clean`（孤儿投影缓存聚合清理）、`/archive-list`（归档清单，纯读）、`/archive-detail`（POST 读归档单条详情）、`/config`（空体读三只可调项、带字段写回 profile 的 patch 层，写会重启这一行；ADR-0043）、`/apply`（六个动作：`delete` / `restore` / `purge` / `count` / `orphan-clean` / `unarchive`；其中 `count` 是纯读、其余五个是写动作）。
- **一组 id 进、逐条结果出**：单条就是长度为 1 的批量，不留第二条执行路径。
- **状态语义**：请求体不对由插件分发器回 400 + 信封；方法或路径不在 exact route 声明内时宿主在 handler 之前回纯文本 404（插件的 405 / 404 只是适配器直调时的防御分支）；401/403 是宿主 `/api` 的鉴权 / 归属失败（附件同源闸例外，回 403 + 失败信封）；操作失败回 200 + 信封——浏览器半先解信封再看状态。
- **鉴权归宿主 `/api`**（ADR-0033）。插件不重建身份，也没有回环免身份分支。唯一的插件侧闸是附件字节段的**同源取数闸**（路由记录声明 `fetchGate`）：拒 `Sec-Fetch-Site: same-site / cross-site` 与 authority 和 `Host` 不符的 http(s) `Origin` / `Referer`。绑定策略归宿主 webserver 配置，插件不替它决定可达性。
- **浏览器半不许 import 任何 `@deepseek-ai/*`**（type-only 也不留）：宿主客户端包随宿主换代而变、不过类型检查，一个抛错的组件会把整个槽位条目打空。要用的控件 / 图标按官方处方抄进 `src/client/ui/*`（类名 `sd-` 前缀、`@keyframes` 改名、配色与几何只走 token——宿主私有的那批经本插件的 `--sd-*` 别名层带公开兜底），来源表在 `src/client/ui/ui.css` 文件头。
- 改动生效分两条路：浏览器半靠宿主 HMR 热推；Node 半必须重启宿主。

## 2. Node 半的分层与依赖方向

```
domain/    零依赖纯部件：会话闭包与 bare 归一（不 import 任何仓内模块）
   ▲
ports/     端口与窄镜像：HostPort 四角色 / FsPort / PresenceCapability / AttachmentsPort / agent-handles
   ▲
trash/ · log/   领域部件：条目、清册与对账、组、附件、投影缓存、日志走帧
   ▲
verbs/     动词：删除 / 恢复 / 永久删除 / 批量 / 在场 / 维护
   ▲
api/       路由表、dispatch、行投影
   ▲
index.ts   组合根：装配 + exact Fetch 路由注册
```

- **`domain/` 是零依赖纯部件**：不 import 任何仓内模块；会话闭包与 bare 归一住这里（见 `CONTEXT.md`「会话闭包」），端口不反向 import `trash/`。
- **宿主路径命名的镜像只有一份**：`projectKey(cwd)` 的编码/解码与 `NO_CWD_PROJECT_DIR` 住 `src/shared/project-key.ts`；会话目录段的 `encodeSegment` 与反解住 `src/shared/session-path.ts`。两者都是宿主未暴露成服务的逐字镜像，宿主换代先复核；`src/trash/entry.ts` 是编码的唯一调用点，恢复按条目 id 里记下的段原地回放，不拿 `sessionId` 重编。
- **依赖面只有组合根装一次**：`src/deps.ts` 的 `CoreDeps` 是六项基础（fs / host / ledger / home / presence / config）；`fs` 是 `CoreFsPort`（不含 `removeDir` / `removeFile`），`host` 是 `HostCorePort`（不含在场三件与投影缓存删除面），`config` 是 `apply` 归一后的只读快照。各 `*Deps` 的逐项形状与路由切片归本文 §4 的依赖面行。
- **失败措辞是横切词汇，家在顶层 `src/errors.ts`**：抛错与回滚措辞被 `api/`、`verbs/`、`trash/` 三层共用，与 `src/deps.ts`、`src/config.ts` 同级——放进任何一层都会逼其余层向上 import。
- **宿主端口按角色切四片**：身份与归属（`HostIdentityPort`）、在场通告（`HostPresencePort`）、会话语料（`HostCorpusPort`）、投影缓存（`HostProjectionPort`），同住 `src/ports/host-port.ts`；`HostPort` 是四者相交的复合别名，适配只由 `createHostPort` 提供。**动词只拿 `HostCorePort`**；在场能力由 `CoreDeps.presence` 提供，端口形状住 `src/ports/presence-port.ts`、实现住 `src/verbs/member-presence.ts`。另外两个窄镜像与 exact Fetch 注册面各按用处分家：agent handle 捕获住 `src/ports/agent-handles.ts`，附件读取面住 `src/ports/attachments-port.ts`（ADR-0035）；exact Fetch 注册面住 `src/api/connection-route.ts`（ADR-0019；投影缓存读写分面承 ADR-0062）。
- **语料缺席是显式的**：可缺席的读面都交 `CorpusRead<T>` = `{ available: true, value }` | `{ available: false }`，不带原因串；`persistedSizes` 的服务缺席同样折成缺席，只有整本读 `readSession` 用抛错表达「读不了」。**缺席之后怎么办归调用方**（逐条口径见本文 §4 的语料读行与本文 §6）。
- **读面是路由记录的一格**：`read` 与 `RouteRead` 的词义见 `CONTEXT.md`「路由读面」，段名归属见本文 §4；裁决见 ADR-0004 / ADR-0012。
- **`verbs` 不 import `api`**：路由层只搬运，业务判据全在动词与部件。
- **活体准入的判据住 `src/verbs/live-admission.ts` 的 `assertNoLive`**：逐个问、任一**有活动**就整组拒绝、短路；**什么时候查、查哪些 id 归调用方**（ADR-0027）。判定一律问宿主 `workspace/session-activity` waterfall 非空；idle 活体允许删除——「attach 着」不是判据。
- **宿主类型面用本地窄镜像**（`src/ports/host-port.ts` 与 `src/ports/agent-handles.ts` 各只声明用到的成员 + 一次强转）：不装宿主类型包、不做 `declare module` 增强。**跨插件一律 `import type`**，值 import 是与生态的红线。
- **配置只有一个家**：`src/config.ts` 只放默认值、归一与本地 Standard Schema；`index.ts` 在 `apply` 第一步归一，结果作为 `CoreDeps.config` 注入，读方从 deps 读；浏览器半只在插件设置页经 `/config` 读/写（ADR-0037、ADR-0043）。

## 3. 浏览器半：槽位贡献与可丢弃投影

- 注册处只有一处：`src/client/index.tsx` 的贡献表（槽位 / 注册元数据 / 注入面 / 组件各一格）+ 一个注册循环；会话菜单两行的双轨协商与 `contextMenu.icon` 归 `src/client/context-menu-actions.tsx` 的 `installSessionMenus`（唯一例外，ADR-0059）。**槽位只挂官方已声明的**——向未声明槽位注册在插件激活时响亮失败。**每条贡献注册时各自包一层 `src/client/ui/ErrorBoundary.tsx` 的边界**：单条渲染崩了只收起它自己那一块，原错与 componentStack 进 console；不提供重试。
- **通道探测决定入口出现与否**：注册任何贡献之前先探 `/ping`；只有成功信封（`pong`）才算通道在。打不通 / 回的不是信封 / 401·403 / 失败信封 / 超时，都按探测不过处理，一个入口都不注册（"不可用"以入口不出现表达），也不回退旧前缀（ADR-0033）。失败原因留 console 原文。
- **客户端条目 pending = 宿主进程死**：可选服务（locale、contextMenus/sessions）不进条目的 `inject`；一次性读走 `ctx.get`，可能迟到的服务用 `ctx.inject([...])` 的 scoped 等待切过去——entry 本身始终 active。
- 文案住 `src/client/copy.ts` 的命名空间字典（zh 真源 + en 逐键镜像），经宿主 locale 服务可选读，缺席降级内置 zh。**渠道错误原文除外**（`src/client/receipt.ts` 与 `src/client/remote.ts` 的协议诊断是固定中文，不随 locale）。
- **跨槽位现场收进可实例化的场景**：`src/client/scene.ts` 的 `ClientScene` 聚合九份现场（修订台 / 首帧快照与详情账本 / 撤销台 / 主视图记忆 / 行登记 / 批量选中集 / 两个请求现场），生产注册面创建一份、各贡献经 `ClientSceneProvider` 读同一实例（槽位是独立 React 树，共享靠实例本身）；无 Provider 的测试回退默认实例。脚手架（值 store、懒读快照、每实例 seq、`reset`、latest-wins、`useLatest`）仍住 `src/client/store.ts`，各现场语义住原 module。测试复位口住 `src/client/reset-client-state.ts`（只清默认场景，只给测试）。
- **失效 → 重读只有一条实现**：`src/client/use-gated-refresh.ts` 的 `useGatedRefresh` 管修订到达、`active` / `demand` 两道门、合并窗与单飞；各消费者只保留自己的数据语义。失效台住 `src/client/trash-store.ts` 与 `src/client/archive-store.ts`，归场景实例里的修订号（默认实例兜底，ADR-0066）；宿主归档旁路观察住 `src/client/host-archive-watch.ts`（服务缺席安静降级）。**一次清单读怎么落地**（latest-wins 票 / 挂载归属 / `refreshing` / 三态 + 缺席 / 首帧初值）也只有一条实现：`src/client/use-panel-list-read.ts` 的 `usePanelListRead`；两档查询只留各自的数据语义。
- **写入座位、busy 闸、清单导航与维护各有自己的 module**：`src/client/write-seats.ts` 把每个调用点的呈现材质、闸与重读通道绑在一处，`src/client/busy-gate.ts` 只拥有「这一趟还算忙」的生命周期，`src/client/trash-nav.ts` 拥有清单的键盘契约与焦点意图，`src/client/ui/top-layer.ts` 拥有顶层浮层名单与 Escape 判据，`src/client/use-maintenance-section.ts` 拥有三段共用的维护状态机。**一档的装配线**住 `src/client/use-panel-tab.ts` 的 `usePanelTab`（两档差异由 adapter 交，状态各一份），**四格版面**住 `src/client/panel-tab.tsx` 的 `PanelTabFrame`，两档视图件住 `trash-tab.tsx` / `archive-pane.tsx`；回收站面板只留页面骨架、两档分段、布局几何与互斥。
- **撤销通知台与 Toast 组件分家**：现场、seq、发布与熄灭住 `src/client/undo-notices.ts`；`src/client/undo-toast.tsx` 只做组件，组合通知台与恢复座位。import 环因此不存在（ADR-0018）。
- 浏览器半**不持任何真相**：失败码与目录名从 `wire.ts` 取常量（自己的未诊断码住 `receipt.ts`），"这次会释放多少"念服务端算好的值——它只做呈现。

界面规格住 `docs/ui-spec.md`；本文 §4 只回答各模块的语义归属，不重复界面层级。

## 4. 唯一主人清单

某条语义"该去哪改"的对照表。**这是唯一一份主人清单**；`CONTEXT.md` 只定义词，不重复归属。写第二份之前先查这里。

### 4.1 契约与通道

| 语义 | 唯一主人 | 边界 |
| --- | --- | --- |
| 段名 / 请求字段组描述（`BODY_GROUPS`）/ 线上形状与失败码（`isSessionDeleteCodeError`、`verbCodeOf`）/ 信封判形 `isRemoteResult` / 线上值判形 `WIRE_VALUE_GUARDS` / 回收站目录名 / 基础路径常量 | `src/shared/wire.ts` | 业务判据 |
| `/apply` 六动作的静态索引（规范动作序 / 静态纯度 / 成功值形状族 / 慢请求档） | `src/shared/apply-actions.ts` 的 `APPLY_ACTIONS` / `APPLY_ACTION_INDEX` | 值型（`src/shared/wire.ts` 的 `ApplyValueByAction`）、路由记录与识别器（`src/api/route-table.ts`）、回执读法（`src/client/receipt.ts`）、写后收尾（`src/client/write-seats.ts`）、文案（`src/client/copy.ts`）；索引不参与运行时分派，矩阵测试只核对投影一致 |
| 浏览器半取数通道（信封解析 / 401·403 固定原文 / 非信封诊断 / 网络失败归一 / 单次往返超时 / 值判形失败面 / 探测） | `src/client/remote.ts` 的 `SessionDeleteRemote` / `requestOutcome` | 段名、方法、请求体形状（`src/shared/wire.ts`）；鉴权（宿主 `/api`）；挂载点（`src/client/api-base.ts`）；`/apply` 的慢请求档从 `src/shared/apply-actions.ts` 索引投影 |
| 取数地址的挂载点投影（官方 `/api` 前缀 + 当前文档所在目录） | `src/client/api-base.ts` 的 `apiPath` | 前缀常量与段名；鉴权；方法归属 |
| 写 `/apply` 回执的读法与摘要（缺 id / null 幂等 / 逐条失败 / orphan-clean 的 not-found 中性；成功、中性、失败、部分计数与按动作取的落地 id 一次派生） | `src/client/receipt.ts` 的 `summarizeReceipt` | 各写入面的呈现；线上形状归 `wire.ts` |
| 纯度 / 读面（`none` 行只拿请求体，`list` / `raw` 行多拿 `RouteRead`）/ body 预读（`bodyOf`）/ 字段解析（`parseBody`）/ 同源取数闸声明（`fetchGate`）/ deps 切片 / 处理（JSON 与 binary 两种 run 形）/ method 与 body 的派生（`defineRoute`） | `src/api/route-table.ts` | 业务判据；段名、方法与字段组描述（`src/shared/wire.ts`）；wire 机制与 body 字节读（`src/api/connection-route.ts`）；动作纯度与名单从 `src/shared/apply-actions.ts` 索引投影 |
| 全部段名到 `connection.fetch.register` 的 exact Fetch 投影、`Request` / `Response` 适配与 wire 机制（body 字节闸 / JSON 解析 / 二进制头 / `filename*` 编码 / `private, no-store` / 失败信封 / `isSameOriginFetch`） | `src/api/connection-route.ts` | 纯度 / 读面 / body 预读 / `fetchGate` 声明（`route-table.ts`）；鉴权（宿主 `/api`） |
| 失败码的措辞与映射、回滚失败的措辞与合并（`details.rollbackFailures`；码本身住 `wire.ts`） | `src/errors.ts` + `src/remote/map-error.ts` | 上屏文案 |

### 4.2 Node 半

| 语义 | 唯一主人 | 边界 |
| --- | --- | --- |
| Node 半依赖面（`CoreDeps` 六项；`DeleteSessionDeps` / `RemovalDeps` / `DeleteDeps`；`attachment` 与 `config` 切片） | `src/deps.ts` | 各动词的调用顺序；路由切片的运行期收窄（`route-table.ts`，ADR-0032） |
| 宿主身份与归属（会话是谁、落哪个项目 / 工作区、活不活 / 归档没有、账本与归档的写面；删除时的显示名取名 `titleOf`） | `src/ports/host-port.ts` 的 `HostIdentityPort` | 通告（归 `HostPresencePort`）；显示名次序（`CONTEXT.md`「条目显示名」） |
| 宿主在场通告（摘 session + agent 三态、`api-session/*` 如实通告） | `src/ports/host-port.ts` 的 `HostPresencePort` | 什么时候算「已离开 / 已回来」（`src/verbs/member-presence.ts`） |
| 会话语料读（`listSessions` / `subagentMembersOf` / `titleSnapshots` / `sessionActivity` / `persistedSizes` / `readSession`） | `src/ports/host-port.ts` 的 `HostCorpusPort` | 看不见语料时怎么办（缺席策略归调用方，形状见本文 §2）；成员判据 = `origin:'subagent'`（ADR-0038） |
| 投影缓存读 / 写分面（`HostProjectionReadPort` / `HostProjectionWritePort`；写只经 `storageDomain.get('session_projcache')`） | `src/ports/host-port.ts` | 什么算孤儿、什么时候删（`src/trash/projection-cache.ts`，ADR-0062） |
| agent handle 捕获（安装时机 / symbol 表 / 按会话 dispose） | `src/ports/agent-handles.ts` | 摘活体三态与通告；`agents` 无按会话 dispose（ADR-0008） |
| 附件读取服务的窄镜像（`available` / `readImage` / `readFileStream`） | `src/ports/attachments-port.ts` | 什么算独占（`src/trash/attachments.ts`）；什么时候删；孤儿扫描 |
| 盘与路径适配（`FsPort`；`exists` 只把 ENOENT / ENOTDIR 当缺席，ADR-0039；`readFileHead` 有界头读）与按角色的能力切片（`FS_*_METHODS`、`CoreFsPort` / `RemovalFsPort` / 其余 `Pick` 别名、运行期 `fsSlice`） | `src/ports/fs-port.ts` | 该删哪些目录 / 文件；哪个角色配哪份名单（各 deps 面与 `route-table.ts` 的 `slice`） |
| 数据根解析（`$DSH_HOME` / `~/.dsh`） | `src/ports/home.ts` 的 `resolveHome` | 宿主的显式配置（插件不可得） |
| 恢复时「挂不挂账本」与那句「归入未分组」 | `src/verbs/restore-session.ts` 的 `attachableWorkspaceId` / `isWorkspaceMissing` | 工作区还在时的挂接失败 |
| 项目目录编码 / 解码与无 cwd 兜底 | `src/shared/project-key.ts` 的 `escapeProjectKey` / `unescapeProjectKey` / `NO_CWD_PROJECT_DIR` | cwd → 目录名的判据（`src/ports/host-port.ts` 的 `projectDirOfCwd`）；组头怎么念（`src/client/trash-view.ts`） |
| 会话目录段编解码（空串抛、`.` / `..` 特判、`~XXXX` 转义） | `src/shared/session-path.ts` 的 `encodeSessionSegment` / `decodeSessionSegment` | 路径拼装与条目 id 的段（`src/trash/entry.ts` 的 `sessionDirForId` / `sessionDirSegmentOf` 是唯一调用点） |
| 条目 id 形状与路径闸（第二段是宿主编码后的目录段） | `src/trash/entry.ts` | 对账 |
| 清册读的两面（`list()` = 对账 + 读；`raw()` = 不对账、不写行） | `src/trash/ledger.ts` 的 `TrashLedger` | 存储域绑定；哪一段拿哪一面（`route-table.ts`） |
| 清册与 `session-trash/` 的对账（header 有界头读、前缀容忍半帧、零漂移零写入） | `src/trash/reconcile.ts` 的 `reconcileTrash` | 目录里读哪一代日志 |
| 清册的 raw 端口（只给 ledger 与对账，不认 storage 域形状） | `src/trash/manifest.ts` 的 `createStorageManifest` | 与目录怎么对账 |
| 宿主 storage domain 的绑定与条目校验 | `src/trash/storage-manifest.ts` | 清册读法；raw 端口 |
| 组语义（谁能接住孩子、`claimOf` 三态、按组收缩 `withoutGroup`） | `src/trash/groups.ts` | 步骤与回滚；同批已带走集持有哪份视图、什么时候收缩 |
| 收缩视图的持有机制（快照捕获、`claim` / `take` / `takeAll` / `view`） | `src/trash/shrinking-view.ts` 的 `createShrinkingView` | 三态与按组收缩判据（`groups.ts`）；谁持有实例（`batch-carried.ts` / `trash-scope.ts`） |
| 会话闭包（`closureOf` / `orphanRootsOf` / `firstByBare` / `bareSessionId` / `sessionIdShapes`） | `src/domain/closure.ts` | 端口「一层一次宿主调用」的适配；各动词的对象映射；组员判据 = `origin:'subagent'`（ADR-0038） |
| 「这一批」（去重保序 / 写动作共用一个循环与逐条信封 / 一批一次通告） | `src/verbs/batch.ts` | 单条动词的步骤；同批已带走集；`count` 是纯读、不走那个循环；`applyUnarchive` 同住这里 |
| 同批已带走集（entry / session 两种 id 域，各有 `claim` / `take`） | `src/verbs/batch-carried.ts` | 组语义；收缩视图机制；purge 的实例归「清册作用域」 |
| 一次成员移动的步骤、反向动作与逐步 undo 结果 | `src/verbs/member-journal.ts` | 哪些成员算一组；失败句子的措辞与合并（`src/errors.ts`） |
| 组级成员移动的顺序、组根结果与整组回滚 | `src/verbs/move-group.ts` | 单成员步骤；谁算一组 |
| 成员离场 / 归位通告（摘 session + agent、三态、成对事件）与动词的在场尾巴 | `src/verbs/member-presence.ts` | 批量恢复由 `batch.ts` 调 `announceRestored(ids)` |
| 在场能力的动词面（三条签名） | `src/ports/presence-port.ts` 的 `PresenceCapability` | 三态与调用顺序；宿主端口角色切分 |
| 清册作用域（purge 的拿目标：选好读面的快照、选组与收缩视图；`purge(id)` / `purgeAll()`；能力只经注入的执行器） | `src/verbs/trash-scope.ts` 的 `createTrashScope` | 读面选哪一格（路由行 / 批量层）；三态与按组收缩；计划与执行（`permanent-removal.ts`） |
| 永久删除的计划与执行（成员 / 目录 / 字节 / 部分回执；成功回执念计划；失败回滚归档态；附件计划与删前复核；`/list` 的组测量有界并发） | `src/verbs/permanent-removal.ts` 的 `planTrashRemoval` / `executeRemoval` / `planVisibleTrash` | 活体准入的判据与时机（`live-admission.ts` 与本文 §2）；组语义；purge 的拿目标；通告；批量 |
| 活体准入的判据与原文（逐个问、任一有活动整组拒绝、短路；idle 活体允许删） | `src/verbs/live-admission.ts` 的 `assertNoLive` | 什么时候查、查哪些 id（调用方给） |
| 附件内容块提取 / 引用扫描 / 独占计划与执行期复核 / 孤儿扫描与清理 / 规范日志旁临时名白名单 | `src/trash/attachments.ts` | 什么时候删（`permanent-removal.ts`）；附件读取（`src/api/attachment.ts` 与宿主服务，ADR-0035）；源文件与普通文件（不删） |
| 孤儿投影缓存的判据与清理、永久删除的逐会话缓存收尾（缓存 id − 语料/持久化 − 清册 raw 行 − 回收站目录，bare 归一；失败关闭） | `src/trash/projection-cache.ts` 的 `orphanProjectionCacheIds` / `reportProjectionCacheOrphans` / `cleanProjectionCacheOrphans` / `dropDeletedSessionCache` | 缓存介质与删除面（`HostProjectionWritePort`）；什么时候清（维护卡 + 永久删除逐条，ADR-0062） |
| 无主子会话的扫描与分组（known 的口径 = 语料里的父 + 清册里的父；根闭包在 `domain/closure.ts`） | `src/verbs/orphan-subagents.ts` 的 `orphanGroupsOf` / `loadOrphanGroups` | 传递闭包、防环与 bare 去重；删哪些；活体准入 |
| 会话日志的选代与走帧（多帧 zstd）、整本读取的顺序与上限（先 stat、比上限、再 read；判别结果 ok / too-large / unreadable） | `src/log/session-log.ts` 的 `readWholeSessionLog` + `src/log/zstd-frames.ts` | 正文该显示什么；各消费方怎么映射「读不出」 |
| 详情给谁看、给多少（块投影、工具配对、单块 / 每页闸、`olderCursor`、子会话摘要与显示名兜底） | `src/trash/detail.ts` 的 `createDetailFold` + `src/trash/display-name.ts` + `src/trash/subagent-summary.ts` 的 `summarizeSubagents` / `displayedSubagentCount` / `SUBAGENT_SUMMARY_LIMIT` | 帧怎么切（`log/`）；折叠怎么画（`src/client/session-detail.tsx`）；组语义（`src/trash/groups.ts`）；子会话段的行显示模型（两条读路各是各的） |
| 归档单条详情读路（寻址边界：目标自己已归档，或已归档根的 subagent 闭包成员；合成 `session` 头喂块折叠；子会话段读不出只让它自己不画） | `src/trash/archive-detail.ts` 的 `readArchiveDetail` | 块 / 分页 / 计数（`detail.ts`）；四路读面口径（`session-rows.ts`）；呈现（`subagent-section.tsx`） |
| 一批会话的行读数装配（批量面 `readRowSurfaces` / 逐行面 `projectRowFacts` / 合计 `sizeTotalsForIds`；有界并发 `mapLimit`） | `src/trash/session-rows.ts` | 哪一批 id、哪些格过线（调用方）；语料可见性（`CorpusRead`）；并发预算取值（调用点） |
| 归档列表投影（归档集 ∩ 语料按 id 交集、ghost 过滤、`wantsLabel` 只随子会话行、大小失败取整档 `io`） | `src/api/archive-rows.ts` 的 `assembleArchiveRows` | 四路读面口径（`session-rows.ts`）；分组（浏览器半）；详情（`readArchiveDetail`） |
| 清册行 → 线上行的投影（显式字面量，不 `...row`） | `src/api/trash-rows.ts` 的 `toWire` / `assembleTrashRows` | 组语义 |
| 附件二进制读取（query 解析、id / kind 闸、宿主服务优先、fs fallback、统一上限、下载头） | `src/api/attachment.ts` 的 `readAttachmentResponse` | 什么算独占；什么时候清；宿主服务的字节校验（`attachments-port.ts`） |
| 孤儿附件报告（扫描折成数量 / 字节 + 对象清单 `id` / `bytes`，清单上限读 `deps.config.orphanPreviewLimit`） | `src/api/attachment-orphans.ts` | 什么算孤儿、删哪些（`src/trash/attachments.ts`）；什么时候清（维护卡，ADR-0021） |
| 可调项（默认值 / 归一 / 本地 Standard Schema；孤儿预览条数、附件响应上限、JSON 扫描上限） | `src/config.ts` 的 `DEFAULT_CONFIG` / `normalizeConfig` / `Config` | 业务判据；宿主怎样读 profile 配置（宿主 plugin manager 与 `cordis.patch.yml`） |
| 可调项的读 / 写段与设置页表单（空体读、带字段写、写经宿主 `configEditor.edit` 重启这一行；表单与归一共享 `CONFIG_LIMITS`） | `src/verbs/config.ts`（写支）、`src/client/config-settings.tsx`（表单） | 默认值 / 归一 / Schema（`src/config.ts`）；宿主怎样串行化 profile 写 |

### 4.3 浏览器半

| 语义 | 唯一主人 | 边界 |
| --- | --- | --- |
| 槽位贡献与注册（一张贡献表 + 一个注册循环；含设置页 keyed 槽位、contextMenus 数据动作与图标；每条贡献包错误边界） | `src/client/index.tsx`（注册前缀 `PLUGIN_ID` 与点号前缀住 `src/client/plugin.ts`；菜单两行的双轨协商在 `src/client/context-menu-actions.tsx`；勾选行与菜单行共用的 live 读法住 `src/client/session-live.ts`） | 各贡献自己的渲染 |
| 槽位条目的渲染失败收口（class 边界 + `withErrorBoundary`；崩溃只收起这一块、`role="alert"` 占位、原错走 console；不提供重试） | `src/client/ui/ErrorBoundary.tsx` | 各贡献的正常渲染；宿主槽位注册与 Props 形状 |
| 回收站面板骨架与两档平级分段（页面骨架、宽窄断点与列宽拖拽、切档双向清空勾选、两个 `usePanelTab` 常驻挂载、归档惰性 M、附件回执与确认框宿主） | `src/client/trash-panel.tsx` | 档的装配线与四格版面（`use-panel-tab.ts` / `panel-tab.tsx`）；两档视图件（`trash-tab.tsx` / `archive-pane.tsx`）；各档状态机 |
| 档的装配线（清单读数 → 分组 → 选择面 → 控制器 → 键盘导航 → 意图预取 → 详情帧；两档差异由 adapter 交：行身份 / 行读数 / 分组键 / 两个 hook / 导航三格 / 预取参数域 / 详情挂载判据） | `src/client/use-panel-tab.ts` 的 `usePanelTab` / `PanelTabAdapter` / `PanelTabController` / `panelDetailNav` / `useGuardedLoadOlder` | 各机制判据（`use-panel-list-read.ts` / `use-list-selection.ts` / `use-gated-refresh.ts` / `trash-nav.ts` / `use-prefetch.ts` / `use-detail-frame.ts`）；两档状态（ADR-0060 第 4 条）；两档视图件 |
| 档的四格版面（工具行 / 清单 / 详情 / 页脚；两栏与下钻分支只写一次，返回 fragment 不新增 DOM 容器） | `src/client/panel-tab.tsx` 的 `PanelTabFrame` | 面板骨架与几何（`trash-panel.tsx`）；清单 DOM（`session-list.tsx`）；详情栏外壳（`detail-pane.tsx`） |
| 两档清单读取的落地生命周期（latest-wins 票 / 挂载归属 / `refreshing` / 三态 + 缺席 / 首帧初值 / 聚合写失败落面 / 可作废） | `src/client/use-panel-list-read.ts` 的 `usePanelListRead` | 两档的数据语义（首帧快照 / corpus-missing / 附件回执 / 惰性计数）与排读节奏（`use-gated-refresh.ts`）；合并窗档位是两档行为差异 |
| 回收站面板状态机（孩子视图、首帧快照恢复与写回、待确认动作与 request 意图、窄档下钻与返回；`select` 按 `drill` 或布局事实决定读不读详情；`extends PanelTabController` 只声明本档差异） | `src/client/use-trash-panel-controller.ts` | 共有面与详情导航装配（`use-panel-tab.ts` 的 `PanelTabController` / `panelDetailNav` / `useGuardedLoadOlder`）；选中面；布局；取数；详情读路；首帧快照与详情账本本体；预取延时；键盘与焦点；写入生命周期 |
| 归档档面板状态机（孩子视图、挂载内详情账本、光标与活动行、下钻包装、`detailNav`、解除归档、删除座位；`extends PanelTabController` 只声明本档差异） | `src/client/use-archive-panel-controller.ts` | 共有面与详情导航装配（`use-panel-tab.ts` 的 `PanelTabController` / `panelDetailNav` / `useGuardedLoadOlder`）；选中面；清单四态；删除确认框 |
| 面板选中面（选中行从全量行找、换版清场、宽档首读自动选中、动作失败原文按行存；两档各一台实例） | `src/client/use-panel-selection.ts` 的 `usePanelSelection` | 勾选集合与折叠组（`use-list-selection.ts`）；详情账本作废（各档控制器经 `onGone`）；键盘与焦点 |
| 清单的选择面（多选态、勾选集合、组头三态派生、`ordered`；两档各一台实例） | `src/client/use-list-selection.ts` | 谁能接住孩子（`groups.ts`）；键盘与焦点 |
| 清单分组列的 DOM（grid 与 aria、组头、行的三格与底色、加载 / 失败 / 空态三张卡） | `src/client/session-list.tsx` 的 `SessionList` + `ListLoading` / `ListNotice` / `ListEmpty` + `useRowFocus` | 行读数与动作（两档各交）；勾选与折叠；活动行与焦点意图；视觉配方 |
| 清单的键盘契约与焦点意图（`aria-activedescendant`、roving tabindex、方向键走环、Enter / Space 双重语义、Esc 分程与顶层让路、按键归属按 key 判） | `src/client/trash-nav.ts` | 可见顺序；详情 / 缓存 / 确认框；行的 DOM 查询；顶层浮层名单 |
| 顶层浮层的名单与「谁在最上层收 Escape」判据 | `src/client/ui/top-layer.ts` | Modal 何时关、清单何时退下钻 |
| 详情视图的通用壳（标题排与返回键、状态壳、块视图、计量行、工作步骤、提问轨数据面、分页入口；投影口 `head` / `infoRows` / `subagents`；壳只消费帧的 `state` / `pager` 两格） | `src/client/session-detail.tsx` 的 `SessionDetail` + `src/client/detail-blocks.ts` | 两档的行集与选中行配对；提问轨渲染；子会话段呈现；帧的接线（`src/client/use-detail-frame.ts`） |
| 详情读路的通用机制（账本 seam、失败不记账、在飞去重、`reset` 作废、保持与静默窗口、版本信号、`olderCursor` 合并、分页失败、`autoRead` 需求门） | `src/client/use-detail-reader.ts` 的 `useDetailReader` / `DetailState` | 账本本体；两档实例；分页滚动锚点；意图预取延时 |
| 详情帧的接线（一档的读路状态 + 保持期导航判据 + 分页读面 + 提问轨合成一个对象；两档投影只转交） | `src/client/use-detail-frame.ts` 的 `useDetailFrame` / `useDetailFramePager` | 各机制判据：reader（`use-detail-reader.ts`）、分页预算与锚点（`use-detail-pager.ts`）、轨（`use-detail-rail.ts`）；两档行投影与显示模型 |
| 详情账本的容量与淘汰（两档同一口径） | `src/client/detail-ledger.ts` 的 `DETAIL_LEDGER_LIMIT` / `writeDetail` / `DetailLedger` | 账本存在哪、活多久（回收站 `trash-snapshot.ts`、归档挂载内 Map）；什么时候丢 |
| 跨面板挂载的首帧快照与详情账本（挂在场景实例里，默认实例兜底；上次成功的清单、选中与已读详情；挂载读一次、不订阅；何时丢什么收在意图名里） | `src/client/trash-snapshot.ts` 的 `readTrashSnapshot` / `reloadSucceeded` / `reloadFailed` / `emptiedTrash` / `rowGone` / `writeSucceeded` / `noteSelection` | 账本上限与淘汰；清单三态；选中 / 详情读路；写回归属 |
| 回收站详情读路实例（账本键 = 条目 id，对外状态主体键 `subject`） | `src/client/use-trash-detail-reader.ts` 的 `useTrashDetailReader` | 通用机制；账本本体 |
| 归档详情读路实例（挂载内账本，键 = 会话 id；孩子读带已归档根） | `src/client/use-archive-detail-reader.ts` 的 `useArchiveDetailReader` | 通用机制；孩子视图开关与失效 |
| 归档档客户端状态与失效链（四态清单、惰性读数、latest-wins；档位门 / 合并 / 单飞交给共用生命周期；归档旁路观察与修订同轮合并） | `src/client/use-archive-query.ts` 的 `useArchiveQuery`；失效台 `src/client/archive-store.ts`；旁路观察 `src/client/host-archive-watch.ts` | 行读数 / 页脚 / 状态面呈现；动作面 |
| 详情右缘的提问轨（一句提问一格、悬停预览、点一下补页到那句、当前句跟滚动；两档接线一份） | `src/client/prompt-rail.tsx`（画）+ `src/client/use-prompt-rail.ts`（补页循环、落位与当前句）+ `src/client/use-detail-rail.ts` 的判据；两档接线住 `src/client/use-detail-frame.ts` 的 `useDetailFrame` | 整条会话的提问索引（`src/trash/detail.ts` 的 `createDetailFold`）；正文滚动锚点；详情栏在不在 DOM |
| 详情子会话段（摘要条 / 展开体 / 锚点 / 意图预取 / 可点与只读两种行；段内派生读数由它算） | `src/client/subagent-section.tsx` 的 `useSubagentSection` | 孩子的原始事实（各档详情）；显示名次序；全量合计与总数怎么算（Node 半）；开合状态只活在当前详情 |
| 动过回收站之后谁重读（失效通告台，只有一个修订号；回收站 / 归档各一条场景实例内的修订号，ADR-0066） | `src/client/trash-store.ts`（归档那台住 `src/client/archive-store.ts`） | 动了什么、谁动的（清单本体永远问宿主） |
| 「失效 → 重读」的节奏（修订到达同步作废、`active` / `demand` 两道门、挂载不算修订、合并窗与单飞、卸载与晚到结算；不产出渲染态） | `src/client/use-gated-refresh.ts` 的 `useGatedRefresh` / `GatedRefreshPolicy` | 读什么、latest-wins、失败上屏（消费者）；修订台；档位活动面 |
| 逐条 `/apply` 的写入链（六个界面位置的座位：菜单单删 / 批量删除 / 外部撤销恢复 / 面板恢复 / 面板永久删除 / 归档档解除归档；一次写入 `apply → 回执摘要 → settlement → refresh`，按 action 的收尾顺序；失败落点经 `FailureSink` 交进来：闸外先清旧失败、ran 后铺逐条失败） | `src/client/write-seats.ts` | 回执判读（`receipt.ts`）、主视图收尾（`main-view.ts`）、谁重读（`trash-store.ts` / `archive-store.ts` / `use-trash-query.ts`）；`count` / `orphan-clean` 不是座位 |
| 「这一趟还算忙」的 busy 生命周期（开闸 / 放回 / 实例隔离 / 同实例防重，不做引用计数） | `src/client/busy-gate.ts` 的 `useBusyGate` | 防抖、排队、重读；谁该禁用；挡回那一趟的收尾 |
| 撤销横幅的现场、seq、停留时长、按条目熄灭与整条清空、失败 backlog | `src/client/undo-notices.ts` | 何时发布（`write-seats.ts`）；呈现（`undo-toast.tsx`） |
| 撤销横幅的呈现（Toast 宿主与撤销动作组合、每通知一枚闸、backlog 显示） | `src/client/undo-toast.tsx` | 现场 / seq / 发布与熄灭；恢复座位；busy 生命周期 |
| 删除 / 恢复时宿主主视图的收尾（删除当前会话关视图、撤销后重开、面板恢复后忘掉） | `src/client/main-view.ts` | 什么时候该删 / 该恢复；重开等待的票 / 订阅 / 放弃边界 |
| 重开等待（票 / 订阅 / 放弃边界 / settle 与 cleanup；订阅优先、不轮询） | `src/client/pending-open.ts` 的 `createPendingOpen` | 什么时候该重开；宿主服务形状 |
| 设置页维护卡三段的状态机（报告 / 失败 / 中性提示 / 第二回执 / 确认框开合 / 在飞档位 / 最新票 / 清完必重查） | `src/client/use-maintenance-section.ts` 的 `useMaintenanceSection` | 各段的远程调用、判据与回执拼句（`use-maintenance.ts`）；呈现 |
| 设置页维护卡三段的 glue（远程调用、「没活可干」判据与回执拼句） | `src/client/use-maintenance.ts` 的 `useMaintenance` | 状态机与不变量；呈现；段名与线上形状；什么算孤儿 |
| 设置页维护卡的呈现（卡片外壳、三个 section、状态行优先级、孤儿附件与投影缓存的横幅 / 失败 / 确认框） | `src/client/maintenance-settings.tsx` + `src/client/orphan-maintenance.tsx` | 段视图与动作；各段 glue；无主子会话块的呈现 |
| 设置页两张卡的占用者与外壳（「可调项」在上、「维护」在下；`summary` 守卫） | `src/client/settings-cards.tsx` + `src/client/settings-view.ts` | 两张卡各自的内容 |
| 清单行与详情的视觉配方（项目标签、组、`CARD` / `ROW` / `ROW_SELECTED` / `BULK_DANGER`、未分组与显示名次序） | `src/client/trash-view.ts` | 行的 DOM（`session-list.tsx`）；样式表（`src/client/ui/layout.css`）；详情标题排薄包装（`trash-detail.tsx`） |
| 回收站详情投影（七行信息表、子会话段的数据投影与徽标入口；行集与选中行配对） | `src/client/trash-detail.tsx` 的 `TrashDetail` | 通用壳与块折叠 / 工作步骤 / 提问轨 / 分页（`session-detail.tsx` 等）；子会话段呈现 |
| 归档详情投影（五行信息表、子会话段） | `src/client/archive-detail.tsx` | 通用壳；子会话段呈现；孩子视图导航态 |
| 两档共用的栏外壳与几何（详情栏 = 滚动容器 + 右缘提问轨；清单栏 = 滚动容器；滚动条档位；正文收口宽度从 TS 派生） | `src/client/detail-pane.tsx` 的 `DetailPane` / `ListPane` / `SCROLL_COLUMN` / `DETAIL_TEXT_MAX_WIDTH` | 栏里画什么；轨本体与轨宽；断点与列宽（`trash-panel.tsx`）；滚动条槽 CSS（`layout.css`） |
| 详情与维护卡预览的附件渲染 / 放大 / 失败占位 | `src/client/attachment-view.tsx` | 什么时候出清理提示（面板 `use-trash-query.ts`、维护卡 `use-maintenance.ts`）；附件二进制怎么读（`src/api/attachment.ts`）；回执行外观（`notice.tsx`） |
| 清理回执行的呈现（图标 / 色彩 / 下边距；面板与维护卡共用，warning / success 两档） | `src/client/notice.tsx` 的 `Notice` | 什么时候该有这句话、失败与跳过怎么拼（各调用方） |
| 正文排版成 DOM（裸 HTML、链接与图片收口） | `src/client/markdown.tsx` + `src/client/ui/markdown.css` | 抄来的宿主消息行样式 |
| 客户端可见文案 | `src/client/copy.ts` | 服务端错误原文；渠道错误原文 |
| 宿主行可见集（slot 组件挂载登记，渲染侧只读快照）与按 id 的登记 / 可选行查找 | `src/client/host-rows.ts` 的 `useVisibleSelectableRows`（订阅骨架住 `store.ts` 的 `createLazyStore`） | 选中集怎么变；全选 / 判定 / 整行点击守卫；DOM 行枚举（已删，ADR-0034） |
| 批量的全选 / 全选判定 / 模式内整行点击守卫 | `src/client/batch-pick.ts` | 可见行的事实源；选中集本身 |
| 宿主会话列表的批量选择面（多选模式 / 勾选集合 / 追加与收缩） | `src/client/batch-selection-store.ts` | 页面上有哪些行；点行算不算选中；不读 DOM |
| 批量删除的呈现件（浮条、确认框、勾选控件、菜单行） | `src/client/batch-bar.tsx` + `src/client/batch-confirm.tsx` + `src/client/batch-select.tsx` + `src/client/batch-menu-item.tsx` | 选中集（`batch-selection-store.ts`）；全选与判定（`batch-pick.ts`）；写入链（`write-seats.ts`） |
| 浏览器半跨槽位现场的场景（九份现场聚成一份可实例化对象；生产注册面一份、贡献经 Provider 共用；默认实例兜底；`reset` 一处） | `src/client/scene.ts` 的 `ClientScene` / `createClientScene` / `ClientSceneProvider` / `useClientScene` / `installClientScene` / `resetDefaultClientScene` | 九份现场各自的语义与工厂（`trash-store.ts` / `archive-store.ts` / `trash-snapshot.ts` / `undo-notices.ts` / `main-view.ts` / `host-rows.ts` / `batch-selection-store.ts` / `delete-confirm.tsx` / `batch-confirm.tsx`）；`store.ts` 的订阅脚手架；`write-seats` 等命令式写仍走默认实例（已知边界） |
| 跨槽位现场脚手架（值 store 快照 / 订阅 / 每实例 seq / `reset`；latest-wins 的 CAS；`useLatest`） | `src/client/store.ts` | 选择面语义；各现场初值与不变量；防抖 / 轮询 / 定时器 / 焦点策略 |
| 浏览器半默认场景的测试复位口（测试 / HMR 收场；生产无调用点） | `src/client/reset-client-state.ts` 的 `resetClientState` | `ClientScene.reset()`（唯一实现）；私有场景的 `reset()` 由测试自己调 |
| 意图预取的延时触发（hover / focus 过预设延时才读、连续划过只认最后一次、卸载清定时器） | `src/client/use-prefetch.ts` 的 `useDelayedPrefetch` / `intentPrefetchHandlers` | 读什么、去重与账本（`use-detail-reader.ts` 的 `prefetch`）；hover / focus 接线 |
| 面板宽度观测与列宽拖拽 | `src/client/use-panel-width.ts` + `src/client/use-column-resize.ts` | 断点定值（`trash-panel.tsx`）；布局样式（`layout.css`） |
| 确认框的页脚壳（`Modal` + 取消 / 确认 + 关框规则 + 危险层级） | `src/client/confirm-dialog.tsx` 的 `ConfirmDialog` | 各框的标题 / 正文 / 确认键文案与状态机 |
| 抄来的官方控件样式（`sd-` 前缀）与点名的自造差异（含 `--sd-*` 别名层） | `src/client/ui/ui.css` 文件头那张来源表 | token 的取值 |

### 4.4 文档

| 语义 | 唯一主人 | 边界 |
| --- | --- | --- |
| 现行界面规格（状态、布局、危险层级） | `docs/ui-spec.md`；像素 / 断点 / 文案键的唯一定义在 `src/client/` 与 `tests/client/` | 各状态的实现细节 |

## 5. seam：可测性怎么落

- **路由层是纯构造器**：`src/api/dispatch.ts` 的 `createDispatcher(deps)` 与 `src/api/connection-route.ts` 的 `registerConnectionRoutes(service, dispatch)` 不依赖 Cordis，用真 `node:http` server + 测试桥承载——`tests/api.test.ts` 钉每一段的 method / 形状 / 信封 / 失败码原文，`tests/connection-route.test.ts` 钉 exact 注册与 `Request` / `Response` 适配。
- **动词层走记录型世界**：`tests/support/world.ts` 的 `createLogWorld` 用声明式读数描述盘与宿主，并按**发生顺序**记 fs / host 两端调用——删除的「摘账本 → 搬目录 → 摘活体 → 通告」是一条顺序断言。
- **领域纯函数直接喂结构**：`src/trash/groups.ts`、`src/trash/reconcile.ts`、`src/trash/entry.ts`、`src/trash/subagent-summary.ts`、`src/shared/wire.ts` 的判据各有一条不起服务、不碰盘的钉子。
- **整本读取的顺序是一条 seam**：`src/log/session-log.ts` 的 `readWholeSessionLog` 是唯一「先 stat、比 `MAX_SESSION_LOG_BYTES`、再 readFile」的实现，判别结果（`ok` / `too-large` / `unreadable`）由 `tests/session-log.test.ts` 钉住；详情与附件引用扫描只映射自己的落点。
- **宿主端口用本地窄镜像 + 假 adapter**：`tests/host-roles.test.ts` 钉角色切分，`tests/ports.test.ts` 钉 `FsPort` 的缺席与搬移语义，`tests/support/fake-deps.ts` 是动词用例共用的内存 adapter。
- **组合根由两份测试各自钉一面**：`tests/skeleton.test.ts` 钉插件模块面（`name` / `inject` / `Config`），`tests/assembly.test.ts` 钉 exact Fetch 路由与 effect 的注册形状。
- **客户端现场是 instance seam**：`tests/client/scene.test.ts` 钉两份场景互不共享、Provider 下发传入实例、无 Provider 回退默认且 `resetClientState` 只清默认；旧测试的自由函数 + 复位口语义不变。
- **档的装配线是两档共用的接线 module**：`usePanelTab` 的 adapter 契约把两档差异收在一处；面板测试只保留跨档组合（Esc 归属 / 切档清勾选 / 惰性 M），两档视图件与控制器各自按档验。
- **详情帧是两档共用的接线 module**：`tests/client/session-detail.test.tsx` 在壳的 interface 上钉状态壳 / 折叠 / 分页 / 子会话读数，`tests/client/use-detail-pager.test.tsx` 直接钉分页器；档专用测试只留投影。
- **动作索引由矩阵测试双向核对**：`tests/apply-actions-matrix.test.ts` 枚举六动作 × 纯度 / 值形 / 慢档 / 回执 / 座位；索引表住 `src/shared/apply-actions.ts`，各家运行时判据不读表。
- **客户端是假 adapter 驱动真实组件**：`tests/client/index.test.tsx` 用假 `ctx` 与假 `fetch` 跑真 `apply`，其余客户端用例按读者分的依赖束注入；不是渲染快照。
- **重开等待句柄直接喂树**：`tests/client/pending-open.test.ts` 用假 store 与假 timer 钉订阅 / 放弃 / 取消；`tests/client/main-view.test.ts` 钉主视图收尾判据。
- **日志读面用真 zstd 帧**：`tests/session-log.test.ts` 与 `tests/zstd-frames.test.ts` 直接造多帧数据，不替身编解码；`tests/session-log.test.ts` 另钉整本读取 seam（超限一个字节都不读）。
- **门的分工**见 `AGENTS.md` 的「必须过的门」；真机验证的走法见 `docs/development.md`。

## 6. 数据与生命周期

- 运行时数据全住数据根（`$DSH_HOME/`，默认 `~/.dsh/`）：会话本体 `sessions/<项目目录>/<会话目录>/`（宿主的；目录名是 `encodeSegment` 的产物），回收站本体 `session-trash/<条目 id>/` 与清册（宿主 storage 域，介质在 `storages/`）。**回收站必须与 `sessions/` 同卷**（搬移靠整目录 `rename`，原子）。
- **`session-trash/` 目录是唯一需要手动动的地方**：真相读（`list()`）先与目录对账（多出的目录重建行、目录没了摘行、认不出的当外人）；纯读面与投影缓存清理只读 `raw()`，不对账、不写行。`storages/` 那份是内部索引，外面改它要重启宿主才生效。
- **清册只记文件里真有的事实**：随盘上随时变的数（还剩几个孩子、这次释放多少）一律现算现给、不落清册。
- **会话列表不是磁盘投影**：宿主语料是持久化 ∪ 内存里 attach 着的活体会话；摘账本挡不住活体。删除必须 `evictLive` 把 session 与 agent handle 一起摘掉（ADR-0008）。
- **删除 = 移入回收站**（可恢复，不自动过期）；**永久删除**只有三条路：purge（单条或一批）、清空回收站、无主子会话清理，都要二次确认；界面文案可以叫「彻底删除」。
- **有成员在跑 ⇒ 整组拒绝、零副作用**：删除 / 永久删除 / 孤儿清理都先过活体准入；插件不替用户终止正在进行的活。
- **回收站与归档解耦**（ADR-0008）：删除**不调** `archiveSession`，`wasArchived` 只记删除前用户自己的归档事实；旧版本删除留下的归档态条目在恢复时迁移式 `unarchive`。彻底删除失败时执行器只回滚还没删掉的会话（ADR-0040）。`unarchive` 是用户显式动作，不是删除 / 恢复的副作用（ADR-0060）。
- **工作区账本缺席不是恢复失败**：恢复照常回盘、跳过 `attach`、归入未分组；`sessions/<projectDir>` 不在仍是硬拒绝，绝不静默建目录。判据住 `src/verbs/restore-session.ts`。
- **无主子会话维护只走官方面、只由插件设置页的维护卡手动触发**：扫描用 `/orphans`，清理是 `/apply` 的 `orphan-clean`；不自动跑。只清会话目录、会话独占的图片附件副本与这些会话自己的投影缓存记录（ADR-0021、ADR-0020、ADR-0062）。`sessionQuery` 缺席时 `/orphans` 响亮失败，purge 只清清册里的那部分。
- 会话日志是**多帧 zstd**：只读版本号最大的那代，绝不拼代（`src/log/session-log.ts`、`src/log/zstd-frames.ts`）。
- **附件库在 `$DSH_HOME/attachments/v1`**：图片在 `objects/`，普通文件在 `file-objects/` + `files/`，宿主所有、没有删除接口。永久删除只清**独占图片副本**——被删会话引用、且剩余任何会话 / 派生存储都不再引用；共享副本保留，源文件不受影响；普通文件只渲染、不代删。剩余引用源读不出就整体跳过；删对象之前再复核一次（ADR-0041）。
- **孤儿附件也只有手动这一条路**：`/attachment-orphans` 报告、`/attachment-clean` 聚合清理，都由维护卡发起；每次调用各自现扫，任一读不出就报告失败、清理零删（ADR-0021）。
- **投影缓存跟会话一起走、存量手动清**：永久删除逐条删掉这一条会话的缓存；缓存域里找不到会话痕迹的记录由维护卡第三段手动检查 / 清理，判据是「缓存 id − 语料/持久化 − 清册 raw 行 − 回收站目录」；只经 storage domain 的写链，不直接删 `storages/` 文件（ADR-0062）。

## 7. 改动面 → 先读什么

表只指路，不复制口径：真正的主人在本文 §4、ADR 与代码注释。

| 改动面 | 先读 |
| --- | --- |
| 段名 / 线上形状 / 失败码 | 本文 §4 的 `src/shared/wire.ts` 行；ADR-0003；`src/api/route-table.ts` |
| 路由 / 鉴权 / 远程身份 | 本文 §1、§4；`src/api/connection-route.ts`；ADR-0033 |
| 删除 / 恢复 / 归档语义 | 本文 §6；`src/verbs/delete-session.ts`、`src/verbs/restore-session.ts`；ADR-0008；归档档见 ADR-0060、ADR-0061 与 `src/trash/archive-detail.ts`、`src/api/archive-rows.ts` |
| 批量与逐步撤销 | 本文 §4 的批量、成员移动与同批已带走集行；ADR-0002；可见行来源见 ADR-0034 |
| 永久删除 / 活体准入 | 本文 §4 的永久删除与活体准入行；ADR-0027、ADR-0040；投影缓存收尾见 ADR-0062 与 `src/trash/projection-cache.ts` |
| 附件与孤儿清理 | 本文 §6；`src/api/attachment.ts`、`src/ports/attachments-port.ts`、`src/trash/attachments.ts`；ADR-0020、ADR-0021、ADR-0035、ADR-0041；上限与条数见 `src/config.ts`（ADR-0037） |
| 可调项 / 设置页表单 | `src/config.ts`、`src/verbs/config.ts`、`src/client/config-settings.tsx`；ADR-0037、ADR-0043 |
| 清册 / 对账 | `src/trash/ledger.ts`、`src/trash/reconcile.ts`；ADR-0012 |
| 会话日志读取 | `src/log/session-log.ts`、`src/log/zstd-frames.ts` |
| 面板 / 交互 / 写入座位 | 本文 §3；`docs/ui-spec.md`；`src/client/write-seats.ts` |
| 回收站详情 / 对话全量 | 本文 §4 的详情与详情壳行；`docs/ui-spec.md` §2 ⑥；ADR-0026；`src/trash/detail.ts`、`src/client/session-detail.tsx` |
| 插件页维护卡 | 本文 §3；`docs/ui-spec.md` §5；ADR-0021、ADR-0062 |
| 宿主接入 / 打包 / 发版 | 本文 §1；`docs/development.md`；ADR-0025 |
| 文档 / ADR / 发布流程 | `docs/AGENTS.md`；`docs/adr/README.md`、`docs/adr/ADR-FORMAT.md`；`CONTRIBUTING.md`、`CHANGELOG.md` |
