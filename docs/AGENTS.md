# 文档规范

本文件回答「这条内容该放在哪、什么时候更新、什么时候归档」。它不重复业务规则：某条语义归谁见 `docs/architecture.md` §4，ADR 怎么写见 `docs/adr/ADR-FORMAT.md`。

**一条事实只住一个家**：当前事实源只写现在时；历史与变更过程只进 ADR、CHANGELOG 或 git；读数住读数的家与测试；过程工件留在本机。别处只链接，不复述。

## 1. 分层与职责

| 层 | 文档 | 只负责 | 事实源 |
| --- | --- | --- | --- |
| 常驻规则 | `AGENTS.md` | 每次会话必须可见的硬约束、先读表、门 | 是（仅规则） |
| 用户入口 | `README.md` | 是什么、怎么装/用、数据在哪、配置与兼容性 | 是（用户可见事实） |
| 详情页短文档 | `docs/DETAIL.md`、`docs/DETAIL.zh.md`（每语言一份） | 宿主插件详情页渲染的一行插图 | 否（README 的投影） |
| 领域词汇 | `CONTEXT.md` | 术语、语义、`_Avoid_`、`_唯一实现_` / `_无单点实现_` | 是（词汇） |
| 当前架构 | `docs/architecture.md` | 分层、依赖方向、唯一主人清单、不变量 | 是（结构） |
| 界面规格 | `docs/ui-spec.md` | 现行状态、布局、层级、危险层级 | 是（界面） |
| 开发手册 | `docs/development.md` | 构建、调试、门、真机验证、发版、环境坑 | 是（操作） |
| 贡献指南 | `CONTRIBUTING.md` | 提交信息、PR/Issue 约定、提交前门、发版边界 | 是（流程） |
| 发布历史 | `CHANGELOG.md` | 每个已发布版本的用户可见变化与升级注意 | 是（发布记录） |
| 决策记录 | `docs/adr/` | 一个决定的 why、边界、被否方案、后果 | 是（why） |
| Agent 技能配置 | `docs/agents/*` | issue、标签、领域文档的 agent 约定 | 否 |
| 读数 | `tests/**` 与代码注释 | 可复核的测试读数与局部口径 | 是（读数） |
| 活跃工单 | GitHub Issues | 进行中的任务与验收 | 否 |
| 过程工件 / 生成快照 | 本机 `.superpowers/`、`.task-scratch/`、`.worktrees/`、`.qoder/` | 任务简报、报告、审查草稿、工具生成的知识快照 | 否（不入库） |

本仓不另写跨半契约规格：契约的唯一主人是 `src/shared/wire.ts`，路由与形状住 `src/api/route-table.ts`，另写一份规格会造第二份契约。界面的现行状态与层级住 `docs/ui-spec.md`，不写进 architecture。

## 2. 放置判据

按「读者在什么场景会打开它」选层：装与用 → README；词义与实现锚 → CONTEXT；结构与归属 → architecture；界面现状 → ui-spec；操作与门 → development；提交与发布边界 → CONTRIBUTING；版本变化 → CHANGELOG；为什么 → ADR。进行中的计划、调研、评审住 GitHub Issues 或本机 `.superpowers/`，完成后把长期成立的部分提炼进上面某一层，其余不落库。

## 3. 写作规则

1. 当前事实源只写现在时；历史、变更过程、旧方案只进 ADR、CHANGELOG、git 或本机过程文档。
2. 一个事实只有一个家；`docs/architecture.md` §4 是语义归属的唯一清单，别处只链接。
3. 代码与测试是最终真相；文档与代码冲突时改文档，并顺手改回现状。
4. 引用仓内路径用相对路径，点名的路径必须真实存在，`pnpm test` 的文档门会扫。唯一的例外是 `README.md` 指向**不随包发布**的手写文档（这些文件不在 `files` 里，npm 页面上读 README 时相对路径落空，所以那几处写 GitHub 绝对地址；随包发布的截图、`LICENSE` 仍用相对路径）。
5. 不写行号（`file.ext:123` 形态会随任何一次编辑漂移）；要指实现就指符号锚。
6. 不抄会腐烂的读数与计数；需要证据就指测试、代码或读数的家。
7. 注释与文档承担为什么、口径、裁决、证据，不承担代码细节；自测问题：这句删掉，读者丢的是「为什么」还是「怎么做」？只丢后者就删或升高度。
8. 词汇优先：新概念先进 `CONTEXT.md` 再写代码。有唯一实现的写 `_唯一实现_`（按子句写 owner 路径 + 符号，消费者叙述放定义句）；没有单点实现的概念写 `_无单点实现_`。每条词条恰有一条实现声明，符号与子句归属由 `tests/context-terms.test.ts` 把守。
9. 根 `AGENTS.md` 预算 ≤ 8,000 字符；超限按「搬迁 → 压缩 → 提额并说明」处理，提额必须在提交信息里写理由。
10. 过程工件默认不进仓库：仓库不设 plans/specs/archive；进行中的计划住 GitHub Issues 或本机 `.superpowers/`。生成的 `.qoder/repowiki/` 不手改、不作架构判断依据，也不把它的结论抄进手写文档。
11. 引用外部文档原文不得改写；自家表述可直接改，引用只能在其之外另加读法说明，否则等于伪造出处。

## 4. 生命周期

- **ADR**：编号只追加；`Status`、索引、锚点与取代规则全住 `docs/adr/ADR-FORMAT.md`，这里不复述。
- **当前事实源**（`README.md`、`CONTEXT.md`、`docs/architecture.md`、`docs/ui-spec.md`、`docs/development.md`）：语义、界面、词汇或操作变化时同批更新；不写历史。像素、断点、文案键的唯一定义在 `src/client/` 与 `tests/client/`。
- **README / 详情页短文档**：用户可见事实变化时更新。兼容性窗口与真机名单的事实源是 `package.json`；README 与徽章是投影，由文档门校验。`docs/DETAIL.md`、`docs/DETAIL.zh.md` 随包发布、由 `locale` 的 `meta.detail` 点名，只写一行插图（判据住 `tests/skeleton.test.ts`）。
- **CONTRIBUTING**：提交信息、PR/Issue 约定、提交前门或发版边界变化时同批更新；构建与发版步骤仍住 `docs/development.md`。
- **CHANGELOG**：只在发版时追加已发布版本；每版用四个固定小节——新增 / 变更 / 修复 / 升级注意，没有内容的小节省略；写用户可见变化与升级注意，未发布改动不预写；历史版本按当时体例保留，逐提交明细留 git。
- **过程工件**：只住本机；任务完成时把长期成立的结论提炼进 ADR、`docs/architecture.md` 或 `docs/ui-spec.md`，其余随工作区消失。
- **生成快照**：整棵树重新生成，不逐文件修；与代码冲突时以代码为准。
- **文档门**：住在 `pnpm test` 的三件套——`tests/docs-liveness.test.ts`、`tests/context-terms.test.ts`、`tests/comment-altitude.test.ts`；判据以测试本身为准，运行口径见 `docs/development.md` 的「门（自动）」。

## 5. 提交前自查

- 这条事实的家是否唯一？别处是否还有旧副本？
- 当前事实源里是否混进了历史、计划或「已改为」的口吻？
- 改动的路径、相对链接/锚点、ADR 编号与 `§N` 指路是否都还活着？（`pnpm test` 的文档门）
- ADR 的 `Status`、索引与 `锚点：` 是否齐全？
- 根 `AGENTS.md` 是否仍在预算内？过程工件与生成的 `.qoder/repowiki/` 是否没有入库或被手改？
