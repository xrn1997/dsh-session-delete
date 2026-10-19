# 架构与形状

这份文档只回答两个问题：**系统分成哪几块、为什么这么切；某条语义的主人在谁头上**。它是 explanation——给读懂代码提供地图，不给代码充当副本。

不在这里的东西，各有各的家：**术语**在 `CONTEXT.md`（词表）；**难逆的裁决与被否决的替代**在 `docs/adr/`（索引见 `docs/adr/README.md`）；**用户可见的事实**在 `README.md`；**构建、门控与发版**在 `docs/developing.md`；**按批次的判据账与真机读数**在两份 `docs/design/` 日志（`2026-09-30-session-delete-design.md` 与 `2026-10-15-trash-detail-design.md`——那两份是**时间线日志**，末尾按批追加；与代码冲突时以代码为准）；**"怎么做"**在代码自己。这里一条读数都不列——列了就是第二份抄本，且必然腐烂。

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

- **通道是自建薄线，不是官方 `remote.<namespace>`**：第三方拿不到 Typert 描述符的挂载点（判据与实测住设计稿第十二批），所以走宿主 web server 上的插件专属前缀路由 `/dsh-session-delete-api`——`src/api/dispatch.ts` ↔ `src/client/remote.ts` 同源 fetch，信封与官方 unary 面同形（`{ok:true,value}` / `{ok:false,error:{code,message,details?}}`）。
- **段名只有六个**（`src/shared/wire.ts`）：`GET /list`、`GET /ping`、`POST /detail`、`POST /apply`、`POST /empty`、`GET /orphans`。写动作全部走 `POST /apply`（`delete` / `restore` / `purge` / `count` / `orphan-clean`），一组 id 进、逐条结果出，**单条就是长度为 1 的批量，不留第二条执行路径**。
- **同源栅栏认得桌面壳那条路**：壳转发前删掉 `host`/`origin`/`cookie`/`sec-fetch-site` ⇒ 真机请求没有 `Origin`、只有 `Referer: dsh-app://app/`（实测判据住 `src/api/dispatch.ts`）。
- 改动生效分两条路：浏览器半靠宿主 HMR 热推；Node 半必须重启宿主。
- **浏览器半一条 `@deepseek-ai/*` 的 import 都不许有**（type-only 也不留）：宿主客户端包随宿主换代而变、不过类型检查，一个抛错的组件会把整个槽位条目打空。要用的控件/图标按官方处方抄进 `src/client/ui/*`（类名 `sd-` 前缀、`@keyframes` 改名、只留 `--dsw-*` token），来源表在 `ui.css` 文件头。

## 2. Node 半的分层与依赖方向

```
ports/     宿主能力的唯一适配（HostPort / FsPort）
   ▲
trash/  ·  log/          ← 领域部件：条目形状、清册对账、组语义、日志走帧
   ▲
verbs/     动词：delete / restore / purge / orphan-clean + batch + member-journal
   ▲
api/       两个投影面里的那个 Node 面：路由表 + dispatch + 行投影
   ▲
index.ts   组合根：装配、注册（前缀路由 / 槽位 / effect）
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

## 4. 唯一主人清单

某条语义"该去哪改"的对照表。写第二份之前先查这里（`CONTEXT.md` 的「一条事实只住一个家」是这张表的词表版；两者冲突时以代码为准）。

| 语义 | 唯一主人 | 它不回答什么 |
| --- | --- | --- |
| 段名 / 线上形状 / 失败码 / 回收站目录名 | `src/shared/wire.ts` | 业务判据 |
| 段名的方法 / 纯度 / body 预读 | `src/api/route-table.ts` | 怎么处理 |
| 清册行 → 线上行的投影 | `src/api/trash-rows.ts` 的 `toWire`（显式字面量，不 `...row`） | 组语义 |
| 组语义（谁能接住孩子、这一组有谁、谁已被同批带走） | `src/trash/groups.ts` | 步骤与回滚 |
| 「这一批」（去重保序 / 清册快照 / 已带走账本 / 逐条信封 / 一批一次通告） | `src/verbs/batch.ts` | 单条动词的步骤 |
| 一次成员移动的步骤与反向动作（含 `details.rollbackFailures` 合并） | `src/verbs/member-journal.ts` | 哪些成员算一组 |
| 条目 id 的形状与路径闸（单段校验） | `src/trash/entry.ts` | 对账 |
| 清册与 `session-trash/` 目录的对账 | `src/trash/reconcile.ts` | 目录里读哪一代日志 |
| 会话日志的选代与走帧（多帧 zstd） | `src/log/session-log.ts` + `src/log/zstd-frames.ts` | 正文该显示什么 |
| 恢复时「挂不挂账本」与那句「归入未分组」 | `src/verbs/restore-session.ts` 的 `attachableWorkspaceId` / `isWorkspaceMissing` | 工作区还在时的挂接失败 |
| 宿主能力的唯一适配（活跃检查、归档、账本、通告、语料） | `src/ports/host-port.ts` | 各动词的调用顺序 |
| 无主子会话的扫描与清理判据 | `src/verbs/orphan-subagents.ts` | 回收站里的组 |
| 失败码的措辞与映射（码住 `wire.ts`） | `src/verbs/errors.ts` + `src/remote/map-error.ts` | 上屏文案 |
| 同源栅栏（桌面壳那条只留 Referer 的路） | `src/api/dispatch.ts` | 操作失败的信封（那是 `map-error`） |
| 客户端可见文案 | `src/client/copy.ts` | 服务端错误原文 |
| 槽位贡献与注册 | `src/client/index.tsx` | 各贡献自己的渲染 |
| 抄来的官方控件样式（`sd-` 前缀）与点名的自造差异 | `src/client/ui/ui.css` 文件头那张来源表 | token 的取值 |

## 5. 数据与生命周期

- 运行时数据全住数据根（`~/.dsh/`）：会话本体 `sessions/<项目目录>/<会话目录>/`（宿主的），回收站本体 `session-trash/<条目 id>/` 与清册（宿主 storage 域，介质在 `storages/`）。**回收站必须与 `sessions/` 同卷**（搬移靠整目录 `rename`，原子）。
- **`session-trash/` 目录是唯一需要手动动的地方**：每次读清单都先与目录对账（多出的目录重建出行、目录没了摘行、认不出的当外人）；`storages/` 那份是内部索引，外面改它要重启宿主才生效。
- **清册只记文件里真有的事实**：随盘上随时变的数（还剩几个孩子、这次释放多少）一律现算现给、不落清册。
- **删除 = 移入回收站**（可恢复，不自动过期）；**彻底删除**（单条 / 一批 / 清空）与**无主子会话清理**是仅有的三条永久删除路径，都要二次确认。
- 会话日志是**多帧 zstd**：只读版本号最大的那代，绝不拼代（判据与实测住 10-15 稿 §1.1 / §1.4）。
- 附件是全局内容寻址的，与会话不是父子关系——删除不连坐、不回收。

## 6. 阅读路径建议

- 要改一条判据：`CONTEXT.md` 找术语 → 本文件第 4 节找主人 → 去那个符号头上读注释 → 查 `docs/adr/` 有没有对应裁决。
- 要加一个段名：`wire.ts` 加键 + `route-table.ts` 加一行（漏任一都是编译错误或测试红）——ADR-0004。
- 要改回收站里"这一组"的口径：只动 `trash/groups.ts`——ADR-0001；往动词里再写一遍就是重新引入那个已算出过两个答案的重复。
- 要给线上加一个字段：`wire.ts` 加必填 + `trash-rows.ts` 的 `toWire` 显式补一格（编译器会指路）——ADR-0003。
- 要判断某条实测边界（zstd 帧、宿主服务成员面、槽位名）：去 `docs/design/` 两份日志按批查；结论落成代码判据后，日志里那条就只是历史。
