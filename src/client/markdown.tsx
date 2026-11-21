/**
 * 回收站详情里的**一段会话正文 → 排版后的 DOM**。用 `react-markdown`（普通 npm 包，inline 进浏览器半
 * 产物，不是宿主包）。三条收口：① 原始 HTML 不进 DOM（默认转义成字面文本、落不成节点）；② 链接与图片
 * 不给它开新面（链接渲染成纯文本 + `title`，图片本地化占位——正文图片路径属于会话当时的 cwd）；
 * ③ 打开 GFM（表格与任务列表）。
 */
import { memo, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Translate } from './copy.js'
// `.sd-md` 那张表由 `ui/styles.ts` 随模块物化注进 `<style>`，所以走副作用导入，不指望调用方也 import 了什么。
import './ui/styles.js'

/** 锚文本保留，URL 只进 `title`——不产生任何可跳转的东西。 */
const AnchorAsText = ({ href, children }: { href?: string; children?: ReactNode }) => (
  <span className="sd-md-link" title={href ?? ''}>{children}</span>
)

/** 图片在回收站里读不到（路径属于会话当时的 cwd），只把 alt 说清楚。 */
const ImageAsText = ({ alt, src, t }: { alt?: string | undefined; src?: string | undefined; t: Translate }) => (
  <span className="sd-md-image" title={src ?? ''}>
    {alt && alt !== '' ? t('detail.image.alt', { alt }) : t('detail.image')}
  </span>
)

function componentsFor(t: Translate): Components {
  // `Components` 的可选键在 EOPT 下不含显式 undefined；这里挂进去的永远是组件本体，取值面按非 undefined 收窄。
  return {
    a: AnchorAsText as NonNullable<Components['a']>,
    img: ((props) => <ImageAsText {...props} t={t} />) as NonNullable<Components['img']>,
  }
}

/**
 * `memo` 是必需的而不是优化：`react-markdown@10.1.0` 里**一处 memoization 都没有**，面板任何一次重渲
 * （悬停、↑↓、「刚刚删除」那句要读 `Date.now()`）都会走到这里 ⇒ 不按住就是每条助手回复每拍重解析一遍。
 * 按住条件是 `text` 与探针 `probe`（按当前 locale 现算的译文，专给 comparator 当「换语言了没」的读数；
 * 「借哪句」的知识住 `copy.ts` 的 `localeProbe`，调用方一律 `probe={localeProbe(t)}`）。
 */
export const MarkdownBody = memo(function MarkdownBody({ text, t }: { text: string; t: Translate; probe: string }): ReactNode {
  return (
    <div className="sd-md" data-dsh-session-delete="md">
      <Markdown remarkPlugins={[remarkGfm]} components={componentsFor(t)}>
        {text}
      </Markdown>
    </div>
  )
}, (prev, next) => prev.text === next.text && prev.probe === next.probe)
