## 1. 使用的样式方案

本插件的 UI 不依赖宿主提供的 `@deepseek-ai/dsh-client-ui-primitives` 包，而是**逐条抄录该包的明文 CSS**（Button、Tag、Modal、Tooltip、Toast、Menu 行等），并放入本仓库的 `src/client/ui/ui.css`。这是一个针对 Cordis/DSH 第三方 UI 插件的特殊约束：官方文档要求「copy markup, CSS, and behavior from the primitive into the plugin … Rename copied classes under your plugin's prefix, keep only `--dsw-alias-*` token references」，原因是宿主随版本升级会改类名且不进行类型检查，直接引用会导致组件抛错并把整个 slot 条目打空。

构建侧使用 `tsdown`（见 `package.json` scripts）打包，无 Tailwind、Sass、PostCSS 等预处理链；样式以纯 `.css` 文件存在，由宿主在运行时注入到插件的 shadow DOM / iframe 中。

## 2. 关键文件

- `src/client/ui/ui.css` — 唯一的全局样式源，集中存放 Button、Tag、Modal、Tooltip、Toast、Menu 行的样式片段。
- `src/client/ui/css.d.ts` — 为 TSX 中通过 `import './ui.css'` 引入样式提供模块声明（允许把 CSS 作为 TS module 引入）。
- `package.json` 的 `dsh.client.inject` 字段声明注入 `@deepseek-ai/dsh-client-locale`，同时 `dsh.compatibility.dshReleases` 锁定与 DSH `0.2.0-rc.2` 兼容。
- `node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/*.module.css` — 被逐条对照抄录的原始样式来源（仅 devDependency，非运行时依赖）。

## 3. 架构与约定

### 3.1 命名空间隔离：全部 `sd-` 前缀
所有复制而来的类名都加上了 `sd-` 前缀（如 `.sd-button`、`.sd-tag-danger`、`.sd-modal-root`、`.sd-toast`、`.sd-menu-item`），替代原 CSS Module 生成的哈希类名。这是样式层面的命名空间隔离，避免与宿主的同名类发生冲突。

### 3.2 颜色与几何走 Design Token
样式文件中**不存在任何颜色的字面量（hex/rgb）**——配色一律通过 `var(--dsw-alias-*)` 与 `var(--ds-*)` 变量读取：
- 文字色：`--dsw-alias-label-primary`
- 按钮填充：`--dsw-alias-button-primary-fill`、`--dsw-alias-button-primary-hover`
- 背景/遮罩：`--dsw-alias-bg-layer-2`、`--dsw-alias-bg-mask-1`
- 边框：`--dsw-alias-border-l3`
- 交互态：`--dsw-alias-interactive-bg-hover`、`--dsw-alias-interactive-bg-active`
- 状态色：`--dsw-alias-state-error-primary`
- 圆角/阴影/层级：`--dsw-radius-md`、`--dsw-radius-panel`、`--dsw-elevation-prominent`、`--dsw-mask-blur`
- 动效时长与缓动：`--ds-transition-duration`、`--ds-ease-in-out`

唯一例外是字号、行高、间距等几何值（如 `14px`、`22px`、`36px`、`999px`、`24px`），这些保留为字面量，与官方原文保持一致。

### 3.3 动画 keyframes 重命名
所有 `@keyframes` 都加了 `sd-` 前缀（如 `sd-modal-enter`），因为 keyframes 是全局命名空间，撞名会互相覆盖。

### 3.4 最小化裁剪
只复制本插件真正用到的子集：Button 的 `primary`/`ghost`/`outline` 三档与 `md`/`sm` 两号尺寸（没有 `toolbar` 变体、没有 `lg`）、Tag 的 `danger` 一档、Modal 的全部骨架、Tooltip 的三个方位、Toast 全部、Menu 行（含 danger 态与 separator）。未使用的变体不预先铺开。

### 3.5 宿主适配钩子
样式通过 CSS 自定义属性桥接宿主框架：
- `--dsh-frame-overlay-top` / `--dsh-frame-chrome-top`：让 Modal 蒙层避让宿主窗口标题栏。
- `max(24px, var(--dsh-frame-overlay-top, 24px))`：保证至少留 24px 边距。

### 3.6 可访问性
遵循宿主设计系统的无障碍约定：
- `@media (prefers-reduced-motion: reduce)` 下禁用动画。
- Modal 关闭焦点环 `outline: none`（由宿主接管聚焦管理）。
- 语义化标签（`<button>`、`<dialog>` 风格结构）配合宿主 a11y 实现。

## 4. 约定与约束

- **规则（来自注释引用的官方实践 cordis-plugin-development/references/practices.md）：** 第三方 UI 插件必须从 primitives 包复制 markup、CSS 和行为，并将类名重命名为带插件前缀的形式，仅保留 `--dsw-alias-*` token 引用。
- **规则（代码内三条改写规则）：**
  1. 所有类名统一加 `sd-` 前缀。
  2. 配色与几何一律走 token，禁止出现颜色字面量；字号/行高/尺寸保留 px 字面量且与官方 CSS 一致。
  3. 所有 `@keyframes` 改名加 `sd-` 前缀以避免全局命名冲突。
- **约束（构建产物）：** 样式随 tsdown 打包进 `lib/` 目录（见 `files` 字段），最终通过宿主 Cordis 机制注入到插件槽位。
- **约束（兼容性）：** `package.json` 的 `dsh.compatibility.dshReleases` 将自身声明为与 DSH `0.2.0-rc.2` 兼容，样式中的 token 名称与之绑定。
- **约束（依赖边界）：** 插件不再把 `@deepseek-ai/dsh-client-ui-primitives` 作为运行时 peer/dev 依赖；其 CSS 是静态复制品，随插件发布。