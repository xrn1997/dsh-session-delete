## 总体方案

本仓库是一个 DeepSeek Harness (DSH) 插件，使用 **pnpm** 作为唯一的包管理器与依赖解析器；没有 Go/Node `vendor` 目录、没有私有 registry 配置，依赖全部从 npm 公共源获取。构建产物由 `tsdown`（打包 JS）+ `tsc -p tsconfig.build.json`（产出 `.d.ts`）双轨生成，发布到 npm。

## 关键文件

- `package.json` — 声明包元数据、运行时依赖、peer/devDependencies、DSH 扩展字段 (`dsh.bundle.patch`、`dsh.client.inject`、`dsh.compatibility.dshReleases`)、`publishConfig.access=public`。
- `pnpm-workspace.yaml` — 仅两个工作区级策略：`minimumReleaseAgeExclude: ['@deepseek-ai/dsh-*']`（放行 DSH 生态包的 24h 冷却），`allowBuilds.esbuild: true`（允许 esbuild 的 postinstall 写平台二进制）。
- `pnpm-lock.yaml` — pnpm 锁文件，锁定所有依赖精确版本。
- `src/deps.ts` — 运行期依赖面（`CoreDeps` / `DeleteSessionDeps` / `RemovalDeps` / `DeleteDeps`）通过 TypeScript interface 描述，而非运行时注入容器；组合根装配后传入各动词。

## 依赖分层与约束

| 类别 | 包名 | 作用 |
|---|---|---|
| peerDependencies | `@deepseek-ai/cordis ^4.0.4`、`react ^18.3.1` | 由宿主 DSH 提供，不随插件安装 |
| dependencies | `react-markdown ^10.1.0`、`remark-gfm ^4.0.1` | 客户端渲染 Markdown |
| devDependencies | vitest、tsdown、typescript、jsdom、testing-library/*、@types/* 等 | 测试与类型检查 |

`engines.node >=24` + `engines.dsh '>=0.1.7-rc.2 <0.3.0-0'` 在 `npm install` 时强制 Node 与宿主版本范围；`dsh.compatibility.dshReleases` 显式列出兼容的 DSH 预发行版本（0.2.0-rc.2 ~ 0.2.1-rc.3），作为插件对宿主的兼容性清单。

## 约定与规则

1. **包管理器锁定**：`packageManager: "pnpm@11.25.0"` 要求开发者与 CI 使用固定版本的 pnpm，配合 `pnpm-lock.yaml` 保证可重现安装。
2. **依赖只读入口**：业务模块禁止直接 import 外部库绕过依赖面；`src/deps.ts` 集中定义 `CoreDeps` 等接口，将文件系统、宿主、ledger、时钟等能力以接口形式注入，降低耦合（见注释“动词之间不互相 import 依赖面 interface”）。
3. **DSH 插件契约**：`dsh.bundle.patch` 指向 `cordis.patch.yml`，`dsh.client.inject` 注入 `@deepseek-ai/dsh-client-locale`，`dsh.client.platform: "web"` 声明前端运行环境。
4. **冷却闸放行**：`pnpm-workspace.yaml` 中 `minimumReleaseAgeExclude: ['@deepseek-ai/dsh-*']` 整 scope 放行，避免 DSH 生态的预发行包被 pnpm 24h 冷却拦截；注释明确说明逐版名单在宿主换代时会静默失效，因此选择整 scope 策略。
5. **构建脚本白名单**：`allowBuilds.esbuild: true` 是 pnpm 10+ 默认拒绝运行构建脚本后的显式白名单，用于让 vitest/vite 传递依赖中的 esbuild postinstall 能落地平台二进制。
6. **发布物裁剪**：`files` 字段仅包含 `lib/index.js`、`lib/client.js`、`lib/types/**/*.d.ts`、`locale`、`icon.svg`、`cordis.patch.yml`、`README.md`、`LICENSE`，其他源码与测试不会被发布。
7. **prepack 钩子**：`prepack` 脚本执行 `npm run build`，确保发布前自动完成 tsdown + tsc 构建。
8. **TypeScript 双配置**：`tsconfig.json` 用于 IDE/typecheck，`tsconfig.build.json` 供构建流程单独引用，隔离编译目标与 `lib/` 输出路径。