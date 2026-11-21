/**
 * 意图预取的延时器：hover / focus 之后等一小段再读，鼠标扫过整列不会变成一串 `/detail` 请求。
 * `run` 常是内联箭头：经 `useLatest` 归一，定时器只认最新那一份；卸载时清掉未落地的定时器。
 */
import { useCallback, useEffect, useRef } from 'react'
import { useLatest } from './store.js'

/** 150ms：够区分「扫过」与「停下来看」，又短到点下去之前通常已经读完（本机一次读数 ~135ms）。 */
const PREFETCH_DELAY_MS = 150

export interface DelayedPrefetch<T> {
  /** 开始计时；已有计时先取消（连续划过只认最后一次）。 */
  schedule: (value: T) => void
  /** 取消未落地的计时；已经跑过的不受影响。 */
  cancel: () => void
}

export function useDelayedPrefetch<T>(run: (value: T) => void): DelayedPrefetch<T> {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useLatest(run)

  const cancel = useCallback((): void => {
    if (timer.current === null) return
    clearTimeout(timer.current)
    timer.current = null
  }, [])

  const schedule = useCallback((value: T): void => {
    cancel()
    timer.current = setTimeout(() => {
      timer.current = null
      latest.current(value)
    }, PREFETCH_DELAY_MS)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `latest` 是 `useLatest` 回的恒稳 ref（规则看不见自定义 hook），读的是 `.current`。
  }, [cancel])

  // 卸载清定时器：面板 / 详情随时可能被切走，别让一颗旧计时器在卸载后读数据。
  useEffect(() => cancel, [cancel])

  return { schedule, cancel }
}

/** 悬停/聚焦的四个指针事件：两处调用点（清单行、子会话行）共用这一份，不各抄一遍。 */
export function intentPrefetchHandlers<T>(
  prefetch: DelayedPrefetch<T>,
  value: T,
): {
  onPointerEnter: () => void
  onPointerLeave: () => void
  onFocus: () => void
  onBlur: () => void
} {
  return {
    onPointerEnter: () => { prefetch.schedule(value) },
    onPointerLeave: prefetch.cancel,
    onFocus: () => { prefetch.schedule(value) },
    onBlur: prefetch.cancel,
  }
}
