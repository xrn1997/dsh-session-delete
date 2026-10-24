/**
 * 「这一趟还算忙」的一枚闸——面板与两个确认框共用的一份实现（各面各持一枚实例）。
 *
 * 为什么收回一处：三个面要的是同一套判据，各写一份只会漂移出第二套。闸的判据只有一条：
 * 任务落地或抛错都把 busy 放回 false；不做引用计数——同一实例同一时刻只跑一趟写动作，多一层计数
 * 只会把「这一趟什么时候算完」变成第二个判据。
 *
 * 边界：闸只拥有 busy 的生命周期，不拥有防抖、不拥有排队、不拥有重读（那是 `runWrite` 的整趟）。
 */
import { useCallback, useMemo, useState } from 'react'

export interface BusyGate {
  readonly busy: boolean
  /** 把一次任务整个包进「这一趟还算忙」；落地与抛错都放回 false。 */
  around<T>(task: () => Promise<T>): Promise<T>
}

export function useBusyGate(): BusyGate {
  const [busy, setBusy] = useState(false)
  const around = useCallback(async <T,>(task: () => Promise<T>): Promise<T> => {
    setBusy(true)
    try {
      return await task()
    } finally {
      setBusy(false)
    }
  }, [])
  // 返回值经 `useMemo` 稳定：`gate` 进各 `useCallback` 的依赖，每次渲染换个新对象会带着它们失效。
  return useMemo(() => ({ busy, around }), [busy, around])
}
