# dsh-session-delete — 给 agent 的工作须知

DSH 的「会话删除」插件。这里只放**跨改动复用的不变量**与**实现前必须先验的前提**；现状地图在 `docs/architecture.md`（含界面规格 §3.1），历史裁决在 `docs/adr/`，代码与测试是最终真相。

## 真相在哪（按顺序读）

1. **`docs/architecture.md`** — 现状地图：双半形态与通道、分层与依赖方向、槽位与探测、**唯一主人清单**（「这条语义该去哪改」的对照表）、数据与生命周期、阅读路径。动手前先在那张表里找到主人，别在第二处写判据。
2. **`docs/adr/`**（索引 `docs/adr/README.md`）— 难逆的裁决与被否决的替代：ADR-0001 组语义一个家、0002 batch/journal 分家、0003 线上形状的家与显式投影、0004 路由表是一条记录、0005 成员离场/归位通告一个家、0006 永久删除计划与执行一个家、0007 宿主端口三角色与语料缺席显式、0008 回收站与归档解耦。翻案先读它们再动。
   - **翻案怎么落字**：推翻**整篇**→ 在该篇头部把状态改成 `superseded` 并指向接手的篇号；只翻**其中一条**→ 不动正文，就地补一条带日期的「就地订正」括注，说清现在谁说了算（先例：ADR-0002 关于 `rollbackFailures` 合并归属那条）。编号只追加、别重排。
   - **引用历史写日期，别写批次号**：读者手上没有能查的批次坐标；引用一次改动写日期，有 commit 就带上，要指裁决就指 ADR 篇号。`tests/docs.test.ts` 钉住「不写批次号」这一半。
3. **代码与测试** — 最终真相。文档与代码冲突时以代码为准，并顺手把上面那处改正。批次账与实测证据不再另存日志；历史留在 git。

## 硬约束（本仓不变量）

- **客户端半的条目激活失败 = 宿主进程死**：桌面壳对"有客户端模块但没激活成功"走的是 `reportFatal(..., "web-boot")`，前端自检会 throw `web boot: N entry did not activate`——**不是 warn、不是静默 pending**。所以：**改动浏览器半后，先在有可见浏览器的隔离 home（镜像目标 profile 的插件组成）上验过，再装进任何 live profile**；只在没有页面的宿主上冒烟会漏掉这一类崩溃（宿主侧自己不报）。
- **`remote.<namespace>` 不是声明即得**：浏览器侧 `remote.<ns>` 只能由**生成的 Typert 描述符贡献**经 `ctx.remote.$mount(...)` 挂上；只在 client 半 `inject` 里写 `remote.<ns>`、却不发布生成的 `typert.host.js` / `typert.remote-client.js`（及对应 `exports`），插件会因拿不到该服务而在前端自检时致命失败。**实测结论（2026-09-30）：第三方没有动态发现这一步**——盒内 `$mount` 的清单写死在 `dsh-api-remotes` 里、全宿主搜 `'/remote'` 零命中，生成器又只认 `<root>/packages/<pkg>/` 的官方仓形 ⇒ 第三方只有两条路：**自挂自**（补生成物 + 自己 `$mount`）或**自建薄线**。本插件的通道走后者：宿主 web server 上的插件专属前缀路由 `/dsh-session-delete-api`（`src/api/dispatch.ts` ↔ 浏览器半 `src/client/remote.ts` 同源 fetch），信封与官方 unary 面同形，两侧共享 `src/shared/wire.ts` 的前缀/段名（**2026-10-19 起六个段名**：`GET /list`、`GET /ping`、`POST /detail`、`POST /apply`（**五个动作都走这一段**——`delete` / `restore` / `purge` / `count` / `orphan-clean`，一组 id 进、逐条结果出，单条就是长度为 1 的批量，**不留第二条执行路径**）、`POST /empty`、`GET /orphans`；`/orphans` 是纯读、不进串行链，`orphan-clean` 是写、进链。**加一个新段名改两处**：`wire.ts` 加键 + `src/api/route-table.ts` 加一行，漏任一都是编译错误或测试红，见 ADR-0004）。**状态语义**：请求本身不对用它自己的 4xx（400 请求体 / 405 方法 / 404 未知路由，栅栏拒 403），**操作失败**回 200 + 信封——别把这两类混成一个 200。
  - **自建薄线的同源栅栏必须认得桌面壳那条路（实测）**：桌面壳 `forwardWebRequest` 转发前删掉 `host`/`origin`/`cookie`/`sec-fetch-site` 四个头 ⇒ 真机到插件路由的请求**没有 `Origin`**、只有 `Referer: dsh-app://app/`；漏认它 = 真机上探测永远 403、所有入口一个都不出现，**而 headless 直连 http 的过门读数完全看不出来**（那条路是同源、本就放行）。判据按 `protocol` + `host` 比：`dsh-app:` 不是 special scheme，`new URL('dsh-app://app/').origin` 是字符串 `"null"`，比 `URL.origin` 永远为假。
- **会话列表不是磁盘投影——摘账本挡不住活体**（实测 2026-09-30 真机）：分组面 =「会话列表 × 工作区账本」，而列表是**并集**——`sessionQuery.listSessions()` = 磁盘上的持久化 **∪** `ctx.sessions` 里 attach 着的**活体会话**（本机运行期打开过/发过消息的就是活体，`session.list` 对活体直接取内存摘要）。所以搬走文件 + 摘账本只能清掉冷会话；活体会话仍会被列出来，而账本一摘它就"无主" ⇒ 客户端 `groupByWorkspace` 把它收进 `workspaceId === undefined` 那一组，标签是宿主的 `group.ungrouped` =「未分组」。**不要把归档当回收站的实现**（2026-10-21）：删除不调 `archiveSession`；回收站与归档是两套状态。`HostPort.evictLive` 把 **session 和 agent 一起**摘掉——`ctx.agents.resume/create` 返回的 `AgentHandle` 带宿主自己的 per-agent teardown（关写句柄、摘 agent/session），`SessionController` 把它丢掉；`createHostPort` **等 `agents` 服务就绪后**（`ctx.inject(['agents'])`；live profile 里它可能晚于插件激活）在 `ctx.agents` 上包一层按会话 id 留住 handle，删除时 `entry.detach()` 后 `await handle.dispose()`。然后发 `api-session/removed`；冷会话没有活体可摘，通告照样必须发。恢复走冷 resume；旧清单里 `wasArchived:false` 但盘上仍归档的条目只做一次迁移式 unarchive，新删除不归档；用户原本归档的保持归档。**没有捕获到 handle 的 agent**（插件激活前已启动的配置 agent / `ctx.agents` 形状变化）只能摘 session，这是已知残留限制，不拿归档当兜底。细节与裁决见 `src/ports/host-port.ts`、`src/verbs/delete-session.ts`、`src/verbs/restore-session.ts` 与 ADR-0008。
- **无主子会话维护只走官方面**（2026-10-19 `f2a7757`）：扫描用 `ctx.get('sessionQuery').listSessions()`（live ∪ persisted），只认 `origin:"subagent"` 且父既不在语料也不在回收站清册的根；清理按传递闭包、逐条 `isLive`，永久删除（**不搬进回收站**）、**不自动**跑。投影缓存与附件不在清理范围（宿主没有公开删除面/引用计数）。判据见 `src/verbs/orphan-subagents.ts` 与对应用例；存量读数不再抄进文档。
  - **回执与路径**（同日 `f2a7757` 的评审修正）：清理回执按组；`not-found` 在界面单列「已不在了」，不计入「N 组未清理」；**删目录阶段**失败在 `error.details` 带 `{removed, freedBytes, failedSessionId}`，更早的 `unarchive` / `detach` 一步不套回执（purge 折成带标签的 `io`、orphan-clean 原样抛出，都不带 details）。`sessionDirOf` / `trashDirOf` 只接受**单段** id/项目名（`restore` 取项目根用的空 `sessionDirName` 是唯一例外），任何盘上删除前都要过这道闸。
  - **`sessionQuery` 缺席**：`purge` 只能清清册里的那部分，盘上后代留给 `GET /orphans` 兜底（与 delete 的降级一致）；`/orphans` 本身则必须响亮失败，绝不拿零条假报告冒充。
- **一条事实只住一个家**（2026-10-19 `f2a7757`；词表与对照表在仓根 `CONTEXT.md`，裁决在 `docs/adr/0001..0008`）：组语义（谁能接住孩子、这一组有谁、谁已被同批带走）只住 `src/trash/groups.ts`；「这一批」只住 `src/verbs/batch.ts`（去重保序 / 清册快照 / 已带走账本 / 逐条信封 / 一批一次通告）；**成员离场/归位通告只住 `src/verbs/member-presence.ts`**（批量通告仍在 `src/verbs/batch.ts`）；一次成员移动的步骤与反向动作只住 `src/verbs/member-journal.ts`；**永久删除的计划与执行只住 `src/verbs/permanent-removal.ts`**（只读计划 + 执行器；journal 不参与——永久删除没有反向动作）；段名的方法 / 纯度 / body 只住 `src/api/route-table.ts`；线上形状、失败码与回收站目录名只住 `src/shared/wire.ts`（行投影是 `src/api/trash-rows.ts` 的 `toWire`：显式字面量、不 `...row`）；**宿主能力的三个角色切面、`evictLive` 的 agent handle 捕获与语料缺席的形状（`CorpusRead`）只住 `src/ports/host-port.ts`**（缺席之后怎么办归调用方）。**加一处新判据之前先看 CONTEXT.md 那张表**——这几条都是"同一个概念曾经在四处各算一遍"拆出来的，别再加第五处。
- **工作区账本缺席不是恢复失败**（2026-10-17 `6d4c61a`）：宿主的「删除工作区」只删**注册**、保留目录与每一份会话日志（0.2.0-rc.2 `WorkspaceRegistry.delete` 的 JSDoc 原文 "retaining its directory and every session log"），那些会话本来就在「未分组」下。回收站里**删在工作区之前**的条目记着的 `workspaceId` 可能已经没有对应工作区 ⇒ 恢复照常回盘、跳过 `attach`（`HostPort.workspaceExists` 判），清单行在点之前说一句「原工作区已不存在，恢复后归入未分组」。**那句与"到底挂不挂账本"必须是同一条判据**（`src/verbs/restore-session.ts` 的 `attachableWorkspaceId` 与由它派生的 `isWorkspaceMissing`）——在装配处另写一遍极性相反的判据，早晚会出现"行上说归入未分组、动词却照样去挂（或反之）"。**attach 的兜底只认端口那句**（`isWorkspaceMissingError`，原话前缀住在 `src/ports/host-port.ts`）：工作区恰好缺席时别的失败照旧回滚报 `io`，不给存储故障伪装成「未分组」的机会。**别把它做成 `project-missing`**：`sessions/<projectDir>` 不在仍然是硬拒绝、绝不静默建目录——那是数据根里的会话落点（可能是盘没挂 / 数据根换了），工作区账本只是可选归属。判据与替代方案住 `src/verbs/restore-session.ts` 与 `src/ports/host-port.ts`，不在文档里另写一遍。
- **宿主要求只有一个声明处：顶层 `engines.dsh`**（2026-10-19 `4bae4aa` 起）：宿主的判据是——清单声明了 `engines.dsh` 时**只由该范围决定、`peerDependencies` 被忽略**；没有它才逐条比对 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer（预发布版本参与匹配）。
  - 本插件的窗口是 `>=0.1.7-rc.2 <0.3.0-0`。地板 = **完整功能**的最低代次：`0.1.7-rc.2` 是 2026-10-19 CLI 台架验过的四槽位齐全、激活零错误、ping 通，**台架读数不进 `dshReleases`**；`0.1.7-rc.1` 缺 `sidebar.session.row.leading`，`0.1.5-rc.1` 起三个会话行槽位全缺。天花板 = 下一条线的起点；`<0.3.0` 在预发布语义下挡不住 `0.3.0-alpha`，必须 `<0.3.0-0`。
  - **`@deepseek-ai/dsh*` 那一类 peer 保持零条**——宿主要求写在 `engines.dsh` 一处，两个家迟早写出两种结论。清单里仍声明的 `@deepseek-ai/cordis` 与 `react` **不是**宿主要求：安装闸与商店牌子都不把它们算进去（见下面「`dsh-*` peer 若将来确要加」那条）。
  - `tests/skeleton.test.ts` 钉住：窗口盖住全部真机代次、地板对上台架下界、不越过下一条线、≤256 字符、不在 `dsh.engines` 另写一份、没有 `dsh-*` peer。
  - **`dsh.compatibility.dshReleases` 是账本不是闸**：只列**真跑过**的宿主、状态词只许 `compatible`（`tests/skeleton.test.ts` **双向**钉：实测过的全在册、在册的全属实测过）；宿主与市场**都不读它**（桌面 asar 与 dsh-market 源码里 `dshReleases` 零命中），它永远不会让商店里那块「未声明宿主要求」消失。**在册说的是"哪份产物"**：`version` 没随这批前移时，新加的代次与 `engines.dsh` 都要等下一次发布才落到 npm 产物上；发版后现查 npm `latest`，别把某次读数写死在这里。
  - **商店的牌子读的是 npm `latest` 清单**（dsh-market `discovery-compatibility.ts`）：`engines.dsh` ?? `dsh.engines.dsh`，加上 `@deepseek-ai/dsh*` peer（cordis / schemastery 被明确排除）；**任何范围串超过 256 字符会被整条丢弃**（261 字符的 `dsh-tools` peer 就这么丢过），有效声明为零 ⇒「未声明宿主要求」。awesome 的 `index.json` 只带**顶层** `engines.dsh`（每晚 probe 读 npm 清单）⇒ 顶层是唯一能同时点亮两处的写法。
  - **`dsh-*` peer 若将来确要加**：那是 npm 的解析面——`dsh plugin add` 会逐项比对，semver 预发布规则下没有"免维护写法"，区间只能逐代显式开口（`@deepseek-ai/cordis`、`react` 不在闸内，写多宽都不影响装机）。本插件 2026-10-02 起一条都没有（控件自造，见下条）；**编译所依与 peer 声明同范围**（实际解析版本由锁文件钉住）。
- **浏览器半不许 import 任何宿主客户端包**（2026-10-02 起）：官方给第三方 UI 插件的规则是 "Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client package as a module"——它们随宿主换代而变、不过类型检查，一个抛错的组件会把整个槽位条目打空（控制台 `slot entry crashed in '<slot>'`）。要用的控件/图标**已按官方处方抄进 `src/client/ui/*`**（类名 `sd-` 前缀、`@keyframes` 改名、只留 `--dsw-*` token）。
  - **来源表与已知差异只住 `src/client/ui/ui.css` 文件头那一处**（那里点名的差异有一类实现落在别的文件，以文件头那句为准）。张数、自造条数、"214 条 / 六个模块"那类计数一律不抄进任何文档——抄一次就多一个会腐烂的镜像（这条在本仓被验证过两次）。
  - 改动那层后按 `docs/developing.md` 的界面保真复核门：与官方明文**逐属性比对零差异**；差异只允许文件头点名的那几类（前缀、`@keyframes` 改名、点名的自造与已声明的差别），再加两档几何重量。
  - **`tsdown.config.ts` 的 `PLATFORM_MODULES` 是纯度门白名单，只列真正在用的**——多留一个键就是多留一个"再 import 一次"的口子。
- **浏览器半可以 inline 非宿主的 npm 依赖，但那条链要自己建栅栏**（2026-10-15 加）：`react-markdown` + `remark-gfm` 落在 `dependencies`（**不是** `peerDependencies`，也**不进** `PLATFORM_MODULES`——那两个键与宿主无关，构建期由 `alwaysBundle` 整条打进 `lib/client.js`）。代价实测（**构建产物读数按当前构建现测，不抄进文档**，免得两处数字对不上）：产物里第三方占绝对大头，gzip 后仍在六位数下半段。**坑（真撞过一次）**：`unified → vfile` 用 `package.json` 的 `imports` 分流 Node/浏览器两套实现（`#minpath: { node: …, default: ….browser.js }`），而 CJS 输出下 rolldown **按 Node 条件解这张图**（把 `'require'` 从 `conditionNames` 摘掉试过，不改变结果：条件是解析器自己加的），于是 `node:path`/`node:url`/`node:process` 闯进浏览器半、被 `gateClientImport` 挡在构建期。处置住在 `tsdown.config.ts` 的 `resolveBrowserBranchImport`：只认那三个 `#` 请求，且**同级真有 `.browser.js` 才接**，否则返回 `null` 让纯度门重新响——**以后再引一条带 `imports` 分流的依赖，照这条办，别改 `PLATFORM_MODULES`**。判据见 `docs/developing.md` 的纯度门与 `tsdown.config.ts` 的 `resolveBrowserBranchImport`（产物读数现测，不抄）。
- **跨插件一律 `import type`**，值 import 是与生态的红线；浏览器半更是**一条 `@deepseek-ai/*` 的 import 都不许有（type-only 也不留）**，宿主那侧的类型面全靠本地窄镜像（`src/client/context.ts`）。
- **客户端可见文案住 `src/client/copy.ts` 的命名空间字典**，经 `ctx.get('locale')` **可选读**宿主 locale 服务（**不进客户端条目的 `inject`**——`src/client/index.tsx` 导出的那份只列 `slots`；条目 pending = 宿主进程死），服务缺席降级到内置 zh；宿主的 `register` 对象形式要求 `zh`/`en` 两套键集合逐字相同。
  - **别把 `package.json` 的 `dsh.client.inject` 当成上面那份**：那是 manifest 侧的另一张表（`tests/skeleton.test.ts` 钉它只列 web 组合花名册里真实存在的 client 包，现在就是 `@deepseek-ai/dsh-client-locale` 一条），它不让条目 pending，所以 locale 出现在那里与本条不矛盾。
  - **`locale/zh.json` / `locale/en.json` 是第三样东西**：插件自己的展示元信息（`meta.title` / `meta.description`，随 `files` 发布），与界面文案字典 `copy.ts` 无关；侧栏那一行的名字走的是 `copy.ts` 的 `trash.title`，不是这里。
- **宿主类型面用本地窄镜像**（只声明用到的成员 + 一次强转），**不装宿主类型包、不做 `declare module` 增强**：npm 上的宿主包与运行中的宿主不同代，引包等于拿错了契约；`extends Context` 还会撞 TS2717。
- **工具名/服务名带插件专属前缀**：宿主对重名**直接抛错**（不是显示难看，是整个工具面挂掉）。
- **槽位只挂官方已声明的**：向未声明槽位注册、或重复声明别人已拥有的 child，都会在**插件激活时**失败——所以撞槽位是响亮失败，不是静默降级。
- **`lib/` 是构建产物，不入库**；从源码目录链进 profile 的安装方式不会替你构建它。三条分发路各自的构建责任：`link:` 要你自己 `pnpm build`；**发布 npm 由 `prepack` 兜**（`package.json` 的 `prepack: npm run build`，`npm|pnpm publish` 与 `npm|pnpm pack` 四条路都会跑）；**git 直装完全没有构建**（本仓不提供 `prepare`，所以那条路现在是死的——要用先补 `prepare`）。
  - **`build` 是两步，顺序不能反**：`tsdown && tsc -p tsconfig.build.json`——tsdown 出台面 JS（Node 半那条配置带 `clean: true`，会先把整个 `lib/` 抹掉），tsc 出官方要求的 `lib/types/**/*.d.ts`（`emitDeclarationOnly`；tsdown 自带的 `lib/index.d.ts` 是官方点名不要的"根声明文件"，已关）。`types` / `exports["."].types` / `exports["./client"].types` 都指向 `lib/types/`。
  - **`files` 是精确清单，不列整目录 `lib`**（官方不变式：不发布 `src`、声明映射、JS map）。所以**构建每新多出一个要发布的产物，就得同时加进 `files`**——否则 npm 装出来的包缺那个文件，而 `link:` 装法一切正常（这条路测不出来）。`lib/client.js.map` 就是这样被留在盘上、不进包的。

## 实现前必须先验的前提

- 实现前先验的前提：宿主公开面以 `src/ports/host-port.ts`、`src/client/index.tsx` 与 `docs/architecture.md` §4 为准；不要从历史日志抄成员面与槽位名。

## 环境坑

- **运行时数据不在本仓**：会话本体 `~/.dsh/sessions/<转义cwd>/<会话目录>/session.vN.jsonl.zstd`；账本与缓存 `~/.dsh/storages/`；回收站在 `~/.dsh/session-trash/`。会话文件是 zstd 压缩的 JSONL，**第一行即 header**（含 `id` 与 `cwd`）。**一个目录里可以并存多代日志（宿主换代把老代留在原地），新代是老代迁移后的超集 ⇒ 只读版本号最大的那代，拼代会重复计数**（判据与用例见 `src/log/session-log.ts` 的 `pickSessionLog` 与 `tests/session-log.test.ts`）。**手工动回收站只动 `~/.dsh/session-trash/`**：清单在每次读清单时与目录对账（多出的目录重建出行、目录没了摘行、认不出的当外人；口径与代价见 `src/trash/reconcile.ts` 与对应用例）——`~/.dsh/storages/` 那份是**内部索引，不用手碰**，且它住宿主 storage 域、**打开时装一次快照** ⇒ 外面改那份要重启宿主才生效。
- **但"用 `zlib.zstdDecompressSync` 直接读会话文件"读不全（2026-10-15 实测更正）**：日志是一次次 append 出来的**多帧** zstd 流，而 Node 的 `zstdDecompressSync` **与** `createZstdDecompress()` 流式**都只给第一帧**（本机一条 3.8 MB 的文件，两个 API 都只回 209 字节 = header 那一行）⇒ 必须自己按帧头与 3 字节块头走帧。**踩坑点**：实测 `descriptor` 恒 `0x04`（单段、无字典、**校验位没置位**），却**每一帧尾都多 4 字节** ⇒ 按规范那一位决定"读不读校验和"会算错边界，得按实测（"跳 4 字节后必须撞上 magic 或到 EOF"）。在 125 个文件 / 36 904 帧上与"扫 magic"逐帧一致、解压零失败；判据与完整量见 `src/log/zstd-frames.ts` 头注与 `tests/zstd-frames.test.ts`。
- **改动的生效路径分两半**：浏览器半走宿主 HMR；Node 半必须重启宿主。
- **验证要有界**：冒烟启动宿主时日志里那行带 token 的 URL 是活的凭据，别留在日志或会话输出里，测完删文件。

## Agent skills

### Issue tracker

工单住在本仓的 GitHub Issues（用 `gh` CLI）。见 `docs/agents/issue-tracker.md`。

### Triage labels

五角色用默认标签串：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文（仓根一份 `CONTEXT.md` + `docs/adr/`）。见 `docs/agents/domain.md`。
