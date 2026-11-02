import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// vitest 没开 `globals`，@testing-library/react 的自动 cleanup 挂不上 ⇒ 显式收尾，
// 否则上一个用例的 DOM 会留在 document 里，下一个用例报 "Found multiple elements"。
afterEach(() => {
  cleanup()
})

// jsdom 没有 `ResizeObserver`（真机 Chromium 一定有）。自造控件 `ui/Tooltip.tsx` 用它量气泡尺寸
// ——那是它"先量再显示"的实现（官方同款），**不为测试改生产代码**，所以在这里补一个空壳：
// 观测到就回调一次，但**不带 `borderBoxSize`** ⇒ 组件里的 `fit()` 按"还没量到"处理，
// 气泡进 DOM 但保持 `visibility: hidden`（用例断言的是"这句话在不在页面上"，不是它在哪）。
class ResizeObserverStub implements ResizeObserver {
  observe(): void {
    /* 不产尺寸：等真实浏览器来 */
  }
  unobserve(): void {}
  disconnect(): void {}
}

// lib.dom 把 ResizeObserver 钉成必有，但 jsdom 运行时没有：用一具声明了可缺席返回的函数读出来
// （直接给 const 标注联合会被初始化式的窄化吃掉），这样空值判据才是必要判据。
function currentResizeObserver(): typeof globalThis.ResizeObserver | undefined {
  return globalThis.ResizeObserver
}
if (currentResizeObserver() === undefined) {
  globalThis.ResizeObserver = ResizeObserverStub
}
