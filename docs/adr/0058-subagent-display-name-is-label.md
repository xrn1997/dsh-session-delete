# 子会话的回收站显示名按 `subagent` label 起，与工作中同名

Status: accepted

回收站条目名在删除那一刻由 `titleOf` 取 `title` 投影，那是主会话的起名法；子会话在工作中显示的是 `subagent` label（委派时的 `description`），fork 子会话显示的是它自己的 `session/title`。同批子会话按 `title` 投影起名会撞成同名、分不清，所以显示名改成 label 优先；存量条目是删除时的快照、不回写，由详情读日志补名字兜底（父日志的 catalog / 子会话自己的日志）。

## 背景

宿主给子会话的显示名是 `subagent` 投影的 `label`：子会话自己日志里 `subagent/descriptor` 的 `label`（值来自委派时的 `description`），宿主子智能体面读 `projectionValues.subagent.label`，同批子会话各不相同。回收站条目名在删除那一刻由 `titleOf` 取 `title` 投影——主会话那套起名法（LLM 标题 / 首句提示词截断兜底）。2026-11-03 本机三组实测：同批两个子会话都叫「你是一名代码审查员，对整个」（提示词截断后一字不差），另有一条 fork 子会话记成父会话的标题（投影缓存的 predecessor 标题兜底，它自己日志里的名字是「在吗问候 (1)」）——回收站里无法分清子会话。清册标题是删除时的快照，写进去就不再变。

## 决定

1. **显示名 = label 优先**：`titleOf` 读投影缓存时取 `subagent` 投影的 `label`，缺席才回落 `title` 投影（缓存整条未命中回落 predecessor 标题的旧口径不动）；删除照旧把显示名存进清册 `title`。判据住 `src/ports/host-port.ts`（`titleOf` / `subagentLabelOf`），`TrashEntry.title` 的语义随之是「删除那一刻的显示名」，不是 `title` 投影的抄本。
2. **存量条目不回写，读时兜底**：
   - **父详情的子会话行**：读父日志的 `subagent/catalog`（`childId` → label，按 bare id 配行），随 `TrashDetailWire.subagents` 的行以可选 `label` 过线。
   - **没有 catalog 登记、标题又和父/兄弟撞名的 fork 孩子**：fork 没有 `subagent/descriptor`，但有它自己的 `session/title`。只对这类行（`session-` 前缀、清册标题为空/等于父/兄弟重名）读它自己的日志，取最后一条 `session/title` 作 `label`；普通子会话仍只读父日志，不逐条开 200 份日志。
   - **独立子会话**（父条目不在回收站、或子会话被单独删除）：详情读自己日志的 `subagent/descriptor` label；fork 子会话没有 descriptor，header 的 `parentSession` 说明它是子会话，用自己日志的最后一条 `session/title`。
   - 回写清册等于把删除时的快照改写成另一时刻的事实，不做。
3. **label 缺席就回落现状**：主会话没有 `subagent/descriptor`、one-shot 可以不给 `label`（委派没有 `description`）、老宿主的组员没有登记；这些条目仍回落 `title` 投影（空串再由界面走未命名兜底）。子会话的另一条兜底是它自己的日志标题（见决定 2），不造第三套名字。

## 边界

- 详情头部的显示名次序是 `entry.label`（父行交来的）→ `detail.label`（详情自己日志里的 descriptor label，或 fork 子会话自己的日志标题）→ 清册 `title` → 日志 `session/title`。清册标题只在**主会话**上保持优先；子会话的 `detail.label` 压过删除时可能起错的快照。
- `/list` 不发 `label`：清单行是清册行的投影，label 是日志里读出来的事实，只随详情 `subagents` 行过线——那一格正是 ADR-0029 定的「孩子没有清单行」的例外（现由 ADR-0055 的「沿用」节承接）。独立子会话在清单里仍显示删除时的快照；打开详情后标题排按上面的次序纠正。
- ADR-0038 收紧组员判据（2026-11-04）之前的删除把普通 fork 也折进了组：那类行没有 `subagent/descriptor`，按决定 2 在标题撞名时读它自己的日志标题；不撞名的旧行保持删除时记下的名字。

## 被否方案

- **label 与 title 并排都显示**：撞名的两串都摆出来并没有让子会话变可分，还给出「哪一串是真名」的第二份抄本。
- **只做读时兜底、不改起名规则**：新删进来的条目仍按 `title` 投影起名；单独删掉的子会话没有父详情可兜，清单行、确认框与撤销横幅都是撞名的那串。
- **迁移/回写存量清册行**：清册是删除那一刻的快照，回写把它改写成另一时刻的事实；自动回写还与「维护动作只在设置页手动触发」（ADR-0021）相抵。
- **每条孩子行读它自己的日志取 label**：子会话段最多 200 行，逐行开日志是读放大；父日志的 `subagent/catalog` 逐孩子记着同一个 label，一次走帧就都拿到。读放大只留给没有 catalog 登记且标题已经撞名的 fork 行。

## 后果

- `src/ports/host-port.ts` 的 `titleOf` 多读一格 `subagent` 投影；`src/trash/detail.ts` 的走帧多折 `subagent/catalog` 与 `subagent/descriptor`；`src/trash/display-name.ts` 是「从子会话自己的日志取显示名」的唯一实现（独立子会话与撞名 fork 行共用）。
- `src/shared/wire.ts` 的 `TrashEntryWire` 多一格可选 `label`（详情 `subagents` 行；父 catalog label 或撞名 fork 自己的日志标题），`TrashDetailWire` 多一格可选 `label`（详情自己日志的 descriptor label / fork 日志标题）；`src/client/subagent-section.tsx` 的 `rowName` 与 `src/client/trash-detail.tsx` 的 `headerName` 统一显示名。
- 存量条目在组里（父详情的子会话段可读到父日志）时按 catalog label 显示；没有 catalog 的 fork 子在标题撞名时按自己的日志标题显示；独立子会话打开详情后按自己的 label/日志标题显示。清单行与确认框仍显示清册快照。

锚点：`src/ports/host-port.ts`（`titleOf` / `subagentLabelOf`）；`src/trash/detail.ts`（`subagentLabels`、`ownLabel` / `ownParentSession`、`childDisplayNameOf`）；`src/trash/display-name.ts`（`displayNameOfLog` / `descriptorLabelOf`）；`src/log/session-log.ts`（`SessionRecord.parentSession`）；`src/shared/wire.ts`（`TrashEntryWire.label` / `TrashDetailWire.label`）；`src/client/subagent-section.tsx`（`rowName`）、`src/client/trash-view.ts`（`detailNameOf`：两档详情标题排共用的四源次序）与 `src/client/trash-detail.tsx`（`headerName`，回收站那一档的薄包装）；`tests/assembly.test.ts`；`tests/trash-detail.test.ts`；`tests/client/trash-detail.test.tsx`；`docs/ui-spec.md` §2（状态⑥）；ADR-0029（`subagents` 行的清册投影，现由 `0055` 沿用）；ADR-0055（子会话段）；ADR-0038（组员判据）。
