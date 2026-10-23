/**
 * 回收站面板的**状态机**：谁被选中、详情缓存、窄档下钻与 Esc 交还焦点、清单换版后的清场、
 * 宽档自动选中、"别处动过回收站"的失效重读，以及确认后的写动作（恢复/批量/清空）与失败落点。
 *
 * 面板接入后，这套语义只住这里；面板自己只留布局与行内动作。搬过来的判据一条不改：
 *
 * - **选中从全量条目里找**（`query.entries`，不是键盘序列 `ordered`）：把某一组折叠起来只是收掉
 *   清单那一列，右栏读的那条不该跟着消失。
 * - **一条只读一次**：面板存活期内按条目 id 缓存成功读数；**失败不缓存**——「重试」与切走再切回
 *   都会重新读那一条（缓存里存一次失败，界面就再也等不到它自己好了）。
 * - **清单换版就让位**：选中的 id 不在新清单里 ⇒ 丢它的缓存、清选中、退出下钻。清单读不到
 *   （`entries === null`）**不算"没了"**：那一拍只是不知道，选中 id 留着，详情回 idle。
 * - **自动选中只认 `selectedId === null`**：同一拍里选中的那条消失时，自动选中看到的是旧选中
 *   （非 null）⇒ 不抢；清场落地后的下一拍才接住新清单的第一条。判据是这道 null 门，不是两个
 *   effect 的声明顺序（顺序反过来也拦得住）。
 * - **失效通告只戳重读**：`useTrashRevision` 变了就 `query.refreshAfterWrite()`；挂载那拍才走
 *   `refreshAll()`。它不碰选中、不碰详情缓存（清单换了自会有上面的清场来收尾）。
 * - **动作成功就丢缓存**：恢复/批量彻底删除成功的条目、清空成功的全部条目，详情缓存必须在同一趟里
 *   失效——否则这条会话再被删回来时会摆着上一世的正文。失败只按 `actionFailure[id]` 留原文，不碰缓存。
 * - **Esc 只在 drilled 期间挂 document 监听**：记下 `selectedId` 再退出下钻，渲染落地后把焦点交还
 *   那一行**一次**；`back()`（「← 返回清单」）只收下钻、不动焦点。控制器自己不查 DOM——焦点动作
 *   走注入的 `focusRow`。
 *
 * **失败原文不翻译**：`detailFailure.message` 与 `actionFailure[id]` 都是 Node 半给的原文
 * （`callRemote` 的 `failure.message`），原样交给详情块与清单行上屏。
 *
 * `busy` 是面板那枚全局闸（写动作在飞）的读数：闸本体也由本 module 导出（`useTrashPanelGate`），
 * `restore` / `confirmApply` 用同一个 `gate.around` 把「动作 + 清单重读」整个包住；闸开着时谁该
 * 禁用由面板决定。`kind:'all'` 的清空**不再套一层** `around`——`query.emptyTrash` 自己已经包了
 * 同一枚闸。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  callRemote,
  type SessionDeleteRemote,
  type TrashDetailLike,
  type TrashEntryLike,
} from './remote.js'
import { forgetMainView } from './main-view.js'
import { dismissUndoNotice } from './undo-toast.js'
import { runWrite, type WriteOutcome } from './write.js'
import type { PendingAction } from './trash-confirm.js'
import { useTrashRevision } from './trash-store.js'
import type { TrashDetailState } from './trash-detail.js'
import type { TrashQuery } from './use-trash-query.js'

/** 面板的一枚全局闸：写动作在飞时 `busy` 为真，`around` 把一次任务整个包在"这一趟还算忙"里。 */
export interface TrashPanelGate {
  readonly busy: boolean
  around<T>(task: () => Promise<T>): Promise<T>
}

/**
 * 闸本体（从 `trash-panel.tsx` 的函数体原样收进来）：任务落地或抛错都把 `busy` 放回 false。
 * 不做引用计数：面板同一时刻只允许一趟写动作（按钮在 `busy` 期间全被按住），多一层计数只会
 * 把"这一趟什么时候算完"变成第二个判据。
 *
 * 返回值经 `useMemo` 稳定：`gate` 进 `restore` / `confirmApply` 的 `useCallback` 依赖，每次渲染
 * 换个新对象会让那两个回调跟着失效，进而把引用它们的 effect 也带着重跑。
 */
export function useTrashPanelGate(): TrashPanelGate {
  const [busy, setBusy] = useState(false)
  const around = useCallback(async <T,>(task: () => Promise<T>): Promise<T> => {
    setBusy(true)
    try {
      return await task()
    } finally {
      setBusy(false)
    }
  }, [])
  return useMemo(() => ({ busy, around }), [busy, around])
}

/**
 * 控制器要的面。`query` 取四样：清单（选中从它里面找）、`refreshAll`（挂载与显式重试）、
 * `refreshAfterWrite`（失效与写后）、清空（面板的写动作那一半）。`ordered` 是键盘/自动选中用的
 * "屏幕上的顺序"（只含展开的组），
 * 由面板算好传进来——布局常量不搬进控制器。
 */
export interface TrashPanelControllerInput {
  deps: Pick<SessionDeleteRemote, 'detail' | 'applyOutcomes'>
  gate: TrashPanelGate
  query: Pick<TrashQuery, 'entries' | 'refreshAll' | 'refreshAfterWrite' | 'emptyTrash'>
  ordered: readonly TrashEntryLike[]
  canAutoSelect: boolean
  focusRow(entryId: string): void
}

export interface TrashPanelController {
  readonly busy: boolean
  readonly selected: TrashEntryLike | null
  readonly selectedId: string | null
  readonly drilled: boolean
  readonly detail: TrashDetailState
  /** 待确认的那一批（确认框的开合）；确认落地后由控制器收起。 */
  readonly pending: PendingAction | null
  /** 恢复/彻底删除/批量 的失败原文，按条目 id 存：切走再回来还在。 */
  readonly actionFailure: Readonly<Record<string, string>>
  select(entry: TrashEntryLike, options?: { drill?: boolean }): Promise<void>
  retry(): void
  back(): void
  setPending(pending: PendingAction | null): void
  /** 单条恢复（`/apply` 的 N=1）：成功后丢缓存，写完无论成败都重读清单，失败原文落回这一行。 */
  restore(entry: TrashEntryLike): Promise<void>
  /** 确认框上的「确认」：按 `pending.kind` 分派到空清或 `confirmApply`。 */
  confirmPurge(): Promise<void>
  /** 一组 id 上的同一个动作：逐条成败落成行上原文/缓存失效，整批只重读一次清单。 */
  confirmApply(action: 'purge' | 'restore', ids: readonly string[]): Promise<void>
}

/** 失败按**哪一条**记：只有 `entryId === selected.id` 的失败会进详情块，别的条目失败不会串台。 */
interface DetailFailure {
  entryId: string
  message: string
}

export function useTrashPanelController(input: TrashPanelControllerInput): TrashPanelController {
  const { deps, gate, query, ordered, canAutoSelect, focusRow } = input
  const { entries, refreshAll, refreshAfterWrite, emptyTrash } = query

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [drilled, setDrilled] = useState(false)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [detailFailure, setDetailFailure] = useState<DetailFailure | null>(null)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [actionFailure, setActionFailure] = useState<Readonly<Record<string, string>>>({})
  /** 面板存活期内每条只读一次（本机量级不值得预读，也不值得重复读）。 */
  const detailCache = useRef(new Map<string, TrashDetailLike>())
  /** Esc 退出下钻后要交还焦点的那一行；等 `drilled` 落地、清单回到 DOM 之后再用一次。 */
  const refocusRow = useRef<string | null>(null)
  /** 挂载那一拍做完整刷新（清单 + 残留），之后失效通告只走写后刷新。 */
  const firstRefresh = useRef(true)

  // 别处动过回收站（侧栏菜单里删了一条、或撤销了另一条）时，这一拍重读清单；报告未知或非空才顺带重扫。
  const revision = useTrashRevision()
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false
      void refreshAll()
      return
    }
    void refreshAfterWrite()
  }, [refreshAll, refreshAfterWrite, revision])

  /**
   * 选一条：命中缓存就直接摆（不经过 loading），没命中才去读那条会话自己的日志。
   * `drill` 是窄档的第二步语义（点行 = 选中并下钻；方向键 = 只移动选中）。
   */
  const select = useCallback(
    async (entry: TrashEntryLike, options: { drill?: boolean } = {}): Promise<void> => {
      setSelectedId(entry.id)
      if (options.drill === true) setDrilled(true)
      if (detailCache.current.has(entry.id)) {
        setLoadingId(null)
        setDetailFailure(null)
        return
      }
      setLoadingId(entry.id)
      setDetailFailure(null)
      const outcome = await callRemote(() => deps.detail(entry.id))
      // 只收自己那一拍的 loading：期间已经切到别的条目时，别把新的那一拍按掉。
      setLoadingId((current) => (current === entry.id ? null : current))
      if (outcome.ok) detailCache.current.set(entry.id, outcome.value)
      else setDetailFailure({ entryId: entry.id, message: outcome.failure.message })
    },
    [deps],
  )

  // 清单换了（别处删了一条、恢复成功、彻底删除成功）：选中那条已经不在了就让位，并把它的缓存丢掉。
  // 下面那条自动选中以 `selectedId === null` 为门，所以这一拍（选中还在）它不抢；清场落地后的下一拍才接住。
  useEffect(() => {
    if (entries === null || selectedId === null) return
    if (entries.some((entry) => entry.id === selectedId)) return
    detailCache.current.delete(selectedId)
    setSelectedId(null)
    setDrilled(false)
  }, [entries, selectedId])

  // 宽档首读完成后自动选中第一条：右栏空着比多一次点击更怪（窄档不自动下钻）。
  // `canAutoSelect` 由面板算（盒子够宽且清单里有东西），控制器不认布局常量。
  useEffect(() => {
    if (canAutoSelect && selectedId === null && ordered.length > 0) void select(ordered[0]!)
  }, [canAutoSelect, selectedId, ordered, select])

  /**
   * 下钻里按 Esc 退回清单：监听挂 `document`，因为窄档下钻时清单**不在 DOM 里**——挂在容器上的
   * Esc 是一条永远收不到的死路径。退回后把焦点交还给选中的那一行（行还没进 DOM，记一笔等这一拍
   * 渲染完再交，见下一个 effect）。
   */
  useEffect(() => {
    if (!drilled) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      refocusRow.current = selectedId
      setDrilled(false)
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [drilled, selectedId])

  // 只在下钻**刚刚退出**、且手里真的有 id 时交还一次焦点；交完就清账，后续重渲染不会重复抢焦点。
  useEffect(() => {
    if (drilled || refocusRow.current === null) return
    focusRow(refocusRow.current)
    refocusRow.current = null
  }, [drilled, focusRow])

  /**
   * 选中那条从**全量条目**里找，不从 `ordered`（只含展开的组）里找：折叠组只是把那一列收掉，
   * 右栏那条不该跟着消失——详情读的是这条会话，跟清单怎么分段无关。
   */
  const selected = useMemo(
    () => (entries ?? []).find((entry) => entry.id === selectedId) ?? null,
    [entries, selectedId],
  )

  const detail = useMemo<TrashDetailState>(() => {
    if (selected === null) return { kind: 'idle' }
    if (loadingId === selected.id) return { kind: 'loading', entry: selected }
    const cached = detailCache.current.get(selected.id)
    if (cached !== undefined) return { kind: 'ready', entry: selected, detail: cached }
    if (detailFailure?.entryId === selected.id) {
      return { kind: 'failed', entry: selected, message: detailFailure.message }
    }
    // 兜底：选中了、这一拍没有在飞的读、缓存刚被某个动作清掉（恢复 / 整批 / 清空）——先按
    // 「读着」摆着，下一次 `select` 或清单换版会把状态推到 ready / failed / idle，不会永久停在这里。
    return { kind: 'loading', entry: selected }
  }, [selected, loadingId, detailFailure])

  /** 「重试」只重读当前这一条，不牵清单。 */
  const retry = useCallback((): void => {
    if (selected !== null) void select(selected)
  }, [selected, select])

  /** 退出下钻（「← 返回清单」）：选中留着，详情不清；焦点不动（只有 Esc 会交还焦点）。 */
  const back = useCallback((): void => {
    setDrilled(false)
  }, [])

  /** 一次动作的失败原文落回它自己那一行（按条目 id 存，别条目的成败不会串台）。 */
  const failRow = useCallback((entryId: string, message: string): void => {
    setActionFailure((current) => ({ ...current, [entryId]: message }))
  }, [])

  /** 成功支（含 already-gone）的条目丢详情缓存。 */
  const clearDetailCache = useCallback((successIds: readonly string[]): void => {
    for (const id of successIds) detailCache.current.delete(id)
  }, [])

  /**
   * 单条恢复：**先清掉这一行的旧失败**（再点一次不该还挂着上一次的原文），再把手势包进 `around`。
   * 成功要丢详情缓存 + 重读清单——缓存不失效的话，这条会话再被删回来时会直接摆出上一世的正文。
   * 失败也重读：组回滚可能自己失败（`details.rollbackFailures`），清单不能继续摆旧行。
   * `refreshAfterWrite` 留在 `around` 里：否则旧清单还在屏上，同一个动作能被再点一次。
   * 单条恢复走 `single` 读法，`already-gone` 不可能出现，所以不传 `sessionIdOfEntry`（那条兜底只服务批量）。
   */
  const restore = useCallback(async (entry: TrashEntryLike): Promise<void> => {
    setActionFailure((current) => {
      const next = { ...current }
      delete next[entry.id]
      return next
    })
    await gate.around(async () => {
      const outcome = await runWrite({
        deps,
        action: 'restore',
        ids: [entry.id],
        single: true,
        // 面板座位：成功支丢详情缓存、熄灭指向这条的撤销横幅，并只忘掉 main-view 记过的会话
        // （不重开、不抢焦点）。信封成功不等于这条落地：settlement 只在 anySuccess 时跑这些钩子。
        presentation: {
          clearDetailCache,
          dismissUndo: dismissUndoNotice,
          forgetMainView,
        },
        // 无论信封还是逐条成败，都重读：顶层失败可能是"成了但响应断在路上"；逐条失败也可能是
        // restore 的组回滚自己失败留下的半套——服务端答"失败"不等于盘上没动。
        // 要不要顺带重扫残留由 query 从 outcome 派生（露面的孩子 / 清单未知），这里只如实转交。
        refresh: refreshAfterWrite,
      })
      const failure = outcome.failures.get(entry.id)
      if (failure !== undefined) failRow(entry.id, failure)
    })
  }, [clearDetailCache, deps, failRow, gate, refreshAfterWrite])

  /**
   * 批量彻底删除 / 批量恢复**共用这一条**：一次 `apply` 把整批交给 Node 半，逐条成败住在
   * `WriteOutcome` 里 ⇒ 不再"每条一次全量重读"。顶层失败（路由自检 / 通道断）只说明没拿到信封，
   * 不能断言哪几条落地：原文保守地铺到每一个 id（别让清单看起来"删成功了"），清单照样重读。
   */
  const confirmApply = useCallback(async (action: 'purge' | 'restore', ids: readonly string[]): Promise<void> => {
    // 成败都走同一段收尾（写完框就收、清单就重读）；要不要顺带重扫残留由 query 从 outcome 派生
    // （purge 总要扫；restore 只在恢复露面的孩子或清单未知时扫），这里只如实转交。
    const settle = (outcome: WriteOutcome<'purge' | 'restore'>): Promise<void> => {
      setPending(null)
      return refreshAfterWrite(outcome)
    }
    await gate.around(async () => {
      const outcome = await runWrite({
        deps,
        action,
        ids,
        // 面板座位：purge 只清成功条目的详情缓存；restore 另熄灭整批撤销横幅并忘掉 main-view 的
        // closedByUs（只遗忘、不重开）。already-gone 的回执不带行（wire 只回 null），它的 sessionId
        // 只能从面板当前清单取名；取不到（清单刚被别的写换过版）就跳过：那条的旧重开 pending 由下一次
        // 删除/恢复按「最新动作优先」作废，不会开着一条指向已恢复会话的横幅。
        presentation: {
          clearDetailCache,
          dismissUndo: dismissUndoNotice,
          forgetMainView,
          sessionIdOfEntry: (entryId) => entries?.find((entry) => entry.id === entryId)?.sessionId,
        },
        refresh: settle,
      })
      if (outcome.failures.size === 0) return
      setActionFailure((current) => {
        const next = { ...current }
        for (const [id, message] of outcome.failures) next[id] = message
        return next
      })
    })
  }, [clearDetailCache, deps, entries, gate, refreshAfterWrite])

  /**
   * 确认框上的「确认」按 `pending` 的形状分派：三条按条目标都委托 `confirmApply`（一段 `/apply`）；
   * 清空是**聚合回执**、形状不同，走 `query.emptyTrash`——它自己已经包了同一枚闸与重读，这里
   * **不再套第二层 `around`**（双套会让外层 busy 提前落下）。
   */
  const confirmPurge = useCallback(async (): Promise<void> => {
    const target = pending
    if (target === null) return
    if (target.kind === 'entry') return confirmApply('purge', [target.entry.id])
    if (target.kind === 'entries') return confirmApply('purge', target.ids)
    if (target.kind === 'restore') return confirmApply('restore', target.ids)
    const emptied = await emptyTrash()
    setPending(null)
    if (emptied) detailCache.current.clear()
  }, [confirmApply, emptyTrash, pending])

  return {
    busy: gate.busy,
    selected,
    selectedId,
    drilled,
    detail,
    pending,
    actionFailure,
    select,
    retry,
    back,
    setPending,
    restore,
    confirmPurge,
    confirmApply,
  }
}
