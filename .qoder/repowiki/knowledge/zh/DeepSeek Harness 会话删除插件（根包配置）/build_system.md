## 1. 构建系统概览

本项目是一个面向 DeepSeek Harness (DSH) 的插件包，使用 **pnpm** 作为包管理器（`packageManager: "pnpm@11.25.0"`），用 **tsdown** 同时编译 Node 端与浏览器端产物，TypeScript 类型声明由 `tsc -p tsconfig.build.json` 单独产出，测试通过 **vitest** 运行，发布走 npm（`publishConfig.access: public`）并由 DSH 宿主通过 `cordis.patch.yml` 注册。

## 2. 关键文件

- `package.json`：脚本、依赖、`dsh.bundle.patch`、`dsh.client.inject/platform/compatibility`、`files` 精确清单。
- `tsdown.config.ts`：双端 tsdown 配置、CSS 文本插件、浏览器端纯度门 (`gateClientImport`)、vfile 分支解析修补。
- `tsconfig.json` / `tsconfig.build.json`：TS 类型检查与构建时类型输出分离。
- `.github/workflows/ci.yml`：GitHub Actions 流水线。
- `cordis.patch.yml`：向宿主 Cordis 注入插件条目。

## 3. 架构与约定

### 3.1 双端产物模型

tsdown 定义两段 entry，均输出到 `lib/`：

| 半 | entry | format | platform | target | 文件名 |
|---|---|---|---|---|---|
| Node 端 | `src/index.ts` | ESM | node | es2024 | `lib/index.js` + `lib/types/...` |
| 浏览器端 | `src/client/index.tsx` | CJS | browser | es2022 | `lib/client.js` |

Node 端 `main: lib/index.js`，浏览器端通过 `exports["./client"]` 暴露 `lib/client.js`；`files` 字段只打包 `lib/index.js`、`lib/client.js`、`lib/types/**/*.d.ts`、`locale`、`icon.svg`、`cordis.patch.yml`、`README.md`、`LICENSE`，其余源码和构建中间文件不进入发布的 npm 包。

浏览器端产物是**单文件 CJS 闭包工厂**，带官方契约要求的 banner/intro/footer：
```js
window.__ModuleLoader__.load({ id: "@xrn1997/dsh-session-delete", factory: (require) => { var module = { exports: {} }; var exports = module.exports; ... return module.exports; } });
```
这要求 tsdown 以 CJS 模式输出且 `dts: false`，避免 `.d.cts` 把 banner/footer 吞进去。

### 3.2 依赖内联策略

- Node 端：`neverBundle: s => s.startsWith('@deepseek-ai/')`，所有 `@deepseek-ai/*` 保留为 `import`（由宿主安装提供），其余 npm 依赖 `alwaysBundle` inline。
- 浏览器端：`neverBundle: isPlatformModule`（仅 `react`、`react/jsx-runtime`、`react-dom`），其余全部 inline。这三者必须是宿主的同一模块实例，因此不能 inline。
- `onlyBundle: false` 关闭 tsdown 默认白名单过滤，改用全量表断言归属。

### 3.3 浏览器端纯度门

`tsdown.config.ts` 导出 `gateClientImport(source)`，在 resolveId 钩子里拦截每个 require 来源：

- 若 source 属于 Node 内置模块集合（`builtinModules` 及其 `node:` 前缀），抛错："client bundle purity: Node 内建 … 不能进浏览器 bundle"。
- 若 source 以 `@deepseek-ai/` 开头但不在 `PLATFORM_MODULES` 白名单中，抛错："跨插件值 import 被禁"。

该函数与 `tests/skeleton.test.ts` 共用，测试用例钉住此行为——任何新增的 Node 内建或跨插件 require 都会导致构建失败。

### 3.4 CSS 处理

浏览器端通过自定义 tsdown 插件 `cssTextPlugin` 将 `.css` 文件读成字符串并 `export default "…"`，再在运行时以 `<style>` 注入。为避免 tsdown 自带的 `tsdown:css-guard` 拦截，插件重写模块 id 为 `<path>?dsh-css-text`，使正则 `/\.(css)$/` 不再命中。该插件只在浏览器端配置挂载，Node 端 import `.css` 会直接报错——这是有意为之的约束：样式只属于浏览器半。

### 3.5 vfile 分支修补

`resolveBrowserBranchImport` 将 vfile/unified/react-markdown 传递依赖中的 `#minpath`、`#minproc`、`#minurl` 三个内部请求重定向到同目录下的 `.browser.js` 实现，防止 rolldown 按 Node 条件解析 `node:path` 触发纯度门。若键名变化则回退默认解析，让纯度门重新响铃。

### 3.6 构建脚本链

```json
"build": "tsdown && tsc -p tsconfig.build.json",
"typecheck": "tsc --noEmit",
"test": "vitest run",
"prepack": "npm run build"
```
`prepack` 保证 `npm pack` 之前先清理并重建 `lib/`；`tsc` 排在 tsdown 之后是因为 tsdown 的 `clean: true` 会先抹掉整个 `lib/`。

### 3.7 版本与兼容性

- 版本号位于 `package.json.version`（当前 `0.4.0`），由 Git tag 驱动发版（见最近提交 `chore: 发版 0.4.0`）。
- 宿主兼容矩阵通过 `package.json.dsh.compatibility.dshReleases` 显式声明（`0.2.0-rc.2` ~ `0.2.1-rc.3` 标记为 `compatible`），而非语义范围。
- `engines.dsh` 给出宿主最低/最高版本约束（`>=0.1.7-rc.2 <0.3.0-0`）。

### 3.8 宿主集成

`cordis.patch.yml` 向宿主 Cordis 插入一个插件条目：
```yaml
- insert:
    - id: session-delete
      name: '@xrn1997/dsh-session-delete'
```
配合 `package.json.dsh.bundle.patch` 指向同一文件，告知 DSH 宿主在安装时应用此补丁。

## 4. 约定与约束

- **包管理器锁定**：CI 执行 `pnpm install --frozen-lockfile`，禁止隐式变更 `pnpm-lock.yaml`。
- **Node 版本**：CI 固定 `node-version: 24`，与 `engines.node >=24` 一致。
- **CI 门禁顺序**：checkout → pnpm setup → node setup → `pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm test` → `pnpm build` → `npm pack --dry-run`；任一阶段失败即阻断合并。
- **并发控制**：`concurrency.group: ci-${{ github.ref }}` + `cancel-in-progress: true`，同一 ref 的新推送会取消旧任务。
- **权限最小化**：`permissions.contents: read`，仅读取仓库内容。
- **浏览器端不可引入 Node 内建或任意 `@deepseek-ai/*` 值模块**：由 `gateClientImport` 在构建期强制，错误信息明确区分两类违规。
- **样式只能出现在浏览器端**：Node 端 tsdown 配置未挂载 `cssTextPlugin`，import `.css` 会在构建期失败。
- **平台模块仅限 React 三键**：`PLATFORM_MODULES = ['react', 'react/jsx-runtime', 'react-dom']`，注释明确指出它们必须与宿主外壳持有的同一模块实例。
- **浏览器端目标固定为 es2022**：避免 tsdown 从 `engines.node` 误推 Node 目标。
- **产物不含 sourcemap**：两端都设 `sourcemap: false`，且 `files` 不收录 map，防止装包后 devtools 请求不存在文件。
- **`lib/` 每次 Node 端构建前清空**：Node 端 `clean: true`，浏览器端 `clean: false` 复用同一目录。
- **浏览器端 `process.env` 等全局被置空**：`define` 注入 `process.env: '{}'`、`import.meta.resolve: 'undefined'`，杜绝 stray 引用解析到 Node loader。
- **Cordis 插件注册**：通过 `cordis.patch.yml` 的 `insert` 条目注入，id 为 `session-delete`，name 为 scoped package 名。

## 5. 不适用项

无 Makefile、Dockerfile、cross-compile 或 shell 构建脚本；所有构建逻辑集中在 `tsdown.config.ts` 与 `package.json` scripts 中。