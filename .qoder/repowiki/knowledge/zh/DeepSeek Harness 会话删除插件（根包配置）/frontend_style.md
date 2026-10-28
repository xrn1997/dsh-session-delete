## 概览

本仓库是 DeepSeek Harness（DSH）的一个 UI 插件，其前端使用 React + TypeScript，并通过 `react-markdown` 渲染会话正文。样式体系不引入第三方 CSS 框架（无 Tailwind、无 SCSS），而是**逐字抄录宿主 `@deepseek-ai/dsh-client-ui-primitives` 与宿主 markdown 包的原始 `.module.css` 文件**，再按官方给第三方插件的处方做三类转换后内联注入到文档 `<head>`。

构建工具为 `tsdown`（见 `package.json` 的 `build` 脚本），CSS 通过 tsdown 的 CSS import 能力以字符串形式载入，再由运行时注入一个带 `data-dsh-session-delete` 标记的 `<style>` 标签；卸载/热替换由宿主在模块物化阶段认领归档。

## 关键文件

- `src/client/ui/styles.ts` — 样式装载器：把 `ui.css` 与 `markdown.css` 合并为一个 `<style>` 注入 DOM，同时维护一份本地 `pointerModality` 标志位供 Tooltip 等组件判断最近一次输入是否来自指针。
- `src/client/ui/ui.css` — 控件层样式：Button / Tag / Modal / Tooltip / Toast / Menu / Checkbox / DisclosureRow / 宽度把手 / 行尾 iconButton / 批量浮条等，全部以 `sd-` 前缀命名。
- `src/client/ui/markdown.css` — 会话正文排版：从宿主 `dsh-client-ui-primitives` 的 MarkdownText 与 CodeBlock 模块抄来，用于 react-markdown 输出。
- `src/client/ui/top-layer.ts` — 顶层 z-index 管理（Toast / Modal / Tooltip 共享）。
- `docs/development.md` — 规定「界面保真复核门」：每次改动需与官方明文逐属性比对零差异，只允许文件头所列的已知差异项。
- `package.json` — 声明 `peerDependencies: @deepseek-ai/cordis ^4.0.4, react ^18.3.1`；`devDependencies` 仅含 `react-markdown` 与测试依赖，无任何 CSS 框架。

## 架构与约定

### 1. 样式来源与复制策略

官方文档要求第三方插件「copy markup, CSS, and behavior from the primitive into the plugin … Rename copied classes under your plugin's prefix, keep only `--dsw-alias-*` token references」。仓库完全遵循：

- **控件类名统一加 `sd-` 前缀**（原为 CSS module 哈希名，全局隔离改由前缀承担）。
- **配色一律走 token**：`--dsw-alias-label-primary`、`--dsw-alias-bg-layer-2`、`--dsw-alias-border-l3`、`--dsw-alias-state-error-primary` 等，一个颜色的十六进制字面量都没有。
- **几何量（圆角/阴影/层级）取 token**：`--dsw-radius-md`、`--dsw-elevation-prominent` 等。**只有字号、行高、间距用 px 字面量**，且与官方原文逐字一致。
- **`@keyframes` 全部改名**并加 `sd-` 前缀，因为 keyframe 是全局命名空间。
- 只抄本插件实际用到的变体（Button 的 primary/ghost/outline + md/sm 尺寸，Tag 的 danger，Modal/Tooltip/Toast/Menu/Checkbox/DisclosureRow 的全部），其余不预先铺开。

### 2. 两个独立 CSS 源

- `ui.css`：控件样式，目标是与 `dsh-client-ui-primitives` 逐属性零差异，受「界面保真复核门」约束。
- `markdown.css`：正文排版，目标与宿主 markdown 包零差异；因来源不同而独立成文件，避免污染 ui.css 的基线。

两者在 `styles.ts` 中同一趟加载：`element.textContent = \`${css}\\n${markdownCss}\``。

### 3. 运行时注入而非构建期产物

样式不是打包进 `.css` 资产，而是在模块作用域内直接 `document.createElement('style')` 注入。理由：宿主对插件的 `<style>` 有原生认领通道——在工厂物化时把插件注入的 style 归档，卸载/换代由宿主统一摘除；若挂在 `apply()` 里则晚了一拍。`data-dsh-session-delete` 既是 HMR 归档线索，也是幂等判据。

### 4. 主题与响应式

- 主题通过宿主暴露的 `--dsw-*` / `--dsh-*` CSS 自定义属性实现；插件本身不定义任何颜色值，宿主换主题时最差只是难看不会崩溃。
- 响应式仅一处：`.sd-modal-mask::after` 与 `.sd-modal-dialog` 上对 `prefers-reduced-motion: reduce` 禁用动画。
- 面板宽度由 `use-panel-width.ts` 读取宿主宽度变化，UI 层通过 CSS `max-height: 100%` 收口而非自算视口。

### 5. 顶层 z-index 与模态隔离

`top-layer.ts` 集中管理 Modal / Tooltip / Toast 的层级，避免各自散写 z-index。`styles.ts` 还维护本地 `pointerModality`（监听 `pointerdown`/`keydown`），供 Tooltip 阻止「指针交互后紧接着 focus」导致的误弹出。

## 约定与约束

- **所有类名以 `sd-` 前缀开头**（见 `ui.css` 文件头注释及全表实践）。
- **禁止在样式中使用颜色字面量**，必须引用 `--dsw-alias-*` / `--dsw-font-*` / `--dsh-content-font-*` 等宿主 token（`ui.css` 文件头三条改写规则之一）。
- **`@keyframes` 必须加 `sd-` 前缀**，避免与宿主或其他插件冲突（同上）。
- **新增控件时必须与官方 primitives 逐属性比对零差异**，差异仅允许「界面保真复核门」所列六处已知例外（见 `ui.css` 文件头列出的 .sd-resizing、focus-visible 行、iconButton aria-pressed/disabled、sd-batch-bar、选中底色兜底、sd-batch-pick-leading）。
- **正文排版差异仅限三处**（表格滚动容器缺失、代码卡 banner 圆角合并、链接 hover 下划线移除），写在 `markdown.css` 文件头说明中作为已知差异清单。
- **不复制宿主的 `pointerModality` 全局状态**：官方 `document.documentElement.dataset.inputModality` 由宿主 primitives 发布，本插件只用本地变量（见 `styles.ts` 注释）。
- **样式装载点必须是模块作用域**，不能放在 `apply()` 内，否则错过宿主认领时机（`styles.ts` 注释明确给出原因）。
- **未使用的 primitives 变体不抄**，以减少表面积（文件头明确列出 Button toolbar/lg、DisclosureRow data-state 等被有意省略的部分）。

## 不适用性说明

本仓库确实包含完整的 UI 样式子系统（React 组件 + 两份手工同步的 CSS + 运行时注入机制 + 严格的 token-only 约定），因此 `frontend_style` 类别适用，置信度为 high。