# 清册读只有一个入口：ledger 拥有对账

Status: accepted

清册的外部事实源是 `session-trash/` 目录，而 raw `manifest.list()` 只是一份可能过期的索引；为了让“读前先对账”不再是一条调用方义务，`src/trash/ledger.ts` 把对账与读合成 `list()`，raw 端口只留给 ledger 与对账实现。声明为 pure 的读面（`/orphans` 的扫描、`/detail` 的详情）不能借读清册之名写行，所以 ledger 另开一个不对账的 `raw()`。

## 决定

1. `TrashLedger` 是动词与路由唯一认识的清册读面：`list()` 是真相读（先对账再交行），`raw()` 是索引快照（不对账、不写行）。
2. raw `ManifestPort` 不再出现在 `CoreDeps` 上；`src/trash/reconcile.ts` 仍收 raw，因为它是 ledger 的 implementation。
3. `/list`、`/empty`、restore、purge 与 `orphan-clean` 的写前读走 `list()`；声明为 pure 的 `/orphans` 与 `/detail` 只走 `raw()`。

## 边界

- 不改清册的记录形状与存储域绑定。
- 不改 `/list` 的“对账 + 读”语义；只是把这条语义从入口搬进 seam。
- 对账仍是幂等、零漂移零写入。
- 纯读面（`/orphans`、`/detail`）仍不写清单：路由记录把 `read:'raw'` 交成 `RouteRead`，处理函数只消费这一面，不再自己挑 `ledger.raw()` / `list()`；`/list` 与 `/empty` 的 `read:'list'` 也由路由选面（后两者本来就写清册）。**这条不是类型面替人挡着的**——`RouteSpec.run` 仍收到整颗 `DeleteDeps`（`ledger.list` / `raw` 都够得到），`read` 是路由层选面的约定；实现选择由 `tests/api.test.ts` 里零 `listDirs` 的用例钉住：这两条请求一次对账都不发生。`/detail` 遇到“行在 raw 里、目录不在”照旧判 `io`，不靠对账摘行。

## 被否掉的替代

- **保留 `reconcileTrash(deps)` 辅助函数、让每个入口自己调**：义务仍在调用方，2026-10-19 的两次漏写就是证据。
- **把对账塞进 `createHostStorageManifest`**：存储域适配器会依赖 fs 与数据根，adapter 的 interface 被 implementation 污染。
- **只给 `manifest.list()` 改名**：raw 与真相仍是同一条方法，调用方仍要猜。
- **让 `/orphans` 也走 `list()`**：它声明为 pure、不进到达序链；一次扫描在链外写清册行，就会与删除/恢复交错。纯读扫描只认 `raw()`。
- **让 `/detail` 也走 `list()` 或把它判成 chained**：详情是“点开一条看正文”，声明为 pure 才有不排队的那条豁免；走 `list()` 会在链外写行，判成 chained 又让一次纯看排在删除/对账后面。详情照 `raw()` 读、由目录判 `io`。
- **不给 ledger 开 `raw()`、让 `/orphans` 直接拿 raw 端口**：raw 重新露回依赖面，每个调用方又得猜“这条读要不要对账”。

锚点：`src/trash/ledger.ts`；`src/trash/reconcile.ts`；`src/trash/detail.ts`；`src/verbs/orphan-subagents.ts`；`src/verbs/batch.ts`；`src/deps.ts`；`tests/ledger.test.ts`；`tests/api.test.ts`。
