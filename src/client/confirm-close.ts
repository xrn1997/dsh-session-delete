import { useCallback } from 'react'

/** 写入在飞时，确认框的关闭/取消都拦住：一次批量在飞时关掉框，用户会以为"没动"，而它其实正在动。
 *  各张确认框（单删 / 批量删除 / 回收站恢复与彻底删除 / 孤儿会话清理 / 孤儿附件清理）共用这一条规则；
 *  `Modal` 的遮罩 / X / Esc 都走同一个 `onClose`。
 *
 *  返回的 `closeDisabled` 与 `close` 同源：取消键的置灰读数也从这里取，各组件不再各写一遍
 *  `disabled={busy}`——否则"拦住"这件事会有两个判据。 */
export interface IdleClose {
  /** 属性声明而不是方法简写：实现体不读 `this`，调用方会把 `close` 摘下来直接交给 `Modal`/
   *  `Button`（`onClose={close}`）；方法简写会给它隐式 `this: IdleClose`，`unbound-method`
   *  就会把这种正常交接报成可疑。形状仍是同一个函数，零运行时改动。 */
  close: () => void
  readonly closeDisabled: boolean
}

export function useIdleClose(busy: boolean, onClose: () => void): IdleClose {
  const close = useCallback(() => {
    if (!busy) onClose()
  }, [busy, onClose])
  return { close, closeDisabled: busy }
}
