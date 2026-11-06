// @vitest-environment jsdom
/**
 * 指针模态监听器的生命周期：`apply` 的 effect 装上它们，卸载 / HMR 换代时摘掉。
 *
 * 这里只钉监听器本身（装上能切换、摘除后不再响应）；`src/client/index.tsx` 把
 * `installPointerModality` 挂进 effect 的那一行是装配代码，不在这里重复渲染整条入口。
 */
import { describe, expect, it } from 'vitest'
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
