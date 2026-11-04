# ADR-0039 — 路径缺席只认 ENOENT / ENOTDIR：`FsPort.exists` 不再把读错误折成「没有」

Status: accepted

`FsPort.exists` 过去只有一句 `existsSync`：权限、断挂载、I/O 错误都被吞成 `false`。删除计划、删父时的孩子筛选与附件引用扫描都拿它当「路径不在」的判据，于是「读不出」被当成「没有」——轻则回一份假删除回执，重则把仍被引用的图片副本当孤儿删掉。现在 `exists` 用 `stat` 实现：只有 `ENOENT` / `ENOTDIR` 回 `false`，其余错误照抛；破坏性路径因此 fail closed。

## 背景

ADR-0020 与 ADR-0027 早就把「读不出」与「没有」分成两件事：附件独占判定要求剩余引用源任一读不出就整体跳过，`/list` 的盘上测量也写明「EACCES / EIO 等非 ENOENT 错误会让整个清单读失败」。但这两条承诺都建在 `sizeOfDir` / `statFile` / `readFile` 上，`exists` 仍是全仓唯一的例外：它把任何 `stat` 错误折成 `false`，而破坏性动作恰恰用它做第一问。

实际踩到的三个分支：

1. **彻底删除假成功**：`probeDir` 先问 `exists`，读不出就记 `present:false`；执行器跳过删目录、照样摘清册行、回「已释放」的合计。目录还在盘上，下一次对账把它重建成一行，但 `workspaceId` / `wasArchived` / `parentEntryId` 已经降级丢失。
2. **删父时孩子永久隐身**：孩子目录 `exists` 回 `false` 时按「盘上没有」跳过（那是为「宿主记录与磁盘不一致」留的降级）。若原因是读不出，孩子留在 `sessions/`，既不在回收站、也不算孤儿，宿主客户端又把 `origin:"subagent"` 行整排藏起来——用户看不见也删不掉。
3. **共享图片被误判孤儿**：会话目录、`sessions/` 根、`session-trash/` 根、`storages/` / `cache/` 根的 `exists` 都参与引用扫描；任一处瞬时读失败就被当成「这里没有引用」，清理计划会把仍在用的图片副本删掉。

## 决定

1. `FsPort.exists` 改成 `stat` + 缺席判据：`ENOENT` 与 `ENOTDIR`（路径中间那一截不是目录）回 `false`；其余错误原样抛出。`rename` 的目标检查改用同一条判据——目标读不出时拒绝搬移，而不是冒险覆盖。
2. 缺席判据只有一个实现：`src/ports/fs-port.ts` 的 `isAbsentPath`。原 `attachments.ts` 的 `isMissing` 收成它的别名，不再维护第二份（那份只认 ENOENT，连 ENOTDIR 都不算缺席）。
3. 调用方**不**各自 try/catch 把读错误吞回去：让失败升到动词层，成为「响亮失败 / 零写入」。这是 ADR-0020 与 ADR-0027 已经写下的方向，本篇只把端口补到同一条线上。

## 边界

- 只回答「路径在不在」，不回答「读得懂吗」；内容损坏、格式不认识仍归各模块自己的 fail-closed 判据。
- **「根不存在」仍按没有引用源处理**：`sessions/`、`session-trash/`、`storages/`、`cache/` 的根 `ENOENT` 依旧是「这里没有引用源」（新 home、正常空目录）。断挂载若也返回 `ENOENT`，这条判据看不出来；要更强的保护需要另立「根哨兵」，不在本篇范围内。
- 不改 `listDirs` / `listFiles` 的失败语义：它们本来就抛。
- 不把 `EACCES` 折成空清单、空计划或零字节——那正是本篇要禁掉的形状。

## 后果

- 回收站清单、彻底删除计划、删除动词与孤儿附件报告在非缺席（ENOENT / ENOTDIR）的读错误上会变红（200 + `sessiondelete/io` 信封），而不是拿 0 / 缺席冒充；永久删除与孤儿清理的附件计划仍按 ADR-0020 的口径整体跳过（200 + `skipped`，零删）。这是有意的行为变化：从前「默默少算」的那一类，现在会明确失败且零写入。
- `rename` 多一次目标 `stat`（原本就是一次 `existsSync`），语义从「读不出算没有」变成「读不出就拒绝」。
- `tests/ports.test.ts` 钉住两条：`ENOTDIR` 与 `ENOENT` 同判；非缺席错误（含 POSIX 下的 `EACCES`）照抛。删除动词与永久删除计划各有一条用例钉住「读不出不是缺席、零写入」。

## 被否掉的替代

- **保留 `existsSync`，只在新代码里另写一个 `tryExists`**：同一件事两个入口，旧调用点会继续按「读不出 = 没有」做删除决定；ADR-0027 已经写过这条判据，缺的是端口兑现它。
- **把读错误折成空结果由调用方自己判**：每个调用点都要记得区分，漏一个就是一次数据消失；判据应该住在端口这一层。
- **用 `lstat` 代替 `stat`**：软链语义会变（断链与指向目标的存在性判定跟着变），而本仓的引用扫描明确要跟随软链（ADR-0020），不在这里改。

锚点：`src/ports/fs-port.ts`；`src/trash/attachments.ts`；`src/verbs/delete-session.ts`；`src/verbs/permanent-removal.ts`；`tests/ports.test.ts`；`tests/delete-session.test.ts`；`tests/permanent-removal.test.ts`；ADR-0020（附件独占与 fail closed）；ADR-0027（永久删除计划与执行）
