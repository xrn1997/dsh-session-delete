# 文档标准固定为一套：核心文件清单、界面规格与三件套文档门

Status: accepted

ADR-0011 固定了核心文件清单与单文件文档门。本篇把界面规格补进核心文件、把 agent 约定列为一层，把文档门拆成三件套，并把 ADR 的锚点与互引形态定死。ADR-0011 的核心文件清单与单文件文档门条款由本篇取代；其「根 AGENTS 只放常驻规则」与「过程文档不入库」继续有效，ADR-0010 的分层结论保留。

## 背景

三件事让原来那套不够用了：

- **`CONTEXT.md` 的词条只靠评审核对**。词条点名的符号搬一次家就静默失效；这份表是接活时最先读的一页，指着不存在的符号比没有更糟。
- **文档门一个文件混着四类判据**：引用活性、已废称呼与 `§N`、职责边界与 ADR 形状、README 投影与截图。失败时读的人先要分辨是哪一类，改一类判据也会牵动整份文件。
- **三类检查缺位**：ADR 编号连续不重号、行号禁令（`file.ext:123` 会随任何一次编辑漂移）、代码注释高度（注释抄代码表达式，抄一次就随代码漂成谎言）。这三类靠人工评审抓不住。

界面规格与 agent 约定已经各有一层，问题不在它们的存在，而在核心文件清单与文档门还没有把它们算进去。

## 决定

1. **核心文件固定为**：`AGENTS.md`、`README.md`、`CONTEXT.md`、`docs/AGENTS.md`、`docs/architecture.md`、`docs/ui-spec.md`、`docs/development.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、`docs/adr/README.md`、`docs/adr/ADR-FORMAT.md`，外加 `docs/agents/*`（agent 技能配置，不是事实源）。
2. **规范正文只住两处**：分层表、放置判据、写作规则、生命周期与评审清单住 `docs/AGENTS.md`；ADR 的标题、`Status`、锚点、互引与取代规则住 `docs/adr/ADR-FORMAT.md`。根 `AGENTS.md` 只留常驻规则，不装文档手册。
3. **界面规格独立成层**：现行状态、布局、层级与危险层级住 `docs/ui-spec.md`；像素、断点、文案键的唯一定义在 `src/client/` 与 `tests/client/`，规格不抄读数。界面事实不再住 `docs/architecture.md`。
4. **agent 约定独立成层**：issue tracker、triage 标签与领域文档的读法住 `docs/agents/*`；它们不进事实源。
5. **ADR 格式收成一套**：`锚点：` 为可折行的一段；互引写 `ADR-NNNN`（指向文件本身的相对链接仍可用）；不引用仓外 ADR 编号——编号序列不对齐，溯源用提交 hash 或本仓可验证的锚点。
6. **文档门收成三件套**：`tests/docs-liveness.test.ts`（文档与代码注释里的路径、引用形态、职责边界、ADR 形状与 README 投影 / 截图清单）、`tests/context-terms.test.ts`（`CONTEXT.md` 点名的符号现查得到）、`tests/comment-altitude.test.ts`（代码注释高度）。三份各管一段，具体判据以测试本身为准；`pnpm test` 仍是默认门。
7. **CHANGELOG 四小节**：新增 / 变更 / 修复 / 升级注意，无内容的小节省略；历史版本按当时体例保留，不回溯改写。

## 边界

- 本仓不另写跨半契约规格：契约的唯一主人是 `src/shared/wire.ts`，路由与形状住 `src/api/route-table.ts`（ADR-0010 的分层结论保留）。
- 界面规格只管现行状态，不装历史取舍与像素读数；历史在 git 与 ADR 里。

## 被否方案

- **继续旧清单 + 单文件文档门**：界面规格与 agent 约定已经在用，清单里不写就没人维护它们；门的四类判据挤在一个文件里，失败时读的人先要分辨是哪一类。
- **让界面规格并回 architecture**：architecture 已经承担主人清单，再装界面状态会让同一份文件同时回答「谁拥有」与「长什么样」。
- **把标准抽成独立仓或包**：`AGENTS.md` 的约定是离被改文件最近的指令生效，独立仓不在 agent 的 checkout 里；本仓规模也撑不起独立标准的版本维护。
- **保留两份格式变体（锚点一行 vs 可折行、`ADR-NNNN-slug` 旧互引 vs `ADR-NNNN`）**：门代码与评审判据不通用，复制一次就分叉。
- **让 `CONTEXT.md` 继续靠评论把守**：词条点名的符号搬一次家就静默失效，评审记性不是门。

## 后果

- 文档门从单文件拆成三件套：新增 ADR 编号连续、行号禁令、`CONTEXT.md` 符号现查与代码注释高度四项检查。
- `CONTEXT.md` 改写为逐条定义并逐条点名锚点，此后由 `tests/context-terms.test.ts` 把守；符号改名会当场红，而不是等下一次评审。
- `docs/ui-spec.md` 与 `docs/agents/*` 的现有内容保留，只统一入链与措辞。
- `锚点：` 的门维持「一段」；ADR-0011 的核心文件清单被取代，ADR-0010 仍可回查分层取舍。

锚点：`docs/AGENTS.md`；`docs/adr/ADR-FORMAT.md`；`docs/ui-spec.md`；`docs/agents/domain.md`；`tests/docs-liveness.test.ts`；`tests/context-terms.test.ts`；`tests/comment-altitude.test.ts`；`AGENTS.md`；ADR-0011。
