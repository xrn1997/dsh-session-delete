# dsh-session-delete — 给 agent 的工作须知

DSH 的「会话删除」插件。需求的来由、已定的选择与实测边界都在设计稿里，这里只放**跨改动复用的不变量**与**实现前必须先验的前提**。

## 真相在哪（按顺序读）

1. **`docs/design/2026-09-30-session-delete-design.md`** — 现状设计：五个触点、边界、错误形状、验证门、已定的选择与被否决的替代。**§7 就是界面规格**（六个状态与它们的结构/层级），本仓不另存像素稿。
2. **`docs/design/2026-10-15-trash-detail-design.md`** — 回收站「两栏形态 + 单条会话详情」，已落地后**按批次往后追加**：§1–§5 是详情那批的实测与判据（多帧 zstd 的形态分布、`source.kind` 过滤、选中态 token、断点的量化理由），§6/§6.1 是真机回退与「渲 Markdown + 抄宿主样式」，**§7 是清单那一列自己可以收**（组折叠 / 一键展开收起 / 拖分栏 / 多选批量删，含 330 下限的量尺；曾有的「整条左栏收起」已按用户裁定删除，判据见现状稿 §10），§8 是空态的居中链（两栏改造碰坏的回归），**§9 是清单对账**（`session-trash/` 目录是唯一需要手动动的地方；`list` = 对账 + 读），**§10 是清单行上的两个只读数**（宿主客户端把 `origin:"subagent"` 的行整排藏了，连「未分组」那一桶也过滤 ⇒ 删了父还剩多少本来看不见；「含 N 个」说的是跟着进来的，「盘上还剩 M 个」说的是没带走的，两个数来源不同、不许互相冒充），**§11 是级联**（删除/恢复/彻底删除都**按组**走：父与它在盘上的孩子各占一格目录、各一行清册，孩子那行记 `parentEntryId`；任一成员在跑⇒整组拒绝零副作用，搬不动⇒已搬的整组退回；身份只认 `header.id`；**接得住孩子的只有根行**——父行不在或父行自己也是孩子时，孩子必须自己占一行，否则它的字节会被页脚数两遍），**§12 是五张票的收口批**（组 = **传递闭包**而不是直接孩子：`kind:'parent'` 一次问一层、问到问空为止，宿主调用次数由层数决定与行数无关，官方 `traceSession` 在父已进回收站时够不到；「这次会释放多少」与页脚共用 `releaseBytesOf`；删除确认框在点之前先说「含 N 个子会话」，为此开**第六个端点** `POST /subagent-count`，它是纯读、不进那条串行链，读不到就整句不说）。"对面比我们强的三格"里投影缓存与 spill 两格同日判为**不做**（理由在 §10 末尾那本账）。想知道界面现在长什么样，读现状稿 §7（那份的 §4 与 §2/§6/§7/§8/§10 已随这几批更新；**产物 kB 读数只住现状稿 §8 那本账**）。
3. **代码与测试** — 最终真相。文档与代码冲突时以代码为准，并顺手把上面那处改正。

## 硬约束（本仓不变量）

- **客户端半的条目激活失败 = 宿主进程死**：桌面壳对"有客户端模块但没激活成功"走的是 `reportFatal(..., "web-boot")`，前端自检会 throw `web boot: N entry did not activate`——**不是 warn、不是静默 pending**。所以：**改动浏览器半后，先在有可见浏览器的隔离 home（镜像目标 profile 的插件组成）上验过，再装进任何 live profile**；只在没有页面的宿主上冒烟会漏掉这一类崩溃（宿主侧自己不报）。
- **`remote.<namespace>` 不是声明即得**：浏览器侧 `remote.<ns>` 只能由**生成的 Typert 描述符贡献**经 `ctx.remote.$mount(...)` 挂上；只在 client 半 `inject` 里写 `remote.<ns>`、却不发布生成的 `typert.host.js` / `typert.remote-client.js`（及对应 `exports`），插件会因拿不到该服务而在前端自检时致命失败。**实测结论（2026-09-30）：第三方没有动态发现这一步**——盒内 `$mount` 的清单写死在 `dsh-api-remotes` 里、全宿主搜 `'/remote'` 零命中，生成器又只认 `<root>/packages/<pkg>/` 的官方仓形 ⇒ 第三方只有两条路：**自挂自**（补生成物 + 自己 `$mount`）或**自建薄线**。本插件的四个动词与两条纯读（单条详情、删除前那次计数）走后者：宿主 web server 上的插件专属前缀路由 `/dsh-session-delete-api`（`src/api/dispatch.ts` ↔ 浏览器半 `src/client/remote.ts` 同源 fetch），信封与官方 unary 面同形，两侧共享 `src/shared/wire.ts` 的前缀/段名（**六个段名一一对应六个面**，加一段就改这一处）。
  - **自建薄线的同源栅栏必须认得桌面壳那条路（实测）**：桌面壳 `forwardWebRequest` 转发前删掉 `host`/`origin`/`cookie`/`sec-fetch-site` 四个头 ⇒ 真机到插件路由的请求**没有 `Origin`**、只有 `Referer: dsh-app://app/`；漏认它 = 真机上探测永远 403、四个入口一个都不出现，**而 headless 直连 http 的过门读数完全看不出来**（那条路是同源、本就放行）。判据按 `protocol` + `host` 比：`dsh-app:` 不是 special scheme，`new URL('dsh-app://app/').origin` 是字符串 `"null"`，比 `URL.origin` 永远为假。
- **会话列表不是磁盘投影——摘账本挡不住活体**（实测 2026-09-30 真机）：分组面 =「会话列表 × 工作区账本」，而列表是**并集**——`sessionQuery.listSessions()` = 磁盘上的持久化 **∪** `ctx.sessions` 里 attach 着的**活体会话**（本机运行期打开过/发过消息的就是活体，`session.list` 对活体直接取内存摘要）。所以搬走文件 + 摘账本只能清掉冷会话；活体会话仍会被列出来，而账本一摘它就"无主" ⇒ 客户端 `groupByWorkspace` 把它收进 `workspaceId === undefined` 那一组，标签是宿主的 `group.ungrouped` =「未分组」。**宿主没有"让内存忘掉一个活体会话"的官方面**（`ctx.sessions` 只公开 `get/list/create/fork/…`；`ctx.agents` 的 handle 同理归创建者）⇒ **要把它从分组面藏掉只有归档一条路**（`archiveSession` 的官方注释即 "Hide one known Session from Workspace grouping surfaces"；客户端按 `archivedFilter` 先过滤归档会话）；**要把它从客户端那一行删掉，靠的是两条"如实通告"**：摘活体（`ctx.sessions.get(id)` → `liveEntryFor(session).detach()`，触点 ⑤）+ 发宿主自己声明并转发的 `api-session/removed` / `api-session/added`（本仓仅有的两处内部入口；cordis 的 event 派发只在 emit 带 carrier 时才过滤监听者，所以不带 carrier 的 emit 会全量到转发器）。**冷会话没有活体可摘，通告照样必须发**——否则那一行要等到重连（`handleConnected` → 重列）才消失。细节与代价见设计稿 §4 末。
- **`peerDependencies` 是宿主的安装闸，不是自述**：`dsh plugin add` 拿运行中的宿主版本逐项比对插件的 `@deepseek-ai/dsh*` peer 区间，不满足即拒绝并回滚 ⇒ 区间只能逐代显式开口，semver 预发布规则下没有"免维护写法"；`dsh.compatibility.dshReleases` 只列**真跑过**的宿主、状态词只许 `compatible`；编译所依用精确版本。**两层的分工别混**：混了就会出现"声明兼容却装不进去"。
  - **闸只认 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 这两类 peer**（实测原文：`evaluatePluginCompatibility` 里 `if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue`）⇒ `@deepseek-ai/cordis`、`react` 写多宽都不影响装机，而**任何一条 `dsh-*` peer 都等于把插件钉在那一代**。本插件 2026-10-02 起**一条都没有**（控件自造，见下条），`tests/skeleton.test.ts` 把这条钉成可判用例。
- **浏览器半不许 import 任何宿主客户端包**（2026-10-02 起）：官方给第三方 UI 插件的规则是 "Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client package as a module"——它们随宿主换代而变、不过类型检查，一个抛错的组件会把整个槽位条目打空（控制台 `slot entry crashed in '<slot>'`）。本插件要用的控件/图标**已按官方处方抄进 `src/client/ui/*`**（类名 `sd-` 前缀、`@keyframes` 改名、只留 `--dsw-*` token），改动那层后按 §8 门 4 复核：与官方明文**逐属性比对零差异**，来源表以 `src/client/ui/ui.css` 文件头那份为准（2026-10-15 起是九张官方 `.module.css`）；差异只允许三类——类名 `sd-` 前缀、`@keyframes` 改名、文件头点名的**那两处自造**（`.sd-resizing`；行的 `[data-dsh-session-delete="trash-row"]:focus-visible`）与一处已声明的差别（把手那条短线由 JS 侧 pointer capture 承担）。**声明条数不再钉进文档**（上一版钉的是"214 条 / 六个模块"，抄写的表一多它就变成假基线），再加上两档几何重量。**`tsdown.config.ts` 的 `PLATFORM_MODULES` 是纯度门白名单，只列真正在用的**（现在是 React 家族三个键）——多留一个键就是多留一个"再 import 一次"的口子。
- **浏览器半可以 inline 非宿主的 npm 依赖，但那条链要自己建栅栏**（2026-10-15 加）：`react-markdown` + `remark-gfm` 落在 `dependencies`（**不是** `peerDependencies`，也**不进** `PLATFORM_MODULES`——那两个键与宿主无关，构建期由 `alwaysBundle` 整条打进 `lib/client.js`）。代价实测（**读数只住在设计稿 §8**，这里不再复述具体 kB，免得又一次构建后两处数字对不上）：产物里第三方占绝对大头，gzip 后仍在六位数下半段。**坑（真撞过一次）**：`unified → vfile` 用 `package.json` 的 `imports` 分流 Node/浏览器两套实现（`#minpath: { node: …, default: ….browser.js }`），而 CJS 输出下 rolldown **按 Node 条件解这张图**（把 `'require'` 从 `conditionNames` 摘掉试过，不改变结果：条件是解析器自己加的），于是 `node:path`/`node:url`/`node:process` 闯进浏览器半、被 `gateClientImport` 挡在构建期。处置住在 `tsdown.config.ts` 的 `resolveBrowserBranchImport`：只认那三个 `#` 请求，且**同级真有 `.browser.js` 才接**，否则返回 `null` 让纯度门重新响——**以后再引一条带 `imports` 分流的依赖，照这条办，别改 `PLATFORM_MODULES`**。判据与读数见设计稿 §8 与 `docs/design/2026-10-15-trash-detail-design.md` §6.1。
- **跨插件一律 `import type`**，值 import 是与生态的红线；浏览器半更是**一条 `@deepseek-ai/*` 的 import 都不许有（type-only 也不留）**，宿主那侧的类型面全靠本地窄镜像（`src/client/context.ts`）。
- **客户端可见文案住 `src/client/copy.ts` 的命名空间字典**，经 `ctx.get('locale')` **可选读**宿主 locale 服务（**不进 `inject`**：客户端条目 pending = 宿主进程死），服务缺席降级到内置 zh；宿主的 `register` 对象形式要求 `zh`/`en` 两套键集合逐字相同。
- **宿主类型面用本地窄镜像**（只声明用到的成员 + 一次强转），**不装宿主类型包、不做 `declare module` 增强**：npm 上的宿主包与运行中的宿主不同代，引包等于拿错了契约；`extends Context` 还会撞 TS2717。
- **工具名/服务名带插件专属前缀**：宿主对重名**直接抛错**（不是显示难看，是整个工具面挂掉）。
- **槽位只挂官方已声明的**：向未声明槽位注册、或重复声明别人已拥有的 child，都会在**插件激活时**失败——所以撞槽位是响亮失败，不是静默降级。
- **`lib/` 是构建产物，不入库**；从源码目录链进 profile 的安装方式不会替你构建它。三条分发路各自的构建责任：`link:` 要你自己 `pnpm build`；**发布 npm 由 `prepack` 兜**（`package.json` 的 `prepack: npm run build`，`npm|pnpm publish` 与 `npm|pnpm pack` 四条路都会跑）；**git 直装完全没有构建**（本仓不提供 `prepare`，所以那条路现在是死的——要用先补 `prepare`）。

## 实现前必须先验的前提

- 实现前要先验的前提见设计稿 §9（本节不再复制——同一事实只住一个家）。

## 环境坑

- **运行时数据不在本仓**：会话本体 `~/.dsh/sessions/<转义cwd>/<会话目录>/session.vN.jsonl.zstd`；账本与缓存 `~/.dsh/storages/`；回收站在 `~/.dsh/session-trash/`。会话文件是 zstd 压缩的 JSONL，**第一行即 header**（含 `id` 与 `cwd`）。**一个目录里可以并存多代日志（宿主换代把老代留在原地），新代是老代迁移后的超集 ⇒ 只读版本号最大的那代，拼代会重复计数**（判据与 2026-10-16 实测见 10-15 稿 §1.4，挑法在 `src/log/session-log.ts` 的 `pickSessionLog`）。**手工动回收站只动 `~/.dsh/session-trash/`**：清单在每次读清单时与目录对账（多出的目录重建出行、目录没了摘行、认不出的当外人；口径与代价见 10-15 稿 §9）——`~/.dsh/storages/` 那份是**内部索引，不用手碰**，且它住宿主 storage 域、**打开时装一次快照** ⇒ 外面改那份要重启宿主才生效。
- **但"用 `zlib.zstdDecompressSync` 直接读会话文件"读不全（2026-10-15 实测更正）**：日志是一次次 append 出来的**多帧** zstd 流，而 Node 的 `zstdDecompressSync` **与** `createZstdDecompress()` 流式**都只给第一帧**（本机一条 3.8 MB 的文件，两个 API 都只回 209 字节 = header 那一行）⇒ 必须自己按帧头与 3 字节块头走帧。**踩坑点**：实测 `descriptor` 恒 `0x04`（单段、无字典、**校验位没置位**），却**每一帧尾都多 4 字节** ⇒ 按规范那一位决定"读不读校验和"会算错边界，得按实测（"跳 4 字节后必须撞上 magic 或到 EOF"）。在 125 个文件 / 36 904 帧上与"扫 magic"逐帧一致、解压零失败；判据与完整量见 `docs/design/2026-10-15-trash-detail-design.md` §1.1。
- **改动的生效路径分两半**：浏览器半走宿主 HMR；Node 半必须重启宿主。
- **验证要有界**：冒烟启动宿主时日志里那行带 token 的 URL 是活的凭据，别留在日志或会话输出里，测完删文件。

## Agent skills

### Issue tracker

工单住在本仓的 GitHub Issues（用 `gh` CLI）。见 `docs/agents/issue-tracker.md`。

### Triage labels

五角色用默认标签串：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文（仓根一份 `CONTEXT.md` + `docs/adr/`）。见 `docs/agents/domain.md`。
