/**
 * 重开等待的唯一生命周期：一张票、一条订阅、一个放弃 timer、一次 settle/cleanup。
 *
 * ADR-0036 的语义不变：**订阅优先、出现即开、最多等一个放弃边界、不轮询**。这里把这段状态机
 * 收成一个可取消句柄：调用方 `schedule` 一次、`cancel` 一次；票、订阅、timer 与 settle 标志
 * 都关在 implementation 里，不再由 main-view 在四个调用点成对手工清理。
 *
 * 依赖（store 的 subscribe、是否已出现、是否还能抢焦点、怎么打开）由调用方交进来——本模块不认宿主。
 */
import { createLatestWins } from './store.js'

export interface PendingOpenInput {
  /** 订阅「清单变了」；返回退订。旧 store 可能没有——那时只有"已经出现"这一支能开。 */
  readonly subscribe?: ((listener: () => void) => () => void) | undefined
  /** 目标是否已经出现在清单里。 */
  readonly isReady: () => boolean
  /** 出现的这一拍还该不该抢焦点（用户可能已经选了别的会话）。 */
  readonly canOpen: () => boolean
  /** 打开目标；调用方自己收宿主抛错。 */
  readonly open: () => void
}

export interface PendingOpen {
  /** 取消在等的等待（没有也安全）；后一次 `schedule` 会先取消前一次。 */
  cancel(): void
  /** 等目标出现再打开；已经在清单里就立即打开。 */
  schedule(input: PendingOpenInput): void
}

/** 默认放弃边界：给宿主 `api-session/added` 到客户端摘要落地留一拍（ADR-0036 的产品决定）。 */
const DEFAULT_GIVE_UP_MS = 2000

export function createPendingOpen(giveUpMs = DEFAULT_GIVE_UP_MS): PendingOpen {
  const latest = createLatestWins()
  let cleanup: (() => void) | undefined

  const cancel = (): void => {
    latest.invalidate()
    const stop = cleanup
    cleanup = undefined
    stop?.()
  }

  return {
    cancel,
    schedule(input) {
      // 新一次等待也是新动作：旧等待的票与订阅先一起作废。
      cancel()
      const ticket = latest.issue()
      let settled = false
      let unsubscribe: (() => void) | undefined
      let timer: ReturnType<typeof setTimeout> | undefined

      const unsubscribeNow = (): void => {
        if (unsubscribe === undefined) return
        const stop = unsubscribe
        unsubscribe = undefined
        try {
          stop()
        } catch {
          // 宿主 store 换代 / 形状不符：退订失败不能让一次界面收尾把删除/恢复结果染红。
        }
      }

      const finish = (): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        unsubscribeNow()
        if (cleanup === finish) cleanup = undefined
      }

      const open = (): void => {
        if (!ticket.current || !input.canOpen()) {
          finish()
          return
        }
        try {
          input.open()
        } finally {
          finish()
        }
      }

      if (input.isReady()) {
        open()
        return
      }
      // 旧 store 没有订阅：不轮询、不猜，直接放弃这次等待（ADR-0036）。已经出现的分支在上面。
      const subscribe = input.subscribe
      if (subscribe === undefined) return

      cleanup = finish
      let stop: (() => void) | undefined
      try {
        stop = subscribe(() => {
          if (input.isReady()) open()
        })
      } catch {
        // 宿主 store 换代 / 形状不符：这次等待安静作废，不让一次界面收尾把恢复结果染红。
        finish()
        return
      }
      unsubscribe = stop
      // 有的快照 store 会在订阅时同步回调；TS 看不见这个回调，settled 在运行期可能已为真。
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 同上：同步回调会让 settled 在 subscribe 返回前变真。
      if (settled) {
        unsubscribeNow()
        return
      }
      timer = setTimeout(finish, giveUpMs)
      // 订阅与第一次检查之间可能已经出现。
      if (input.isReady()) open()
    },
  }
}
