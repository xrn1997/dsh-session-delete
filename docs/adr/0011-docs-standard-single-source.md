# 文档标准单源：核心文件、ADR 格式与文档门清单

Status: superseded by 0024

本仓固定一套文档标准：核心文件、ADR 格式与文档门检查清单各只有一份，仓内差异只在 `docs/AGENTS.md` 声明。原 ADR-0010 的分层与「过程文档不入库」保留；它关于 ADR 格式、AGENTS 预算单位与文档治理文件位置的条款由本篇取代。

## 背景

ADR-0010 定下了文档分层与过程文档不入库，但格式与门仍散在多处：ADR 的索引、状态与锚点没有统一形态，根 `AGENTS.md` 的预算单位没有定死，文档治理文件的位置与「一条事实一个家」的判据分居根 `AGENTS.md` 与 `docs/AGENTS.md`。改一处要靠记忆，文档门也只覆盖了其中一部分。需要一份可机械校验的标准，让核心文件、决策的形状与门的清单在本仓内单源，仓内差异显式声明。

## 决定

1. **核心文件固定**：`AGENTS.md`（常驻规则）、`README.md`（用户事实）、`CONTEXT.md`（术语 + `_Avoid_`，新/改词条补 `_唯一实现_`）、`docs/AGENTS.md`（文档规范）、`docs/architecture.md`（当前形状与主人清单）、`docs/development.md`（构建、门、发版）、`CONTRIBUTING.md`（提交与发版边界）、`CHANGELOG.md`（发布历史）、`docs/adr/README.md` + `docs/adr/ADR-FORMAT.md`（决策与索引）。
2. **ADR 格式固定**：每篇紧跟标题写 `Status: accepted` 或 `Status: superseded by NNNN`；每篇在索引恰好出现一次；文末必须有 `锚点：`；正文只写当前真相，日期留在 git；互引允许但开篇自足；整篇翻案新写一篇并标旧篇。
3. **文档门收进一处**：`pnpm test` 内的 `tests/docs.test.ts` 继续把守路径、已废称呼、`§N` 指路、ADR 索引、Markdown 链接 / 标题锚点、截图清单；增加根 AGENTS 字符预算（≤ 8,000）、ADR `Status` 与核心文件在场检查。仓库无 CI，默认测试命令就是门。
4. **根 AGENTS 只放常驻规则**：文档分层、放置判据、写作规则与生命周期移到 `docs/AGENTS.md`；根文件保留先读表、硬约束、门与文档指针。
5. **过程文档与界面规格**：过程工件只住本机 `.superpowers/` 或 `.task-scratch/`，不入库；本仓不另写跨半契约规格：唯一主人是 `src/shared/wire.ts`；界面状态与层级住 `docs/ui-spec.md`。
6. **迁移**：开发手册统一为 `docs/development.md`；README、CONTRIBUTING、CHANGELOG、architecture 与 ADR 的入链同批更新；ADR-0010 标为被本篇取代。

## 被否方案

- **只写判据、不固定核心文件清单**：判据没有落点，格式、预算与门禁会继续分叉；核心文件清单是判据唯一可检查的形态。
- **把标准正文与文档门抽成独立仓**：`AGENTS.md` 的约定是离被改文件最近的指令生效，独立仓不在 agent 的 checkout 里；本仓规模也撑不起独立标准仓的版本维护。文档门以后可以抽成单独的包，规范正文必须留在仓内。
- **继续把文档规则放在根 AGENTS**：根文件已经承担先读表、硬约束与门；再装分层、生命周期与 ADR 格式会让每次会话都为细节付费，且没有单一入口回答「这条内容该放哪」。
- **照搬重型文档模板（多层目录 + 整套门禁）**：那套结构适合文档与协作体量更大的仓；本仓 ADR 体量小、单人维护，抄目录只会多出空壳与维护成本。只取单一文档标准、决策生命周期与最小机械检查。

## 后果

- 文档多了一层 `docs/AGENTS.md` 与 `ADR-FORMAT.md`，但每份文件只回答一类问题；根 AGENTS 变短，细节可按需打开。
- 存量 ADR 需要补 `Status` 并把 `相关` 行收成文末 `锚点：`；开发手册改名会波及 README、CONTRIBUTING、CHANGELOG、architecture 与 ADR 的入链，文档门会把这些一次抓住。
- 预算与门禁清单进测试，不再写在散文里；以后调预算只改测试与 `docs/AGENTS.md` 的口径，不靠记忆。
- `ADR-0010` 仍可回查当时的取舍；本仓当前文档规范以本篇与 `docs/AGENTS.md` 为准。

锚点：`docs/AGENTS.md`；`docs/adr/ADR-FORMAT.md`；`tests/docs.test.ts`；`AGENTS.md`；`README.md`；`CONTRIBUTING.md`；`CHANGELOG.md`；`docs/development.md`；`docs/ui-spec.md`；`src/shared/wire.ts`；ADR-0010。
