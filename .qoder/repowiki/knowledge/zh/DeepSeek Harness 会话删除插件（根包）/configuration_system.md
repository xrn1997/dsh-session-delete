## 概览

本仓库是一个 DeepSeek Harness (DSH) 插件，**没有独立的运行时配置文件加载器**。其“配置”由三部分组成：

1. **宿主装配期配置**：`package.json` 的 `dsh.*` 字段 + `cordis.patch.yml`。
2. **宿主服务注入**：通过 `inject` 声明从宿主容器取依赖（`workspaceRegistry` / `storageDomain` / `webServer`）。
3. **运行时环境变量**：仅使用 `$DSH_HOME` 定位宿主数据根。

没有 `.env`、`.yaml/.toml` 应用级配置、feature flag 系统或 secrets manager。

## 关键文件

- `package.json` — 插件元数据、`exports`、`peerDependencies`、`dsh.*` 配置段。
- `cordis.patch.yml` — Cordis 注入清单，告诉宿主在何处插入插件。
- `src/index.ts` — 插件入口，实现 `name`、`inject`、`createStorageManifest`、`resolveHome`。
- `vitest.config.ts` — 测试环境的 Node/jsdom 双项目配置（非运行期配置）。

## 架构与约定

### 1. Cordis 插件装配 (`package.json` + `cordis.patch.yml`)

`package.json` 中定义两套 DSH 专属配置：

- `dsh.bundle.patch` → 指向 `./cordis.patch.yml`，即 Cordis 打包时用于补丁宿主装配的文件。
- `dsh.client.inject` → 浏览器端注入列表（当前注入 `@deepseek-ai/dsh-client-locale`），`dsh.client.platform` 固定为 `web`。
- `dsh.compatibility.dshReleases` → 声明与哪个 DSH 版本兼容（示例 `0.2.0-rc.2`）。

`cordis.patch.yml` 内容极简，仅声明一个 `insert` 条目：

```yaml
- insert:
    - id: session-delete
      name: '@xrn1997/dsh-session-delete'
```

这表示插件以 Cordis 插件形式被宿主按 ID 挂载。`package.json` 的 `files` 字段显式把 `cordis.patch.yml` 打入发布包，确保宿主能读到该 patch。

### 2. 宿主服务注入 (`src/index.ts`)

插件通过顶层导出的常量声明依赖：

```ts
export const name = '@xrn1997/dsh-session-delete'
export const inject = ['workspaceRegistry', 'storageDomain', 'webServer']
```

注释明确解释了三选三的取舍：

- `workspaceRegistry` / `storageDomain` / `webServer` 是实际使用的三项。
- `remote`、`sessions`、`sessionProjectionCache` **故意不写**：前者是浏览器半服务，写入会导致 Node 半挂起；后两者要么未用、要么是可选服务，写进 `inject` 会让插件停在 `pending (waiting for services: ...)`。

这是宿主容器对插件的**唯一依赖声明机制**，不是环境变量也不是配置文件。

### 3. 运行时环境变量 (`$DSH_HOME`)

`src/index.ts` 中的 `resolveHome(env)` 实现宿主数据根解析，优先级镜像宿主 `dsh-home-paths` 的行为：

1. 显式配置值（插件不可见，宿主自行传入）。
2. `$DSH_HOME`（空白视为未设，避免覆盖到当前工作目录）。
3. 回退到 `<homedir>/\.dsh`。

关键约束（代码注释引用宿主源码）：

- 空白字符串被视为“未设置”，不会覆盖默认路径。
- `~/` 前缀会展开为主目录。
- 最终调用 `resolve()` 规范化路径。

当宿主 profile 的显式 `dshHome` 与本插件算出的路径不一致时，插件**不会尝试修正**——删除/恢复操作会以 `not-found` 拒绝且零副作用，因为会话与回收站同卷。

### 4. 存储域配置（数据 schema）

`trashDomainSpec` 定义回收站的持久化结构，作为宿主 `storageDomain` 的 spec 传入：

- `name`: 带插件 scope 前缀的全局键 `xrn1997_session_delete_trash`。
- `version`: `1`。
- `layout`: `'per-record'`（单条记录独立文档）。
- `invalidRecords`: `'backup-and-skip'`（坏记录备份并跳过，不影响整个域打开）。
- `tables.entries.valueSchema`: 本地实现的 `parse(raw)` 校验器（因仓库硬约束不引入 zod，手动镜像 zod 接口）。

domain 名受 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` 约束（`@` `/` `-` 不允许），表名也走同一正则。

## 约定与约束

| 类别 | 约定/约束 | 来源 |
|---|---|---|
| 插件装配 | 宿主通过 Cordis 的 `cordis.patch.yml` 注册插件 ID，文件名必须出现在 `package.json.files` 中 | `cordis.patch.yml` + `package.json` `files` |
| 依赖声明 | 只写字符串数组形式的 `inject`；写对象 `{required, optional}` 会让插件停在 pending | `src/index.ts` 顶部注释 |
| 可选服务 | 未在 `inject` 中声明的服务不能直接取用；`sessionProjectionCache` 等可选服务需容错降级 | `src/index.ts` 注释与消费方用法 |
| 数据根 | 本插件只认 `$DSH_HOME`，不读其他环境变量 | `src/index.ts` `resolveHome` |
| 域名命名 | domain 名必须匹配 `^[a-z][a-z0-9_]*$`，含 scope 前缀 | `src/index.ts` `defineDomain` + 正则 |
| 存储 schema | 每条记录必须通过 `valueSchema.parse`；类型错误会抛 `TypeError` | `trashEntrySchema` |
| 布局策略 | 回收站用 `per-record` + `backup-and-skip`，坏记录不阻塞域打开 | `trashDomainSpec` + 注释引用官方 `session_projcache` 同款 |
| 构建产物 | 浏览器端 UI 经 `tsdown` 打包，`exports` 暴露 `.` 主入口、`./client` 客户端入口、`./locale/*.json` 本地化文件 | `package.json` `exports` |