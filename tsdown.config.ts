import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const PKG_NAME = '@xrn1997/dsh-session-delete'

/** 浏览器半允许表 = **本插件真正 require 的宿主冻结平台模块**（宿主外壳里 `staticModules` 的实参，
 *  隔离数据根上实测过原文，见设计稿 §9）。
 *
 *  **2026-10-02 收窄**：上一版是那张表的全部 9 个键（含 `@deepseek-ai/dsh-client-ui-primitives` 与
 *  `-ui-slots` / `-store` / `-dockkit` / `@deepseek-ai/cordis`）。现在本插件**不再 require 任何
 * 宿主客户端包**（控件与图标已按官方处方固化成 `src/client/ui/*`，见那里的头注），所以允许表收到
 *  只剩 React 家族三个键。
 *
 *  **为什么收窄而不是留着**：这张表是**纯度门的白名单**。留着 `-ui-primitives` 就等于给"再 import
 *  它一次"留着口子，而那条路正是我们这次要拆掉的（它随宿主换代而变、不经类型检查，一个抛错的组件
 *  会把整个槽位条目打空）。**白名单只列在用的**，多出来的每一条都是纯度门的一次豁免。
 *
 *  三个键都是各代宿主的交集：React 的**模块身份**必须与外壳自己那份同一（否则 hooks 在两个 React
 *  实例间崩），所以它只能由冻结表解答，不能 inline。 */
export const PLATFORM_MODULES = ['react', 'react/jsx-runtime', 'react-dom']

const isPlatformModule = (spec: string): boolean => PLATFORM_MODULES.includes(spec)

/**
 * `.css` → 「一段字符串」的构建插件（只有浏览器半挂它）。
 *
 * 为什么要它：本插件的控件样式住在 `src/client/ui/ui.css`（可读、可 review 的真 CSS），而浏览器半
 * 的产物是**单文件 CJS 闭包工厂**，没有 CSS 资产通道——样式必须在运行时以 `<style>` 文本注入
 * （宿主的模块表会在工厂物化时认领这些 `<style>`，见 `src/client/ui/styles.ts` 头注）。这个插件就是
 * 把文件内容变成 `export default "<文本>"` 的那一步，`ui/styles.ts` 导入它即可。
 *
 * **为什么走"改 id"而不是直接 `load`**：tsdown 自带一道 `tsdown:css-guard`（`transform`，`order:'post'`，
 * 按 id 正则 `/\.(css|less|…)$/` 命中即抛「请装 @tsdown/css」）。`transform` 永远排在 `load` 之后，
 * 所以光在 `load` 里返回 JS 文本挡不住它——**必须让这个模块的 id 不再以 `.css` 结尾**。
 * 于是 `resolveId` 把它改写成 `<绝对路径>?dsh-css-text`，`load` 认这个后缀。
 * 本仓不引新依赖（`@tsdown/css` 不在依赖里，也不会进），这道 guard 对我们是纯噪音。
 *
 * **只对 `.css` 生效**，且 Node 半那条配置不挂它 ⇒ 哪天有人在 `src/index.ts` 里 import 了 `.css`，
 * 构建期会**响亮失败**（这正是想要的：样式只属于浏览器半）。
 */
const CSS_TEXT_SUFFIX = '?dsh-css-text'

const cssTextPlugin = {
  name: 'dsh-session-delete-css-text',
  resolveId(id: string, importer: string | undefined): string | null {
    if (!id.endsWith('.css') || importer === undefined) return null
    const file = id.startsWith('.') ? resolve(dirname(importer), id) : id
    return `${file}${CSS_TEXT_SUFFIX}`
  },
  load(id: string): string | null {
    if (!id.endsWith(CSS_TEXT_SUFFIX)) return null
    const path = id.slice(0, -CSS_TEXT_SUFFIX.length)
    return `export default ${JSON.stringify(readFileSync(path.startsWith('file:') ? fileURLToPath(path) : path, 'utf8'))}`
  },
}

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
    plugins: [
      cssTextPlugin,
      {
        name: 'dsh-session-delete-client-purity',
        resolveId: gateClientImport,
      },
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      // `dsh.client` 包 `./client` 导出必须用的闭合工厂；id = package.json 的 name（scoped 包写全名）
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG_NAME)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
