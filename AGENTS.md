# dsh-session-delete — 给 agent 的工作须知

DSH 的「会话删除」插件。这份文件只做三件事：告诉你先读哪份、哪些门必须过、哪些红线跨所有改动。架构细节、构建步骤、历史裁决都不在这里。

## 先读哪份

| 你要回答的问题 | 读 |
| --- | --- |
| 用户怎么装、怎么用、数据在哪 | `README.md` |
| 这个词在本仓指什么 | `CONTEXT.md` |
| 系统分成哪几块、某条语义归谁、数据怎么走 | `docs/architecture.md`（§4 是唯一主人清单） |
| 界面现在长什么样、有哪些状态与层级 | `docs/ui-spec.md` |
| 怎么构建、怎么验、怎么发版、有哪些环境坑 | `docs/development.md` |
| 怎么提交、PR、发版边界 | `CONTRIBUTING.md` |
| 每个版本改了什么、升级注意 | `CHANGELOG.md` |
| 当初为什么这么定、否掉了什么 | `docs/adr/`（索引 `docs/adr/README.md`；写作规范 `docs/adr/ADR-FORMAT.md`） |
| 文档该放哪、什么时候更新/归档 | `docs/AGENTS.md` |
| issue / 标签 / 领域文档约定 | `docs/agents/*` |

**一条事实只住一个家**：动手前先在 `docs/architecture.md` §4 找到主人；同一判据不要在第二处再写一遍。代码与测试是最终真相；文档与代码冲突时，改文档。文档分层、放置与生命周期见 `docs/AGENTS.md`；进行中的计划住 GitHub Issues 或本机 `.superpowers/`，不入库。根 `AGENTS.md` 预算 ≤ 8,000 字符。

## 必须过的门

1. **客户端半改动先在有可见浏览器的隔离 home 验过**：条目激活失败 = 宿主进程死（`web boot: N entry did not activate`），不是 warn、不是静默 pending。只在没有页面的宿主上冒烟会漏掉这类崩溃。完整走法见 `docs/development.md` 的「真机验证」。
2. **Node 半改动必须重启宿主**；浏览器半走宿主 HMR。
3. **改通道先改契约**：段名 / 动作 / 形状 / 失败码住 `src/shared/wire.ts`，方法 / 纯度 / body 住 `src/api/route-table.ts`；加一个新段名两处一起改。请求本身不对用 4xx，操作失败回 200 + 信封。为什么不用官方 `remote.<namespace>` 见 ADR-0009。
4. **删除 / 恢复不碰归档**：回收站与归档是两套状态；删除必须把 session 和它的 agent handle 一起摘掉，恢复走冷 resume。判据与已知限制见 ADR-0008。
5. **浏览器半不许 import 任何宿主客户端包**（type-only 也不留）；跨插件一律 `import type`；宿主类型面用本地窄镜像，不装宿主类型包、不做 `declare module` 增强。
6. **客户端条目注册只在 `src/client/index.tsx`**：槽位只挂官方已声明的；可选服务走 `ctx.get`，不进条目的 `inject`（条目 pending = 宿主进程死）。
7. **宿主要求只在顶层 `engines.dsh`**；`@deepseek-ai/dsh*` peer 保持零条。窗口值与真机名单的事实源是 `package.json`；README 与徽章是投影（文档门校验），`tests/skeleton.test.ts` 双向钉住 `package.json` 与实测代次。
8. **构建产物 `lib/` 不入库**；`files` 是精确清单，构建每新多出一个要发布的产物就同步加进去。构建与发版细节见 `docs/development.md`。
9. **工具名 / 服务名带插件专属前缀**：宿主对重名直接抛错，不是显示难看，是整个工具面挂掉。

## 实现前先验

- 宿主公开面以 `src/ports/host-port.ts`、`src/client/index.tsx` 与 `docs/architecture.md` §4 为准；不要从历史日志或旧 ADR 的路径抄成员面与槽位名。
- 改动前先看 `docs/adr/` 有没有相关裁决；翻案按 `docs/adr/ADR-FORMAT.md` 落字，别在正文里层层打补丁。

## Agent skills

### Issue tracker

工单住在本仓的 GitHub Issues（用 `gh` CLI）。见 `docs/agents/issue-tracker.md`。

### Triage labels

五角色用默认标签串：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文（仓根一份 `CONTEXT.md` + `docs/adr/`）。见 `docs/agents/domain.md`。
