/**
 * 「这一趟还算忙」的一枚闸——面板、两个确认框与撤销横幅共用的一份实现（各面各持一枚实例）。
 *
 * 为什么收回一处：各面要的是同一套判据，各写一份只会漂移出第二套。闸的判据只有两条：
 * 任务落地或抛错都把 busy 放回 false；同一实例同一时刻只跑一趟——在飞时再包一趟会被**同步**
 * 挡回（`busy` 是 state，要等下一拍才上屏，同一 tick 的连点拦不住），不做引用计数，多一层计数
 * 只会把「这一趟什么时候算完」变成第二个判据。
 *
 * 边界：闸只拥有 busy 的生命周期与同实例防重，不拥有防抖、不拥有排队、不拥有重读（那是 `runWrite` 的整趟）。
 */
import { useCallback, useMemo, useRef, useState } from 'react'

export interface BusyGate {
  readonly busy: boolean
  /** 把一次任务整个包进「这一趟还算忙」；落地与抛错都放回 false。
   *  同一枚闸已有任务在飞时这一次**不执行**（同步判重），立即回 `undefined`。类型里带上 `undefined`
   *  不是将就，是判据：挡回的那一趟什么都没跑，把它伪装成一枚 `T` 就是把「没跑」当成「跑完且结果是
   *  那个值」——消费返回值的调用方（写入座位、清空）会照着编出失败原文或宣布成功。怎么收尾由调用方
   *  定：这一趟的界面后果归在飞的那一趟，挡回来的那一份什么都不该改。 */
  around: <T>(task: () => Promise<T>) => Promise<T | undefined>
}

export function useBusyGate(): BusyGate {
  const [busy, setBusy] = useState(false)
  const flying = useRef(false)
  const around = useCallback(async <T,>(task: () => Promise<T>): Promise<T | undefined> => {
    if (flying.current) return undefined
    flying.current = true
    setBusy(true)
    try {
      return await task()
    } finally {
      flying.current = false
      setBusy(false)
    }
  }, [])
  // 返回值经 `useMemo` 稳定：`gate` 进各 `useCallback` 的依赖，每次渲染换个新对象会带着它们失效。
  return useMemo(() => ({ busy, around }), [busy, around])
}
