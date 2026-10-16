// 断点全靠"面板盒子被量到的宽度"，而 jsdom 没有真实布局（`getBoundingClientRect()` 恒 0）、
// 也没有 ResizeObserver。生产代码只认标准 RO 与真几何量法；这里给测试装一个**能手动交回宽度**的
// 替身——它改的是被观测元素自己的 `getBoundingClientRect`，所以生产那条读法一行都不为测试让路。
// 不动 `tests/client/support/setup.ts` 里那个空壳（`ui/Tooltip` 依赖它"量不到"的行为）。
import { vi } from 'vitest'

export interface WidthObserver {
  /** 派发一次宽度（必须在 `act(...)` 里调，因为它会触发组件的 state 更新）。 */
  pump(width: number): void
  /** 当前在观测的实例数（用例可据此断言卸载时真的一次不剩）。 */
  active(): number
  restore(): void
}

export function installWidthObserver(): WidthObserver {
  const observers: Array<{ notify: (width: number) => void; elements: Set<Element> }> = []
  class FakeResizeObserver {
    private readonly elements = new Set<Element>()
    private readonly notify: (width: number) => void
    constructor(callback: (entries: Array<{ target: Element }>) => void) {
      this.notify = (width: number) => {
        for (const el of this.elements) {
          el.getBoundingClientRect = () => ({ width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON: () => ({}) })
        }
        for (const el of this.elements) callback([{ target: el }])
      }
      observers.push({ notify: this.notify, elements: this.elements })
    }
    observe(el: Element): void { this.elements.add(el) }
    unobserve(el: Element): void { this.elements.delete(el) }
    disconnect(): void {
      this.elements.clear()
      const at = observers.findIndex((o) => o.elements === this.elements)
      if (at >= 0) observers.splice(at, 1)
    }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  return {
    pump: (width) => { for (const observer of [...observers]) observer.notify(width) },
    active: () => observers.length,
    restore: () => { vi.unstubAllGlobals() },
  }
}
