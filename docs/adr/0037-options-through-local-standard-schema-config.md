# ADR-0037 — 可调项走本地 Standard Schema 的 Config，不引宿主 schema 库

Status: accepted

插件过去把三只旋钮写死在模块里：附件单次响应上限 20 MiB、孤儿附件预览 200 条、附件引用扫描的单个 JSON 上限 10 MiB。现在它们进 `src/config.ts`，由插件导出的 `Config` 在宿主激活时校验、`apply` 归一，profile 的 `cordis.patch.yml` 可以覆盖。`Config` 是一段手写的 **Standard Schema**，不 import `@deepseek-ai/schemastery` 之类的宿主包。

## 背景

DSH 官方实践要求把可调项放进插件 `Config`，而不是散在代码常量里。Cordis 的 Config 接受 **Standard Schema**（`@standard-schema/spec`，Cordis 自己的依赖）；宿主自带插件（例如 `@deepseek-ai/dsh-plugin-manager`）用 `@deepseek-ai/schemastery` 构造 schema，配置页据此投影字段。

本仓的硬约束是「跨插件一律 `import type`」：Node 半不从宿主包做值 import。把 `@deepseek-ai/schemastery` 作为值依赖引进来会破这条约束；而 `Config` 的接口只要求 Standard Schema 形状（`~standard.validate`），手写三十行就够，不必搬一整套 schema 库。

## 决定

1. **`src/config.ts` 是唯一家**：`DEFAULT_CONFIG`（三只旋钮与默认值）、`normalizeConfig`（缺省合并、未知键/非整数/越界响亮抛错）、`Config`（Standard Schema，`~standard.validate` 交回归一值或 `issues`）。
2. **`apply(ctx, rawConfig)` 归一后注入 deps**：`normalizeConfig(rawConfig)` 的结果作为 `CoreDeps.config` 交给组合根装出的依赖面；读方从自己的 deps 读，不再 import 模块级单例。配置仍随插件实例走（宿主里只有一个实例），但不再是隐藏的进程状态。
3. **三只旋钮与范围**：`orphanPreviewLimit`（1..10000，默认 200）、`maxAttachmentBytes`（1..200 MiB，默认 20 MiB）、`maxJsonRefBytes`（1..100 MiB，默认 10 MiB）。它们分别由 `src/api/attachment-orphans.ts`、`src/api/attachment.ts`、`src/trash/attachments.ts` 经 `deps.config` 读取。
4. **默认值随 patch 走**：`cordis.patch.yml` 写出三项默认值，用户就地改；不发版也能调。
5. **失败要响**：未知键、非整数、越界都会让插件激活失败（宿主会回滚这一条），不会拿半套配置启动。
6. **浏览器半不读它**：撤销停留 6 秒是产品决定，不跨半传；Host Config 只管 Node 半的读/扫上限。

## 边界

- 宿主配置页的字段投影只认 native Schemastery；本插件手写的 Standard Schema 不在其列，`Config` 上无字段可展开。判据、实测读数与两条路见下。
- 不 import 任何宿主 schema 库；Cordis 将来若提供冻结的 schema 构造器，再按 Dependency Rule 评估替换，不在本轮加值依赖。
- 配置随组合根装配注入：测试给 deps 一份配置，不再有全局 `resetConfig()`；不引入环境变量或第二套配置文件。
- 不改线上形状：三只旋钮都不进 `wire.ts`；客户端不感知。

> 宿主配置页的字段投影要求 native Schemastery（`isNativeConfigSchema` 只认 `Symbol.for('schemastery') === true`、`type` 是字符串、`meta` 是非空对象）；本插件的 Standard Schema 不满足这三条。**0.2.2-rc.1 实测** `Config.listConfigs` 对本插件回 `status: 'unsupported'`，插件管理器不渲染字段表单；旧代次未逐一复核。配置以 `cordis.patch.yml` 为准。要做字段表单有两条路：在 `plugins.row.config` 自绘表单并新增一条 Host 配置写路由（走 `configEditor.edit`），或值 import `@deepseek-ai/schemastery`（破跨插件 import 红线）；两者当前都不做，若要做，选前者（不破跨插件 import 红线）。

## 后果

- 三只上限/条数可以按 profile 调，不用改代码或发版；默认值仍与旧行为一致。
- `src/config.ts` 是唯一家；`CoreDeps` 多 `config` 一格，读方从 deps 拿归一后的只读快照。`docs/architecture.md` §4 有主人行，README「可调项」与 `cordis.patch.yml` 是投影。
- 宿主配置页的字段渲染是已知的受约束偏离；做字段表单的两条路与当前取舍见「边界」。
- 新增 `tests/config.test.ts` 钉默认值、归一、非法值与 Standard Schema 返回值。

## 被否掉的替代

- **值 import `@deepseek-ai/schemastery`**：破「跨插件一律 `import type`」，且把宿主的 schema 库版本带进插件。
- **继续写死常量**：用户改一次要改代码/发版，官方实践也不认。
- **环境变量**：宿主已经有 profile 的 patch 层；再造一套环境变量等于第二个配置家。
- **不写 `Config`，只读 `apply` 的第二参**：能跑，但宿主无法在激活前校验，未知键/越界会拖到运行期才炸。

锚点：`src/config.ts`；`src/index.ts`；`src/deps.ts`；`cordis.patch.yml`；`src/api/attachment.ts`；`src/api/attachment-orphans.ts`；`src/trash/attachments.ts`；`tests/config.test.ts`；`tests/deps.test.ts`；`README.md`；`docs/architecture.md` §4；`AGENTS.md`；ADR-0035。
