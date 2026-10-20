# 架构与形状

这份文档只回答两个问题：**系统分成哪几块、为什么这么切；某条语义的主人在谁头上**。它是 explanation——给读懂代码提供地图，不给代码充当副本。

不在这里的东西，各有各的家：**术语**在 `CONTEXT.md`（词表）；**难逆的裁决与被否决的替代**在 `docs/adr/`（索引见 `docs/adr/README.md`）；**用户可见的事实**在 `README.md`；**构建、门控与发版**在 `docs/developing.md`；**界面规格**在本文 §3.1；**"怎么做"**在代码自己。这里一条读数都不列——列了就是第二份抄本，且必然腐烂。批次账与实测证据不再另存日志，历史留在 git。

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

- **通道是自建薄线，不是官方 `remote.<namespace>`**：第三方拿不到 Typert 描述符的挂载点（为什么不用官方 remote 见 `CONTEXT.md` 的「薄线」条），所以走宿主 web server 上的插件专属前缀路由 `/dsh-session-delete-api`——`src/api/dispatch.ts` ↔ `src/client/remote.ts` 同源 fetch，信封与官方 unary 面同形（`{ok:true,value}` / `{ok:false,error:{code,message,details?}}`）。
- **段名只有六个**（`src/shared/wire.ts`）：`GET /list`、`GET /ping`、`POST /detail`、`POST /apply`、`POST /empty`、`GET /orphans`。写动作全部走 `POST /apply`（`delete` / `restore` / `purge` / `count` / `orphan-clean`），一组 id 进、逐条结果出，**单条就是长度为 1 的批量，不留第二条执行路径**。
- **同源栅栏认得桌面壳那条路**：壳转发前删掉 `host`/`origin`/`cookie`/`sec-fetch-site` ⇒ 真机请求没有 `Origin`、只有 `Referer: dsh-app://app/`（实测判据住 `src/api/dispatch.ts`）。
- 改动生效分两条路：浏览器半靠宿主 HMR 热推；Node 半必须重启宿主。
- **浏览器半一条 `@deepseek-ai/*` 的 import 都不许有**（type-only 也不留）：宿主客户端包随宿主换代而变、不过类型检查，一个抛错的组件会把整个槽位条目打空。要用的控件/图标按官方处方抄进 `src/client/ui/*`（类名 `sd-` 前缀、`@keyframes` 改名、只留 `--dsw-*` token），来源表在 `ui.css` 文件头。

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

- **`verbs` 不 import `api`**：路由层只搬运，业务判据全在动词与部件。
- **宿主类型面用本地窄镜像**（`src/ports/host-port.ts` 只声明用到的成员 + 一次强转）：不装宿主类型包、不做 `declare module` 增强——npm 上的宿主包与运行中的宿主不同代，引包等于拿错了契约。
- **跨插件一律 `import type`**，值 import 是与生态的红线。

## 3. 浏览器半：槽位贡献与可丢弃投影

- 注册处只有一处：`src/client/index.tsx`（菜单行、行首勾选、行尾兜底、overlay 浮条/确认框、面板行 + 中央面板）。**槽位只挂官方已声明的**——向未声明槽位注册在插件激活时响亮失败。
- **通道探测决定入口出现与否**：注册任何贡献之前先探 `GET /ping`；探测不过 ⇒ 一个入口都不注册（"不可用"以入口不出现表达，不新造禁用态 UI——半吊子 UI 比没有 UI 更糟）。探测**过了**（哪怕回的是失败信封）就照常注册。
- **客户端条目 pending = 宿主进程死**：可选服务（locale）走 `ctx.get` 而不是 `inject`。
- 文案住 `src/client/copy.ts` 的命名空间字典（zh 真源 + en 逐键镜像），经宿主 locale 服务可选读，缺席降级内置 zh。
- 浏览器半**不持任何真相**：失败码与数据根目录名从 `wire.ts` 取常量，"这次会释放多少"念服务端算好的 `releaseBytes`——它只做呈现。

### 3.1 界面规格（现行）

结构与层级以本节为准；像素值、断点、文案键的唯一定义在 `src/client/` 与 `tests/client/`，本节不抄读数。历史取舍在 git 历史，不在本仓另存日志。

**入口与面板**

- 会话行菜单一项红色「删除」；会话在跑时置灰，并说明先停止。
- 回收站入口是一对座位：`sidebar.panellist` 的一行 + `main` 同 key 的中央面板，必须同批注册（`selectPanel` 对未注册的 id 直接抛）。面板行常驻，不做计数角标；头部只放标题与条数/占用（多选态那一行改说「已选 N 条」，合计让位给勾选数），动作在面板体顶端。

**六个基础状态**

| 状态 | 内容 | 规则 |
| --- | --- | --- |
| ① 会话行菜单 | 红色「删除」 | 运行中置灰并说明先停止 |
| ② 删除确认 | 可恢复说明；盘上有后代时先说「含 N 个子会话，将一起移入回收站」 | 主按钮 `primary`；N 读不到就不出这句、不写 0，也不因此禁用主按钮 |
| ③ 撤销提示 | 删除后即时出现 | 停留时长住 `undo-toast.tsx` 的 `UNDO_HOLD_MS`；撤销即恢复 |
| ④ 回收站清单 | 按项目分组的卡片；每条两行（标题 / 删除于… · 大小）；组视图另挂「含 N 个子会话」与「盘上还剩 M 个子会话」，两者不互相冒充；工作区已删的条目另挂「原工作区已不存在，恢复后归入未分组」 | 行右：恢复（描边）/ 彻底删除（安静红）；整行 `role=option`（点行选中/看详情，点按钮动作）；头部条数与占用；页脚「清空回收站…」 |
| ⑤ 彻底删除确认 | 单条与清空共用；单条报本次释放量 = 父 + 折进来的孩子 + 盘上后代 | 主按钮实心红；清空先对账再清 |
| ⑥ 单条详情 | 标题行（清册标题优先）+ 元信息表（时间、体量、计数、模型、位置——项目名取日志 header 的无损 `cwd`；删除于相对与绝对各一句）+ 正文 | 助手 Markdown、用户原话；正文不显示推理段与工具调用，工具调用只在元信息里报条数；注入/未显示条数上屏；四态：未选中/读数中/失败/有内容 |

**面板与清单**

- 面板四态：读数中、空、读数失败、有条目。空态不出现「清空回收站…」；失败原文上屏 + 重试，不折成空态；不做「刷新」按钮，读清单先对账。
- 两档形态：中央列够宽**且**清单有条目时走左右两栏（清单可拖、详情吃余下、正文自己限宽）；窄于此走下钻（清单铺满，点行详情铺满 + 返回）。清单为空或失败时不分栏。断点定值与列宽夹值以 `trash-panel.tsx` 的 `SPLIT_MIN_WIDTH` 和 `usePanelWidth` / `use-column-resize` 为准。
- 清单开关：组折叠、全部折叠/展开、多选；折叠的条目不进 DOM；组头三态勾选框覆盖整组（含折叠起来的）。视图状态（折叠集、拖出的宽度）不跨会话记住。
- 键盘：`listbox`/`option` + roving tabindex；↑↓ 只走可见行；窄档 Enter/Space 下钻，Esc 返回；多选态 `aria-multiselectable`，Enter/Space 切换勾选；详情不加 `aria-live`。
- 危险层级：页面本体唯一那块实心红**永远在页脚那一排的最后一颗**（非多选 =「清空回收站…」，多选 =「彻底删除 N 条」；写法是 `trash-view.ts` 的 `BULK_DANGER`）；行内那颗「彻底删除…」是安静的红（不铺底）；「恢复」描边；浮层确认用实心红。
- 失败落点：清单读失败只在清单块；某条正文读失败只在详情块，不冻结动作；操作失败原文落在出事那一行/那一块。

**批量删除四态**：宿主会话列表「⋯ → 多选」的显式模式、批量确认框、批量撤销横幅、部分失败态（框不关、原文落行、可重试）。两套与单删并存；结构以 `src/client/batch-bar.tsx`、`src/client/batch-confirm.tsx`、`src/client/batch-select.tsx`、`src/client/batch-selection-store.ts`、`src/client/host-rows.ts` 为准。

**残留维护三块**：只在 `GET /orphans` 报回 >0 时出现条件残留条；扫描/清理失败与原位回执（`not-found` 单列「已不在了」）；清理二次确认（按项目列数量/字节，说明父已不存在、不可恢复、只清会话目录）。清理是 `/apply` 的 `orphan-clean`，不自动跑。

## 4. 唯一主人清单

某条语义"该去哪改"的对照表。写第二份之前先查这里（`CONTEXT.md` 的「一条事实只住一个家」是这张表的词表版；两者冲突时以代码为准）。

| 语义 | 唯一主人 | 它不回答什么 |
| --- | --- | --- |
| 段名 / 线上形状 / 失败码 / 回收站目录名 | `src/shared/wire.ts` | 业务判据 |
| 段名的方法 / 纯度 / body 预读 | `src/api/route-table.ts` | 怎么处理 |
| 清册行 → 线上行的投影 | `src/api/trash-rows.ts` 的 `toWire`（显式字面量，不 `...row`） | 组语义 |
| 组语义（谁能接住孩子、这一组有谁、谁已被同批带走） | `src/trash/groups.ts` | 步骤与回滚 |
| 「这一批」（去重保序 / 清册快照 / 已带走账本 / 逐条信封 / 一批一次通告） | `src/verbs/batch.ts` | 单条动词的步骤 |
| 成员离场 / 归位通告（摘活体、三态、成对事件） | `src/verbs/member-presence.ts` | 批量通告（`announceRestoredBatch` 归 `src/verbs/batch.ts`） |
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
| 宿主在场通告（摘活体三态、`api-session/*` 如实通告） | `src/ports/host-port.ts` 的 `HostPresencePort` | 什么时候算「已离开 / 已回来」（归 `src/verbs/member-presence.ts`） |
| 会话语料读（整表身份 `listSessions`、子会话闭包 `subagentMembersOf`） | `src/ports/host-port.ts` 的 `HostCorpusPort` | 看不见语料时怎么办（**缺席策略归调用方**；各调用方的清单只住 `CONTEXT.md` 的「语料缺席」条） |
| 宿主能力的生产 adapter（一颗对象同时满足三个角色） | `src/ports/host-port.ts` 的 `createHostPort` | 各动词的调用顺序 |
| 无主子会话的扫描与分组（谁算孤儿、传递闭包与去重） | `src/verbs/orphan-subagents.ts` | 删哪些目录、报多少字节、谁挡活体（归 `src/verbs/permanent-removal.ts`）；回收站里的组 |
| 失败码的措辞与映射、回滚失败的措辞与合并（`details.rollbackFailures`；码本身住 `wire.ts`） | `src/verbs/errors.ts` + `src/remote/map-error.ts` | 上屏文案 |
| 同源栅栏（桌面壳那条只留 Referer 的路） | `src/api/dispatch.ts` | 操作失败的信封（那是 `map-error`） |
| 客户端可见文案 | `src/client/copy.ts` | 服务端错误原文 |
| 清册与残留的取数编排（到达序号、在飞的旧响应不许盖新态） | `src/client/use-trash-query.ts` | 服务端算的那个数 |
| 清单的选择面（多选态、勾选集合、组头三态派生） | `src/client/use-trash-selection.ts` | 谁能接住孩子（`src/trash/groups.ts`） |
| 动过回收站之后谁重读（失效通告台，只有一个修订号） | `src/client/trash-store.ts` | 动了什么、谁动的（清单本体永远问宿主） |
| 跨槽位现场脚手架（快照 / 订阅 / 每实例 seq / `reset`） | `src/client/store.ts` | 选择面语义（那是 `src/client/batch-selection-store.ts`）；各现场自己的初值与不变量 |
| 批量选择面（多选模式 / 勾选集合 / 追加与收缩） | `src/client/batch-selection-store.ts` | 页面上有哪些行、点行算不算选中（那是 `src/client/host-rows.ts`）；不读 DOM |
| 宿主行读取与整行点击守卫（可见行 / 全选判定 / 捕获阶段拦行点击） | `src/client/host-rows.ts` | 选中集怎么变（归 `src/client/batch-selection-store.ts`）；不拥有选择变更 |
| 回收站面板状态机（选中 / 详情缓存 / 行失败 / 确认派发 / 自动选中 / 下钻回退） | `src/client/use-trash-panel-controller.ts` | 布局（`src/client/trash-panel.tsx`）、取数（`src/client/use-trash-query.ts`）、选择面（`src/client/use-trash-selection.ts`） |
| 槽位贡献与注册 | `src/client/index.tsx` | 各贡献自己的渲染 |
| 现行界面规格（状态、布局、危险层级） | 本文 §3.1；像素/断点/文案键的唯一定义在 `src/client/` 与 `tests/client/` | 各状态的实现细节 |
| 抄来的官方控件样式（`sd-` 前缀）与点名的自造差异 | `src/client/ui/ui.css` 文件头那张来源表 | token 的取值 |

## 5. 数据与生命周期

- 运行时数据全住数据根（`~/.dsh/`）：会话本体 `sessions/<项目目录>/<会话目录>/`（宿主的），回收站本体 `session-trash/<条目 id>/` 与清册（宿主 storage 域，介质在 `storages/`）。**回收站必须与 `sessions/` 同卷**（搬移靠整目录 `rename`，原子）。
- **`session-trash/` 目录是唯一需要手动动的地方**：每次读清单都先与目录对账（多出的目录重建出行、目录没了摘行、认不出的当外人）；`storages/` 那份是内部索引，外面改它要重启宿主才生效。
- **清册只记文件里真有的事实**：随盘上随时变的数（还剩几个孩子、这次释放多少）一律现算现给、不落清册。
- **删除 = 移入回收站**（可恢复，不自动过期）；**彻底删除**（单条 / 一批 / 清空）与**无主子会话清理**是仅有的三条永久删除路径，都要二次确认。
- 会话日志是**多帧 zstd**：只读版本号最大的那代，绝不拼代（判据与用例住 `src/log/session-log.ts`、`src/log/zstd-frames.ts` 与 `tests/session-log.test.ts`、`tests/zstd-frames.test.ts`）。
- 附件是全局内容寻址的，与会话不是父子关系——删除不连坐、不回收。

## 6. 阅读路径建议

- 要改一条判据：`CONTEXT.md` 找术语 → 本文件第 4 节找主人 → 去那个符号头上读注释 → 查 `docs/adr/` 有没有对应裁决。
- 要加一个段名：`wire.ts` 加键 + `route-table.ts` 加一行（漏任一都是编译错误或测试红）——ADR-0004。
- 要改回收站里"这一组"的口径：只动 `src/trash/groups.ts`——ADR-0001；往动词里再写一遍就是重新引入那个已算出过两个答案的重复。
- 要改「彻底删除 / 孤儿清理删哪些目录、报多少字节、谁挡活体」：删除、字节与活体准入只动 `src/verbs/permanent-removal.ts`（计划只读、执行器只写）——ADR-0006；孤儿集合仍由 `src/verbs/orphan-subagents.ts` 的 `orphanGroupsOf` / `loadOrphanGroups` 扫出，组语义仍归 `src/trash/groups.ts`，通告仍归 `src/verbs/member-presence.ts`。
- 要给线上加一个字段：`wire.ts` 加必填 + `trash-rows.ts` 的 `toWire` 显式补一格（编译器会指路）——ADR-0003。
- 要改界面：先看本文 §3.1，再动 `src/client/` 与对应用例；像素、断点与文案键不在文档里抄第二份。
- 要判断某条实测边界（zstd 帧、宿主服务成员面、槽位名）：看代码判据与 `tests/`（zstd 走 `src/log/zstd-frames.ts` + `tests/zstd-frames.test.ts`）；历史证据在 git 历史。
