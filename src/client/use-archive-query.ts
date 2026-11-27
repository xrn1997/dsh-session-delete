/**
 * 归档清单的取数编排：**四态** + 唯一重读入口 `reload`。一次读的落地（票 / 挂载归属 / refreshing /
 * 失败上屏）住 `use-panel-list-read.ts`；这一层只留归档数据语义：四态映射（`corpus-missing` 是显式
 * 缺席，不是空清单也不是失败，ADR-0060 决定第 4 条）、惰性计数与失效接线。
 * 失效链：三来源只戳修订台（旁路观察与自救戳 `archive-store`，回收站动作戳 `trash-store`），查询订阅
 * 两台；**active 门**不活动只置脏不读；同拍多次失效合并成一次读；latest-wins 旧响应不许盖新态。
 */
import { useCallback, useState } from 'react'
import type { ArchiveRowWire } from '../shared/wire.js'
import type { SessionDeleteRemote } from './remote.js'
import { useArchiveRevision } from './archive-store.js'
import { useClientScene } from './scene.js'
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

/** 归档清单状态对视图行的唯一解读：只有 `ready` 交出行；缺席与失败都不折成空清单。 */
export function archiveRowsOf(list: ArchiveListState): readonly ArchiveRowWire[] | null {
  return list.status === 'ready' ? list.rows : null
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

  const scene = useClientScene()
  const trashRevision = useTrashRevision()
  const archiveRevision = useArchiveRevision()

  // 失效链的唯一落点：生命周期判 active/修订与合并节奏（本档每次激活都重读），这里只交 reload。
  const { markConsumed } = useGatedRefresh({
    active,
    revisions: [trashRevision, archiveRevision],
    refresh: read.reload,
    policy: { initialDirty: true, refreshOnActivate: true },
  })

  const { reload: readReload } = read
  const reload = useCallback((): Promise<void> => {
    // 显式重读（如归档档移入回收站后包进写闸的 reload）把此刻两台修订一并消费（顺序与上面的
    // `revisions` 入参一致），避免同拍 `invalidateTrash()` 随后触发 React 提交时经 `useGatedRefresh`
    // 再补一趟 `/archive-list`。
    markConsumed([scene.trashRevisions.read(), scene.archiveRevisions.read()])
    return readReload()
  }, [markConsumed, readReload, scene])

  return { list, refreshing: read.refreshing, count, reload }
}
