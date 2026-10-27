# ADR-0006 — 永久删除的计划与执行只有一个家：`src/verbs/permanent-removal.ts`

Status: accepted

## 背景

三件事在 2026-10-20 之前各说各的：

1. **`/list` 念的记录字节与 purge 删的盘上字节不是同一个数**：`releaseBytes` 由清册里的 `sizeBytes`（删除那一刻记下）+ 孩子的 `sizeBytes` + 盘上后代现量拼出，而 purge 的 `freedBytes` 是删之前逐个 `sizeOfDir`。回收站里手工动过、会话后来又长大，两个数只会越差越远——卡片上「这次会释放多少」和真删后的回执各说各的。盘上后代的枚举也是 `/list` 自己一套（只按这一组的清册 id 排除），与 purge 的排除面不是逐字相同。

2. **purge 与 orphan-clean 各手写一遍永久删除序列**：两个动词各自排「先退归档集 → 再摘账本 → 最后删目录」，量目录、live 准入、成员离场通告各写一遍；谁能带部分回执、失败用哪个标签，埋在各自的 `try/catch` 行文里。

3. **purge 借 journal 放一条没有反向动作的序列**：`createJournal(steps)` 的 interface 是「移动步骤各自声明 `undo`、失败时按相反顺序退化，没有 `undo` 的步骤（删除侧那步只读就是）跳过」（`JournalStep.undo?` 本就是可选的；ADR-0002：它只服务「成员在 `sessions/` 与 `session-trash/` 之间搬」这一件事）。purge 的步骤一步都不可回滚，journal 在这里只剩一个顺序数组的壳——既越出它的边界，也让「永久删除没有回滚」这件事看起来像 journal 管。

## 决定

1. 永久删除收进 `src/verbs/permanent-removal.ts` 一个 module、两半：**只读计划**（`planVisibleTrash` / `planTrashRemoval` / `planOrphanRemoval`）与**执行器**（`executeRemoval`）。计划量目录、算字节、选盘上后代、做 live 准入；执行器只写、不再量、不再判活体——**计划就是执行前的闸**。
2. **字节按盘上实测**：`/list` 的 `releaseBytes` 与 purge 的 `freedBytes` 都来自 `measureTrashRow` / `planMemberRemovals` 的 `sizeOfDir`。清册里的 `sizeBytes` 仍是「删除那一刻的读数」（清单行「大小」那一格照旧念它），但不再参与「这次会释放多少」的合计。
3. **live 准入住计划里、在任何写之前**：purge 查 targets 与全部枚举到的盘上后代；orphan-clean 查整组（含目录已不在的成员）。任一在跑就整条拒绝、零副作用。
4. **部分回执由 `kind` 决定，只覆盖删目录那一段**（**2026-10-20 就地订正**：计划上曾有一个 `receipt:'none' | 'partial'` 字段，与 `kind` 在生产里 1:1、等于同一件事记了两份，已删除）：`kind:'trash'`（purge）失败只抛那一步的 `io` 与原文、不带 details；`kind:'orphan'`（orphan-clean）在**删目录阶段**失败时另带 `{removed, freedBytes, failedSessionId}`。删目录之前的 `unarchive` / `detach` 一步不套这层回执：purge 照旧折成带标签的 `io`、仍不带 details，orphan-clean **原样抛出**那个错误（不包 `io`、不带 details）——与迁移前的错误形状一致。同一执行器两种回执，由 `kind` 决定，执行器不猜。
5. **通告仍归 `member-presence`**：执行器逐条调 `memberGone`（摘活体三态 + `api-session/removed`），不另写一份（ADR-0005）。
6. **journal 不参与永久删除**：它只服务有反向动作的一次移动；永久删除的步骤顺序由执行器拥有。源码护栏把 `createJournal(` 的允许名单钉在 `src/verbs/member-journal.ts`（定义）与 `src/verbs/delete-session.ts` / `src/verbs/restore-session.ts`（调用）；删目录与在场通告在动词面已由 `RemovalDeps` / `PresenceCapability` 守住。

## 边界

- 不改组语义（`src/trash/groups.ts`，ADR-0001）：`planTrashRemoval` 的 `targets` 由调用方选好，计划只量、只筛、只查活体。
- 不改批量（`src/verbs/batch.ts`，ADR-0002）与线上形状（`src/shared/wire.ts`，ADR-0003）；不新增段名或动作。
- 不碰投影缓存；附件只按 ADR-0020 清独占的图片副本，计划与执行的其余边界照旧。
- `sessionQuery` 缺席仍按原降级：purge 只清清册那部分，计划回空 members、不抛。盘上残留要等 `sessionQuery` 在时由 `GET /orphans` 兜底——`/orphans` 自己也缺 `sessionQuery` 时**响亮失败**（`io`），绝不拿零条假报告冒充；「兜底」说的是服务回来后看得到，不是缺席时看得到。

## 后果

- **`/list` 每条可见行多一次 `sizeOfDir`**（组根与折进它的每个孩子；盘上后代本来就量过）：读清单从「念清册」变成部分「量盘」。回收站行数少，可以接受；盘很慢时这里是新的读放大点。**第二个读放大点**：盘上后代走 `planMemberRemovals`，每个成员多一次 `host.workspaceOf`，而 `/list` 只念它的字节与条数、不用 `workspaceId`。若将来压测确认这笔账本查询占了大头，再给只读计划加一条「只要计数与字节」的变体；在此之前不为一个未测的放大点另开路径。
- **回收站目录不在的行报 0 字节、清册行照样摘**：`measureTrashRow` 回 `present:false` / 0，执行器不再问盘，`removed` 照样 +1——否则永远多一条点不开的行。
- **盘上后代按全部清册 id 排除**（不再只按这次的 targets）：跟着任一条进回收站的孩子都不会按「盘上残留」再算或再删一遍；同一个 bare id 全局只计划一次。
- **`/list` ↔ purge ↔ 清空 三处同一条口径**：`planVisibleTrash` 与 `planTrashRemoval` 共用 `selectStrandedMembers` / `measureTrashRow` / `planMemberRemovals`；行上说的释放量就是清空真删的合计（只剩两次读之间的盘上变化）。
- **能力面 + 源码护栏**：`fs.removeDir` 由 `RemovalDeps` 在类型面收口到动词——会话删除拿 `DeleteSessionDeps`（`CoreDeps` + 时钟），恢复与计划函数拿 `CoreDeps`；这三类都不含 `removeDir`（`presence` 是另一条能力面，见 ADR-0019）。执行器 `executeRemoval` 与把能力交给它的永久删除分发层拿 `RemovalDeps`。组合根与路由仍持有全量的 `DeleteDeps`，所以「除执行器外没有第二处 `removeDir` 调用」继续用源码护栏钉住；`createJournal(` 的允许名单、以及 purge / orphan-clean 的「委托给执行器」结构同理（import confinement 与「不要自己调」无法用类型表达）。这些护栏彼此分开钉（「有没有第二处」+「第一处还在」）。
- 新增词条「永久删除计划」与 `docs/architecture.md` §4 的主人行。

## 行为差异（迁移时有意接受的六处）

- **live 现在也覆盖清册 targets**：purge 过去只查盘上后代，targets 自己在跑也照删；现在计划先查 targets 再查后代，任一在跑整条拒绝。
- **盘上后代的排除面从「这次 targets 的清册 id」扩到「全部清册 id」**：已在回收站、但不在这次 targets 里的子会话，不会再被当成盘上残留多删一遍。
- **计划期 `sizeOfDir` 失败丢了旧步骤标签、仍映射成 `io`**：过去 purge 在「删除回收站目录失败」那一步里量字节、失败带那个标签；现在量字节在计划期，错误不经那一步的包装，`toRemoteFailure` 仍把非动词错误兜成 `io` 且保留原文——客户端看到的码不变，句子不再带步骤标签。
- **`subagentBytes` 的来路从清册记录值换成盘上实测**：旧读数是跟着父进回收站的孩子各自 `sizeBytes`（删除那一刻记下的）之和；现在由 `planVisibleTrash` 逐个量孩子的回收站目录，与 `releaseBytes`、purge 的 `freedBytes` 同一条口径。清册里的 `sizeBytes` 仍只念在清单行「大小」那一格。
- **`exists` 与 `sizeOfDir` 之间目录消失（ENOENT）按「不在」处理**（2026-10-20 补记）：`measureMemberDir` / `measureTrashRow` 把它折成 `undefined` / `present:false`、0 字节——`/list` 少算这条刚消失的目录而不是报错，purge / orphan-clean 的计划里也没有可删的字节；盘没挂、权限、I/O 等其它失败照旧响亮抛出，绝不伪装成「目录没了」。
- **`GET /list` 多了一整类失败来源**（2026-10-20 补记）：`releaseBytes` 改由盘上实测之后，任一条**可见行**的目录读不了（EACCES / EIO 等非 ENOENT 错误）会让整个清单读失败、回 200 + `sessiondelete/io` 信封；迁移前这一格只念清册里的 `sizeBytes`、不碰盘，那些世界照样列得出清单，而清单面板是恢复其它条目的唯一入口。ENOENT 仍按上一条折叠成「不在」，所以普通缺目录不会触发这条；`tests/api.test.ts` 有一条用例钉住这个回执形状。这是「口径同源」换来的失败面，不是顺手改的降级——要改就得先回答「这一行说释放 0、其实几百 MB」算不算假话。

## 被否掉的替代

- **对齐到清册记的 `sizeBytes`**（`/list` 继续念旧数、只让 purge 现量）：两处继续各说各的，且「这张卡说会释放多少」会随回收站里手工动过的目录越漂越远——它本来就该回答「现在删掉能腾多少」。
- **只在执行时量**（计划不量、执行器删前才算）：`/list` 就没有同一条口径可念；而且量字节失败会发生在已经退完归档集、摘完账本之后，不再是「一切写之前」。
- **purge 继续用 journal**（只把两个动词的序列抽成共享 steps）：把一条没有 `undo` 的序列塞进「每步自带反向动作」的 interface，ADR-0002 的边界会被「journal 也能跑单向步骤」抹掉。
- **计划与执行器拆成两个 module**：两者共享同一份形状（`RemovalPlan` / `PlannedTrashRow` / `PlannedMemberRemoval`），执行器每一步都在解释计划里的字段；拆开只会让「计划就是执行前的闸」这条不变量跨文件维护。

锚点：`CONTEXT.md`（永久删除计划）；`src/verbs/permanent-removal.ts`；ADR-0002（journal 只服务有反向动作的一次移动）、ADR-0005（成员通告）、ADR-0020（附件边界）
