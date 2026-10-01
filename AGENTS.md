# dsh-session-delete — 给 agent 的工作须知

DSH 的「会话删除」插件。需求的来由、已定的选择与实测边界都在设计稿里，这里只放**跨改动复用的不变量**与**实现前必须先验的前提**。

## 真相在哪（按顺序读）

1. **`docs/design/2026-09-30-session-delete-design.md`** — 现状设计：五个触点、边界、错误形状、验证门、已定的选择与被否决的替代。**§7 就是界面规格**（五个状态与它们的结构/层级），本仓不另存像素稿。
2. **代码与测试** — 最终真相。文档与代码冲突时以代码为准，并顺手把上面那处改正。

## 硬约束（本仓不变量）

- **客户端半的条目激活失败 = 宿主进程死**：桌面壳对"有客户端模块但没激活成功"走的是 `reportFatal(..., "web-boot")`，前端自检会 throw `web boot: N entry did not activate`——**不是 warn、不是静默 pending**。所以：**改动浏览器半后，先在有可见浏览器的隔离 home（镜像目标 profile 的插件组成）上验过，再装进任何 live profile**；只在没有页面的宿主上冒烟会漏掉这一类崩溃（宿主侧自己不报）。
- **`remote.<namespace>` 不是声明即得**：浏览器侧 `remote.<ns>` 只能由**生成的 Typert 描述符贡献**经 `ctx.remote.$mount(...)` 挂上；只在 client 半 `inject` 里写 `remote.<ns>`、却不发布生成的 `typert.host.js` / `typert.remote-client.js`（及对应 `exports`），插件会因拿不到该服务而在前端自检时致命失败。**实测结论（2026-09-30）：第三方没有动态发现这一步**——盒内 `$mount` 的清单写死在 `dsh-api-remotes` 里、全宿主搜 `'/remote'` 零命中，生成器又只认 `<root>/packages/<pkg>/` 的官方仓形 ⇒ 第三方只有两条路：**自挂自**（补生成物 + 自己 `$mount`）或**自建薄线**。本插件的四个动词走后者：宿主 web server 上的插件专属前缀路由 `/dsh-session-delete-api`（`src/api/dispatch.ts` ↔ 浏览器半 `src/client/remote.ts` 同源 fetch），信封与官方 unary 面同形，两侧共享 `src/shared/wire.ts` 的前缀/段名。
  - **自建薄线的同源栅栏必须认得桌面壳那条路（实测）**：桌面壳 `forwardWebRequest` 转发前删掉 `host`/`origin`/`cookie`/`sec-fetch-site` 四个头 ⇒ 真机到插件路由的请求**没有 `Origin`**、只有 `Referer: dsh-app://app/`；漏认它 = 真机上探测永远 403、四个入口一个都不出现，**而 headless 直连 http 的过门读数完全看不出来**（那条路是同源、本就放行）。判据按 `protocol` + `host` 比：`dsh-app:` 不是 special scheme，`new URL('dsh-app://app/').origin` 是字符串 `"null"`，比 `URL.origin` 永远为假。
- **会话列表不是磁盘投影——摘账本挡不住活体**（实测 2026-09-30 真机）：分组面 =「会话列表 × 工作区账本」，而列表是**并集**——`sessionQuery.listSessions()` = 磁盘上的持久化 **∪** `ctx.sessions` 里 attach 着的**活体会话**（本机运行期打开过/发过消息的就是活体，`session.list` 对活体直接取内存摘要）。所以搬走文件 + 摘账本只能清掉冷会话；活体会话仍会被列出来，而账本一摘它就"无主" ⇒ 客户端 `groupByWorkspace` 把它收进 `workspaceId === undefined` 那一组，标签是宿主的 `group.ungrouped` =「未分组」。**宿主没有"让内存忘掉一个活体会话"的官方面**（`ctx.sessions` 只公开 `get/list/create/fork/…`；`ctx.agents` 的 handle 同理归创建者）⇒ **要把它从分组面藏掉只有归档一条路**（`archiveSession` 的官方注释即 "Hide one known Session from Workspace grouping surfaces"；客户端按 `archivedFilter` 先过滤归档会话）；**要把它从客户端那一行删掉，靠的是两条"如实通告"**：摘活体（`ctx.sessions.get(id)` → `liveEntryFor(session).detach()`，触点 ⑤）+ 发宿主自己声明并转发的 `api-session/removed` / `api-session/added`（本仓仅有的两处内部入口；cordis 的 event 派发只在 emit 带 carrier 时才过滤监听者，所以不带 carrier 的 emit 会全量到转发器）。**冷会话没有活体可摘，通告照样必须发**——否则那一行要等到重连（`handleConnected` → 重列）才消失。细节与代价见设计稿 §4 末。
- **`peerDependencies` 是宿主的安装闸，不是自述**：`dsh plugin add` 拿运行中的宿主版本逐项比对插件的 `@deepseek-ai/dsh*` peer 区间，不满足即拒绝并回滚 ⇒ 区间只能逐代显式开口，semver 预发布规则下没有"免维护写法"；`dsh.compatibility.dshReleases` 只列**真跑过**的宿主、状态词只许 `compatible`；编译所依用精确版本。**两层的分工别混**：混了就会出现"声明兼容却装不进去"。
- **宿主类型面用本地窄镜像**（只声明用到的成员 + 一次强转），**不装宿主类型包、不做 `declare module` 增强**：npm 上的宿主包与运行中的宿主不同代，引包等于拿错了契约；`extends Context` 还会撞 TS2717。
- **跨插件一律 `import type`**，值 import 是与生态的红线；浏览器半只能 require 宿主**冻结平台模块表**内的东西，该表取各代宿主的**交集**（并集里的每条多出来的都是纯度门的一次豁免）。
- **工具名/服务名带插件专属前缀**：宿主对重名**直接抛错**（不是显示难看，是整个工具面挂掉）。
- **槽位只挂官方已声明的**：向未声明槽位注册、或重复声明别人已拥有的 child，都会在**插件激活时**失败——所以撞槽位是响亮失败，不是静默降级。
- **`lib/` 是构建产物，不入库**；从源码目录链进 profile 的安装方式不会替你构建它。

## 实现前必须先验的前提

- 实现前要先验的前提见设计稿 §9（本节不再复制——同一事实只住一个家）。

## 环境坑

- **运行时数据不在本仓**：会话本体 `~/.dsh/sessions/<转义cwd>/<会话目录>/session.vN.jsonl.zstd`；账本与缓存 `~/.dsh/storages/`；回收站在 `~/.dsh/session-trash/`。会话文件是 zstd 压缩的 JSONL，**第一行即 header**（含 `id` 与 `cwd`），Node 24 自带 `zlib.zstdDecompressSync` 可直接读。
- **改动的生效路径分两半**：浏览器半走宿主 HMR；Node 半必须重启宿主。
- **验证要有界**：冒烟启动宿主时日志里那行带 token 的 URL 是活的凭据，别留在日志或会话输出里，测完删文件。

## Agent skills

### Issue tracker

工单住在本仓的 GitHub Issues（用 `gh` CLI）。见 `docs/agents/issue-tracker.md`。

### Triage labels

五角色用默认标签串：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文（仓根一份 `CONTEXT.md` + `docs/adr/`）。见 `docs/agents/domain.md`。
