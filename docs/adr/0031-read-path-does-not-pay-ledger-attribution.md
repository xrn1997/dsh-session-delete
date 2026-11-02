# ADR-0031 — 只读清单不吃账本归属，字节口径仍同源

Status: accepted

ADR-0027 决定 2 曾让 `/list` 与 purge 共用 `planMemberRemovals`；那一支会为每个盘上后代问一次 `host.workspaceOf`，而 `/list` 只念字节与条数，不读归属。账本读失败会把一类本来只属于删除的失败面拉进清单读取。

## 决定

1. **测量与补账本归属分家**：`measureMembers` 只量字节（`exists`→`sizeOfDir`，零账本读）；`planMemberRemovals` 在它之上补逐成员的 `workspaceOf`，只给 purge / orphan-clean 的删除计划用。
2. `/list` 的只读计划只吃 `measureMembers`；`host.workspaceOf` 只由真要摘账本的删除计划付。
3. 共用的是**字节口径**（两边都量同一个目录、同一套 `exists`→`sizeOfDir`），不是「两边跑同一个函数」。

## 边界

- 不改 ADR-0027 的活体复查、计划/执行器拆分与回执形状；本篇只替换它关于「`/list` 与 purge 共用同一份带归属测量」的那一格。
- 清册里的 `sizeBytes` 仍是删除那一刻的读数，不参与「这次会释放多少」。

## 后果

- `/list` 不再为每个盘上后代多开一次 `workspaceOf`，也不再把账本归属读失败拉进清单的失败面。
- 行上说的释放量仍是清空真删的合计；两边量的是同一套盘上字节，只剩两次读之间的盘上变化。

## 被否掉的替代

- **`/list` 也走 `planMemberRemovals`**：清单不读 `workspaceId`，却要为它付每成员一次宿主调用，并把账本归属的失败面拉进一条本来只会由删除触发的读。
- **先压测确认账本查询占大头，再给只读计划开一条只要计数与字节的变体**：开这条路径的理由不是那笔查询测出来有多贵，而是 `workspaceOf` 的失败面与调用次数本来就不属于清单读取。

锚点：`src/verbs/permanent-removal.ts`（`measureMembers` / `planMemberRemovals`）；`tests/permanent-removal.test.ts`；`tests/api.test.ts`；`docs/architecture.md` §4；ADR-0027。
