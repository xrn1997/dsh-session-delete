/**
 * 「这一趟还算忙」的一枚闸——面板、单条移入宿主、批量浮条与撤销横幅各持一枚实例，共用一份判据。
 * 任务落地或抛错都把 busy 放回 false；同一实例同一时刻只跑一趟——在飞时靠 ref 同步挡回（`busy` 是 state，
 * 要等下一拍才上屏，同一 tick 的连点拦不住），不做引用计数（那会把「这一趟什么时候算完」变成第二个判据）。
 * 闸不管防抖、排队与重读。
 */
import { useCallback, useMemo, useRef, useState } from 'react'

/** 一次过闸的落地面：**没跑**与**跑了**在类型面就是两支，不靠 `undefined` 兼职。 */
export type GateRun<T> =
  | { readonly kind: 'blocked' }
  | { readonly kind: 'ran'; readonly value: T }

export interface BusyGate {
  readonly busy: boolean
  /** 把一次任务整个包进「这一趟还算忙」；落地与抛错都放回 false。
   *  在飞时不执行（同步判重），立即回 `{ kind: 'blocked' }`；挡回的那一趟什么都没跑，调用方必须按 `kind` 分派——
   *  把它伪装成一枚 `T` 就是拿「没跑」当「跑完且结果是那个值」，界面后果归在飞的那一趟。 */
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
