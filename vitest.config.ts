import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/** 平台模块 `@deepseek-ai/dsh-client-ui-primitives` 在**测试期**的替身（原因见该文件头注释：
 *  真包的 lib/index.js 顶层 import 了它自己的 devDependencies（shiki / simple-icons / katex…），
 *  不随包发布，测试进程加载不起来；装那一串等于给本仓加十条依赖）。 */
const PRIMITIVES_DOUBLE = fileURLToPath(
  new URL('./tests/client/support/platform-primitives.tsx', import.meta.url),
)

export default defineConfig({
  test: {
    // 两个 project 而不是一个全局 environment：Node 半的用例要真 `import.meta.url`
    // （`tests/skeleton.test.ts` 拿它定位 package.json），在 jsdom 下那是 http:// URL，
    // `fileURLToPath` 直接抛 "The URL must be of scheme file"。所以浏览器半单独一个 jsdom 面。
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
          alias: {
            '@deepseek-ai/dsh-client-ui-primitives': PRIMITIVES_DOUBLE,
          },
        },
      },
    ],
  },
})
