/**
 * 清册读数的取数编排：一次 `/list`、一张最新票、一句附件回执。
 *
 * 三条承重规矩：
 * - 最新票：在飞的旧清单读不许盖掉新状态。
 * - 读不到就说读不到：失败进 `unknown`（原文上屏），不折成"空的"。
 * - 附件读数只住在写动作的回执里：清单重读读不出来，所以它单独一条提示、**最新的写赢**。
 *
 * 无主子会话的检查/清理**不在这一面**：那是插件设置页维护卡的手动动作（`use-maintenance.ts`）。
 * 面板挂载、写后重读与清空都只碰清单，一次都不自动扫（ADR-0021）。
 */
import { useCallback, useState } from 'react'
import type { BusyGate } from './busy-gate.js'
import { callRemote, type SessionDeleteRemote, type TrashEntryLike } from './remote.js'
import { clearUndoNotice } from './undo-notices.js'
import { createLatestWins } from './store.js'
import type { Translate } from './copy.js'
import { attachmentSkippedSentence } from './receipt.js'
import type { AttachmentCleanupWire } from '../shared/wire.js'

export type TrashQueryDeps = Pick<SessionDeleteRemote, 'list' | 'emptyTrash'>

/** 清单的唯一状态：加载中 / 有行 / 未知。`unknown` 不向下游交出任何行——旧行不许继续可操作。 */
export type TrashListState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly rows: readonly TrashEntryLike[] }
  | { readonly status: 'unknown'; readonly failure: string }

/** 清单状态对视图的**唯一解读**：行、失败原文、加载中与空态一次交出。
 *  面板与控制器不再各自从 `status` 反推——"未知"不是"空"，也不许把失败折成空态。 */
export interface TrashListView {
  readonly rows: readonly TrashEntryLike[] | null
  readonly failure: string | null
  readonly loading: boolean
  readonly empty: boolean
}

export function listView(list: TrashListState): TrashListView {
  switch (list.status) {
    case 'loading':
      return { rows: null, failure: null, loading: true, empty: false }
    case 'unknown':
      return { rows: null, failure: list.failure, loading: false, empty: false }
    case 'ready':
      return { rows: list.rows, failure: null, loading: false, empty: list.rows.length === 0 }
  }
}

export interface TrashQuery {
  readonly list: TrashListState
  /** 最近一次写动作（purge / 清空）的附件读数，已经拼成一句话：**最新的写赢**。
   *  一次没有附件读数的 purge / 清空、或这一趟写失败（没拿到回执）都会把它清成 `null`，不让上一条的
   *  读数冒充这一趟；删除与恢复不碰它。它是**过去那一趟的回执**、不是清单状态：清单重读读不出来。 */
  readonly attachmentNotice: string | null
  /** 把一份附件读数摆上屏（`undefined` = 这一趟没有读数，旧提示收掉）；句子怎么拼归这里，调用方只管转交。 */
  noteAttachmentCleanup(a: AttachmentCleanupWire | undefined): void
  /** 重读清单；挂载与显式「重试」用它。面板没有第二条扫描：孤儿检查是设置页维护卡的手动动作。 */
  refreshAll(): Promise<void>
  /** 写后/失效通告：与 `refreshAll` 同一条读。两个名字留着是因为调用点问的是两件事
   *  （"用户要看现在的"与"别处动过了，跟上"），不是两条路径。清单读失败时旧行进 `unknown`。 */
  refreshAfterWrite(): Promise<void>
  /** 清空回收站（聚合回执）：成功就熄掉撤销横幅并重读，失败就把清单置为未知并摆上原文。交回是否成功。 */
  emptyTrash(): Promise<boolean>
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
  const [list, setList] = useState<TrashListState>({ status: 'loading' })
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null)

  /** 清单的唯一读法：签到一张票再发请求；输给后发的读时这一次什么都不落地（不让旧响应盖掉新状态）。 */
  const [reloadLatest] = useState(createLatestWins)
  const reload = useCallback(async (): Promise<void> => {
    const ticket = reloadLatest.issue()
    const outcome = await callRemote(() => deps.list())
    if (!ticket.current) return
    if (!outcome.ok) {
      setList({ status: 'unknown', failure: outcome.failure.message })
      return
    }
    setList({ status: 'ready', rows: outcome.value })
  }, [deps, reloadLatest])

  /**
   * 附件读数上屏：`skipped`（这一轮部分或整体没敢清）优先于 `failed`（逐文件真出错）——前者是原因，
   * 后者只是件数。**`removed > 0` 时不许说成"整轮没清"**：那一轮清掉了 `removed` 件，只是没清完，
   * 句子要把已清的那几件一起说出来。两者同时出现时 `failed` 追加在句尾：跳过原因不许把真失败吞掉。
   * 没有读数 = 这一趟没得说，旧提示收掉。
   */
  const noteAttachmentCleanup = useCallback((a: AttachmentCleanupWire | undefined): void => {
    if (a === undefined) {
      setAttachmentNotice(null)
      return
    }
    // 跳过半句与维护卡共用同一判据（`receipt.ts`）；面板只在「没有跳过但有逐文件失败」时报数，
    // 全清干净不上屏（面板不拿"清了 0 件 / 清了几件"占一行）。
    const skipped = attachmentSkippedSentence(a, t)
    if (skipped !== null) {
      setAttachmentNotice(skipped)
      return
    }
    setAttachmentNotice(a.failed > 0 ? t('trash.attachments.failed', { count: a.failed }) : null)
  }, [t])

  // 清空是**聚合回执**、不是 `/apply` 座位：`emptyTrash` 自己包闸（别在外面再套一层，双套会让外层 busy 提前落下）。
  const emptyTrash = useCallback((): Promise<boolean> => gate.around(async () => {
    const outcome = await callRemote(() => deps.emptyTrash())
    if (!outcome.ok) {
      // 清空失败在这块界面上的落点就是"清单未知"：回收站此刻是什么样我们不知道，旧行也不能继续可操作。
      // 同时作废在飞的清单读——晚到的旧读不能把这一拍又盖回 ready。
      reloadLatest.invalidate()
      setList({ status: 'unknown', failure: outcome.failure.message })
      // 这一趟没拿到回执：不能断言附件清没清，旧读数也不许继续当"最近一次写"的后果挂在那儿。
      noteAttachmentCleanup(undefined)
      return false
    }
    // 清空把所有落点一起清了：还挂着的横幅是一条注定失败的「撤销」，先收掉再重读（判据与现场住
    // `undo-notices.ts`；逐条 purge 那一路由 settlement 的 purge 支熄灭，ADR-0013）。失败不熄——
    // 回收站还在，撤销仍是可做的动作。
    clearUndoNotice()
    await reload()
    // 附件那半句只住在这一趟的聚合回执里，重读读不出来 ⇒ 重读之后再摆（清单读失败也不影响它：
    // 已经发生的事情与"此刻清单长什么样"无关）。
    noteAttachmentCleanup(outcome.value.attachments)
    return true
  }), [gate, deps, reload, reloadLatest, noteAttachmentCleanup])

  return {
    list,
    attachmentNotice,
    noteAttachmentCleanup,
    refreshAll: reload,
    refreshAfterWrite: reload,
    emptyTrash,
  }
}
