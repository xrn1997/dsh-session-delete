import { builtinModules } from 'node:module'
import { defineConfig } from 'tsdown'

const PKG_NAME = '@xrn1997/dsh-session-delete'

/** 浏览器半允许表 = 宿主**冻结平台模块表**（隔离数据根上实测，见设计稿 §9）。
 *  取数：外壳 bundle 里 `this.modules = o.create({ boot, staticModules: rM() })` 的 `rM()` 实参原文，
 *  **9 个键**（`react` / `react/jsx-runtime` / `react-dom` / `react-dom/client` / `@deepseek-ai/cordis` /
 *  `@deepseek-ai/dsh-client-store` / `@deepseek-ai/dsh-client-ui-slots` / `@deepseek-ai/dsh-client-ui-primitives` /
 *  `@deepseek-ai/dsh-client-ui-dockkit`）。
 *
 *  **收录判据**：本插件只声明兼容 `0.2.0-rc.2` 一代（peer 闸逐代开口，见 package.json），
 *  所以"各代交集"在这一代上就等于这一代的冻结表本身。**不是**把 asar 里 `"@deepseek-ai/*"` 扫出来的
 *  312 个包名并集——那是并集，抄进来等于给纯度门开 300 个豁免口；也不是
 *  其它插件跨代的 8 键子集（那是另一个插件的兼容面，不是我们的）。
 *  表内我们实际要用的是 React 家族 / `-ui-primitives`（组件与图标）/ `-ui-slots`（槽位注册）；
 *  **`@deepseek-ai/dsh-client-connection` 不在表内**：它是自带 `lib/client.js` 的动态包 row，
 *  只能由 `dsh.client.external` 的精确请求解析到自己的 row——本插件不值 import 它，
 *  客户端半若将来需要，再按 external 精确请求另裁。 */
export const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const isPlatformModule = (spec: string): boolean => PLATFORM_MODULES.includes(spec)

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((id) => `node:${id}`)])

const NODE_ENV = process.env.NODE_ENV ?? 'production'

/**
 * 构建期纯度门：浏览器半 bundle 里每个 `require` 都必须由平台模块表解答（Global Constraints）。
 * - **Node 内建闯进浏览器 bundle**：浏览器 CJS 没有模块加载器，放行 = 运行时 ReferenceError ⇒ throw。
 * - **平台表之外的 `@deepseek-ai/*` 值 import**：跨插件值 import 是生态红线，且运行时 require 落空 ⇒ throw。
 * - 其余 npm 依赖由下面 client 半的 `alwaysBundle` inline 进 bundle，不产生 require ⇒ 不拦。
 *
 * type-only import 已被擦除，到不了这道门（跨插件类型面按本仓规约走本地窄镜像）。
 * 这个函数与 `tests/skeleton.test.ts` 里的用例共用：门本身就是被测试钉住的行为。
 */
export function gateClientImport(source: string): null {
  if (NODE_BUILTINS.has(source)) {
    throw new Error(
      `client bundle purity: Node 内建 "${source}" 不能进浏览器 bundle——选依赖的 browser 导出或提供浏览器实现`,
    )
  }
  if (source.startsWith('@deepseek-ai/') && !isPlatformModule(source)) {
    throw new Error(
      `client bundle purity: "${source}" 不在平台模块表——跨插件值 import 被禁；跨插件协作走 cordis 服务（type-only import 不受此门限制）`,
    )
  }
  return null
}

export default defineConfig([
  {
    // Node 半：ESM node，`@deepseek-ai/*` 留 import（真实安装里由宿主提供），npm 依赖 inline，dts 直出
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: {
      // 归属已由 neverBundle/alwaysBundle 全量表定，onlyBundle 关闭其白名单过滤并消掉构建期 hint
      onlyBundle: false,
      neverBundle: (s) => s.startsWith('@deepseek-ai/'),
      alwaysBundle: (s) => !s.startsWith('@deepseek-ai/'),
    },
  },
  {
    // 浏览器半：CJS 单文件闭合工厂（官方 `./client` 导出的三段式 banner/intro/footer 契约）
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    // 显式定 target：不写的话 tsdown 会从 `engines.node`（`>=24`）推出 Node 目标——
    // 给浏览器 bundle 挂 Node 目标的语义是错的。这半只跑在宿主外壳的 Chromium 里。
    target: 'es2022',
    dts: false, // dts 会把 banner/footer 包进 .d.cts 弄坏解析
    sourcemap: true,
    clean: false, // Node 半已 clean；两段配置同写 lib/
    deps: {
      onlyBundle: false, // 归属已由下面两个谓词全量表定
      neverBundle: isPlatformModule, // 模块表能答的 require 留给注入的 require
      alwaysBundle: (s) => !isPlatformModule(s), // 其余全 inline（npm 依赖）
    },
    define: {
      // 四键缺一，inline 的 node 习惯依赖在浏览器 boot 抛 ReferenceError
      'process.env': '{}',
      'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
      'import.meta.env.MODE': JSON.stringify(NODE_ENV),
      'import.meta.env': JSON.stringify({ MODE: NODE_ENV }),
      // browser CJS 无模块加载器——杜绝 stray 引用解析到 Node loader
      'import.meta.resolve': 'undefined',
    },
    // CJS 输出会让部分传递依赖解析到它们的 Node 入口——浏览器条件导出必须权威
    inputOptions: {
      resolve: { conditionNames: ['browser', 'import', 'require', 'default'] },
    },
    plugins: [{
      name: 'dsh-session-delete-client-purity',
      resolveId: gateClientImport,
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      // `dsh.client` 包 `./client` 导出必须用的闭合工厂；id = package.json 的 name（scoped 包写全名）
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG_NAME)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
