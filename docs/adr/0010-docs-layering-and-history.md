# ADR-0010 — 文档分层：当前事实、裁决与历史各归一个家，过程工件不入库

Status: superseded by 0011

## 背景

2026-10-20 之前，本仓用批次日志记录每轮改动与实测；同一事实在日志、architecture 与 ADR 之间复述，日志里的批次号也没有可查坐标。2026-10-20 删掉两份批次日志，引用改指还活着的家，并加了文档门。

此前，文档规则仍散在 AGENTS 的先读表、architecture 开头、ADR-FORMAT 与 developing 的文档门里，没有一份回答「这条内容该放哪、什么时候归档」的标准。`.qoder/repowiki/` 是生成快照，可能落后于代码；如果被当成事实源，会制造第二份现状。

## 决定

1. 根 `AGENTS.md` 只放每次会话必须可见的硬约束、先读表与门；详细文档规则住 `docs/AGENTS.md`。
2. 当前事实按读者分层：用户入口 `README.md`、词汇 `CONTEXT.md`、架构与主人清单 `docs/architecture.md`、操作 `docs/development.md`、贡献 `CONTRIBUTING.md`、发布历史 `CHANGELOG.md`、界面 `docs/ui-spec.md`。
3. 裁决只进 `docs/adr/`：一篇一个决定，写 why、边界、被否方案与后果；ADR 不写现状地图。
4. 历史只留 git；仓库不建批次日志、plans/specs/archive。进行中的计划住 GitHub Issues 或本机 `.superpowers/`（gitignore），完成后把长期成立的部分提炼进事实源，其余不落库。
5. `.qoder/repowiki/` 是生成快照，不手改、不作事实源、不把它的结论抄进手写文档；与代码冲突时以代码为准。
6. 文档门（`tests/docs.test.ts`）机械钉住路径存在、废名、`§N` 指路、相对链接/锚点、ADR 索引完整、README 截图清单、唯一主人清单/界面规格标题、兼容性投影与 `AGENTS.md` 预算；规则变了先改门。

## 边界

- `docs/agents/*` 是 agent 技能配置，不是本仓事实源。
- 本文不记录当前架构、词义或界面状态；那些各有各的家。
- 不承诺以后也不建 plans/specs；如果真需要，先按 ADR-FORMAT 重新裁决，不悄悄加目录。

## 后果

- 新文档先看 `docs/AGENTS.md` 选层；当前事实源只写现在时，历史写日期或指 ADR。
- 文档改动必须过 `pnpm test` 的文档门；路径改名、ADR 索引漏项、`§N` 指错、相对链接/锚点断开、截图清单漂移都会红。
- 过程工件不再进仓库，减少第二份现状；代价是历史细节只留在 git/Issue，查起来比日志慢。

## 被否掉的替代

- **保留批次日志**：同一事实多处复述，批次号没有可查坐标；2026-10-20 已退役。
- **建 plans/specs/archive**：本仓面向单人维护的小插件，进行中的计划用 Issues/本机草稿即可；入库会引入「已完成计划仍以计划口吻存在」的问题。
- **照搬重型文档层（大量手写文档、规格、计划与归档）**：本仓体量不够，照搬只会多出空目录与第二份抄本。
- **把 `.qoder/repowiki` 当事实源**：它是生成快照，更新路径不在仓内，必然落后。
- **继续把文档规则写在根 AGENTS**：根 AGENTS 是常驻规则入口，不是文档手册；细节放进去会让每次会话都为它付费。

锚点：`AGENTS.md`；`docs/AGENTS.md`；`docs/architecture.md` §4；`docs/adr/ADR-FORMAT.md`；`tests/docs.test.ts`；`.gitignore`
