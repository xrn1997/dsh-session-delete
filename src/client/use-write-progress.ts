/**
 * 写入进度的浏览器半轮询与**写身份认领**（ADR-0069 决定 4）：`flying` 为真时以 {@link PROGRESS_POLL_MS}
 * 周期轮询 `/progress`（首帧立即拉一次），落 false 即停并丢弃在飞结果（latest-wins）。
 *
 * 认领判据只有一条：快照 `running` 且 `action` 相同且 `ids` 与本趟有**交集** ⇒ `own`（k/N 才是这一趟写的）；
 * `running` 但认领不上 ⇒ `queued`（到达序链上排在另一趟后面）；`idle` 或未在飞 ⇒ `null`（兜底忙碌文案归调用方）。
 * 认领名单的空集走空集守卫、同归 `null`（细分口径住 {@link claimProgress}）。
 * 假进度是反目标：另一趟写在飞时界面不许冒领它的 k/N，认领不上就只说「排队中」。
 *
 * **单票在飞**（口径裁定）：上一票没落地时 tick 直接跳过、不作废在飞票，落地或失败才放行下一拍。
 * 每拍都发新票会在 RTT 长于周期时把在飞票全部作废——每一票都活不到落地，脸就冻在旧帧上，
 * 正是「以为卡了」的病根场景。latest-wins 只留给「落 false 丢弃在飞」那一刀。
 *
 * 进度是遥测小读：`progress()` 走独立短上限并在 cleanup 中止；某一拍读失败不改写上一帧现场，
 * 下一拍再读（写落定由 `flying` 落 false 收口，不留残帧）。现场全在 state/ref：`own` 逐渲染换新对象不影响认领（渲染期现算）。
 */
import { useEffect, useRef, useState } from 'react'
import type { WriteProgressAction, WriteProgressStep, WriteProgressWire } from '../shared/wire.js'
import type { ProgressDeps, RemoteOutcome } from './remote.js'
import { createLatestWins, useLatest } from './store.js'

/** 轮询周期 300ms：够密到 k/N 的推进看得见，够疏到不跟自己那趟写抢盘（口径裁定，不随配置走）。 */
export const PROGRESS_POLL_MS = 300

/** 认领结果的界面脸：`own` 才带 k/N 与步骤（原样来自快照，不折算百分比——假进度是反目标）；
 *  动作码随脸走——渲染端不再从调用处二次传身份（face 与 action 本是一件事的两格）。 */
export type WriteProgressFace =
  | { readonly kind: 'own'; readonly action: WriteProgressAction; readonly done: number; readonly total: number; readonly step: WriteProgressStep; readonly startedAt: number; readonly localStartedAt: number }
  | { readonly kind: 'queued' } // 本趟在飞但进度属于另一趟（到达序链上排在它后面）

/**
 * 认领判据（ADR-0069 决定 4）：按「action 相同且 ids 有交集」认领——`ids` 是请求里带的天然身份，交集
 * 不比整份名单（并发移入回收站收窄批也仍认得自己的趟）。纯函数：没读到快照与 `idle` 同判 `null`。
 *
 * **空集守卫**：认领名单塌成空集（在场行没读到）时交集判据失效——同 action 在飞的那趟可能是本趟，
 * 「排队中：另一写入进行中…」无从断言、更不许冒领它的 k/N（假进度是反目标）⇒ 归「没认领到」，
 * 出 `null` 由调用方给兜底忙碌文案。action 不同照旧 `queued`（本趟的记录必然同 action，那句断言是真的）。
 */
function claimProgress(
  wire: WriteProgressWire | null,
  own: { readonly action: WriteProgressAction; readonly ids: readonly string[] },
  localStartedAt: number,
): WriteProgressFace | null {
  if (wire === null || wire.status === 'idle') return null
  if (wire.action !== own.action) return { kind: 'queued' }
  if (own.ids.length === 0 || wire.ids.length === 0) return null
  if (!wire.ids.some((id) => own.ids.includes(id))) return { kind: 'queued' }
  return { kind: 'own', action: own.action, done: wire.done, total: wire.total, step: wire.step, startedAt: wire.startedAt, localStartedAt }
}

/**
 * 在飞写的进度面：`flying` 为真才轮询（写不飞不轮，不白打 `/progress`）；返回 `null` 时调用方出
 * 兜底忙碌文案。轮询是 `setInterval` + 首帧立即拉一次，**单票在飞**（在飞 tick 跳过、不作废票）；
 * `flying` 落 false 时清计时器、换代丢弃在飞结果、连快照一起收掉——下一趟在飞前，上一趟的 k/N 不许冒头。
 */
export function useWriteProgress(
  deps: ProgressDeps,
  own: { readonly action: WriteProgressAction; readonly ids: readonly string[] },
  flying: boolean,
): WriteProgressFace | null {
  const [wire, setWire] = useState<WriteProgressWire | null>(null)
  // 并发读只有最新可落地（`store.ts` 的原语）：换代语义把「落 false 丢弃在飞」这一刀收在同一处。
  const [epoch] = useState(createLatestWins)
  const localStartedAt = useRef(0)
  // `deps` 可能内联换身份：定时器经这份 ref 现读最新那一份，不拿调度那一刻的旧闭包。
  const latestDeps = useLatest(deps)

  useEffect(() => {
    if (!flying) return
    localStartedAt.current = Date.now()
    // 单票在飞的挡板：在飞期间的 tick 既不重发也不作废票（作废 = 脸停帧的病根），落地/失败才放行下一拍。
    let inFlight = false
    const controller = new AbortController()
    const poll = (): void => {
      if (inFlight) return
      inFlight = true
      const ticket = epoch.issue()
      const land = (outcome: RemoteOutcome<WriteProgressWire> | null): void => {
        inFlight = false
        // 失败一拍不动现场（进度是遥测，下一拍再读）；通道契约不抛，这里的 null 只防假件把 Promise 弄裂。
        if (outcome === null || !outcome.ok || !ticket.current) return
        setWire(outcome.value)
      }
      void latestDeps.current.progress(controller.signal).then(land, () => land(null))
    }
    poll() // 首帧立即拉一次：300ms 内用户不能只看见空转。
    const timer = setInterval(poll, PROGRESS_POLL_MS)
    return () => {
      clearInterval(timer)
      controller.abort()
      // 落 false 即停并丢弃在飞结果：换代让未落地的读认输，快照同拍收掉（下一趟不许端上一趟的脸）。
      epoch.invalidate()
      setWire(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 判据只有 flying 的翻转；deps 经 useLatest 现读，epoch 恒稳。
  }, [flying])

  return flying ? claimProgress(wire, own, localStartedAt.current) : null
}
