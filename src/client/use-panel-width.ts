/**
 * 观测**面板自己那一块**的宽度：侧栏折叠/展开、拖动分栏都改它而 window 不动，所以不听 `window.resize`。
 * 量的是**盒子 border-box 宽**（`getBoundingClientRect().width`），不是扣过内边距的 `contentRect.width`。
 * 首帧读一次、之后跟 RO；读到 0 就是窄档 ⇒ **窄档是默认、宽档要被证明**；RO 缺席时停在窄档。
 */
import { useLayoutEffect, useState, type RefObject } from 'react'

export function usePanelWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  // 首帧就要拿到宽度：`useEffect` 会让宽视口先按 0 画一帧窄档，再跳成两栏。
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    setWidth(el.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => {
      const target = entries[0]?.target
      if (target !== undefined) setWidth(target.getBoundingClientRect().width)
    })
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [ref])
  return width
}
