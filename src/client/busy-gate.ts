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

/** 一次过闸的落地面：**没跑**与**跑了**在类型面就是两支，不靠 `undefined` 兼职。 */
export type GateRun<T> =
  | { readonly kind: 'blocked' }
  | { readonly kind: 'ran'; readonly value: T }

export interface BusyGate {
  readonly busy: boolean
  /** 把一次任务整个包进「这一趟还算忙」；落地与抛错都放回 false。
   *  同一枚闸已有任务在飞时这一次**不执行**（同步判重），立即回 `{ kind: 'blocked' }`。
   *  挡回的那一趟什么都没跑——把它伪装成一枚 `T` 就是把「没跑」当成「跑完且结果是那个值」，
   *  消费返回值的调用方（写入座位、清空）会照着编出失败原文或宣布成功。挡回来那一份的界面后果
   *  归在飞的那一趟，调用方按 `kind` 分派，写不出「拿没跑当跑完」。 */
  around: <T>(task: () => Promise<T>) => Promise<GateRun<T>>
}

export function useBusyGate(): BusyGate {
  const [busy, setBusy] = useState(false)
  const flying = useRef(false)
  const around = useCallback(async <T,>(task: () => Promise<T>): Promise<GateRun<T>> => {
    if (flying.current) return { kind: 'blocked' }
    flying.current = true
    setBusy(true)
    try {
      return { kind: 'ran', value: await task() }
    } finally {
      flying.current = false
      setBusy(false)
    }
  }, [])
  // 返回值经 `useMemo` 稳定：`gate` 进各 `useCallback` 的依赖，每次渲染换个新对象会带着它们失效。
  return useMemo(() => ({ busy, around }), [busy, around])
}
