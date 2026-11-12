# 永久删除为什么逐会话带走投影缓存、存量为什么只由维护卡手动清

Status: accepted

宿主的会话投影缓存（`session_projcache`）只写不删：缓存服务没有删除面，删除会话也不会让它消失。所以永久删除每删掉一条会话，就顺带删掉**这一条**会话的缓存记录；以前删剩的孤儿记录由维护卡手动检测、手动清理。两条路都只碰证明没有会话痕迹的派生记录，不按计划名单批量扫，也不直接删 `storages/` 下的文件。

## 背景

宿主把每条会话的投影状态 checkpoint 成 `session_projcache` 域里的一份记录（`per-record` 布局，一条会话一份文档）。写点在会话创建、事件阈值、`turn/end` 与 `session/disposed`；读点是列表与冷读。**没有任何删除或回收路径**：`SessionProjectionCache` 的公开面只有 `write` / `coldSnapshot` / `cachedSnapshot` 一类，缓存服务的 storage domain 也没有暴露给它的删除方法。

本插件的删除只搬走 `sessions/` 下的会话目录，永久删除只删目录、清册行、归档位与独占附件；ADR-0006 的边界当时写的是「不碰投影缓存」（ADR-0027 的同一句已按本篇就地更新）。结果是：会话删得越多，`session_projcache` 里越积越多的记录再也找不到对应会话——记录本身不会读错（读面按 id + lifecycle identity 校验），但磁盘占用随删除量线性增长，而且没有任何自动兜底。

修复不能走「删文件」：`storages/` 是宿主的内部索引，绕过域的内存权威会让运行中的宿主与盘上不一致（`docs/architecture.md` §6）。能用的只有 `storageDomain.get('session_projcache').table('sessions')` 的同一条写链。

## 决定

1. **永久删除逐会话删缓存，不按名单批量。** `executeRemoval` 每处理完一条回收站行（目录删掉、清册行摘掉）或一个盘上成员目录，就删**这一条会话**的缓存（按 `sessionIdShapes` 覆盖 `session-x` / `x` 两代写法）；中途失败时，已删成的照清、没删成的不动。目录本来就不在的盘上成员不是这一趟从回收站删掉的东西，不碰它的缓存——留给维护卡按孤儿判据处理。`present:false` 的回收站行仍算「这一条从回收站删掉」：清册行摘掉后删它的缓存。
2. **存量只由维护卡的第三段手动清。** 报告与清理共用一条判据：`session_projcache` 的记录 id −（会话语料/持久化里的 id ∪ 清册 **raw** 行 ∪ `session-trash/` 目录名），id 按 `bareSessionId` 归一。清理只读调用方交来的 raw 行与目录名，**不先对账、不改写清册**——`ledger.list()` 会把目录不在的幽灵行摘掉，那正是判据要保护的面；报告与清理因此不会出现「报告保护、清理删掉」的差。失败关闭：语料缺席或读不出、持久化服务在场但列表读不出、或投影缓存存储域不可用 ⇒ `io`（活体只有语料看得见，持久化列表不是全集——语料缺席时拿持久化当唯一真相，会把没落盘的活体会话的缓存误报成孤儿）；持久化服务确实缺席时没有 persisted-only 会话，语料是完整保护面。只删这一刻仍无会话痕迹的记录；删完自动重查。
3. **删除只走 storage domain 的写链。** `storageDomain.get('session_projcache').table('sessions')` 的 `deleteMany`（旧宿主没有就逐条 `delete`，单条失败收进回执的 `failed`、继续删其余条）。官方把它标成 diagnostic surface；当前没有更窄的公开入口，最稳的长期解是上游给缓存服务补一个 `drop(id)`，本仓按方法存在性探测。读面只认已打开的域：缓存服务缺席不等于没有记录，域取不到 ⇒ `io`；核心面只拿读面，`dropProjectionCache` 只进 `HostRemovalPort` / `RemovalDeps`。
4. **失败语义分开。** 永久删除的缓存删除是派生数据收尾：失败只记 warning，不把已经完成的会话删除翻成失败；漏掉的记录由维护卡兜住。维护卡的清理失败回 `{ removed, failed }`（旧宿主逐条删除的部分失败如实回），界面清完重查，真实剩余量以重查为准。
5. **维护段沿用 ADR-0021 的手动口径。** 挂载不扫、没有定时器、没有自动清理；只有用户点「检查 / 查看并清理」才发请求。0 条时只显示「没有发现」。

## 边界

- **不改删除/恢复与归档的关系**（ADR-0008）：删除仍不碰归档，恢复仍走冷 resume；恢复后的会话缓存按宿主自己的冷读路径重建，不靠本插件保留。
- **不清理还能恢复或还在册的会话**：清册行（含目录不在的幽灵行）与 `session-trash/` 目录都是保护面，宁可少报一条也不误删。
- **不碰附件、清册与归档集**：维护卡第三段只删 `session_projcache` 的记录，不先对账、不改写清册；附件段与孤儿会话段各自的手动判据不变。
- **没有已打开存储域的旧宿主**：维护卡报告回 `io`（明确说读面不可用；缓存服务缺席也不算空表），永久删除的收尾降级为 warning——不伪装成清理成功。
- **不做全量清空**：不存在「清掉整个 `session_projcache`」的动作；删除名单永远是逐条判据的结果。

## 被否方案

- **按 `plan.unarchive` 一次性批量删**：计划名单包含目录已不在的成员与各种降级项，删除面比这一趟真正删掉的会话宽；一次失败的 purge 可能提前删掉还在回收站里的会话缓存。逐会话、删成一条清一条。
- **直接删 `storages/session_projcache/sessions/<id>.json`**：绕过域的内存权威与写链，与运行中的缓存服务不一致；`docs/architecture.md` §6 已把 storages 定为内部索引。
- **只做前进、不做维护卡**：这次修复之前已经删掉的会话不会再有下一次 purge，存量永远清不掉。
- **维护卡自动扫描或定时清理**：与 ADR-0021 的「手动维护」口径冲突；派生数据也不值得为它挂常驻扫描。
- **等上游补 `drop(id)` 再做**：宿主没有这个面，插件不能替它发版；先走 storage domain 的已打开域，探测不到就降级。
- **语料缺席时退回持久化列表**：持久化列表只覆盖磁盘持久化，活体只有 `listSessions` 看得见；没落盘的活体会话的缓存会被误报成孤儿删掉。语料缺席按 `/orphans` 同一口径响亮失败（看不见 ≠ 没有），宁可这一段报「检查失败」也不猜。

锚点：`src/verbs/permanent-removal.ts`（`executeRemoval` 的逐会话收尾）；`src/trash/projection-cache.ts`（`orphanProjectionCacheIds` / `reportProjectionCacheOrphans` / `cleanProjectionCacheOrphans` / `dropDeletedSessionCache`）；`src/ports/host-port.ts`（`HostProjectionReadPort` / `HostProjectionWritePort` / `HostRemovalPort` / `projectionCacheTableOf`）；`src/api/route-table.ts`（`projection-orphans` / `projection-clean` 两行）；`src/shared/wire.ts`（`ProjectionCacheOrphanReportWire` / `ProjectionCacheCleanupWire`）；`src/client/use-maintenance.ts` / `src/client/maintenance-settings.tsx`（维护卡第三段）；`tests/projection-cache.test.ts`；`tests/permanent-removal.test.ts`；`tests/host-roles.test.ts`；`tests/client/maintenance-settings.test.tsx`；`docs/ui-spec.md` §5.2；ADR-0008（删除/恢复与归档解耦）；ADR-0019（core 只拿读面）；ADR-0021（手动维护）；ADR-0027（永久删除的计划与执行器）。