/**
 * jsdom 缺的指针事件那一层（与 `observe-width.ts` 给 `ResizeObserver` 补桩是同一条路子）。
 *
 * **实测**（2026-10-15，探针跑在本仓的 client project 里）：jsdom 26 上
 * `typeof window.PointerEvent === 'undefined'`，于是 `fireEvent.pointerDown(el, {clientX: 500})`
 * 造出来的是一个**裸 `Event`**（`constructor.name === 'Event'`），init 里的 `clientX`／`pointerId`
 * 一个都不带，元素上也没有 `setPointerCapture`。拿它去测拖动，读数只会是 `NaN`——
 * 那不是实现的 bug，是环境的洞。
 *
 * 所以这里做两件事：① 给 `Element.prototype` 补上捕获那三个方法（真 Chromium 有）；
 * ② 提供 `firePointer`，按 DOM 规范的做法造一个带 `clientX`/`pointerId` 自有属性的 `pointer*`
 * 事件派发出去。React 18 的 pointer 事件仍走根容器委托，所以 `bubbles: true` 就能被接住，
 * 合成事件上的 `clientX` 会读到我们挂在原生事件上的那一份。
 *
 * **生产代码里不许出现 `?.` 之类的"环境兜门"**：真宿主是 Chromium，这些 API 必然在场。
 */
import { act } from '@testing-library/react'

const capture = Element.prototype as unknown as {
  setPointerCapture: () => void
  releasePointerCapture: () => void
  hasPointerCapture: () => boolean
}

capture.setPointerCapture = () => {}
capture.releasePointerCapture = () => {}
capture.hasPointerCapture = () => true

export interface PointerInit {
  clientX: number
  pointerId?: number
}

export function firePointer(target: Element, type: string, init: PointerInit): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { clientX: init.clientX, pointerId: init.pointerId ?? 1 })
  // 绕开 `fireEvent` 就得自己补这一层：它内部是用 `act` 派发并冲刷 React 的更新队列的，
  // 裸 `dispatchEvent` 出去，handler 里的 `setState` 不会在这一句之后已经反映到 DOM 上。
  act(() => {
    target.dispatchEvent(event)
  })
}
