import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 两个 project 而不是一个全局 environment：Node 半的用例要真 `import.meta.url`
    // （`tests/skeleton.test.ts` 拿它定位 package.json），在 jsdom 下那是 http:// URL，
    // `fileURLToPath` 直接抛 "The URL must be of scheme file"。所以浏览器半单独一个 jsdom 面。
    //
    // 这里**不再有 alias**：浏览器半曾经把 `@deepseek-ai/dsh-client-ui-primitives` 整个替身掉
    // （真包的 `lib/index.js` 顶层 import 了它自己的 shadcn/katex 等一堆不随包发布的依赖，测试进程加载不起来）。
    // 2026-10-02 起本插件自己拥有那层控件（`src/client/ui/*`），替身连同 alias 一起删了——
    // 顺带消掉那条替身固有的盲区："真产物少一个具名导出"在 alias 下是免疫的。
    projects: [
      {
        test: {
          name: 'node',
          // 整棵 `tests/` 都算 Node 面，只把浏览器半那一支让给下面的 jsdom project：
          // 逐目录点名（`tests/*.test.ts` + 各子目录）会在新加一层时悄悄漏跑整批用例。
          // `exclude` 是**替换**默认表而不是往里加，所以 `node_modules` / `dist` 那两条得自己留着。
          include: ['tests/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', 'tests/client/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'client',
          include: ['tests/client/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['./tests/client/support/setup.ts'],
        },
      },
    ],
  },
})
