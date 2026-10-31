# ADR-0027 — 永久删除仍是计划 + 执行器，活体准入在计划期与首笔写前各查一次

Status: accepted

永久删除继续收进 `src/verbs/permanent-removal.ts` 一个只读计划 + 执行器（ADR-0006）；这一版把活体准入从「只在计划期查一次」扩成「计划期查一次、执行器动第一笔写前用计划里的会话名单再查一次」，因为计划与第一笔写之间隔着附件引用的全 home 扫描，大 home 上是秒级窗口，期间 resume 的会话会被计划漏掉。

## 背景

ADR-0006 把永久删除收成两半，结束了三件事各说各话：

1. `/list` 念清册里记的旧 `sizeBytes`，purge 删的是盘上实测字节，两个数越差越远。
2. purge 与 orphan-clean 各手写一遍「退归档集 → 摘账本 → 删目录」，量目录、live 准入、成员离场通告各写各的。
3. purge 借 journal 放一条没有反向动作的序列，越出了 journal「只服务可回滚的一次移动」这条边界。

它同时写定「计划就是执行前的闸」，执行器只写、不再判活体。附件清理在计划之后还要扫全 home 的引用（ADR-0020），这段只读扫描把计划与第一笔写拉开到秒级；窗口里用户 resume 的会话，计划没看见，当时的执行器会删掉它的目录——一次计划期准入不再覆盖整趟写。

## 决定

1. 永久删除收进 `src/verbs/permanent-removal.ts` 一个 module、两半：**只读计划**（`planVisibleTrash` / `planTrashRemoval` / `planOrphanRemoval`）与**执行器**（`executeRemoval`）。计划量目录、算字节、选盘上后代、做第一次 live 准入；执行器不再量，字节念计划，动第一笔写前再做一次 live 复查（见 3）。
2. **字节按盘上实测**：`/list` 的 `releaseBytes` 与 purge 的 `freedBytes` 都来自 `measureTrashRow` / `planMemberRemovals` 的 `sizeOfDir`。清册里的 `sizeBytes` 仍是「删除那一刻的读数」（清单行「大小」那一格照旧念它），但不再参与「这次会释放多少」的合计。
3. **live 准入住任何写之前，分两处**：计划期 purge 查 targets 与全部枚举到的盘上后代，orphan-clean 查整组（含目录已不在的成员）；执行器动第一笔写前用 `plan.unarchive`（覆盖所有会被删目录的会话 id）再查一次。任一处发现会话在跑就整条拒绝、零副作用。第二查只补计划→执行的窗口，不替代计划期准入，也不在名单之外另加判据；判据本身仍归 `src/verbs/live-admission.ts` 的 `assertNoLive`。
4. **部分回执由 `kind` 决定，只覆盖删目录那一段**：`kind:'trash'`（purge）失败只抛那一步的 `io` 与原文、不带 details；`kind:'orphan'`（orphan-clean）在删目录阶段失败时另带 `{removed, freedBytes, failedSessionId}`。删目录之前的 `unarchive` / `detach` 一步不套这层回执：purge 照旧折成带标签的 `io`、仍不带 details，orphan-clean 原样抛出那个错误（不包 `io`、不带 details）。同一执行器两种回执，由 `kind` 决定，执行器不猜。
5. **通告仍归 `member-presence`**：执行器逐条调 `memberGone`（摘活体三态 + `api-session/removed`），不另写一份（ADR-0019）。
6. **journal 不参与永久删除**：它只服务有反向动作的一次移动；永久删除的步骤顺序由执行器拥有。源码护栏把 `createJournal(` 的允许名单钉在 `src/verbs/member-journal.ts`（定义）与 `src/verbs/delete-session.ts` / `src/verbs/restore-session.ts`（调用）。

## 边界

- 不改组语义（`src/trash/groups.ts`，ADR-0001）：`planTrashRemoval` 的 `targets` 由调用方选好，计划只量、只筛、只查活体。
- 批量语义不变（组、收缩与回执仍归 `src/verbs/batch.ts`，ADR-0002）：`orphan-clean` 只把字节测量收窄到请求点名的根；线上形状（`src/shared/wire.ts`，ADR-0003）不动，不新增段名或动作。
- 不碰投影缓存；附件只按 ADR-0020 清独占的图片副本，计划与执行的其余边界照旧。
- **计划与执行之间的 live 窗口**：计划期准入发生在附件引用扫描之前，大 home 上一次扫描可达数秒；期间用户 resume 的会话，计划看不见。`executeRemoval` 在任何写之前用 `plan.unarchive` 再查一次 `isLive` 补上这个缺口——失败时仍然零写入。这一查只补窗口，不替代计划期准入。
- `sessionQuery` 缺席仍按原降级：purge 只清清册那部分，计划回空 members、不抛。盘上残留要等 `sessionQuery` 在时由 `GET /orphans` 兜底——`/orphans` 自己也缺 `sessionQuery` 时**响亮失败**（`io`），绝不拿零条假报告冒充。

## 后果

- **`/list` 每条可见行多一次 `sizeOfDir`**（组根与折进它的每个孩子；盘上后代本来就量过）：读清单从「念清册」变成部分「量盘」。回收站行数少，可以接受；盘很慢时这里是新的读放大点。**第二个读放大点**：盘上后代走 `planMemberRemovals`，每个成员多一次 `host.workspaceOf`，而 `/list` 只念它的字节与条数、不用 `workspaceId`。
- **`releaseBytes` 改由盘上实测后，`/list` 多了一整类失败来源**：任一条可见行的目录读不了（EACCES / EIO 等非 ENOENT 错误）会让整个清单读失败、回 200 + `sessiondelete/io` 信封。ENOENT 在 `exists` 与 `sizeOfDir` 之间发生仍按「目录不在」折叠成 0 字节，不伪装成其它失败。
- **回收站目录不在的行报 0 字节、清册行照样摘**：`measureTrashRow` 回 `present:false` / 0，执行器不再问盘，`removed` 照样 +1——否则永远多一条点不开的行。
- **盘上后代按全部清册 id 排除**（不再只按这次的 targets）：跟着任一条进回收站的孩子都不会按「盘上残留」再算或再删一遍；同一个 bare id 全局只计划一次。
- **`/list` ↔ purge ↔ 清空 三处同一条口径**：`planVisibleTrash` 与 `planTrashRemoval` 共用 `selectStrandedMembers` / `measureTrashRow` / `planMemberRemovals`；行上说的释放量就是清空真删的合计（只剩两次读之间的盘上变化）。
- **能力面 + 源码护栏**：`fs.removeDir` 由 `RemovalDeps` 在类型面收口到动词；执行器与把能力交给它的分发层拿 `RemovalDeps`，组合根与路由仍持有全量的 `DeleteDeps`。「除执行器外没有第二处 `removeDir` 调用」继续用源码护栏钉住。
- **执行器多一次只读的 live 复查**：名单来自计划里的 `plan.unarchive`，只会在真要写时发生；失败仍零写入。它不复用计划期那一次查询的读数，因为窗口正是为了捕获两查之间的变化。

## 被否掉的替代

- **只靠计划期准入**（ADR-0006 原样）：计划与第一笔写之间的附件引用扫描是秒级，期间 resume 的会话会被删——这正是这一版要补的洞。
- **执行器每删一条查一次**：一个批次会变成 N 次查询；窗口是计划→第一笔写这一段，一次名单复查已覆盖整趟写。
- **把附件扫描挪到计划期、让计划与执行之间没有窗口**：扫描是只读的，但会把 `/list` 与计划都拖慢；扫描与写之间仍可能插入别的 await，挪位置换不来原子性。要原子性得宿主提供锁，这里没有。
- 字节口径、journal、拆 module 的被否方案仍见 ADR-0006，不在这里复述。

锚点：`CONTEXT.md`（永久删除计划、活体准入）；`src/verbs/permanent-removal.ts`；`src/verbs/live-admission.ts`；`src/verbs/batch.ts`；`tests/permanent-removal.test.ts`；`tests/live-admission.test.ts`；`tests/purge-trash.test.ts`；`docs/architecture.md` §4（永久删除 / 活体准入）；ADR-0020（附件边界）
