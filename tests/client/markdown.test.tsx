// 详情正文的 markdown 那一层（2026-10-15 真机反馈后新增）。
// 这里只管"一段 markdown 源 → 什么 DOM"，把三条收口钉住：原始 HTML 不进 DOM、链接与图片不开新面。
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MarkdownBody } from '../../src/client/markdown.js'

const body = (text: string) => render(<MarkdownBody text={text} />)

describe('回收站详情 · markdown 正文', () => {
  it('块级结构真的被渲出来（标题/列表/粗体/表格），不是一整块纯文本', () => {
    const { container } = body('# 标题\n\n- 第一项\n- **第二项**\n\n| 列 | 值 |\n| --- | --- |\n| a | 1 |')
    expect(container.querySelector('h1')?.textContent).toBe('标题')
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(container.querySelector('strong')?.textContent).toBe('第二项')
    // GFM 表格：没开 remark-gfm 的话这五行会原样留成一段文本。
    expect(container.querySelectorAll('th')).toHaveLength(2)
    expect(container.querySelector('td')?.textContent).toBe('a')
  })

  it('围栏代码块留在 pre/code 里，行内码与它分开', () => {
    const { container } = body('看 `npm run build`：\n\n```ts\nconst a = 1\n```')
    expect(container.querySelector('pre code')?.textContent).toContain('const a = 1')
    const inline = container.querySelector(':not(pre) > code')
    expect(inline?.textContent).toBe('npm run build')
  })

  it('日志里存过的裸 HTML 只会变成**字面文本**，变不成节点（不带 rehype-raw）', () => {
    const { container } = body('<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>')
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    // 实测（react-markdown 10.1）：默认**不是**丢掉这段源，而是转义成文本——页面上看得见
    // `<img …>` 这串字符，但它不是元素，`onerror` 没有可以落脚的地方。
    expect(container.innerHTML).not.toContain('<img')
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">')
  })

  it('链接渲成不可点的文本，地址只进 title', () => {
    body('详见[设计稿](https://example.com/doc)')
    const anchor = screen.getByText('设计稿')
    expect(anchor.tagName).not.toBe('A')
    expect(anchor.getAttribute('title')).toBe('https://example.com/doc')
    expect(document.querySelector('a[href]')).toBeNull()
  })

  it('图片渲成一句说明（会话里的图路径在回收站里读不到）', () => {
    body('![回归截图](/tmp/shot.png)')
    expect(screen.getByText('[图片 · 回归截图]')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })

  it('样式挂在 .sd-md 上——那张表就是宿主 MarkdownText 的投影，换选择器会静默失配', () => {
    const { container } = body('正文')
    expect(container.querySelector('.sd-md')).not.toBeNull()
  })
})
