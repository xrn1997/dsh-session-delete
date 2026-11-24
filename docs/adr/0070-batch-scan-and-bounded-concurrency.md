# 批量永久删除的批级扫描与批内并发（预裁决 / 第二波补跑覆盖 delete / restore 调度）

Status: accepted

一批的执行从逐条串行改成「预裁决 → 波次 1 有界并发 → 第二波串行补跑」，独占图片的候选与剩余引用扫描提到批级；「同批已带走 = 幂等成功」的语义一格不退化——载体成功回幂等支，载体没带走就补跑。

## 背景

逐条串行的批驱动把宿主读与盘上测量按条放大（每组各扫两趟），大批量时整条到达序链被拖长；而并发一旦放开，最先要保的是「同批已带走」语义（ADR-0002）：同批父先被删时孩子跟着走，后到的孩子 id 是一次幂等 no-op——**载体成功 ⇒ 幂等 `null` / `{removed:0,freedBytes:0}`；被带走的后来者不许变报错、不许双搬**。批驱动把计划与执行分家、附件尾提升到批级（失败的组视图不动、下一轮还能认领）之后，批执行才有了在波次上重排的空间。

## 决定

1. **预裁决（输入序）**：entry 域 = 清册快照上的 claim（判据住 `groups.ts`）；session 域 = 批开始一次 `subagentMembersOf` + 盘上在场预测组（`firstByBare` 去重、共享后代归第一个声明者）。批量 BFS 不把请求根预先塞进全局 `seen`：否则「父+子同批」时子根会从父闭包里消失，预裁决把两条都误判为 fresh。**预判只管调度**——carried 挂不挂、谁进波次 1；实况为准在动词与第二波，预测错了只是调度白排，不改任何一条信封。
2. **波次 1 有界并发**：预测 fresh 的条目按 `BATCH_RUN_CONCURRENCY` 跑；**组内串行不动**——实况会碰同一处的一组条目（同批父子 / 共享后代 / 两条计划撞同一目录）串成一条组按输入序跑，双搬红线不许赌预测对；互不相交的组之间才并发。
3. **第二波串行补跑（实况为准）**：预判 carried 的 id 在载体跑完后按实况裁决——entry 域看执行视图有没有 take，session 域看在不在某载体的 `movedSessionIds` 里；带走了回幂等支，没带走（载体失败 / 没搬它）进第二波串行执行，串行循环沿用动态 carried 语义（claim → 跑或 carried）。逐条失败不传染；信封按**输入序**落位；`already-gone` / `missing` / 单条 `null` 的协议错判形照旧。
4. **一次批一扫 + 计划/执行分家**：独占候选与剩余引用扫描从逐组各扫提到全批一趟（计划一趟、复核一趟）；逐组计划只吐本组被删目录，执行只按计划动手（成功才收缩执行视图——失败的组第二波还能认领）。分家的执行口是清册作用域的 `runGroup(plan)`：组只拿到自己的计划动手，不重扫、不裁决。
5. **附件尾批级化，只带走真删掉的目录的独占副本**：尾在全部组执行完后统一复核 + 删除，引用扫描以盘上剩余引用源为判据——失败组没删掉的目录在复核面里，它们的图片自动保留；第二波补跑要删的目录也进过批级扫描：挂起条目的**行目录与盘上残离子会话目录**一并喂进扫描面（载体计划期被闸拒掉时它的计划不存在，挂起条目的第二波计划仍可能删这些成员目录）。扫面多喂不会多删：尾的复核以盘上为准，没删掉的目录自动保留。盘上残离子会话读不出时只交行目录，并把该组的第二波补跑判失败（`io`）——宁可不删、留着让人重试，也不让它删掉没进过扫描面的目录。第二波重规划若长出扫描时不存在的新目录，同样 fail closed，不执行补跑。失败路径不再泄漏附件孤儿。
6. **动词 interface 不动**：删除动词仍一个 id 一次调用、自己读实况；批级预测只服务调度，组语义与同批已带走集的归属一格不搬。

## 边界

- 同批已带走集的判据仍住 `src/trash/groups.ts`：session 域与 entry 域的持有面住 `batch-carried.ts`，purge 那一半住清册作用域；本篇不翻 ADR-0002。
- 到达序链不动：批内并发只发生在一趟 `/apply` 内部，跨请求仍然串行。
- **波次 1 的组按预裁决固定，不按失败重裁**：更早的 fresh 条目执行失败时，后来者拿不到「本该连同失败那条一起跑」的更大组——失败条目把行留给下一次请求。预判只服务调度，这条取舍不改任何一条信封；UI 的选择只发可见根行，请求里同时带父子 id 才可能撞上。
- **共享残离子会话后代的读数不逐组去重**：同一 bare id 挂在两个组根下时，两组计划都把它算进 `removed` / `freedBytes`（执行期第二次删是空转成功），批内相加可能大于实际释放；执行不双搬，`/empty` 一组不受影响。单行回执的同类口径已在 `selectStrandedMembers` 的锚点里写明。
- **预裁决放开「父+子同批」后，`count` 读数的批内相加会重复计子根**：批级一次 `subagentMembersOf` 里父的闭包含子根，确认框那句「含 N 个子会话」逐条相加时子树被数两遍。这是显示级读数、不是信封——`count` 本就允许整条读不到时整句不说（`batch-confirm` 的 `counts === null` 支）；界面选择只发可见根行，该组合在生产 UI 不可达，不为此加去重层。
- **步骤 tick 的唯一映射不因波次改变**（计划函数进门 `measuring`、批尾进门 `attachments`）；每条（含失败条）完成 tick 一次，第二波补跑的条目也各一次。
- 附件红线不翻（ADR-0020）：只随永久删除清 `.dsh` 内独占图片副本；剩余引用源读不出照旧 fail closed（ADR-0041）。
- **批级 skipped 逐组归因、不串台**：候选日志读不出 / 附件对象读不出的 skip 原因按**组**记进计划（`unreadableCandidatesByGroup` / `unreadableObjectsByGroup`），只落自己组的成功回执；失败组没有回执可挂，那句随它的错误信封一起重试。全批共享的两段（剩余引用证明与执行期复核）走统一目标面。

## 后果

- `batch.ts` 从逐条循环长成四段：预裁决 → 波次调度（`chainsOf` / `runWave`，旋钮 `BATCH_RUN_CONCURRENCY`）→ 第二波串行 → per-id 回执合成；purge / orphan-clean / empty 三条批驱动同构，`/empty` 的驱动序另立 `empty-batch.ts` 一家。
- 计划与执行彻底分家：`planTrashRemoval` / `planOrphanRemoval` 只测不删、`executeRemoval` 不再管附件；附件尾 `executeAttachmentTail` 在全批执行完后跑一次，回执的 per-id 附件读数由合成层拆回。
- 调度预读从「每条一次」变为「每批一次」（`subagentMembersOf` 批级扫 + 在场探测），读不出时整批退化为串行链、预测不冒充实况；动词仍保留自己那次权威实况重读。只有附件剩余引用扫描真正收成批级一趟。
- 磁盘事实一格不松：同批已带走的幂等支（`null` / `{removed:0, freedBytes:0}`）、信封输入序、逐条失败不传染、活体准入按组两遍（ADR-0027）与删前复核（ADR-0041）全部由 `tests/batch.test.ts`、`tests/batch-carried.test.ts`、`tests/attachments.test.ts`、`tests/permanent-removal.test.ts` 钉住。

## 被否方案

- **客户端分条发请求**：打散同批已带走的幂等语义（跨请求没人持有它），N 次往返、N 个信封，回执按输入序的合成也没人做。
- **接受边缘不一致**（共享后代双搬 / 双计、载体失败仍回 carried-0）：代价是「丢删除」或「双搬」——红线不拿边缘不一致换实现省事。
- **跨请求并发**（放开到达序链）：写链是回收站与清册一致性的边界；可拿的并行度在批内已经拿满。

锚点：`src/verbs/batch.ts` 的 `applyActions` / `runPurgeBatch` / `BATCH_RUN_CONCURRENCY`；`src/verbs/batch-carried.ts` 的 `preAdjudicateSession` / `createEntryCarried`；`src/verbs/trash-scope.ts` 的 `TrashScope`；`src/verbs/empty-batch.ts` 的 `runEmptyBatch`（`/empty` 与批驱动同构的驱动序）；`src/trash/attachments.ts` 的 `planBatchImageAttachmentRemoval`；`src/verbs/permanent-removal.ts` 的 `plannedAttachmentDirs` / `executeAttachmentTail` / `executeRemoval`；`tests/batch.test.ts`；ADR-0002（同批已带走集）；ADR-0027（计划与执行器）；ADR-0041（执行期复核）
