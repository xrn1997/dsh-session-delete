// layout.css 是本插件自造的伪类规则（inline style 表达不了 hover / focus-visible）；
// 这些规则没有运行时组件可断言，只能钉文件本身与装载点。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function readSource(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const css = readSource('../src/client/ui/layout.css')
const styles = readSource('../src/client/ui/styles.ts')

describe('layout.css', () => {
  // 判据（为什么不用与页面同值的 bg-layer）住 layout.css 头注；这里只钉规则本身。
  // 行与组头认 `session-list.tsx` 交出的类名：**一条规则两档共用**，按档位各写一条就是漂移的入口。
  it('悬停底色走交互悬停档，不用与页面同值的 bg-layer；两档行同一份', () => {
    expect(css).toMatch(/\.sd-session-row:hover\s*\{[^}]*background:\s*var\(--sd-interactive-bg-hover\)/)
    expect(css).not.toMatch(/data-dsh-session-delete="(trash|archive)-row"\]:hover/)
    expect(css).not.toMatch(/background:\s*var\(--dsw-alias-bg-layer-[12]\)/)
  })

  it('面板头两档用大号分段（与旧 H1 同档）；动作列与组头指示器不按档位分叉', () => {
    expect(css).toMatch(/\.sd-seg-lg button\s*\{[^}]*font-size:\s*16px/)
    expect(css).toMatch(/\.sd-session-row\s+\.sd-icon-btn:disabled/)
    expect(css).toMatch(/\.sd-session-group-row\s+\.sd-group-chevron/)
    expect(css).not.toMatch(/data-dsh-session-delete="(trash|archive)-(row|group-row)"/)
  })

  it('图标按钮与分段控件都有可见键盘焦点环', () => {
    expect(css).toMatch(/\.sd-icon-btn:focus-visible\s*\{[^}]*outline:/)
    expect(css).toMatch(/\.sd-seg button:focus-visible\s*\{[^}]*outline:/)
  })

  it('禁用态压过行级提亮，写入在飞时按钮不能看起来还能点', () => {
    expect(css).toMatch(/\.sd-session-row\s+\.sd-icon-btn:disabled/)
    expect(css).toMatch(/\.sd-narrow\s+\.sd-session-row\s+\.sd-icon-btn:disabled/)
  })

  it('子会话导航行标题取主色，悬停也不退回次级色', () => {
    expect(css).toMatch(/\[data-dsh-session-delete="session-subagent-row"\],\s*[\s\S]*?color:\s*var\(--dsw-alias-label-primary\)/)
  })

  // 判据：摘要条/跳转徽标的底色若内联，会压过 :hover（同文件头那条真机反馈）；底色只能住这里。
  it('子会话摘要条、跳转徽标与导航行的底色住 CSS，悬停走交互档、都有焦点环', () => {
    expect(css).toMatch(/\[data-dsh-session-delete="session-subagents-toggle"\],[\s\S]*?\[data-dsh-session-delete="session-subagent-row"\]\s*\{\s*background:\s*transparent/)
    expect(css).toMatch(/\[data-dsh-session-delete="session-subagents-toggle"\]:hover,[\s\S]*?\[data-dsh-session-delete="session-subagent-row"\]:hover\s*\{\s*background:\s*var\(--sd-interactive-bg-hover\)/)
    expect(css).toMatch(/\[data-dsh-session-delete="session-subagents-jump"\]:focus-visible[\s\S]*?outline:/)
  })

  // 判据：宿主的 composer 在视图标签之间横移过 4px（scrollbar 占布局），修法是无条件预留槽位；
  // 这里钉的是同一条规则落在两栏的公共类上。
  it('两栏无条件预留滚动条槽', () => {
    expect(css).toMatch(/\.sd-stable-scroll\s*\{\s*scrollbar-gutter:\s*stable/)
  })

  // 判据：滚动条档位配方（overflow / 内边距 / thumb token）只住 `detail-pane.tsx` 的 `SCROLL_COLUMN`，
  // `ListPane` 自己合上；面板再抄一份 thumb token，两栏就会各自漂移。
  it('滚动条档位配方住 detail-pane.tsx，面板不抄第二份', () => {
    const pane = readSource('../src/client/detail-pane.tsx')
    expect(pane).toContain("'--dsh-scrollbar-thumb': 'var(--sd-scrollbar-bg-l2)'")
    const panel = readSource('../src/client/trash-panel.tsx')
    expect(panel).not.toContain('--dsh-scrollbar-thumb')
  })

  it('骨架条有 2s 脉冲，reduced-motion 下关掉', () => {
    expect(css).toMatch(/\.sd-skeleton-bar\s*\{[^}]*animation:/)
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*?\.sd-skeleton-bar[^}]*animation:\s*none/)
  })

  // 提问轨（ADR-0057）：常驻要靠 `position: absolute` 不占正文布局；刻度是伪元素，
  // 悬停/当前/焦点三种强调只能写在这里；补页的呼吸动画同样要能被 reduced-motion 关掉。
  it('提问轨绝对定位、不占正文布局', () => {
    expect(css).toMatch(/\.sd-prompt-rail\s*\{[^}]*position:\s*absolute/)
  })

  // 几何只有一个来源：右缘是正文列宽的函数，由 `detail-pane.tsx` 从 `DETAIL_TEXT_MAX_WIDTH`
  // 算好以行内属性交给组件；轨宽住 `PromptRail` 的 `RAIL_WIDTH`，详情栏的右槽从它派生。
  // 样式表里再抄一份列宽或轨宽（旧写法是 `100% - 894px` / `width: 30px`）就是第二份事实，
  // 迟早与内层 `maxWidth` / `RAIL_GUTTER` 漂开——轨会离开正文列、间距也不再是那一档。
  it('提问轨的右缘与宽度都从 TS 派生：几何住 TS，样式表不写死', () => {
    expect(css).not.toMatch(/\.sd-prompt-rail\s*\{[^}]*right:/)
    expect(css).not.toMatch(/\.sd-prompt-rail\s*\{[^}]*width:/)
    expect(css).not.toContain('894px')
    const pane = readSource('../src/client/detail-pane.tsx')
    expect(pane).toContain('max(14px, calc(100% - ${DETAIL_TEXT_MAX_WIDTH}px))')
    expect(pane).toContain('const RAIL_GUTTER = RAIL_WIDTH + 14')
    const rail = readSource('../src/client/prompt-rail.tsx')
    expect(rail).toContain('style={{ right, width: RAIL_WIDTH }}')
  })

  it('提问刻度有悬停/当前/键盘焦点三档，焦点环不靠宿主 token', () => {
    expect(css).toMatch(/\.sd-prompt-mark:hover::before\s*\{[^}]*background:/)
    expect(css).toMatch(/\[aria-current="true"\]::before\s*\{[^}]*background:/)
    expect(css).toMatch(/\.sd-prompt-mark:focus-visible::before\s*\{[^}]*background:/)
    expect(css).toMatch(/\.sd-prompt-mark:focus-visible::after\s*\{[^}]*outline:/)
  })

  it('补页中的呼吸动画在 reduced-motion 下关掉', () => {
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*?\.sd-prompt-mark\[data-loading="true"\]::before[^}]*animation:\s*none/)
  })

  // 落位不画高亮框（宿主 `scrollToTurn` 也只对齐）：钉住「没有落地框规则」。让位的像素只有
  // `use-prompt-rail.ts` 的 `JUMP_SCROLL_MARGIN_PX` 一个来源：用户行行内消费它，`ACTIVE_EDGE_PX`
  // 从它派生（必须大于它，否则落位后「当前这句」判给上一句；那里有对应的行为用例）。
  it('落位让位住 TS 单源，样式表不写第二份像素，也不画落地高亮框', () => {
    expect(css).not.toMatch(/scroll-margin-top:\s*\d/)
    expect(css).not.toContain('.sd-jump-flash')
    const rail = readSource('../src/client/use-prompt-rail.ts')
    expect(rail).toContain('export const ACTIVE_EDGE_PX = JUMP_SCROLL_MARGIN_PX + 4')
    const detail = readSource('../src/client/session-detail.tsx')
    expect(detail).toContain('scrollMarginTop: JUMP_SCROLL_MARGIN_PX')
  })

  it('刻度的悬停档与选中档分开：悬停次级色、选中主色', () => {
    expect(css).toMatch(/\.sd-prompt-mark:hover::before\s*\{[^}]*--sd-label-tertiary/)
    expect(css).toMatch(/\.sd-prompt-mark\[aria-current="true"\]::before\s*\{[^}]*label-primary/)
  })

  it('styles.ts 把 layout.css 与另三份样式一起装进 <style>', () => {
    expect(styles).toContain("import layoutCss from './layout.css'")
    expect(styles).toMatch(/\$\{css\}[\s\S]*\$\{layoutCss\}/)
  })
})
