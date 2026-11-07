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
  it('悬停底色走交互悬停档，不用与页面同值的 bg-layer', () => {
    expect(css).toMatch(/trash-row"\]:hover\s*\{\s*background:\s*var\(--sd-interactive-bg-hover\)/)
    expect(css).not.toMatch(/background:\s*var\(--dsw-alias-bg-layer-[12]\)/)
  })

  it('图标按钮与分段控件都有可见键盘焦点环', () => {
    expect(css).toMatch(/\.sd-icon-btn:focus-visible\s*\{[^}]*outline:/)
    expect(css).toMatch(/\.sd-seg button:focus-visible\s*\{[^}]*outline:/)
  })

  it('禁用态压过行级提亮，写入在飞时按钮不能看起来还能点', () => {
    expect(css).toMatch(/trash-row"\]\s*\.sd-icon-btn:disabled/)
    expect(css).toMatch(/\.sd-narrow\s+\[data-dsh-session-delete="trash-row"\]\s+\.sd-icon-btn:disabled/)
  })

  it('子会话导航行标题取主色，悬停也不退回次级色', () => {
    expect(css).toMatch(/\[data-dsh-session-delete="trash-subagent-row"\],\s*[\s\S]*?color:\s*var\(--dsw-alias-label-primary\)/)
  })

  it('styles.ts 把 layout.css 与另三份样式一起装进 <style>', () => {
    expect(styles).toContain("import layoutCss from './layout.css'")
    expect(styles).toMatch(/\$\{css\}[\s\S]*\$\{layoutCss\}/)
  })
})
