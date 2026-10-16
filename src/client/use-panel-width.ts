/**
 * 观测**面板自己那一块**的宽度（回收站的断点全靠它，设计稿 2026-10-15 §2.1）。
 *
 * 为什么不是 `window.innerWidth`：这块住在宿主的中央列里，**侧栏折叠/展开、拖动分栏**都会改它的宽度
 * 而 window 一点不动——只听 window 的 resize 会在侧栏折叠后拿着旧宽度画错形态。
 *
 * 量的是**盒子的 border-box 宽**（`getBoundingClientRect().width`），不是 `contentRect.width`：
 * 后者已经扣掉内边距，而"多宽才分两栏"那个阈值说的是整块盒子——拿扣过内边垫的数去比就是**扣两次**，
 * 结果明明够宽却退化成下钻（2026-10-15 真机反馈后定的判据）。
 *
 * 首帧读一次当前宽度，之后跟着 RO 走；读到 0 就是窄档 ⇒ **窄档是默认、宽档要被证明**。
 * RO 缺席（不可能的宿主）时停在窄档：功能一条不少，只是同屏两栏变成下钻。
 */
import { useEffect, useState, type RefObject } from 'react'

export function usePanelWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
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
