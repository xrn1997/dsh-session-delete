## 1. 使用的系统与工具

- **包管理器**：pnpm（由根目录 `pnpm-lock.yaml`、`pnpm-workspace.yaml` 确认）。
- **构建工具**：`tsdown`（`package.json` scripts 中 `build: tsdown`），TypeScript 5.9.3。
- **测试运行器**：vitest 3.2.7，配合 jsdom、@testing-library/*。
- **发布配置**：`publishConfig.access = public`，通过 npm 公共注册表发布；仓库未出现 `.npmrc`/`.pnp*` 等私有 registry 配置。
- **宿主集成**：作为 DeepSeek Harness (DSH) 插件发布，通过 `dsh.bundle.patch` 指向 `cordis.patch.yml`，并通过 `peerDependencies` 与宿主共享运行时依赖。

## 2. 关键文件

- `package.json`：唯一的依赖清单，定义 `peerDependencies`、`devDependencies`、`engines.node >= 24`、`exports` 多入口、`files` 白名单以及 `dsh.*` 插件元数据。
- `pnpm-workspace.yaml`：workspace 级别策略，包含版本冷却放行与构建脚本允许列表。
- `pnpm-lock.yaml`：锁定所有依赖解析结果。
- `tsconfig.json` / `vitest.config.ts`：类型与测试环境的依赖相关配置。

## 3. 架构与约定

### 3.1 运行时 vs 开发时依赖分离

- 仅宿主与浏览器运行时所需的库放在 `peerDependencies`：`@deepseek-ai/cordis ^4.0.2`、`react ^18.3.1`。这意味着插件**不打包** React/Cordis，而是复用宿主已提供的实例，避免重复加载。
- 其余全部放入 `devDependencies`：构建工具（tsdown、typescript）、测试工具（vitest、jsdom、@testing-library/*）、React 运行时副本（供测试使用）。

### 3.2 多入口导出

`package.json` 的 `exports` 字段定义了三个入口：
- `.` → `lib/index.js`（主 API）
- `./client` → `lib/client.js`（浏览器端 UI）
- `./locale/*.json` → `locale/*.json`（本地化文案）
- `./package.json` → `package.json`（供宿主读取插件元信息）

`files` 白名单限制发布产物为 `lib`、`locale`、`icon.svg`、`cordis.patch.yml`、`README.md`、`LICENSE`，确保源码与构建中间产物不会被误发。

### 3.3 DSH 插件元数据

`package.json` 中的 `dsh` 字段声明插件如何被宿主消费：
- `bundle.patch` → `cordis.patch.yml`（通过 esbuild patch 机制集成 Cordis）
- `client.inject` → `['@deepseek-ai/dsh-client-locale']`（注入宿主 locale 客户端）
- `client.platform` → `'web'`
- `compatibility.dshReleases` → 显式声明对 `0.2.0-rc.2` 兼容

### 3.4 Node 引擎约束

`engines.node >= 24` 强制要求宿主或开发者使用 Node ≥ 24，这与当前 pnpm 生态及依赖包的现代语法需求一致。

## 4. 约定与约束

### 观察到的约定

1. **peerDependencies 与 devDependencies 中的 react 版本保持严格一致**（均为 `18.3.1`），以避免宿主与测试环境出现双份 React 实例。
2. **@deepseek-ai/cordis** 在 `peerDependencies` 中用范围 `^4.0.2`，在 `devDependencies` 中钉死 `4.0.4`，体现“宿主提供运行时、开发时使用最新可用版本”的策略。
3. 所有第三方依赖在 `package.json` 中以**精确版本号**（除 peerDependency 的范围外）声明，并由 `pnpm-lock.yaml` 进一步锁定树形结构。
4. 测试依赖与生产依赖完全隔离——`tests/` 下的代码只引入 `devDependencies` 中的库。

### 明确规则（有 enforce 来源）

1. **Node 版本下限**：`package.json` 的 `engines.node >= 24`，由 pnpm 在安装时校验（`engines.strict` 默认开启时会在安装失败）。[来源：`package.json`]
2. **发布前必须构建**：`prepack` script 执行 `npm run build`，即 `tsdown`，否则发布的 `lib/` 为空。[来源：`package.json` scripts.prepack]
3. **构建产物白名单**：只有 `files` 数组中列出的路径会被发布到 npm，其他源码不会随包分发。[来源：`package.json` files]
4. **ESBuild 构建脚本允许**：`pnpm-workspace.yaml` 中 `allowBuilds.esbuild: true`，因为 vitest/vite 的传递依赖需要运行 esbuild 的 postinstall 来下载平台二进制；若关闭则安装失败。[来源：`pnpm-workspace.yaml`]
5. **@deepseek-ai/dsh-* 包绕过发布冷却闸**：`minimumReleaseAgeExclude` 对整个 scope 放行，避免 DSH 宿主在 24h 冷却窗口内因版本过新而被 pnpm 拒绝安装。注释明确指出逐版放行会因宿主换代而静默失效，因此采用整 scope 放行。[来源：`pnpm-workspace.yaml` 注释与配置]
6. **Peer dependency 版本范围**：宿主可通过满足 `^4.0.2` 的 cordis 与 `^18.3.1` 的 react 与之协作，这是插件契约的一部分。[来源：`package.json` peerDependencies]

### 未见的内容

- 无 `vendor/` 或 `node_modules` 外的 vendoring 策略。
- 无私有 npm registry、`pnpmfile.js`、`.npmrc` 或 `NPM_TOKEN` 等认证配置。
- 无依赖更新自动化（如 Dependabot、Renovate）配置文件。