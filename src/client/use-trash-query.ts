/**
 * 清册读数的取数编排：一次 `/list`、一张最新票、一句附件回执。一次读的落地住
 * `use-panel-list-read.ts`；这一层只留回收站自己的数据语义：首帧快照读写、附件回执的「最新写赢」、
 * 清空这条聚合写。规矩：读不到就说读不到（失败进 `unknown`，不折成空）；附件读数只住写回执里；
 * 快照重读失败整份丢掉；请求属于发起它的那次挂载（卸载后晚到的结论不写模块级快照）。
 * 无主子会话检查不在这一面（设置页维护卡手动动作，ADR-0021）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BusyGate, GateRun } from './busy-gate.js'
import { type SessionDeleteRemote, type TrashEntryLike } from './remote.js'
import {
  emptiedTrash,
  reloadFailed,
  readTrashSnapshot,
  reloadSucceeded,
} from './trash-snapshot.js'
import { dismissUndoNotice } from './undo-notices.js'
import { useLatest } from './store.js'
import type { Translate } from './copy.js'
import { attachmentSkippedSentence } from './receipt.js'
import type { AttachmentCleanupWire } from '../shared/wire.js'
import { usePanelListRead, type PanelReadOutcome } from './use-panel-list-read.js'

export type TrashQueryDeps = Pick<SessionDeleteRemote, 'list' | 'emptyTrash'>

/** 清单的唯一状态：加载中 / 有行 / 未知。`unknown` 不向下游交出任何行——旧行不许继续可操作。 */
export type TrashListState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly rows: readonly TrashEntryLike[] }
  | { readonly status: 'unknown'; readonly failure: string }

/** 清单状态的窄读：只交「可以操作的行」——`null` = 还没有行（加载中 / 未知）；"未知"不是"空"，
 *  失败不折成空态。加载 / 空 / 失败卡片各档按自己的 `status` 选（`trash-tab.tsx`），不从这里反推。 */
export function rowsOf(list: TrashListState): readonly TrashEntryLike[] | null {
  return list.status === 'ready' ? list.rows : null
}

export interface TrashQuery {
  readonly list: TrashListState
  /** 清单已有行、重读还在飞（只给 `aria-busy`；不是第四态）。 */
  readonly refreshing: boolean
  /** 最近一次写动作（purge / 清空）的附件读数，已拼成一句话：**最新的写赢**；没有读数或写失败都清成
   *  `null`。它是过去那一趟的回执，不是清单状态。 */
  readonly attachmentNotice: string | null
  /** 把一份附件读数摆上屏（`undefined` = 这一趟没有读数，旧提示收掉）；句子怎么拼归这里，调用方只管转交。 */
  noteAttachmentCleanup: (a: AttachmentCleanupWire | undefined) => void
  /** 重读清单：挂载、显式重试、写后与失效通告都走这一条（同一件事）；面板没有第二条扫描（ADR-0021）。 */
  reload: () => Promise<void>
  /** 清空回收站（聚合回执）：成功按发起时名单熄撤销横幅、丢详情账本并重读；失败把清单置 unknown 并摆
   *  原文。blocked = 闸挡回、什么都没跑。 */
  emptyTrash: () => Promise<GateRun<boolean>>
}

/** 回收站清单的读：形状折成共用落地面；首帧快照与失败丢快照落在这里。 */
async function readTrashList(deps: TrashQueryDeps): Promise<PanelReadOutcome<TrashEntryLike, null>> {
  const outcome = await deps.list()
  if (!outcome.ok) return { kind: 'failure', message: outcome.failure.message }
  return { kind: 'rows', rows: outcome.value, meta: null }
}

export function useTrashQuery({
  deps,
  t,
  gate,
}: {
  deps: TrashQueryDeps
  t: Translate
  /** 面板的一枚全局闸：清空这条写动作把整趟包在里面（面板的 `busy`）。 */
  gate: BusyGate
}): TrashQuery {
  const read = usePanelListRead<TrashEntryLike, null>({
    // 首帧快照只在挂载读一次；之后由成功读数写回、失败支整份丢掉。
    initial: () => {
      const snapshot = readTrashSnapshot()
      return snapshot === null ? null : { rows: snapshot.rows, meta: null }
    },
    read: () => readTrashList(deps),
    onSuccess: (rows) => { reloadSucceeded(rows) },
    onFailure: () => { reloadFailed() },
  })

  /** 共用 hook 交回的稳定动作（`useLatest` 归一后的 ref 上取），不把每拍换新身份的 `read` 对象带进依赖。 */
  const { reload, fail: failRead } = read
  const list: TrashListState = read.state.status === 'loading'
    ? { status: 'loading' }
    : read.state.status === 'ready'
      ? { status: 'ready', rows: read.state.rows }
      : read.state.status === 'failure'
        ? { status: 'unknown', failure: read.state.message }
        // 回收站的 `read` 不可能回 absent（三支是两档共用类型面）：真发生按读失败处理。
        : { status: 'unknown', failure: t('trash.readFailed') }

  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null)

  /** 输入引用归一（`useLatest`）：`list` 也放进来——清空起飞前要按发起时在场名单记名单，塞进依赖会让
   *  回调每次读数换新身份。 */
  const latest = useLatest({ deps, t, gate, list })

  /** 清空这条写自己的挂载归属：不受共用读 hook 的 alive 管（它管的是清单读）。 */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  /**
   * 附件读数上屏：`skipped`（没敢清）优先于 `failed`（逐文件出错）；`removed > 0` 时不许说成"整轮没清"，
   * 两者同时出现时 `failed` 追加句尾。没有读数 = 旧提示收掉。
   */
  const noteAttachmentCleanup = useCallback((a: AttachmentCleanupWire | undefined): void => {
    if (a === undefined) {
      setAttachmentNotice(null)
      return
    }
    // 跳过半句与维护卡共用同一判据；面板只在「没有跳过但有逐文件失败」时报数，全清干净不上屏。
    const skipped = attachmentSkippedSentence(a, latest.current.t)
    if (skipped !== null) {
      setAttachmentNotice(skipped)
      return
    }
    setAttachmentNotice(a.failed > 0 ? latest.current.t('trash.attachments.failed', { count: a.failed }) : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `latest` 是 `useLatest` 的恒稳 ref（规则看不见自定义 hook），不是每拍新值。
  }, [])

  // 清空是**聚合回执**、不是 `/apply` 座位：自己包闸（双套会让外层 busy 提前落）。被挡回的那一趟原样交回
  // `{kind:'blocked'}`，不许折成 `false`——`false` 说的是「跑过、没清成」。
  const emptyTrash = useCallback((): Promise<GateRun<boolean>> => latest.current.gate.around(async () => {
    // 发起那一刻的在场名单：清空只熄灭指向这些条目的横幅。清空在飞期间从侧栏新删的一条会发布
    // 新横幅，它不在名单里——不能被这次清空顺手收掉（那是一条仍可撤销的动作）。
    const emptiedIds = (rowsOf(latest.current.list) ?? []).map((row) => row.id)
    const outcome = await latest.current.deps.emptyTrash()
    if (!outcome.ok) {
      // 挂载已经不在：这一趟的结论归后来那次挂载，不许拿旧失败清掉它刚写下的快照。
      if (!alive.current) return false
      // 清空失败的落点就是"清单未知"：此刻是什么样我们不知道，旧行也不能继续可操作；同时作废在飞清单读、
      // 丢掉首帧快照。
      failRead(outcome.failure.message)
      setAttachmentNotice(null)
      return false
    }
    // 按发起时名单熄灭横幅：命中才收；只碰名单内条目，卸载后的晚到结论也不会误熄新挂载的横幅。
    // 失败不熄——回收站还在，撤销仍可做。
    dismissUndoNotice(emptiedIds)
    // 挂载已经不在：重读、快照与账本都归后来那次挂载；这里只交付「清空成功」这一个结论。
    if (!alive.current) return true
    await reload()
    // 清空让整份详情账本作废：孩子详情不随清单修剪，靠这里丢；空清单快照原样留着（重读刚写下的）。
    emptiedTrash()
    // 附件那半句只住这一趟的聚合回执里，重读读不出来 ⇒ 重读之后再摆。
    noteAttachmentCleanup(outcome.value.attachments)
    return true
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `latest` 是 `useLatest` 的恒稳 ref（规则看不见自定义 hook）；`read.fail` / `read.reload` 由共用 hook 保证身份恒稳。
  }), [failRead, reload, noteAttachmentCleanup])

  return {
    list,
    refreshing: read.refreshing,
    attachmentNotice,
    noteAttachmentCleanup,
    reload,
    emptyTrash,
  }
}
