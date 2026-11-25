// @vitest-environment jsdom
/**
 * 指针模态监听器的生命周期：`apply` 的 effect 装上它们，卸载 / HMR 换代时摘掉。
 *
 * 这里只钉监听器本身（装上能切换、摘除后不再响应）；`src/client/index.tsx` 把
 * `installPointerModality` 挂进 effect 的那一行是装配代码，不在这里重复渲染整条入口。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installPointerModality, isPointerModality } from '../../src/client/ui/styles.js'

describe('指针模态监听器', () => {
  it('装上后指针置真、键盘置假；摘除后不再响应', () => {
    const dispose = installPointerModality()
    window.dispatchEvent(new Event('pointerdown'))
    expect(isPointerModality()).toBe(true)
    window.dispatchEvent(new Event('keydown'))
    expect(isPointerModality()).toBe(false)

    dispose()
    window.dispatchEvent(new Event('pointerdown'))
    expect(isPointerModality()).toBe(false)
  })
})

// 浮层层级是**用户能看见的规矩**：确认框开着时底下的撤销横幅 / 浮条不许还抢得到点击。
// 这里直接读样式表文本（与 skeleton 的读法同源）；数值不在文档里抄，断言的只是相对次序。
describe('浮层层级', () => {
  const uiCss = readFileSync(join(process.cwd(), 'src/client/ui/ui.css'), 'utf8')
  const layoutCss = readFileSync(join(process.cwd(), 'src/client/ui/layout.css'), 'utf8')

  const zIndexOf = (css: string, selector: string): number => {
    const start = css.indexOf(`${selector} {`)
    expect(start, `没找到 ${selector}`).toBeGreaterThanOrEqual(0)
    const match = /z-index:\s*(\d+)/.exec(css.slice(start))
    if (match === null) throw new Error(`${selector} 没有 z-index`)
    return Number(match[1])
  }

  it('确认框压过撤销横幅、批量浮条与拖放胶囊：框打开时底层浮层不许盖过它', () => {
    const modal = zIndexOf(uiCss, '.sd-modal-root')
    const batchBar = zIndexOf(uiCss, '.sd-batch-bar')
    expect(zIndexOf(uiCss, '.sd-toast')).toBeLessThan(modal)
    expect(batchBar).toBeLessThan(modal)
    expect(zIndexOf(layoutCss, '.sd-drop-pill')).toBeLessThan(modal)
    expect(zIndexOf(layoutCss, '.sd-drop-pill')).toBeGreaterThanOrEqual(batchBar)
  })
})

// 抄来的表里一条属性写两遍时，前一条是死代码（后一条覆盖它）。2026-11 清掉表格宽度那一处。
describe('markdown.css 没有写两遍的表宽', () => {
  const css = readFileSync(join(process.cwd(), 'src/client/ui/markdown.css'), 'utf8')

  it.each(['.sd-md th', '.sd-md td'])('%s 只有一条 max-width（没被后一条覆盖成死代码）', (selector) => {
    const start = css.indexOf(`${selector} {`)
    expect(start, `没找到 ${selector}`).toBeGreaterThanOrEqual(0)
    const block = css.slice(start, css.indexOf('}', start))
    expect(block.match(/max-width:/g) ?? []).toHaveLength(1)
    expect(block).toContain('max-width: min(30vw, 320px)')
  })
})
