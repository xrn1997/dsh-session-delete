# ADR-0043 — 可调项的字段表单走自绘「可调项」卡 + `/config` 读/写段

Status: accepted

三只可调项过去只能改 profile 的 `cordis.patch.yml`；宿主的字段投影不认本插件手写的 Standard Schema（ADR-0037）。现在插件设置页多一张「可调项」卡：`POST /config` 空体读、带字段写，写经宿主 `configEditor.edit`；不引 Schemastery，也不把表单交给宿主投影。

## 背景

ADR-0037 决定 `Config` 走本地 Standard Schema，代价是 `Config.listConfigs` 对本插件回 `status: 'unsupported'`，插件管理器不渲染字段表单。那一篇同时写明：要做表单有两条路——在插件页自绘表单并新增一条 Host 配置写路由（走 `configEditor.edit`），或值 import `@deepseek-ai/schemastery`（破跨插件 `import type` 红线）；优选前者。本决定把前一条落地。

## 决定

1. **新段 `/config`（POST）**：空体（`null` / `{}`）读当前值，带字段写；读是纯的、写进到达序链——`configEditor.edit` 会让这一行重启，不能和删除 / 恢复交错。与 `/detail` 一样用 POST 表达读，段数从九变十。
2. **形状与范围只住 `wire.ts`**：`SessionDeleteConfigWire` 是线上形状，`CONFIG_LIMITS` 是闭区间整数范围；`src/config.ts` 的 `SessionDeleteConfig` 是前者的别名，归一也读同一份 `CONFIG_LIMITS`。表单与 Node 半不会各写一份范围。
3. **写只走 `configEditor`**：`ctx.fiber.entry` 与 `ctx.get('configEditor')` 在组合根取；写支把它们交给 `src/verbs/config.ts`，`edit(entry, current => ({ ...current, ...next }))`。编辑器缺席 / entry 缺席回 `io` 并点名 `cordis.patch.yml`；编辑器拒绝回 `io` 并带原因；值本身不合法回 400（适配器把路由码折成 `io`，请求对不对看状态码）。
4. **表单住既有 `plugins.bundle.config` 卡**：不另开 `plugins.row.config`。后者的 key 是 `<包名>#<patch 行 id>`，客户端要知道 patch 行 id；前者按 bundle 包名寻址，是客户端本来就有的身份。两张卡同属一个槽位占用者：「可调项」在上，「维护」在下。
5. **保存的语义是「交出去」**：写会让 **Node 半**这一行重启；浏览器半的卡片不随卸载，用 `/config` 的保存回执回填，重开插件页时重新读取。状态行只说「已保存；插件正在重启」，不假装页面完成了一次重新读取。读失败与保存失败都把原文上屏，不吞。

## 边界

- 不引 `@deepseek-ai/schemastery`：ADR-0037 的红线仍成立；宿主字段投影仍是 `unsupported`，这张自绘卡是唯一表单。
- 不直接读写 profile 的 patch 文件：写只有 `configEditor` 一条路（宿主自己串行化、校验并处理更高层覆盖）。
- `SessionDeleteConfigWire` 不进清册行形状：它只属于 `/config` 与设置页；回收站清单与详情不受影响。
- 没有自动保存、定时器或挂载即写：读一次、用户点保存才写。
- 撤销停留 6 秒仍是浏览器半的产品决定，不跨半传。

## 后果

- README「可调项」同时写 patch 与设置页卡两条路；`cordis.patch.yml` 仍是默认值与覆盖的家。
- `src/config.ts` 多一个 wire 别名与 `CONFIG_LIMITS` 的引用；`DeleteDeps` 多 `configEditor` / `entry` 两格，路由表多一个 `config` 切片（`CoreDeps & { configEditor?, entry? }`）。
- 新增测试：`tests/api.test.ts` 的 `/config` 用例、`tests/client/config-settings.test.tsx`、`tests/route-table.test.ts` 的段名 / 纯度 / 切片行、`tests/connection-route.test.ts` 的全部段名表。
- 宿主的字段表单仍不出现；用户若在插件页保存，这一行会重启一次（与直接改 patch 后宿主重启这一行的语义相同）。

## 被否掉的替代

- **值 import `@deepseek-ai/schemastery`**：破「跨插件一律 `import type`」，且把宿主 schema 库版本带进插件；ADR-0037 已否。
- **`plugins.row.config`**：key 要带 patch 行 id，客户端与 `cordis.patch.yml` 的 id 耦合；本决定改用按包名寻址的 bundle 卡。
- **另开 `GET /config`**：多一段只为读；`/detail` 已有「POST 表达读」的先例，空体与写共用一段。
- **先回包再异步 `configEditor.edit`**：无法把编辑器的拒绝（更高层覆盖）报给用户；宿主文档要求报告拒绝，不假装保存成功。

锚点：`src/api/route-table.ts`；`src/verbs/config.ts`；`src/index.ts`；`src/shared/wire.ts`；`src/config.ts`；`src/client/config-settings.tsx`；`src/client/settings-cards.tsx`（两张卡的槽位占用者）；`src/client/settings-view.ts`（共用外壳）；`src/client/remote.ts`；`tests/api.test.ts`；`tests/client/config-settings.test.tsx`；`tests/client/settings-cards.test.tsx`；`tests/route-table.test.ts`；`tests/connection-route.test.ts`；`README.md`；`docs/ui-spec.md` §5；ADR-0037。
