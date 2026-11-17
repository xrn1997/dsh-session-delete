/**
 * 两档清单读数共用的**读一趟**生命周期：latest-wins 票、挂载归属（`alive`）、`refreshing` 标记、
 * 失败落面与首帧初值。两档的取数形状（`/list` 的行 vs `/archive-list` 的四态信封）与缺席语义
 * （回收站没有 absent；归档有 `{available:false}`）各自由 adapter 折成 {@link PanelReadOutcome}，
 * 生命周期只住这一处。
 *
 * 为什么收：`use-trash-query.ts` 与 `use-archive-query.ts` 曾各写一遍「票 + alive + refreshing +
 * 失败上屏」；同一件事写两遍，一边补了卸载晚到守卫、另一边忘了是不可能的漂移。收口之后两档只
 * 留自己的数据语义（首帧快照 / corpus-missing / 附件回执 / 归档计数），共用读的落地。
 *
 * **排读节奏不在这里**：`use-gated-refresh.ts` 拥有「什么时候排读」（active/修订/合并/单飞）。
 * 本 hook 只暴露唯一动作 `reload()`，由调用方（或它自己的 gated-refresh 接线）驱动——归档档在
 * 自己的 query 里直接接线，回收站档由面板控制器接线，两档的既有语义都不搬。
 *
 * 合并窗两档不同、是**行为差异**不是实现细节：归档档同一拍的多次 `reload` 共享一个微任务
 * （它的失效来源多台）；回收站保持既有语义（每次调用各自发一趟，latest-wins 裁决落地）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createLatestWins, useLatest } from './store.js'

/** 一次读的归一路面：adapter 把各自信封折成三支；本 hook 只认这三支。 */
export type PanelReadOutcome<R, M> =
  | { readonly kind: 'rows'; readonly rows: readonly R[]; readonly meta: M }
  /** 显式缺席（归档档的 `{available:false}` / 语料不可见）。它不是空清单、也不是失败。 */
  | { readonly kind: 'absent' }
  | { readonly kind: 'failure'; readonly message: string }

/** 读数的三态 + 缺席态：两档的渲染侧各自从这一份派生自己的旧形状（见两个 query 包装）。 */
export type PanelListState<R, M> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly rows: readonly R[]; readonly meta: M }
  | { readonly status: 'absent' }
  | { readonly status: 'failure'; readonly message: string }

export interface PanelListReadSpec<R, M> {
  /** 首帧初值（回收站首帧快照）：挂载只调一次；null = 从 loading 起画。 */
  readonly initial?: () => { readonly rows: readonly R[]; readonly meta: M } | null
  /** 发一趟读并折成三支。`read` 经 `useLatest` 读取，逐渲染换新引用不会让回调换身份。 */
  readonly read: () => Promise<PanelReadOutcome<R, M>>
  /** 成功落点（回收站写回首帧快照；归档无）。 */
  readonly onSuccess?: (rows: readonly R[], meta: M) => void
  /** 失败落点（回收站整份丢快照；归档无）。 */
  readonly onFailure?: (message: string) => void
  /** 同一拍多次 `reload` 共享一个微任务（归档档）；缺省 false = 每次调用各自发一趟。 */
  readonly coalesceMicrotask?: boolean
}

export interface PanelListRead<R, M> {
  readonly state: PanelListState<R, M>
  /** 读数已有行、重读还在飞；只给 `aria-busy`，不是第五态。 */
  readonly refreshing: boolean
  /** 唯一重读入口：挂载、显式重试、写后、失效通告都走这一条。
   *  属性声明而非方法简写：它会被摘下来交给 `useGatedRefresh`，隐式 `this` 会触发 `unbound-method`。 */
  readonly reload: () => Promise<void>
  /** 聚合写失败等「读数之外」的失败落面：作废在飞读、跑 `onFailure`、把清单打成 failure。
   *  回收站的清空失败走这一条（旧行与快照一起作废，措辞原文由调用方给）。 */
  readonly fail: (message: string) => void
}

export function usePanelListRead<R, M>(spec: PanelListReadSpec<R, M>): PanelListRead<R, M> {
  /** 首帧初值只在挂载读一次：之后由成功读数写回（回收站快照的写回归 adapter 的 `onSuccess`）。 */
  const [initial] = useState(() => spec.initial?.() ?? null)
  const [state, setState] = useState<PanelListState<R, M>>(
    initial === null
      ? { status: 'loading' }
      : { status: 'ready', rows: initial.rows, meta: initial.meta },
  )
  const [refreshing, setRefreshing] = useState(initial !== null)

  /** 输入逐渲染换新引用：`read` / 落点 / 合并档位都经 `useLatest` 归一，`reload` 身份恒稳。 */
  const latest = useLatest(spec)

  /** 这一份挂载还在不在：卸载后晚到的响应不许再写状态（快照挂在场景实例里，见两个 adapter）。 */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const [ticket] = useState(createLatestWins)
  /** 合并窗那一张在飞的 promise（只归档档用）；null = 没有待落地的读。 */
  const scheduled = useRef<Promise<void> | null>(null)

  /** 一次读：签到一张票再发请求；输给后发的读时这一次什么都不落地。 */
  const doRead = useCallback(async (): Promise<void> => {
    const readTicket = ticket.issue()
    setRefreshing(true)
    const outcome = await latest.current.read()
    if (!alive.current || !readTicket.current) return
    setRefreshing(false)
    if (outcome.kind === 'failure') {
      latest.current.onFailure?.(outcome.message)
      setState({ status: 'failure', message: outcome.message })
      return
    }
    if (outcome.kind === 'absent') {
      setState({ status: 'absent' })
      return
    }
    latest.current.onSuccess?.(outcome.rows, outcome.meta)
    setState({ status: 'ready', rows: outcome.rows, meta: outcome.meta })
  }, [latest, ticket])

  /** 唯一重读入口。合并微任务的档位（归档）同一拍只发一趟；回收站保持每次调用各自发。 */
  const reload = useCallback((): Promise<void> => {
    if (latest.current.coalesceMicrotask !== true) return doRead()
    const inFlight = scheduled.current
    if (inFlight !== null) return inFlight
    const run = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        scheduled.current = null
        void doRead().then(resolve)
      })
    })
    scheduled.current = run
    return run
  }, [doRead, latest])

  /** 读数之外的失败落面（聚合写失败）：旧行与快照一起作废，在飞旧读不许再盖回新态。 */
  const fail = useCallback((message: string): void => {
    ticket.invalidate()
    setRefreshing(false)
    latest.current.onFailure?.(message)
    setState({ status: 'failure', message })
  }, [latest, ticket])

  return {
    state,
    refreshing,
    reload,
    fail,
  }
}
