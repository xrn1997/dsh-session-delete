# Third-Party Notices

本包整体以 [Apache-2.0](LICENSE) 发布。下列文件**逐字派生**自 DeepSeek Harness
（`deepseek-ai/deepseek-harness`）中以 **MIT** 许可发布的客户端包，继续受 MIT 约束；本文件保留其
版权与许可声明，并记录来源、落点与改写。另有一部分构建期依赖被内联进 `lib/client.js`，各自的
许可证见第 2 节。

抄录代次：`@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2`（`ui.css` 与 `icon.svg` 的文件头
记录）；`ui-conversation` / `ui-workspace` 两张样式表按同一代宿主产物抄录，具体出处见 `ui.css`
头注。各副本的有意差异以文件头注为准。

## 1. 来源与落点

| 上游包（MIT） | 上游产物 | 本包中的副本 | 改写 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-client-ui-primitives` | `IconTrashOutlineRegular` 的图标形状 | `icon.svg` | 颜色写死为中灰（图片形式的 SVG 不继承 `currentColor`）；不带 `aria-hidden`（可及名由承载它的宿主卡片提供） |
| `@deepseek-ai/dsh-client-ui-primitives` | 图标集的明文产物 | `src/client/ui/icons.tsx` | 只保留本插件用到的图标；几何、`viewBox`、`strokeWidth` 不动；只暴露 `size` |
| `@deepseek-ai/dsh-client-ui-primitives` | `Button` / `Tag` / `Modal` / `Tooltip` / `Toast` / `MenuItemButton` / `Checkbox` 的明文实现，以及 `top-layer.ts` / `format.ts` | `src/client/ui/Button.tsx`、`src/client/ui/Tag.tsx`、`src/client/ui/Modal.tsx`、`src/client/ui/Tooltip.tsx`、`src/client/ui/Toast.tsx`、`src/client/ui/MenuItemButton.tsx`、`src/client/ui/Checkbox.tsx`、`src/client/ui/top-layer.ts`、`src/client/ui/format.ts` | 只收本插件用到的变体与行为；组件 API 收窄；文件头注点名与官方的差异 |
| `@deepseek-ai/dsh-client-ui-primitives` | `Button` / `Tag` / `Modal` / `Tooltip` / `Toast` / `Menu` / `Checkbox` / `DisclosureRow` 的 CSS Module 明文 | `src/client/ui/ui.css` | 类名加 `sd-` 前缀；`@keyframes` 改名；配色与几何走 `--sd-*` 别名层（解析到宿主 `--dsw-*` token）；只收用到的变体；文件头点名的七处本插件自造差异 |
| `@deepseek-ai/dsh-client-ui-primitives` | `markdown/MarkdownText.module.css`（`.markdown` 一支）、`markdown/CodeBlock.module.css`（`pre`） | `src/client/ui/markdown.css` | 选择器适配 react-markdown 产出的 DOM；文件头点名的三处有意差异 |
| `@deepseek-ai/dsh-client-ui-conversation` | `ConversationRoot.module.css` 的 `.widthHandle` 族 | `src/client/ui/ui.css` | 同上（类名前缀 / token 别名层） |
| `@deepseek-ai/dsh-client-ui-workspace` | `Rows.module.css` 的 `.iconButton` 族 | `src/client/ui/ui.css` | 同上（类名前缀 / token 别名层） |

这些副本只保留形状、布局与交互基线；本包不因收录它们而主张对上游素材的著作权。

## 2. 构建期内联的 npm 依赖

`lib/client.js` 内联了 `react-markdown`、`remark-gfm` 及其传递依赖；`react` / `react-dom` 由宿主
平台表提供，不在分发物内。本包的**生产依赖为空**（这条内联闭包住 `devDependencies`，只在构建期进产物），
所以 `pnpm licenses list --prod` 是空的；下表是 `pnpm-lock.yaml` 里从 `react-markdown` / `remark-gfm`
可达的**运行期**闭包（`@types/*` 等只在类型面出现、不进产物）。升级依赖后按同一份 lockfile 重跑
`pnpm licenses list --dev`，只取这条闭包核对并更新。

| 包 | 版本 | 许可证 | 作者 |
| --- | --- | --- | --- |
| `@ungap/structured-clone` | 1.4.0 | ISC | Andrea Giammarchi |
| `bail` | 2.0.2 | MIT | Titus Wormer |
| `ccount` | 2.0.1 | MIT | Titus Wormer |
| `character-entities` | 2.0.2 | MIT | Titus Wormer |
| `character-entities-html4` | 2.1.0 | MIT | Titus Wormer |
| `character-entities-legacy` | 3.0.0 | MIT | Titus Wormer |
| `character-reference-invalid` | 2.0.1 | MIT | Titus Wormer |
| `comma-separated-tokens` | 2.0.3 | MIT | Titus Wormer |
| `debug` | 4.4.3 | MIT | Josh Junon |
| `decode-named-character-reference` | 1.3.0 | MIT | Titus Wormer |
| `dequal` | 2.0.3 | MIT | Luke Edwards |
| `devlop` | 1.1.0 | MIT | Titus Wormer |
| `escape-string-regexp` | 4.0.0, 5.0.0 | MIT | Sindre Sorhus |
| `estree-util-is-identifier-name` | 3.0.0 | MIT | Titus Wormer |
| `extend` | 3.0.2 | MIT | Stefan Thomas |
| `hast-util-to-jsx-runtime` | 2.3.6 | MIT | Titus Wormer |
| `hast-util-whitespace` | 3.0.0 | MIT | Titus Wormer |
| `html-url-attributes` | 3.0.1 | MIT | Titus Wormer |
| `inline-style-parser` | 0.2.7 | MIT | — |
| `is-alphabetical` | 2.0.1 | MIT | Titus Wormer |
| `is-alphanumerical` | 2.0.1 | MIT | Titus Wormer |
| `is-decimal` | 2.0.1 | MIT | Titus Wormer |
| `is-hexadecimal` | 2.0.1 | MIT | Titus Wormer |
| `is-plain-obj` | 4.1.0 | MIT | Sindre Sorhus |
| `longest-streak` | 3.1.0 | MIT | Titus Wormer |
| `markdown-table` | 3.0.4 | MIT | Titus Wormer |
| `mdast-util-find-and-replace` | 3.0.3 | MIT | Titus Wormer |
| `mdast-util-from-markdown` | 2.1.0 | MIT | Titus Wormer |
| `mdast-util-gfm` | 3.1.0 | MIT | Titus Wormer |
| `mdast-util-gfm-autolink-literal` | 2.0.1 | MIT | Titus Wormer |
| `mdast-util-gfm-footnote` | 2.1.0 | MIT | Titus Wormer |
| `mdast-util-gfm-strikethrough` | 2.0.1 | MIT | Titus Wormer |
| `mdast-util-gfm-table` | 2.0.0 | MIT | Titus Wormer |
| `mdast-util-gfm-task-list-item` | 2.0.0 | MIT | Titus Wormer |
| `mdast-util-mdx-expression` | 2.0.1 | MIT | Titus Wormer |
| `mdast-util-mdx-jsx` | 3.2.0 | MIT | Titus Wormer |
| `mdast-util-mdxjs-esm` | 2.0.1 | MIT | Titus Wormer |
| `mdast-util-phrasing` | 4.1.0 | MIT | Victor Felder |
| `mdast-util-to-hast` | 13.2.1 | MIT | Titus Wormer |
| `mdast-util-to-markdown` | 2.2.0 | MIT | Titus Wormer |
| `mdast-util-to-string` | 4.0.0 | MIT | Titus Wormer |
| `micromark` | 4.0.3 | MIT | Titus Wormer |
| `micromark-core-commonmark` | 2.0.4 | MIT | Titus Wormer |
| `micromark-extension-gfm` | 3.0.0 | MIT | Titus Wormer |
| `micromark-extension-gfm-autolink-literal` | 2.1.0 | MIT | Titus Wormer |
| `micromark-extension-gfm-footnote` | 2.1.0 | MIT | Titus Wormer |
| `micromark-extension-gfm-strikethrough` | 2.1.0 | MIT | Titus Wormer |
| `micromark-extension-gfm-table` | 2.1.2 | MIT | Titus Wormer |
| `micromark-extension-gfm-tagfilter` | 2.0.0 | MIT | Titus Wormer |
| `micromark-extension-gfm-task-list-item` | 2.1.0 | MIT | Titus Wormer |
| `micromark-factory-destination` | 2.0.1 | MIT | Titus Wormer |
| `micromark-factory-label` | 2.0.1 | MIT | Titus Wormer |
| `micromark-factory-space` | 2.1.0 | MIT | Titus Wormer |
| `micromark-factory-title` | 2.0.1 | MIT | Titus Wormer |
| `micromark-factory-whitespace` | 2.0.1 | MIT | Titus Wormer |
| `micromark-util-character` | 2.1.1 | MIT | Titus Wormer |
| `micromark-util-chunked` | 2.0.1 | MIT | Titus Wormer |
| `micromark-util-classify-character` | 2.0.1 | MIT | Titus Wormer |
| `micromark-util-combine-extensions` | 2.0.1 | MIT | Titus Wormer |
| `micromark-util-decode-numeric-character-reference` | 2.0.2 | MIT | Titus Wormer |
| `micromark-util-decode-string` | 2.0.1 | MIT | Titus Wormer |
| `micromark-util-edit-map` | 1.0.0 | MIT | Titus Wormer |
| `micromark-util-encode` | 2.0.1 | MIT | Titus Wormer |
| `micromark-util-html-tag-name` | 2.0.1 | MIT | Titus Wormer |
| `micromark-util-normalize-identifier` | 2.0.1 | MIT | Titus Wormer |
| `micromark-util-resolve-all` | 2.0.1 | MIT | Titus Wormer |
| `micromark-util-sanitize-uri` | 2.0.1 | MIT | Titus Wormer |
| `micromark-util-subtokenize` | 2.1.0 | MIT | Titus Wormer |
| `micromark-util-symbol` | 2.0.1 | MIT | Titus Wormer |
| `micromark-util-types` | 2.0.3 | MIT | Titus Wormer |
| `ms` | 2.1.3 | MIT | — |
| `parse-entities` | 4.0.2 | MIT | Titus Wormer |
| `property-information` | 7.2.0 | MIT | Titus Wormer |
| `react-markdown` | 10.1.0 | MIT | Espen Hovlandsdal |
| `remark-gfm` | 4.0.1 | MIT | Titus Wormer |
| `remark-parse` | 11.0.0 | MIT | Titus Wormer |
| `remark-rehype` | 11.1.2 | MIT | Titus Wormer |
| `remark-stringify` | 11.0.0 | MIT | Titus Wormer |
| `space-separated-tokens` | 2.0.2 | MIT | Titus Wormer |
| `stringify-entities` | 4.0.4 | MIT | Titus Wormer |
| `style-to-js` | 1.1.21 | MIT | Mark |
| `style-to-object` | 1.0.14 | MIT | Mark |
| `trim-lines` | 3.0.1 | MIT | Titus Wormer |
| `trough` | 2.2.0 | MIT | Titus Wormer |
| `unified` | 11.0.5 | MIT | Titus Wormer |
| `unist-util-is` | 6.0.1 | MIT | Titus Wormer |
| `unist-util-position` | 5.0.0 | MIT | Titus Wormer |
| `unist-util-stringify-position` | 4.0.0 | MIT | Titus Wormer |
| `unist-util-visit` | 5.1.0 | MIT | Titus Wormer |
| `unist-util-visit-parents` | 6.0.2 | MIT | Titus Wormer |
| `vfile` | 6.0.3 | MIT | Titus Wormer |
| `vfile-message` | 4.0.3 | MIT | Titus Wormer |
| `zwitch` | 2.0.4 | MIT | Titus Wormer |

## 许可全文

### MIT

本节适用于第 1 节的抄本（版权人 `DeepSeek`，`Copyright (c) 2026 DeepSeek`）与第 2 节表格里的
构建期依赖（版权人见上表，各包 LICENSE 原文）。

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ISC

```text
ISC License

Copyright (c) 2021, Andrea Giammarchi, @WebReflection

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```
