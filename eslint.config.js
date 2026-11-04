import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * 本仓的机器门。
 *
 * 分工：`tsc` 管类型形状与可赋值性（`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、
 * `erasableSyntaxOnly` 这些档位现在都在 tsconfig 里），ESLint 管 tsc 看不见的一类——
 * 显式 `any`、从边界渗进来的 `any`、悬浮 Promise、非空断言。所以要用**类型感知**规则集：
 * `no-unsafe-*` 拿不到类型信息就没有意义（姊妹仓 dsh-novel 的教训：那边把这条归属写成
 * 「由 tsc 档位管」，而 tsc 从不拒绝显式 `any`）。
 *
 * `react-hooks` 两条是 error：浏览器半的槽位注册与写回结算靠依赖数组正确，deps 写错是
 * 「界面停在旧值」这类最难复现的缺陷。存量豁免按 `eslint-disable` + 理由逐条落，生产代码不开目录级
 * 降级；唯一的目录级例外是 `tests/**` 的 `require-await`，理由写在那一块里。
 *
 * 不写格式类规则：仓内没有格式化工具，ESLint 代替它立规只会和既有排版打架。
 */
export default tseslint.config(
  { ignores: [
    'lib/**',
    'node_modules/**',
    '.qoder/**',
    'compat/**',
    'docs/**',
    // 本机过程工件与隔离工作区（见 .gitignore）：不是仓库事实，也不是类型感知语料的输入。
    // 少了这几条，按 CONTRIBUTING 把采样脚本放进 .superpowers/.task-scratch 会让 `eslint .` 在
    // 规则加载阶段直接崩，`pnpm gates` 红；.worktrees/ 则会把整棵第二工作树当源码扫。
    '.superpowers/**',
    '.task-scratch/**',
    '.worktrees/**',
    '.dsh-vision-toolkit/**',
  ] },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,

  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',

      // 点名写出这两条：已由 strictTypeChecked 隐含打开，写出来是为了让「本仓的门」
      // 在配置里现查得到，而不是靠读者记住某个预设集包含哪些规则。
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',

      // 数字插值是本仓既有写法（错误信息里带字节数、偏移、id）。strict 档默认关掉它，
      // 代价是把正当读数改成 String(x) 噪音。
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],

      // 本仓已用 `_path` / `_a` 这类下划线占位表示「形状要、值不用」；只放行参数位的下划线名字，
      // 变量与导入仍按原规则报（否则「忘了用」会被误导成故意）。
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // 关掉：它挡的是「箭头简写顺手返回了 void」这类可读性问题，不挡任何缺陷类
      // （实测本仓 101 处，改法一律是给简写加大括号）。按基线第 1 节判据——
      // 只改写法、不改变缺陷类的规则没有资格占门。
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-meaningless-void-operator': 'off',
    },
  },

  {
    // 一次性脚本与配置入口不参与包发布，也不承载运行时不变量；类型感知规则对它们
    // 的收益低于成本（tsdown / vitest 两份在 tsconfig 的 include 内，本文件连 program 都不进；
    // 三者都不落进产物、也不被应用代码 import）。
    files: ['tsdown.config.ts', 'vitest.config.ts', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },

  {
    // 测试替身里 `vi.fn(async (…) => …)` 的 `async` 就是为了回一个 Promise，
    // 体内没有 await 是正确形态。生产代码保持这条在线。
    files: ['tests/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
)
