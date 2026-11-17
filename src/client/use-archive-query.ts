/**
 * 归档清单的取数编排：**四态** + 唯一重读入口 `reload`。
 *
 * 「一次读怎么落地」（票 / 挂载归属 / `refreshing` / 失败上屏）已收进
 * `src/client/use-panel-list-read.ts` 的两档共用实现；这一层只留归档自己的数据语义：四态映射
 * （含 `corpus-missing`）、惰性计数，以及「失效 → 重读」的接线。
 *
 * 四态：`loading` / `ready`（行 + 合计 + 大小缺席数）/ `failure`（读失败：错误上屏 + 重试）/
 * `corpus-missing`（`{available:false}`：「语料不可见」的独立显式态，**不是**空清单、也不是
 * 通用失败——ADR-0060 决定第 4 条的显式缺席语义：看不见 ≠ 没有）。
 *
 * 失效链（ADR-0060 决定第 4 条）：
 * - 三个来源都只戳修订台：旁路观察与自救动作戳 `archive-store`，插件自己的回收站动作戳 `trash-store`
 *   （恢复/撤销会让已归档会话重新可见、删除会让它消失——都不改 `archivedSessionIds`，旁路观察看不到）。
 *   查询自己订阅**两台**修订号，effect 依赖 `[active, 两台修订]`。
 * - **active 门**：归档档不活动时只置脏（修订号已记着"变过"）、不读；切到 active 那一拍才读——
 *   默认档是回收站，不为一个可能不打开的档在挂载时付一次全语料读。
 * - **同一拍多次失效合并到一次读**（React 批处理 + `reload` 发起前的微任务合并，共用 hook 的
 *   `coalesceMicrotask`）。
 * - **latest-wins**：每次读一张票，旧响应不许盖新态；在飞期间的新失效只置脏、结算后追补一轮
 *   （单飞由共用生命周期保证；旧票由 `createLatestWins` 作废，ADR-0060 决定第 4 条）。没有轮询。
 * - **快照隔离**：清单/选中/详情都不进 `trash-snapshot`——同一次挂载内缓存（本 hook 常驻挂载，
 *   切档保留已读），卸载即丢。
 */
import { useState } from 'react'
import type { ArchiveRowWire } from '../shared/wire.js'
import type { SessionDeleteRemote } from './remote.js'
import { useArchiveRevision } from './archive-store.js'
import { useTrashRevision } from './trash-store.js'
import { useGatedRefresh } from './use-gated-refresh.js'
import { usePanelListRead, type PanelReadOutcome } from './use-panel-list-read.js'

export type ArchiveListState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly rows: readonly ArchiveRowWire[]; readonly totalBytes: number; readonly missingSizeCount: number }
  | { readonly status: 'failure'; readonly message: string }
  | { readonly status: 'corpus-missing' }

/** 归档清单那一行背后的合计读数：`ready` 态的两格。 */
interface ArchiveListMeta {
  readonly totalBytes: number
  readonly missingSizeCount: number
}

export interface ArchiveQuery {
  readonly list: ArchiveListState
  /** 清单已有行、重读还在飞；只给 `aria-busy` 用，**不是第五态**。 */
  readonly refreshing: boolean
  /** M 的惰性读数：首次成功读取前是 `null`（不摆假 0），之后随每次成功读数更新。 */
  readonly count: number | null
  /** 唯一重读入口：挂载/切档、两台修订、自救动作、显式重试全走这一条。 */
  reload: () => Promise<void>
}

/** 归档清单的读：把四态信封折成共用落地面；`{available:false}` 是显式缺席，不是失败。 */
async function readArchiveList(
  deps: Pick<SessionDeleteRemote, 'archiveList'>,
): Promise<PanelReadOutcome<ArchiveRowWire, ArchiveListMeta>> {
  const outcome = await deps.archiveList()
  if (!outcome.ok) return { kind: 'failure', message: outcome.failure.message }
  if (!outcome.value.available) return { kind: 'absent' }
  return {
    kind: 'rows',
    rows: outcome.value.rows,
    meta: {
      totalBytes: outcome.value.totalBytes,
      missingSizeCount: outcome.value.missingSizeCount,
    },
  }
}

export function useArchiveQuery({
  deps,
  active,
}: {
  deps: Pick<SessionDeleteRemote, 'archiveList'>
  /** 归档档活动（面板挂载且档位在归档）：不活动只置脏不读。 */
  active: boolean
}): ArchiveQuery {
  /** M 的惰性读数：首次成功前 `null`；失败不后退（旧读数仍说"最后一次成功读到的条数"）。 */
  const [count, setCount] = useState<number | null>(null)

  const read = usePanelListRead<ArchiveRowWire, ArchiveListMeta>({
    read: () => readArchiveList(deps),
    onSuccess: (rows) => { setCount(rows.length) },
    coalesceMicrotask: true,
  })

  const list: ArchiveListState = read.state.status === 'loading'
    ? { status: 'loading' }
    : read.state.status === 'ready'
      ? {
        status: 'ready',
        rows: read.state.rows,
        totalBytes: read.state.meta.totalBytes,
        missingSizeCount: read.state.meta.missingSizeCount,
      }
      : read.state.status === 'absent'
        ? { status: 'corpus-missing' }
        : { status: 'failure', message: read.state.message }

  const trashRevision = useTrashRevision()
  const archiveRevision = useArchiveRevision()

  // 失效链的唯一落点：生命周期判 active/修订与合并节奏（本档每次激活都重读），这里只交 reload。
  useGatedRefresh({
    active,
    revisions: [trashRevision, archiveRevision],
    refresh: read.reload,
    policy: { initialDirty: true, refreshOnActivate: true },
  })

  // `read.reload` 的身份由 `usePanelListRead` 的 `useCallback` 保证恒稳；不要再包一层
  // `useCallback`——`read` 对象每渲染换新，包了反而让身份逐渲染变。
  return { list, refreshing: read.refreshing, count, reload: read.reload }
}
