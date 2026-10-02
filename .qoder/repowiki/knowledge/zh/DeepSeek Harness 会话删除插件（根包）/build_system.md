## 1. 总体方案

这是一个 DeepSeek Harness（DSH）的 Node.js 插件包，采用 **pnpm workspace** 管理依赖、**tsdown** 做 TypeScript 编译打包、**Vitest** 跑测试。仓库没有 Makefile、Dockerfile 或 CI 配置文件；所有构建/发布动作都通过 `package.json` 中的 npm scripts 与 pnpm 约定驱动。

## 2. 关键文件

- `package.json`：入口脚本、产物路径、exports、`dsh` 插件元数据、`publishConfig`。
- `tsconfig.json`：TS 编译选项（target ES2022、module ESNext、moduleResolution Bundler），仅用于类型检查（`noEmit: true`）。
- `vitest.config.ts`：双 project 配置——`node` 环境跑 `tests/*.test.ts`，`jsdom` 环境跑 `tests/client/**/*.test.{ts,tsx}`。
- `pnpm-workspace.yaml`：定义 `minimumReleaseAgeExclude` 与 `allowBuilds`。
- `cordis.patch.yml`：供 DSH 宿主在 bundle 阶段注入的 patch。

## 3. 构建与产物

- 编译器：**tsdown**（`"build": "tsdown"`）。TypeScript 本身只做类型检查（`tsc --noEmit`，脚本名为 `typecheck`）。
- 产物目录：**`lib/`**（由 `main` 指向 `lib/index.js`、`types` 指向 `lib/index.d.ts` 体现）。
- ESM-only：`"type": "module"`，无 CJS 兼容层。
- 模块导出：通过 `exports` 字段声明主入口 `.`、客户端入口 `./client`，以及静态资源 `./locale/*.json` 和 `./package.json`。
- 预发布钩子：`prepack` 执行 `npm run build`，确保 `npm pack` / `pnpm publish` 前自动产出 `lib/`。
- 运行时要求：`engines.node >= 24`。

## 4. 测试体系

- 框架：**Vitest 3.x**，配合 jsdom 模拟浏览器环境。
- 双项目隔离（见 `vitest.config.ts`）：
  - `node` 项目：运行 `tests/*.test.ts`，使用真实 Node 环境，因为某些用例需要真实的 `import.meta.url`（注释明确说明在 jsdom 下会抛 `The URL must be of scheme file`）。
  - `client` 项目：运行 `tests/client/**/*.test.{ts,tsx}`，使用 `jsdom` 环境，setup 文件为 `./tests/client/support/setup.ts`。
- 断言库：`@testing-library/jest-dom` + `@testing-library/dom` + `@testing-library/react`。
- 无自定义 alias：注释写明自 2026-10-02 起已删除对 `@deepseek-ai/dsh-client-ui-primitives` 的 alias，改为直接引用自身 `src/client/ui/*`，避免“真产物少一个具名导出”的盲区。

## 5. 插件集成约定（`dsh` 字段）

`package.json` 中的 `dsh` 字段描述插件如何被 DSH 宿主消费：

- `bundle.patch`: `./cordis.patch.yml` —— 宿主在打包时注入 Cordis patch。
- `client.inject`: `["@deepseek-ai/dsh-client-locale"]` —— 向宿主注入 locale 能力。
- `client.platform`: `web` —— 指明客户端运行平台。
- `compatibility.dshReleases`: `{ "0.2.0-rc.2": "compatible" }` —— 显式声明与宿主版本 `0.2.0-rc.2` 兼容。

## 6. 依赖管理与约束（pnpm 策略）

`pnpm-workspace.yaml` 中有两条仓库级规则：

- `minimumReleaseAgeExclude: ['@deepseek-ai/dsh-*']`：对整个 scope 的 `@deepseek-ai/dsh-*` 包放开发布冷却期限制（注释说明：不逐版点名，避免宿主换代后静默失效）。
- `allowBuilds: { esbuild: true }`：允许 `esbuild` 运行 postinstall 构建脚本（注释解释 vitest/vite 的传递依赖需要落地平台二进制，而 pnpm 10+ 默认拒绝）。

## 7. 观察到的约束与约定

- 源码位于 `src/`，产物位于 `lib/`，二者通过 `main`/`types`/`exports` 解耦。
- 测试源码位于 `tests/`，按运行环境分两层：Node 用例放根 `tests/`，浏览器 UI 用例放 `tests/client/`。
- 本地化文案放在仓库根 `locale/*.json`，并通过 `exports` 的 glob 模式暴露给宿主。
- TS 严格模式开启（`strict`、`noUnusedLocals`、`noUnusedParameters`），但跳过第三方库检查（`skipLibCheck: true`）。
- 包元数据中 `peerDependencies` 与 `devDependencies` 分别锁定宿主依赖（`@deepseek-ai/cordis ^4.0.2`）与开发依赖（`@deepseek-ai/cordis 4.0.4`），形成“宿主用稳定版、开发用最新版”的双轨策略。
- 版本号遵循语义化版本（当前 `0.0.1`），由 Git tag / release flow 管理（仓库未内嵌自动 bump 脚本）。
- 发布范围：`publishConfig.access: public`，包名 `@xrn1997/dsh-session-delete`。

## 8. 缺失项

未发现 Dockerfile、CI 流水线（如 GitHub Actions）、Makefile、跨平台构建脚本或自动化 release/bump 工具链；这些环节可能由上游 DSH 宿主或组织级模板统一管理。