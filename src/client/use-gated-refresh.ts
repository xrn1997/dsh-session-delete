/**
 * 「失效 → 重读」生命周期的唯一实现（读路径加固设计的第 2 节）：三个读路径消费者
 * （归档清单、归档详情 reader、回收站清单）共用这一条节奏，档位门不再各写一遍。
 *
 * 分工：**失效是事实，读是动作**。修订到达时作废必达且便宜（同步跑 `onInvalidate`）；
 * 读只在有需求时发生——`active`（面板/档位在眼前）与 `demand`（reader 的 subject 在场）两道门
 * 都开才排，且**落地那一刻再验一次门**：排队期间关档/丢主体，票作废，dirty 留着等门再开补读。
 * 合并窗把风暴收敛成一次读；单飞保证同一时刻至多一个 refresh 在飞，在飞期间的修订只置脏、
 * 结算后至多一轮追补；强制激活（`refreshOnActivate`）同样吃两道门与单飞。
 * latest-wins / 失败上屏仍由调用方的 `refresh` 自持——本 hook 只管节奏，不管内容。
 *
 * 挂载**不算一次修订**：它既不作废也不置脏。清单类靠 `initialDirty: true` 在门开时读第一趟；
 * 详情类等 subject 出现后由调用方自己的首读逻辑负责（`initialDirty` 缺省 false）。
 *
 * 三条纪律：
 * - **hook 内不 setState**：全部现场住 ref，它不产出渲染态，也不因触发读数让宿主组件多渲染；
 *   定时器只有合并窗这一颗（ADR-0036「订阅不轮询」的口径：它是批后合并，不是周期拉取）。
 * - **输入逐渲染换新对象**：回调经 `store.ts` 的 `useLatest` 归一；`revisions` 拼成签名字符串
 *   进依赖，数组每拍新身份不会误触发，签名真的变了才算一次修订。
 * - **现场只认最新那一份**：effect 里不许闭包捕获当拍的 active/demand——React 允许别的 effect
 *   引发额外一次提交，旧闭包会把「不活动」的判断带进晚到的调度。门一律在动作点现读。
 */
import { useEffect, useRef } from 'react'
import { useLatest } from './store.js'

/** 详情类消费者的合并窗默认值：够把一批写后通告收成一趟读，又短到用户察觉不到。 */
export const DEFAULT_REFRESH_COALESCE_MS = 120

export interface GatedRefreshPolicy {
  /** 挂载时先置脏（清单类：挂载就读）；默认 false（详情类：subject 出现才读）。 */
  readonly initialDirty?: boolean
  /** 每次 active false→true 都强制 refresh（归档清单的既有语义）；默认 false。 */
  readonly refreshOnActivate?: boolean
  /** 合并窗（毫秒）：同一窗口内多次失效合并为一次读；0 = 仅微任务合并。默认 0。 */
  readonly coalesceMs?: number
}

export function useGatedRefresh(input: {
  /** 面板/档位是否活动：不活动只置脏不读。 */
  readonly active: boolean
  /** 读需求（reader 传 `subject !== null`）；默认 true。 */
  readonly demand?: boolean
  /** 订阅的修订号集合：任一变化即一次失效。 */
  readonly revisions: readonly number[]
  /**
   * 便宜、同步、每次修订都跑的现场作废——本 hook 里唯一不过两道门的回调，所以「档位关着也要
   * 立刻丢」的现场只能落在这里。**缺省不传不是漏传**：整本账本作废不属于这一类——当场丢会让
   * 兜底首读绕过合并窗与单飞，归档 reader 因此把它放进自己的 refresh（ADR-0063 决定第 5 条）。
   */
  readonly onInvalidate?: () => void
  /** 实际的读；latest-wins 与失败面由它自持。 */
  readonly refresh: () => Promise<void>
  readonly policy?: GatedRefreshPolicy
}): void {
  // 修订序列的稳定签名：数组逐渲染新身份不误触发，内容变了才算一次修订。
  const signature = input.revisions.join('|')

  const invalidate = useLatest(input.onInvalidate)
  const refresh = useLatest(input.refresh)
  const policy = useLatest(input.policy)
  // 档位门的现读面：排读与落地两处都现读最新提交的值。
  const gate = useLatest({ active: input.active, demand: input.demand ?? true })

  const dirty = useRef(policy.current?.initialDirty === true)
  const refreshing = useRef(false)
  const alive = useRef(true)
  /** 待落地的读（合并窗计时器或微任务票）；null = 没有在等的读。 */
  const pending = useRef<{ cancel?(): void } | null>(null)
  /** 每次排读/撤票递增：不可取消的微任务靠票号认出「已被换掉」而认输。 */
  const generation = useRef(0)
  /** 已处理过的修订签名：null = 还没跑过挂载那一拍（挂载不算修订）。 */
  const seenSignature = useRef<string | null>(null)

  // 卸载安全：晚到的结算与未落地的调度都不许再排读。
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      cancelPending()
    }
  }, [])

  /** 落地前复核：门关着、已在飞、已卸载，都不许起新读，dirty 留给下一次门开。 */
  const canStart = (): boolean =>
    alive.current && !refreshing.current && gate.current.active && gate.current.demand

  const start = (): void => {
    cancelPending()
    // dirty 在启动时消费：在飞期间到达的新修订重新置脏，结算后追补。
    dirty.current = false
    refreshing.current = true
    const settle = (): void => {
      refreshing.current = false
      if (!alive.current) return
      if (dirty.current && gate.current.active && gate.current.demand) schedule()
    }
    // 失败不隐式重试：refresh 只是一次尝试，失败面上屏归调用方；这里只收尾节奏。
    // 调用方若同步抛错，也要收尾，否则 refreshing 永远为 true、之后一条读都起不来。
    try {
      void refresh.current().then(settle, settle)
    } catch {
      settle()
    }
  }

  const cancelPending = (): void => {
    pending.current?.cancel?.()
    pending.current = null
    // 作废与重排都算换代：任何在途的旧落地都不再代表当前意图。
    generation.current += 1
  }

  /**
   * 排一次读；已有待落地的读则重置为 trailing（风暴收敛成最后一次之后的单趟读）。
   * `coalesceMs=0` 那颗是微任务票：微任务本身不可取消，靠「票还是不是当前那张」认输——
   * 后续修订一进来就换票，旧票醒来发现自己已过期，不再起读。
   */
  const schedule = (): void => {
    if (!alive.current) return
    cancelPending()
    const window = policy.current?.coalesceMs ?? 0
    if (window <= 0) {
      const ticket = generation.current
      pending.current = {}
      queueMicrotask(() => {
        if (generation.current !== ticket) return
        pending.current = null
        if (canStart()) start()
      })
      return
    }
    const timer = setTimeout(() => {
      pending.current = null
      if (canStart()) start()
    }, window)
    pending.current = { cancel: () => { clearTimeout(timer) } }
  }

  /** 唯一的排读入口：门与在飞状态在这里现读，不在任何闭包里留副本。 */
  const maybeSchedule = (): void => {
    if (!dirty.current) return
    if (!gate.current.active || !gate.current.demand) return
    // 在飞期间只置脏：结算时的 settle 会补一轮；这里再排只会造一张注定被丢弃的票。
    if (refreshing.current) return
    schedule()
  }

  // 修订到达（挂载那一拍只记签名，不算修订）：先同步作废（失效必达），再按门排读。
  useEffect(() => {
    if (signature === seenSignature.current) return
    const mounted = seenSignature.current === null
    seenSignature.current = signature
    if (mounted) return
    invalidate.current?.()
    dirty.current = true
    maybeSchedule()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 判据只有签名这一个；其余输入都在动作点经 ref 现读。
  }, [signature])

  // 激活那一拍：关档先撤票（排队中的读不许落地）；force 语义仍吃 demand 门与单飞。
  useEffect(() => {
    if (!input.active) {
      cancelPending()
      return
    }
    if (policy.current?.refreshOnActivate !== true) {
      maybeSchedule()
      return
    }
    if (!gate.current.demand) {
      // 强制激活撞上无需求：把「这一趟要读」记在 dirty 上，需求翻上来时补一次。
      dirty.current = true
      return
    }
    if (refreshing.current) {
      dirty.current = true
      return
    }
    cancelPending()
    dirty.current = false
    if (alive.current) start()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 判据只有 active 的翻转；其余现场经 ref 现读。
  }, [input.active])

  // demand 翻上来那一拍：关需求先撤票；翻上来时欠着 dirty 才补读。
  useEffect(() => {
    if (input.demand === false) {
      cancelPending()
      return
    }
    maybeSchedule()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 判据只有 demand 的翻转；其余经 ref 现读。
  }, [input.demand])
}