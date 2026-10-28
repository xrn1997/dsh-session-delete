## 1. 采用的方案

本仓库是一个 DeepSeek Harness (DSH) 插件，**没有传统意义上的应用级配置文件**（无 `.env`、无 `config/` 目录、无 YAML/TOML 运行时配置）。运行期可配置的点集中在两类：

- **运行时环境**：通过宿主提供的 Node.js `process.env` 注入，唯一被插件消费的键是 `$DSH_HOME`。
- **构建期定义**：由 `tsdown.config.ts` 在编译时把 `process.env.NODE_ENV` / `import.meta.env.MODE` 等常量内联到浏览器 bundle 中。

插件本身不解析任何本地 JSON/YAML/TOML 文件；它从宿主侧的 Cordis 服务获取路由表与 API，并把自身元数据登记到 `cordis.patch.yml`。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `src/ports/home.ts` | 解析宿主数据根 `$DSH_HOME` 的唯一入口 |
| `src/index.ts` | 插件装配入口，调用 `resolveHome()` 得到 home 路径 |
| `tsdown.config.ts` | 双端构建配置，定义 Node 半与浏览器半、依赖内联策略、平台模块白名单、`process.env` 注入 |
| `package.json` | DSH 插件清单（`dsh.bundle.patch`、`dsh.client.inject`、`dsh.compatibility.dshReleases`）、包导出契约、peer/dev 依赖 |
| `cordis.patch.yml` | 将插件注册为 Cordis 子插件（`id: session-delete`） |
| `tests/home.test.ts` | `resolveHome` 优先级与边界用例 |
| `tests/assembly.test.ts` | 测试中覆盖 `process.env.DSH_HOME` |

## 3. 架构与约定

### 3.1 宿主数据根解析（`src/ports/home.ts`）

`resolveHome(env = process.env, homeDir = homedir())` 实现如下优先级（与官方 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome(configured, env)` 行为镜像）：

1. 若 `env.DSH_HOME` 存在且非空白（`trim().length > 0`），使用该值；
2. 否则回退到 `join(homeDir, '.dsh')`；
3. 对 `~` 与 `~/...` 做展开，其余路径用 `resolve()` 规范化。

注释明确声明：**显式配置那一级对插件不可得**——宿主自身的 `Config.dshHome` 不会传进插件，因此插件只能看到环境变量这一层。当宿主实际 data root 与插件算出的不一致时，删除/恢复操作会“响亮拒绝、零副作用”（返回 `not-found` / `trash-empty` / `project-missing`），不会误删其他 profile 的数据。

### 3.2 构建期配置（`tsdown.config.ts`）

- **Node 半**：ESM，target `es2024`，`@deepseek-ai/*` 不被打包（留给宿主提供），其余 npm 依赖全部 inline。
- **浏览器半**：CJS 单文件闭合工厂（banner/intro/footer 符合官方 `./client` 三段式契约），target `es2022`，React 家族 (`react`, `react/jsx-runtime`, `react-dom`) 走平台模块白名单 `PLATFORM_MODULES`，其余全 inline。
- **`process.env` 注入**：浏览器端 define 四个键 —— `process.env = '{}'`、`process.env.NODE_ENV`、`import.meta.env.MODE`、`import.meta.env`，缺任一都会导致运行时报 ReferenceError。
- **纯度门 `gateClientImport`**：禁止浏览器 bundle 中出现 Node 内建或不在白名单中的 `@deepseek-ai/*` 值 import，违反即抛错；该函数与 `tests/skeleton.test.ts` 共用，行为被测试钉住。
- **CSS 处理**：自定义 `cssTextPlugin` 把 `.css` 转成字符串导出，仅挂在浏览器半，Node 半若 import `.css` 会在构建期失败。

### 3.3 插件注册与宿主集成

- `package.json` 的 `exports` 暴露 `.`（Node 入口 `lib/index.js`）与 `./client`（浏览器 CJS 工厂 `lib/client.js`），以及 `./locale/*.json`、`./package.json`。
- `dsh.bundle.patch` 指向 `cordis.patch.yml`，后者插入一个 Cordis 子插件条目 `session-delete`。
- `dsh.client.inject` 声明注入 `@deepseek-ai/dsh-client-locale`，`dsh.client.platform` 为 `web`。
- `dsh.compatibility.dshReleases` 列出兼容的 DSH 版本。

## 4. 约定与约束

- **唯一运行时配置项**：`$DSH_HOME`。空值视为未设置，不会把 home 解析成当前工作目录（见 `src/ports/home.ts` 注释及 `tests/home.test.ts` 第 18–21 行断言）。
- **默认 home 位置**：`homedir()/.dsh`，与桌面版实测一致。
- **home 解析只镜像后两级**：显式配置层对插件不可见，因为宿主 helper `dshHomePath(...segments)` 同样不传 `configured`，且 `ctx.profileContext` 不包含数据根字段（见 `src/ports/home.ts` 三条实证注释）。
- **浏览器构建 purity 规则**：浏览器 bundle 不得 require 任何 Node 内建模块或不在 `PLATFORM_MODULES` 白名单中的 `@deepseek-ai/*` 包；`tsdown.config.ts` 的 `gateClientImport` 在 resolve 阶段直接 throw。
- **浏览器构建 `process.env` 规则**：必须通过 `define` 注入四键，否则运行时报 ReferenceError（`tsdown.config.ts` 注释说明）。
- **CSS 使用范围**：`.css` 文件只能在浏览器半使用；Node 半 import `.css` 会在构建期失败（`tsdown.config.ts` CSS_TEXT_SUFFIX 插件只对带 importer 的 `.css` 生效）。
- **DSH 版本兼容性**：由 `package.json` 的 `engines.dsh` 与 `dsh.compatibility.dshReleases` 共同声明，插件只在指定范围内安装。
- **测试隔离**：所有测试通过临时目录覆盖 `process.env.DSH_HOME`，避免探针触碰本机真实数据根（见 `tests/assembly.test.ts` 第 951–961 行）。

## 5. 结论

本仓库的配置系统非常克制：**运行时只有单一环境变量 `$DSH_HOME`**，构建期由 `tsdown.config.ts` 控制双端产物形态与依赖内联策略，部署元信息通过 `package.json` 的 `dsh.*` 字段和 `cordis.patch.yml` 表达。没有通用的配置加载器、schema 校验或热重载机制——这与 DSH 插件作为宿主子模块的定位一致。