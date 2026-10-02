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
          include: ['tests/*.test.ts'],
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
