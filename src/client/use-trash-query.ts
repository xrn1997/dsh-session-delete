/**
 * 清册读数的取数编排：一次 `/list`、一张最新票、一句附件回执。
 *
 * 三条承重规矩：
 * - 最新票：在飞的旧清单读不许盖掉新状态。
 * - 读不到就说读不到：失败进 `unknown`（原文上屏），不折成"空的"。
 * - 附件读数只住在写动作的回执里：清单重读读不出来，所以它单独一条提示、**最新的写赢**。
 * - 首帧快照：挂载时若有一份上次成功的清单，先按 `ready` 画它并标 `refreshing`，再静默重读；
 *   重读失败整份丢掉（快照不许把旧行续命成"此刻的事实"）。快照本体住 `trash-snapshot.ts`。
 * - 挂载归属：请求属于发起它的那次挂载。卸载后晚到的结论（成功或失败）一律不写模块级快照——
 *   快照是跨挂载共享的，旧挂载的结论不是"此刻的事实"。
 *
 * 输入的引用**不需稳定**：`deps` / `t` / `gate` 经 `useLatest` 归一（判据住 `store.ts`），
 * 返回的三个回调身份恒稳，可安全进调用方 effect 的依赖。
 *
 * 无主子会话的检查/清理**不在这一面**：那是插件设置页维护卡的手动动作（`use-maintenance.ts`）。
 * 面板挂载、写后重读与清空都只碰清单，一次都不自动扫（ADR-0021）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BusyGate, GateRun } from './busy-gate.js'
import { type SessionDeleteRemote, type TrashEntryLike } from './remote.js'
import {
  clearTrashDetails,
  clearTrashSnapshot,
  readTrashSnapshot,
  reconcileTrashRows,
} from './trash-snapshot.js'
import { dismissUndoNotice } from './undo-notices.js'
import { createLatestWins, useLatest } from './store.js'
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
 *  面板与控制器不再各自从 `status` 反推——"未知"不是"空"，也不许把失败折成空态。
 *  `refreshing` 只说明"清单已有行、重读还在飞"：行可能来自首帧快照或上一次成功读数。
 *  它不改变三态，也不许把读失败折成"有行"（失败支会先把快照丢掉再落 `unknown`）。 */
export interface TrashListView {
  readonly rows: readonly TrashEntryLike[] | null
  readonly failure: string | null
  readonly loading: boolean
  readonly empty: boolean
  readonly refreshing: boolean
}

export function listView(list: TrashListState, refreshing = false): TrashListView {
  switch (list.status) {
    case 'loading':
      return { rows: null, failure: null, loading: true, empty: false, refreshing: false }
    case 'unknown':
      return { rows: null, failure: list.failure, loading: false, empty: false, refreshing: false }
    case 'ready':
      return { rows: list.rows, failure: null, loading: false, empty: list.rows.length === 0, refreshing }
  }
}

export interface TrashQuery {
  readonly list: TrashListState
  /** 清单已有行、重读还在飞（行来自首帧快照或上一次成功读数）。只给视图挂 `aria-busy` 用；
   *  它**不是第四态**。 */
  readonly refreshing: boolean
  /** 最近一次写动作（purge / 清空）的附件读数，已经拼成一句话：**最新的写赢**。
   *  一次没有附件读数的 purge / 清空、或这一趟写失败（没拿到回执）都会把它清成 `null`，不让上一条的
   *  读数冒充这一趟；删除与恢复不碰它。它是**过去那一趟的回执**、不是清单状态：清单重读读不出来。 */
  readonly attachmentNotice: string | null
  /** 把一份附件读数摆上屏（`undefined` = 这一趟没有读数，旧提示收掉）；句子怎么拼归这里，调用方只管转交。 */
  noteAttachmentCleanup: (a: AttachmentCleanupWire | undefined) => void
  /** 重读清单：挂载、显式「重试」、写后与失效通告都走这一条读——问的是同一件事（"清单现在长什么样"）。
   *  曾经分作 `refreshAll` / `refreshAfterWrite` 两个名字，那是调用点问的两件事（"用户要看现在的"与
   *  "别处动过了，跟上"），不是两条路径，合一为 `reload`。面板没有第二条扫描：孤儿检查是设置页
   *  维护卡的手动动作（ADR-0021）。清单读失败时旧行进 `unknown`。 */
  reload: () => Promise<void>
  /** 清空回收站（聚合回执）：成功就按发起时已在回收站里的条目熄掉撤销横幅、丢详情账本并重读，
   *  失败就把清单置为未知并摆上原文。
   *  两支判别：`{kind:'blocked'}` = 闸把这一趟挡回来了、什么都没跑（调用方不收框，等在飞那一趟的
   *  结论）；`{kind:'ran', value}` 里 `value` 是清空落没落地（`false` 的原文已在清单那块上屏）。 */
  emptyTrash: () => Promise<GateRun<boolean>>
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
  /** 挂载时只读一次首帧快照；之后由 `reload` 成功支写回、失败支整份丢掉。 */
  const [initialSnapshot] = useState(readTrashSnapshot)
  const [list, setList] = useState<TrashListState>(() => initialSnapshot === null
    ? { status: 'loading' }
    : { status: 'ready', rows: initialSnapshot.rows })
  const [refreshing, setRefreshing] = useState(initialSnapshot !== null)
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null)

  /** 输入引用归一（判据住 `store.ts` 的 `useLatest`）：回调经它读最新输入，身份恒稳。
   *  `list` 也放进来：清空起飞前要按下「发起时已在回收站里的条目」记名单，不能把它塞进
   *  `emptyTrash` 的依赖（那会让回调每次读数换身份）。 */
  const latest = useLatest({ deps, t, gate, list })

  /**
   * 这一份挂载还在不在。清单快照是**模块级**的，而请求属于某一次挂载：切走面板后晚到的响应
   * 不许再写快照——否则旧读数会盖掉新挂载刚写下的行，还会按旧行把新行仍引用的详情剪掉
   * （`reconcileTrashRows` 的 `previousIds` 读的是当前快照）。StrictMode 的挂载→卸载→再挂载
   * 由 setup 里重新置真接住。
   */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  /** 清单进入 `unknown` 的唯一落点：旧行与首帧快照一起作废，重读在飞标记一起收掉。 */
  const failList = useCallback((failure: string): void => {
    clearTrashSnapshot()
    setRefreshing(false)
    setList({ status: 'unknown', failure })
  }, [])

  /** 清单的唯一读法：签到一张票再发请求；输给后发的读时这一次什么都不落地（不让旧响应盖掉新状态）。 */
  const [reloadLatest] = useState(createLatestWins)
  const reload = useCallback(async (): Promise<void> => {
    const ticket = reloadLatest.issue()
    setRefreshing(true)
    const outcome = await latest.current.deps.list()
    if (!alive.current || !ticket.current) return
    if (!outcome.ok) {
      // 读不到就整份丢掉：旧行不许继续冒充此刻的回收站（`unknown` 不向下游交行）。
      failList(outcome.failure.message)
      return
    }
    reconcileTrashRows(outcome.value)
    setRefreshing(false)
    setList({ status: 'ready', rows: outcome.value })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `latest` 是 `useLatest` 回的恒稳 ref（自定义 hook，规则看不见），读的是 `.current`。
  }, [reloadLatest, failList])

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
    const skipped = attachmentSkippedSentence(a, latest.current.t)
    if (skipped !== null) {
      setAttachmentNotice(skipped)
      return
    }
    setAttachmentNotice(a.failed > 0 ? latest.current.t('trash.attachments.failed', { count: a.failed }) : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `latest` 是 `useLatest` 的恒稳 ref（规则看不见自定义 hook），不是每拍新值。
  }, [])

  // 清空是**聚合回执**、不是 `/apply` 座位：`emptyTrash` 自己包闸（别在外面再套一层，双套会让外层 busy 提前落下）。
  // 被闸挡回的那一趟原样交回 `{kind:'blocked'}`（这一趟没跑），不许在这里折成 `false`——`false` 说的是
  // 「跑过、没清成」，而那一趟的原文已经上过屏；调用方要能把两者分开。
  const emptyTrash = useCallback((): Promise<GateRun<boolean>> => latest.current.gate.around(async () => {
    // 发起那一刻的在场名单：清空只熄灭指向这些条目的横幅。清空在飞期间从侧栏新删的一条会发布
    // 新横幅，它不在名单里——不能被这次清空顺手收掉（那是一条仍可撤销的动作）。
    const emptiedIds = (listView(latest.current.list).rows ?? []).map((row) => row.id)
    const outcome = await latest.current.deps.emptyTrash()
    if (!outcome.ok) {
      // 挂载已经不在：这一趟的结论归后来那次挂载，不许拿旧失败清掉它刚写下的快照。
      if (!alive.current) return false
      // 清空失败在这块界面上的落点就是"清单未知"：回收站此刻是什么样我们不知道，旧行也不能继续可操作。
      // 同时作废在飞的清单读——晚到的旧读不能把这一拍又盖回 ready；首帧快照也一起丢掉。
      reloadLatest.invalidate()
      failList(outcome.failure.message)
      // 这一趟没拿到回执：不能断言附件清没清，旧读数也不许继续当"最近一次写"的后果挂在那儿。
      noteAttachmentCleanup(undefined)
      return false
    }
    // 按条目名单熄灭横幅：命中才收，未命中的（含在飞期间新发布的）原样留着。这一步只碰名单内的
    // 条目，所以卸载后的晚到结论也不会误熄新挂载刚发布的横幅（判据与现场住 `undo-notices.ts`；
    // 逐条 purge 那一路由 settlement 的 purge 支熄灭，ADR-0013）。失败不熄——回收站还在，撤销仍可做。
    dismissUndoNotice(emptiedIds)
    // 挂载已经不在：重读、快照与账本都归后来那次挂载；这里只交付「清空成功」这一个结论。
    if (!alive.current) return true
    await reload()
    // 清空让整份详情账本作废：孩子详情不随清单修剪，靠这里丢；空清单快照原样留着（重读刚写下的）。
    clearTrashDetails()
    // 附件那半句只住在这一趟的聚合回执里，重读读不出来 ⇒ 重读之后再摆（清单读失败也不影响它：
    // 已经发生的事情与"此刻清单长什么样"无关）。
    noteAttachmentCleanup(outcome.value.attachments)
    return true
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `latest` 是 `useLatest` 的恒稳 ref（规则看不见自定义 hook）。
  }), [reload, reloadLatest, failList, noteAttachmentCleanup])

  return {
    list,
    refreshing,
    attachmentNotice,
    noteAttachmentCleanup,
    reload,
    emptyTrash,
  }
}
