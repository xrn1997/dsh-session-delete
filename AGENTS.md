# dsh-session-delete — 给 agent 的工作须知

DSH 的「会话删除」插件。这份文件只回答三件事：先读哪份、哪些门必须过、哪些红线跨所有改动。架构细节、构建步骤、裁决理由都不在这里。双半产物：Node 半（Cordis 插件 + `/dsh-session-delete-api`，`src/{api,domain,log,ports,remote,shared,trash,verbs}` 与 `config.ts` / `deps.ts` / `errors.ts` / `index.ts`）与浏览器半（左侧栏回收站面板、行菜单、批量浮条、插件设置页的可调项 + 维护卡，`src/client`）。

## 先读哪份

| 你要回答的问题 | 读 |
| --- | --- |
| 用户怎么装、怎么用、数据在哪 | `README.md` |
| 这个词在本仓指什么 | `CONTEXT.md` |
| 系统分成哪几块、某条语义归谁 | `docs/architecture.md`（§4 是唯一主人清单） |
| 界面现在长什么样、有哪些状态与层级 | `docs/ui-spec.md` |
| 怎么构建、怎么验、怎么发版、有哪些环境坑 | `docs/development.md` |
| 怎么提交、PR、发版边界 | `CONTRIBUTING.md` |
| 每个版本改了什么、升级注意 | `CHANGELOG.md` |
| 当初为什么这么定、否掉了什么 | `docs/adr/`（索引 `docs/adr/README.md`；规范 `docs/adr/ADR-FORMAT.md`） |
| 文档该放哪、什么时候更新/归档 | `docs/AGENTS.md` |
| issue / 标签 / 领域文档约定 | `docs/agents/*` |

**一条事实只住一个家**：动手前先在 `docs/architecture.md` §4 找到主人；同一判据不要在第二处再写一遍。代码与测试是最终真相；文档与代码冲突时，改文档。文档分层与生命周期见 `docs/AGENTS.md`；进行中的计划住 GitHub Issues 或本机 `.superpowers/`，不入库。根 `AGENTS.md` 预算 ≤ 8,000 字符。

## 必须过的门

1. **`pnpm gates` 是门的总入口**（typecheck / lint / test / build / pack，任一红即红）；`pnpm typecheck` 与 `pnpm test` 仍必须同批跑，各自确认退出码。`tsc` 管类型形状，**`any` 归 ESLint**——`tsc` 从不拒绝显式 `any`。
2. **客户端半改动先在有可见浏览器的隔离 home 验过**：条目激活失败 = 宿主进程死（`web boot: N entry did not activate`），不是 warn、不是静默 pending。走法见 `docs/development.md` 的「真机验证」。
3. **Node 半改动必须重启宿主**；浏览器半走宿主 HMR。
4. **发版前跑 `pnpm gates`**，退出码看过；CI 与发版工作流共用同一条命令，不另抄步骤清单。

## 硬约束

- **改通道先改契约**：段名 / 动作 / 方法 / 请求形状 / 失败码 / 信封住 `src/shared/wire.ts`（段名表每项 `{ path, method, body }`，两半只投影）；`/apply` 成功值形状住 `src/shared/apply-values.ts`（schema 由 `src/shared/value-schema.ts` 的 DSL 声明，wire 只派生类型与判形）；纯度 / 读面 / body 预读 / 同源取数闸声明住 `src/api/route-table.ts`（`bodyOf` 只投影 wire 那一格）。加一个新段名两处一起改。请求本身不对用 4xx，操作失败回 200 + 信封；浏览器半把信封解析成唯一落地面 `RemoteOutcome`（ADR-0053）。通道只走宿主 `connection` 的 exact Fetch 路由（`/api/dsh-session-delete-api/*`，鉴权归宿主 `/api`）；支持面是 web UI 与桌面端，没有自建前缀 / fallback（ADR-0033）。
- **移入回收站 / 恢复不碰归档**：回收站与归档是两套状态；移入回收站必须把 session 和它的 agent handle 一起摘掉，恢复走冷 resume（ADR-0008）。`unarchive` 是用户显式动作，不是移入回收站 / 恢复的副作用（ADR-0060）。
- **附件红线**：附件只随永久删除清 `.dsh` 内独占图片副本——不碰源文件、不碰普通文件、共享引用保留；剩余引用源读不出就跳过。判据住 `src/trash/attachments.ts`（ADR-0020）。孤儿会话、孤儿附件与孤儿投影缓存的检查/清理都是**手动**：只在插件设置页的维护卡里触发（ADR-0021 / ADR-0062）；永久删除逐条带走被删会话的缓存。
- **浏览器半不许 import 任何宿主客户端包**（type-only 也不留）；跨插件一律 `import type`；宿主类型面用本地窄镜像，不装宿主类型包、不做 `declare module` 增强。
- **客户端条目注册只在 `src/client/index.tsx`**（唯一例外：会话菜单两行的双轨注册与 `contextMenu.icon` 两个 key 归 `src/client/context-menu-actions.tsx` 的 `installSessionMenus`，由 `index.tsx` 调一次；ADR-0059）：槽位只挂官方已声明的；可选服务走 `ctx.get`，不进条目的 `inject`（条目 pending = 宿主进程死）；可能迟到的服务用 `ctx.inject([...])` 的 scoped 等待切过去。
- **宿主要求只在顶层 `engines.dsh`**；`@deepseek-ai/dsh*` peer 保持零条。窗口值与真机名单的事实源是 `package.json`；README 与徽章是投影（文档门校验窗口 / 名单 / 徽章三句），`tests/skeleton.test.ts` 双向钉住 `package.json` 与实测代次。
- **对外注册名带插件专属前缀**（路由前缀、locale 命名空间、插件 key、`data-dsh-session-delete`、工具 / 服务名）：宿主对重名直接抛错，不是显示难看，是整个面挂掉。
- **`lib/` 是构建产物且不入库**：先 `pnpm build`；`files` 是精确清单，构建每新多出一个要发布的产物就同步加进去。运行时数据不在仓库：回收站、清册与会话本体都在 `$DSH_HOME`（缺省 `~/.dsh`）下，且**回收站必须与 `sessions/` 同卷**。

## 实现前先验

- 宿主公开面以 `src/ports/host-port.ts`、`src/client/index.tsx` 与 `docs/architecture.md` §4 为准；不要从历史日志或旧 ADR 的路径抄成员面与槽位名。
- 改动前先看 `docs/adr/` 有没有相关裁决；翻案按 `docs/adr/ADR-FORMAT.md` 落字，别在正文里层层打补丁。
- 命名新概念前先查 `CONTEXT.md`：自造同义词会让同一概念长出第二份抄本。

## Agent skills

### Issue tracker

工单与 spec 住本仓 GitHub Issues（`gh` CLI）。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个规范 triage 角色沿用默认标签串。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：仓根 `CONTEXT.md` 是词表，决策住 `docs/adr/`。见 `docs/agents/domain.md`。
