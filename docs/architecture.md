# 架构与形状

这份文档只回答两件事：**系统分成哪几块、某条语义的主人是谁**。术语在 `CONTEXT.md`；难逆的裁决与被否方案在 `docs/adr/`；用户可见事实在 `README.md`；构建、门与发版在 `docs/development.md`；界面现状在 `docs/ui-spec.md`。代码与测试是最终真相；文档与代码冲突时改文档。

## 设计词

**module**：有 interface 与 implementation 的任何东西。**interface**：调用方要知道的全部（类型、不变量、顺序、错误形状）。**seam**：可以不改这里就换掉行为的位置。**adapter**：满足某个 seam 上 interface 的具体东西。**depth**：interface 上的杠杆；薄 interface 压着一大坨行为 = deep。**leverage**：调用方得到的。**locality**：维护者得到的（改动、bug、验证集中在一处）。

## 1. 双半与通道

```
       浏览器半（宿主前端）                     Node 半（宿主进程）
  src/client 槽位界面 / 面板 / 详情      HTTP/JSON      src/api 路由
  只有视图与可丢弃投影                ──────────▶      src/verbs 删除·恢复·永久删除
                                                        src/trash 清册与附件
                                                        src/log 日志走帧
             ▲
             └── 契约：src/shared/wire.ts（段名 / 请求 / 信封 / 失败码）+ src/shared/apply-values.ts（/apply 成功值）
```

- **通道只有一条**：宿主 `connection` 的 exact Fetch 路由，全部段名注册在 `/api/dsh-session-delete-api/*`；Host / Origin / 浏览器认证归宿主 `/api` bridge（ADR-0033）。没有自建前缀与 fallback；支持面是 web UI 与桌面端。
- **段名只有一张表**（`src/shared/wire.ts` 的 `ROUTES`，每段 `{ path, method, body }`）。十五段：`/ping`、`/list`、`/detail`、`/empty`、`/orphans`、`/attachment`、`/attachment-orphans`、`/attachment-clean`、`/projection-orphans`、`/projection-clean`、`/archive-list`、`/archive-detail`、`/config`、`/apply`、`/progress`。
- `/apply` **六个动作**：`delete` / `restore` / `purge` / `count` / `orphan-clean` / `unarchive`；`count` 是纯读，其余五个是写动作。
- **一组 id 进、逐条结果出**：单条就是长度为 1 的批量。
- **状态语义**：请求体不对 → 400 + 信封；路径/方法不在路由声明内 → 宿主在 handler 之前回 404；401/403 是宿主鉴权；操作失败回 200 + 信封（浏览器半先解信封再看状态）。信封形状 `{ok:true,value}` / `{ok:false,error:{code,message,details?}}`。
- **浏览器半不许 import 任何 `@deepseek-ai/*`**（type-only 也不留）：要用的控件按官方处方抄进 `src/client/ui/*`（类名 `sd-` 前缀、配色走 token）。宿主类型面用本地窄镜像，不装宿主类型包。
- **生效**：浏览器半靠宿主 HMR；Node 半必须重启宿主。

## 2. Node 半的分层与依赖方向

```
domain/   零依赖纯部件（会话闭包、bare 归一）
  ▲
ports/    端口与宿主窄镜像（HostPort 四角色 / FsPort / Presence / Attachments / agent-handles）
  ▲
trash/ · log/   领域部件（条目、清册与对账、组、附件、投影缓存、日志走帧）
  ▲
verbs/    动词（删除 / 恢复 / 永久删除 / 批量 / 在场 / 维护）
  ▲
api/      路由声明、dispatch、行投影
  ▲
index.ts  组合根：装配 + exact Fetch 注册
```

- **依赖面只有组合根装一次**：`src/deps.ts` 的 `CoreDeps` 是 fs / host / ledger / home / presence / config 六项；各动词只拿自己用得到的切片，路由行声明切片（ADR-0032）。
- **`verbs` 不 import `api`**；`domain` 不 import 仓内模块；`ports` 不反向 import `trash`。
- **宿主端口按角色切四片**（身份与归属 / 在场通告 / 会话语料 / 投影缓存），适配只由 `createHostPort` 提供；动词只拿 `HostCorePort`，在场能力由 `CoreDeps.presence` 给。
- **语料缺席是显式的**：可缺席读面交 `CorpusRead<T> = {available:true,value} | {available:false}`；缺席之后怎么办归调用方。
- **失败措辞是横切词汇**，家在 `src/errors.ts`；码住 `src/shared/wire.ts`。
- **配置只有一个家**：`src/config.ts` 的默认值、归一与本地 Standard Schema；`apply` 归一后作为 `CoreDeps.config` 注入。
- **`/apply` 值形状只声明一次**：`src/shared/apply-values.ts` 三族 schema（清册行 / 聚合回执 / 数字），`src/shared/wire.ts` 的类型与运行期判形都从它派生；`src/shared/value-schema.ts` 是那枚极小 DSL。

## 3. 浏览器半

- **注册处只有一处**：`src/client/index.tsx` 的贡献表 + 一个注册循环；会话菜单两行与两个 icon key 是唯一例外（`src/client/context-menu-actions.tsx`，ADR-0059）。槽位只挂官方已声明的；每条贡献各自包 `src/client/ui/ErrorBoundary.tsx`。
- **通道探测决定入口**：注册前先探 `/ping`，打不通就一个入口都不注册（ADR-0033）；失败原因留 console。
- **场景 seam**：`src/client/scene.ts` 的 `ClientScene` 聚合八份跨槽位现场。注册面在激活期安装一份；各贡献经 `ClientSceneProvider` 读同一实例；未安装即抛错（ADR-0067）。八个现场模块仍导出自由函数，委托进程场景的实例。
- **失效 → 重读一条实现**：`src/client/use-gated-refresh.ts` 的 `useGatedRefresh` 管修订到达、active / demand 两道门、合并窗与单飞；显式重读可经 `markConsumed` 消费当拍修订，免补发第二趟。**一次清单读的落地**也一条：`src/client/use-panel-list-read.ts` 的 `usePanelListRead`（latest-wins、挂载归属、三态 + 缺席、首帧初值）。
- **档的装配线一条**：`src/client/use-panel-tab.ts` 的 `usePanelTab` 把清单读数 → 分组 → 选择面 → 控制器 → 键盘 → 预取 → 详情帧接成一份，两档差异全交 `PanelTabAdapter`；四格版面住 `src/client/panel-tab.tsx`；两档状态仍各一份（ADR-0060 第 4 条、ADR-0065）。
- **孩子视图的收口一条**：`src/client/use-panel-child-view.ts` 的 `usePanelChildView` 管收尾顺序、返回两程与 `DetailNav` 装配；孩子怎么找、主体怎么投影归各档（ADR-0055 单级）。
- **详情读路一条**：`src/client/use-detail-reader.ts` 的 `useDetailReader` 管账本、在飞、失败、保持与分页；右缘提问轨住 `src/client/prompt-rail.tsx` 与 `src/client/use-prompt-rail.ts`。
- **写链一条**：`src/client/write-seats.ts` 六个写入座位共用一条 `apply → 解信封 → 回执摘要 → settlement → refresh` 生命周期；闸住 `src/client/busy-gate.ts`。
- **维护卡**：状态机住 `src/client/use-maintenance-section.ts`，远程与拼句住 `src/client/use-maintenance.ts`；三段都只有手动触发（ADR-0021）。
- **跨槽位协议**：撤销现场住 `src/client/undo-notices.ts`（呈现 `undo-toast.tsx`）；主视图收尾住 `src/client/main-view.ts`；首帧快照住 `src/client/trash-snapshot.ts`；宿主行登记住 `src/client/host-rows.ts`。
- **文案**住 `src/client/copy.ts`；渠道错误原文（`remote.ts` / `receipt.ts`）是固定中文，不随 locale。

## 4. 唯一主人清单

某条语义「该去哪改」的对照表。**这是唯一一份主人清单**；`CONTEXT.md` 只定义词。

### 4.1 契约与通道

| 语义 | 唯一主人 |
| --- | --- |
| 段名 / 请求字段组 / 请求与信封类型 / 失败码 / 信封判形 `isRemoteResult` / 回收站目录名 | `src/shared/wire.ts` |
| `/apply` 动作索引（规范动作序 / 静态纯度 / 慢请求档）与成功值形状 | `src/shared/apply-actions.ts` 的 `APPLY_ACTIONS` / `APPLY_ACTION_INDEX`；值形状住 `src/shared/apply-values.ts` 的 `APPLY_VALUE_SCHEMAS` |
| 值形状 DSL（`check` + `Infer`） | `src/shared/value-schema.ts` |
| 浏览器半取数（信封解析 / 401·403 原文 / 网络失败归一 / 单次往返超时 / 探测） | `src/client/remote.ts` 的 `SessionDeleteRemote` |
| 取数地址的挂载点 | `src/client/api-base.ts` 的 `apiPath` |
| 写回执的读法与摘要 | `src/client/receipt.ts` 的 `summarizeReceipt` |
| 纯度 / 读面 / body 预读 / 字段解析 / 同源取数闸 / deps 切片 | `src/api/route-table.ts` |
| 段名到 exact Fetch 的投影与 wire 机制 | `src/api/connection-route.ts` |
| 失败码措辞与回滚失败合并 | `src/errors.ts` + `src/remote/map-error.ts` |

### 4.2 Node 半

| 语义 | 唯一主人 |
| --- | --- |
| 依赖面（`CoreDeps` 六项与各动词切片） | `src/deps.ts` |
| 宿主身份与归属 / 在场通告 / 会话语料 / 投影缓存四角色 | `src/ports/host-port.ts` |
| agent handle 捕获 / 附件读取窄镜像 / 盘与路径适配 / 数据根 | `src/ports/agent-handles.ts` · `src/ports/attachments-port.ts` · `src/ports/fs-port.ts` · `src/ports/home.ts` |
| 项目目录编码 / 会话目录段编解码 | `src/shared/project-key.ts` · `src/shared/session-path.ts` |
| 条目 id 与路径闸 / 清册读 / 与目录对账 / storage 域绑定 | `src/trash/entry.ts` · `src/trash/ledger.ts` · `src/trash/reconcile.ts` · `src/trash/storage-manifest.ts` |
| 组语义 / 收缩视图 / 会话闭包 | `src/trash/groups.ts` · `src/trash/shrinking-view.ts` · `src/domain/closure.ts` |
| 一批的循环与逐条信封 / 批执行形态（预裁决 → 波次并发 → 第二波补跑） / 同批已带走集 | `src/verbs/batch.ts` · `src/verbs/batch-carried.ts` |
| 清空回收站的批驱动（`/empty` 的驱动序与失败面） | `src/verbs/empty-batch.ts` |
| 写入进度记录与步骤 tick 面 | `src/verbs/write-progress.ts` |
| 成员移动步骤与组回滚 / 离场归位通告 | `src/verbs/member-journal.ts` · `src/verbs/move-group.ts` · `src/verbs/member-presence.ts` |
| 会话目录搬移与瞬态占用重试 | `src/verbs/move-directory.ts` |
| 活体准入判据 | `src/verbs/live-admission.ts` 的 `assertNoLive` |
| 永久删除的计划与执行 / 清册作用域（purge 拿目标） | `src/verbs/permanent-removal.ts` · `src/verbs/trash-scope.ts` |
| 附件内容块、引用扫描、独占计划与复核、孤儿扫描 | `src/trash/attachments.ts` |
| 孤儿投影缓存的判据与清理、逐会话缓存收尾 | `src/trash/projection-cache.ts` |
| 无主子会话扫描与分组 | `src/verbs/orphan-subagents.ts` |
| 会话日志选代与走帧 / 整本读取上限 | `src/log/session-log.ts` · `src/log/zstd-frames.ts` |
| 详情块投影、工具配对、分页与子会话摘要 | `src/trash/detail.ts` · `src/trash/display-name.ts` · `src/trash/subagent-summary.ts` |
| 归档单条详情读路 / 归档列表投影 / 清册行投影 | `src/trash/archive-detail.ts` · `src/api/archive-rows.ts` · `src/api/trash-rows.ts` |
| 行读数装配与有界并发 | `src/trash/session-rows.ts` |
| 附件二进制读取与下载头 | `src/api/attachment.ts` |
| 可调项默认值 / 归一 / Schema / 读写段 | `src/config.ts` · `src/verbs/config.ts` |

### 4.3 浏览器半

| 语义 | 唯一主人 |
| --- | --- |
| 槽位贡献与注册 / 错误边界 | `src/client/index.tsx` · `src/client/ui/ErrorBoundary.tsx` |
| 场景与八个现场 | `src/client/scene.ts` |
| 跨槽位现场脚手架（值 store / latest-wins / `useLatest`） | `src/client/store.ts` |
| 面板骨架与两档互斥 / 档的装配线 / 四格版面 / 两档视图 | `src/client/trash-panel.tsx` · `src/client/use-panel-tab.ts` · `src/client/panel-tab.tsx` · `src/client/trash-tab.tsx` · `src/client/archive-pane.tsx` |
| 清单读生命周期 / 失效节奏 | `src/client/use-panel-list-read.ts` · `src/client/use-gated-refresh.ts` |
| 失效通告台（回收站 / 归档各自的修订号） | `src/client/trash-store.ts` · `src/client/archive-store.ts` |
| 两档控制器 | `src/client/use-trash-panel-controller.ts` · `src/client/use-archive-panel-controller.ts` |
| 孩子视图收口（收尾顺序 / 返回两程 / 导航面） | `src/client/use-panel-child-view.ts` |
| 选中面 / 选择面 / 批量选中集与整行点击守卫 | `src/client/use-panel-selection.ts` · `src/client/use-list-selection.ts` · `src/client/batch-selection-store.ts` · `src/client/batch-pick.ts` |
| 移入回收站动作 / 批量移入回收站呈现（动作宿主 / 浮条 / 勾选控件 / 菜单行） | `src/client/delete-action.tsx` · `src/client/batch-bar.tsx` · `src/client/batch-select.tsx` · `src/client/batch-menu-item.tsx` |
| 宿主行可见登记（行组件挂载登记，渲染侧只读快照） | `src/client/host-rows.ts` |
| 拖放投放目标 / 拖放判定 / 状态机 | `src/client/trash-entry.tsx` · `src/client/trash-drop.ts` · `src/client/drop-machine.ts` |
| 清单 DOM / 键盘契约 / 顶层浮层名单 | `src/client/session-list.tsx` · `src/client/trash-nav.ts` · `src/client/ui/top-layer.ts` |
| 详情壳与块 / 详情读路 / 详情帧 / 子会话段 | `src/client/session-detail.tsx` · `src/client/detail-blocks.ts` · `src/client/use-detail-reader.ts` · `src/client/use-detail-frame.ts` · `src/client/subagent-section.tsx` |
| 提问轨（画 + 补页落位） | `src/client/prompt-rail.tsx` · `src/client/use-prompt-rail.ts` |
| 首帧快照与详情账本 | `src/client/trash-snapshot.ts` · `src/client/detail-ledger.ts` |
| 写链 / busy 生命周期 | `src/client/write-seats.ts` · `src/client/busy-gate.ts` |
| 进度轮询 / 写身份认领 / 进度行 | `src/client/use-write-progress.ts` · `src/client/write-progress.tsx` |
| 撤销现场与呈现 | `src/client/undo-notices.ts` · `src/client/undo-toast.tsx` |
| 主视图收尾 / 重开等待 | `src/client/main-view.ts` · `src/client/pending-open.ts` |
| 维护状态机 / 远程 glue / 呈现 | `src/client/use-maintenance-section.ts` · `src/client/use-maintenance.ts` · `src/client/maintenance-settings.tsx` · `src/client/orphan-maintenance.tsx` |
| 可调项表单 | `src/client/config-settings.tsx` |
| 客户端文案 / 抄来的控件与来源表 | `src/client/copy.ts` · `src/client/ui/ui.css` |

### 4.4 文档

| 语义 | 唯一主人 |
| --- | --- |
| 现行界面规格 | `docs/ui-spec.md`；像素、断点与文案键的唯一定义在 `src/client/` 与 `tests/client/` |

## 5. seam：可测性怎么落

- **路由层是纯构造器**：`createDispatcher(deps)` 与 `registerConnectionRoutes` 不依赖 Cordis；`tests/api.test.ts` 钉每一段的 method / 形状 / 信封 / 失败码。
- **动词层走记录型世界**：`tests/support/world.ts` 用声明式读数描述盘与宿主，并按发生顺序记调用。
- **领域纯函数直接喂结构**：`src/trash/groups.ts`、`src/trash/reconcile.ts`、`src/trash/entry.ts`、`src/shared/wire.ts` 各有一条不起服务的钉子。
- **宿主端口用本地窄镜像 + 假 adapter**：`tests/host-roles.test.ts`、`tests/ports.test.ts`、`tests/support/fake-deps.ts`。
- **客户端是假 adapter 驱动真实组件**：测试按读者分的依赖束注入，不是渲染快照；场景每例换新（`tests/client/support/setup.ts`）。
- **动作索引由矩阵测试双向核对**：`tests/apply-actions-matrix.test.ts` 枚举动作 × 纯度 / 值形 / 慢档 / 回执 / 座位；值形状本身只有 `src/shared/apply-values.ts` 一份。

## 6. 数据与生命周期

- 运行时数据全住数据根（`$DSH_HOME/`，默认 `~/.dsh/`）：会话 `sessions/<项目目录>/<会话目录>/`，回收站 `session-trash/<条目 id>/` 与清册（宿主 storage 域）。**回收站必须与 `sessions/` 同卷**（搬移靠 `rename`）。
- `session-trash/` 是唯一需要手动动的地方：真相读（`list()`）先与目录对账；纯读面与投影缓存清理只读 `raw()`。
- **清册只记文件里真有的事实**；随盘上随时变的数（还剩几个孩子、这次释放多少）现算现给。
- **移入回收站可恢复，永久删除需确认**：移入回收站不自动过期、所有入口即执行（不弹确认框）；永久删除只有三条路：purge、清空回收站、无主子会话清理，都要二次确认。
- **有成员在跑 ⇒ 整组拒绝、零副作用**（活体准入）；idle 活体允许移入回收站。
- **回收站与归档解耦**（ADR-0008）：移入回收站不调 `archiveSession`；`unarchive` 是用户显式动作（ADR-0060）。工作区账本缺席不是恢复失败，归入未分组；`sessions/<projectDir>` 不在是硬拒绝。
- **维护只走手动**：`/orphans`、`/attachment-orphans`、`/projection-orphans` 与各自的 clean 段都只由插件设置页维护卡发起（ADR-0021）。
- **会话日志是多帧 zstd**：只读版本号最大的那代，绝不拼代。
- **附件库在 `$DSH_HOME/attachments/v1`**：永久删除只清被删会话独占的图片副本；共享副本与源文件保留；删前复核（ADR-0041）。
