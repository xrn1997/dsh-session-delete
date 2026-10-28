/**
 * 回收站详情里的**一段会话正文 → 排版后的 DOM**。
 *
 * 为什么用 `react-markdown` 而不是自己写解析器：助手回复本身就是 markdown 源，宿主平时也是这么渲的；
 * 自己写只能覆盖到我记得的那几种语法，表格、嵌套列表、引用一深就漏（漏出来的样子是"少渲了半段"，
 * 比不渲更难查）。这条依赖是**普通 npm 包，不是宿主包**：它被 inline 进浏览器半产物，不 require、
 * 不进 `PLATFORM_MODULES`、不进 `peerDependencies`（AGENTS.md 那条"不许 import 宿主客户端包"讲的是
 * `@deepseek-ai/*`，与这条无关）。
 *
 * 三条收口：
 * ① **原始 HTML 不进 DOM**。react-markdown 默认不把 markdown 里夹的裸 HTML 变成节点（要做得显式挂
 *    `rehype-raw`，我们没挂）——所以"日志里存过一段 `<img onerror=…>`"不会在面板里被执行。
 *    实测（10.1）补一句：默认那条路是**转义成字面文本**（页面上看得见 `<img …>` 这串字符），不是丢掉；
 *    看得见是诚实（用户本来就能从会话里读到它），关键是它落成不了节点。
 * ② **链接与图片不给它开新面**：链接渲染成纯文本 + `title` 带上原 URL（面板在宿主中央列里，
 *    我们不去碰宿主的导航与 `window.open`，那是别人的地盘）；图片渲染成本地化占位（`copy.ts` 的
 *    `detail.image` / `detail.image.alt`），因为正文里的图片路径指向会话当时的 cwd，在回收站里
 *    既读不到也不该去读。
 * ③ **GFM 打开**：会话里最常出现的是表格与任务列表（`remark-gfm`）。
 */
import { memo, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Translate } from './copy.js'
// 「组件在屏幕上」必然等于「样式在场」：`.sd-md` 那张表由 `ui/styles.ts` 随模块物化注进 `<style>`，
// 所以这里跟其他 ui 组件一样走副作用导入，不指望调用方恰好也 import 了什么。
import './ui/styles.js'

/** 锚文本保留，URL 只进 `title`——不产生任何可跳转的东西。 */
const AnchorAsText = ({ href, children }: { href?: string; children?: ReactNode }) => (
  <span className="sd-md-link" title={href ?? ''}>{children}</span>
)

/** 图片在回收站里读不到（路径属于会话当时的 cwd），只把 alt 说清楚。 */
const ImageAsText = ({ alt, src, t }: { alt?: string; src?: string; t: Translate }) => (
  <span className="sd-md-image" title={src ?? ''}>
    {alt && alt !== '' ? t('detail.image.alt', { alt }) : t('detail.image')}
  </span>
)

function componentsFor(t: Translate): Components {
  return {
    a: AnchorAsText as Components['a'],
    img: ((props) => <ImageAsText {...props} t={t} />) as Components['img'],
  }
}

/**
 * `memo` 是必需的而不是优化：`react-markdown@10.1.0` 里**一处 memoization 都没有**（读实
 * `node_modules/react-markdown/lib/index.js`——`Markdown()` 每次调用都 `createProcessor(options)`
 * 再 `runSync(parse(file))`，`MarkdownHooks` 那一支也一样），而面板任何一次重渲（悬停、↑↓、
 * 「刚刚删除」那句要读 `Date.now()`）都会走到这里 ⇒ 不按住就是每条助手回复每拍重解析一遍。
 * 按住的条件是 `text` 与**探针 `localeKey`**（调用方在渲染时算好的一句固定键译文 `t('common.close')`）。
 * `t` 本身是宿主 `bind` 出来的**稳定身份**（`copy.ts` 头注），一次客户端激活只造一个——拿身份当判据，
 * 换语言就漏了：同一个 `t` 换 locale 后吐另一套词，烘进正文树的那句图片占位会滞留旧语言，而周围的
 * 标签那一拍已经改口。探针也不能在 comparator 里现调 `t` 取——宿主 `t` 读的是**当前** locale，
 * prev/next 那一拍都取到新值、恒等；只有渲染时算好存进 props 的那份才是换语言那一刻的读数。
 * 探针没变 = 同语言同 `t` ⇒ 跳过重解析；变了（换语言或换 `t`）⇒ 重解析。
 */
export const MarkdownBody = memo(function MarkdownBody({ text, t }: { text: string; t: Translate; localeKey: string }): ReactNode {
  return (
    <div className="sd-md" data-dsh-session-delete="md">
      <Markdown remarkPlugins={[remarkGfm]} components={componentsFor(t)}>
        {text}
      </Markdown>
    </div>
  )
}, (prev, next) => prev.text === next.text && prev.localeKey === next.localeKey)
