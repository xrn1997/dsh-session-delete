/**
 * 归档清单的取数编排：**四态** + 唯一重读入口 `reload`。
 *
 * 四态：`loading` / `ready`（行 + 合计 + 大小缺席数）/ `failure`（读失败：错误上屏 + 重试）/
 * `corpus-missing`（`{available:false}`：「语料不可见」的独立显式态，**不是**空清单、也不是
 * 通用失败——ADR-0060 决定第 4 条的显式缺席语义：看不见 ≠ 没有）。
 *
 * 失效链（ADR-0060 决定第 4 条）：
 * - 三个来源都只戳修订台：A1 与自救动作戳 `archive-store`，插件自己的回收站动作戳 `trash-store`
 *   （恢复/撤销会让已归档会话重新可见、删除会让它消失——都不改 `archivedSessionIds`，A1 看不到）。
 *   查询自己订阅**两台**修订号，effect 依赖 `[active, 两台修订]`。
 * - **active 门**：归档档不活动时只置脏（修订号已记着"变过"）、不读；切到 active 那一拍才读——
 *   默认档是回收站，不为一个可能不打开的档在挂载时付一次全语料读。
 * - **同一拍多次失效合并到一次读**（React 批处理 + `reload` 发起前的微任务合并）。
 * - **latest-wins**：每次读一张票，旧响应不许盖新态；在飞期间的新失效只置脏、结算后追补一轮
 *   （单飞由共用生命周期保证；旧票由 `createLatestWins` 作废，ADR-0060 决定第 4 条）。没有轮询。
 * - **快照隔离**：清单/选中/详情都不进 `trash-snapshot`——同一次挂载内缓存（本 hook 常驻挂载，
 *   切档保留已读），卸载即丢。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ArchiveRowWire } from '../shared/wire.js'
import type { SessionDeleteRemote } from './remote.js'
import { useArchiveRevision } from './archive-store.js'
import { useTrashRevision } from './trash-store.js'
import { createLatestWins, useLatest } from './store.js'
import { useGatedRefresh } from './use-gated-refresh.js'

export type ArchiveListState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly rows: readonly ArchiveRowWire[]; readonly totalBytes: number; readonly missingSizeCount: number }
  | { readonly status: 'failure'; readonly message: string }
  | { readonly status: 'corpus-missing' }

export interface ArchiveQuery {
  readonly list: ArchiveListState
  /** 清单已有行、重读还在飞；只给 `aria-busy` 用，**不是第五态**。 */
  readonly refreshing: boolean
  /** M 的惰性读数：首次成功读取前是 `null`（不摆假 0），之后随每次成功读数更新。 */
  readonly count: number | null
  /** 唯一重读入口：挂载/切档、两台修订、自救动作、显式重试全走这一条。 */
  reload: () => Promise<void>
}

export function useArchiveQuery({
  deps,
  active,
}: {
  deps: Pick<SessionDeleteRemote, 'archiveList'>
  /** 归档档活动（面板挂载且档位在归档）：不活动只置脏不读。 */
  active: boolean
}): ArchiveQuery {
  const [list, setList] = useState<ArchiveListState>({ status: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [count, setCount] = useState<number | null>(null)
  const trashRevision = useTrashRevision()
  const archiveRevision = useArchiveRevision()
  const latest = useLatest({ deps })

  /** 这一份挂载还在不在：卸载后晚到的响应不许再写状态。 */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const [reads] = useState(createLatestWins)
  /** 同一拍的多次 `reload` 共享这一个 promise（微任务合并）。 */
  const scheduled = useRef<Promise<void> | null>(null)

  const doRead = useCallback(async (): Promise<void> => {
    const ticket = reads.issue()
    setRefreshing(true)
    const outcome = await latest.current.deps.archiveList()
    if (!alive.current || !ticket.current) return
    setRefreshing(false)
    if (!outcome.ok) {
      setList({ status: 'failure', message: outcome.failure.message })
      return
    }
    if (!outcome.value.available) {
      setList({ status: 'corpus-missing' })
      return
    }
    const { rows, totalBytes, missingSizeCount } = outcome.value
    setList({ status: 'ready', rows, totalBytes, missingSizeCount })
    setCount(rows.length)
  }, [reads, latest])

  const reload = useCallback((): Promise<void> => {
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
  }, [doRead])

  // 失效链的唯一落点：生命周期判 active/修订与合并节奏（本档每次激活都重读），这里只交 reload。
  useGatedRefresh({
    active,
    revisions: [trashRevision, archiveRevision],
    refresh: reload,
    policy: { initialDirty: true, refreshOnActivate: true },
  })

  return { list, refreshing, count, reload }
}
