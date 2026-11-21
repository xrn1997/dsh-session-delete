/**
 * 详情读路的**通用机制**：账本 + 在飞去重 + 失败 + 保持 + 分页；账本与取数是注入的 seam，回收站与
 * 归档各是一台薄实例。承重判据：成功才记账（失败不让旧详情顶位）；同一条在飞只发一次；保持只对
 * 顶层且上一条仍在清单里；晚到的更早页不落屏；分页失败只坏分页（正文仍 ready）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TrashDetailBlockWire } from '../shared/wire.js'
import type { DetailLedger } from './detail-ledger.js'
import type { RemoteOutcome } from './remote.js'

/** 详情值的最小面：分页合并只认这两格。 */
export interface DetailBody {
  readonly blocks: readonly TrashDetailBlockWire[]
  readonly olderCursor: number | null
}

/** 一台详情读路的状态（主体键名 `subject`：回收站实例对外映射成 `entry`，键名语义归各自视图）。 */
export type DetailState<S, D> =
  | { kind: 'idle' }
  | { kind: 'loading'; subject: S }
  | { kind: 'failed'; subject: S; message: string }
  | { kind: 'holding'; subject: S; detail: D }
  | { kind: 'ready'; subject: S; detail: D }

export interface DetailReaderInput<S, D extends DetailBody> {
  readonly fetch: (id: string, before?: number) => Promise<RemoteOutcome<D>>
  readonly ledger: DetailLedger<D>
  readonly subject: S | null
  /** 主体的身份（回收站 = 条目 id；归档 = 会话 id）。 */
  readonly idOf: (subject: S) => string
  /** 主体是清单里的顶层行：孩子视图不保持上一条（它的返回键语义在孩子视图上，会串）。 */
  readonly topLevel: boolean
  /** 上一条已就绪的详情是否仍在清单里：被清单换版收走就不再顶住画面。 */
  readonly present: (id: string) => boolean
  /** 主体换成「还没读过」的那一条时要不要自动补读（兜底那一支）。窄档方向键只移选中、详情栏不在眼前：
   *  那里给 false，别为每次按键打一条 `/detail`；显式 `ensure` 一律照常读。 */
  readonly autoRead?: boolean
}

export interface DetailReader<S, D extends DetailBody> {
  readonly detail: DetailState<S, D>
  /** 「保持期拒绝导航/跳转」的唯一出口：holding ⇒ false，其余 true。两个控制器的守卫与
   *  `use-detail-rail` 的 `disabled` 都只问它，不再各自重推保持。 */
  readonly canNavigate: boolean
  readonly loadingOlder: boolean
  readonly olderFailure: string | null
  readonly ensure: (id: string) => Promise<void>
  readonly prefetch: (id: string) => void
  readonly loadOlder: () => Promise<void>
  readonly retry: () => void
  /** 只收分页的旧失败（切主体 / 回父时）；在飞登记不动。 */
  readonly clearOlderFailure: () => void
  readonly reset: (id: string) => void
  readonly forget: (id: string) => void
  /** 整本作废：丢缓存、在飞、保持与失败，回到首次读数（归档集变更时用）。 */
  readonly clearAll: () => void
}

interface DetailFailure {
  id: string
  message: string
}

interface ShownDetail<S, D> {
  ready: { readonly subject: S; readonly detail: D }
  topLevel: boolean
}

interface InFlight {
  show(id: string | null): void
  begin(id: string): boolean
  end(id: string): void
  clear(): void
  /** 这一条这会儿有没有在读：`reset` 只给**真的在飞**的那条挂作废标记。 */
  has(id: string): boolean
}

/**
 * 在飞句柄：`fetch` 与「更早一页」各持一份。判重在同步侧（`begin`：同一 tick 连点不发第二条），
 * 上屏在 state 侧。
 */
function useInFlight(): readonly [string | null, InFlight] {
  const flying = useRef(new Set<string>())
  const [shownId, setShownId] = useState<string | null>(null)
  const show = useCallback((id: string | null): void => setShownId(id), [])
  const begin = useCallback((id: string): boolean => {
    if (flying.current.has(id)) return false
    flying.current.add(id)
    return true
  }, [])
  const end = useCallback((id: string): void => {
    flying.current.delete(id)
    setShownId((current) => (current === id ? null : current))
  }, [])
  const clear = useCallback((): void => {
    flying.current.clear()
    setShownId(null)
  }, [])
  const has = useCallback((id: string): boolean => flying.current.has(id), [])
  return [shownId, useMemo<InFlight>(
    () => ({ show, begin, end, clear, has }),
    [show, begin, end, clear, has],
  )] as const
}

export function useDetailReader<S, D extends DetailBody>(input: DetailReaderInput<S, D>): DetailReader<S, D> {
  const { fetch, ledger, subject, idOf, topLevel, present, autoRead = true } = input
  /** 输入引用归一，形状同 `store.ts` 的 `useLatest`，但写回**必须留在渲染期**：读路与补页在子组件
   *  的 effect 里问「现在画的是哪一条」，父侧 effect 排在其后——提交后才写回会让它们读到旧主体。 */
  const subjectRef = useRef<S | null>(subject)
  subjectRef.current = subject
  const idOfRef = useRef(idOf)
  idOfRef.current = idOf

  /**
   * 这一份挂载还在不在：账本跨挂载存活，而请求属于某一次挂载——切走后晚到的读数不许再写账本
   * （ADR-0048 边界）。
   */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const [detailShown, detailFlight] = useInFlight()
  const [failure, setFailure] = useState<DetailFailure | null>(null)
  const [shown, setShown] = useState<ShownDetail<S, D> | null>(null)
  /** 已被 `reset` 作废的在飞读数：落地时它还在这张表里 ⇒ 这一拍的成功与失败都不许落地。 */
  const voided = useRef(new Set<string>())
  /** 整本作废的代次：作废前发出、作废后才回来的旧读数也要丢——只凭 `voided` 会漏掉那一拍。 */
  const clearToken = useRef(0)
  const [olderShown, olderFlight] = useInFlight()
  const [olderFailure, setOlderFailure] = useState<DetailFailure | null>(null)
  /** 账本被写入后要有一个**必然变化**的 state 把新对象推上屏（极快的响应会把置位/清位合批成净零变化）。 */
  const [version, setVersion] = useState(0)

  /** 一条详情读落地：成功写账本；失败不记账，也不许旧详情替它顶位。`quiet` = 意图预取：只热身账本、
   *  不碰失败态；例外是落地时该条已成主体。 */
  const read = useCallback(async (
    id: string,
    options: { readonly quiet?: boolean } = {},
  ): Promise<void> => {
    const token = clearToken.current
    const outcome = await fetch(id)
    // 整本作废（`clearAll`）之前发出的读数：不落地，也不许按掉作废后那一拍的在飞登记。
    if (token !== clearToken.current) return
    // 只收自己那一拍的 loading：期间已经切到别的条目时，别把新的那一拍按掉。
    detailFlight.end(id)
    // 卸载后晚到的读数不落账本（ADR-0048 边界）。
    if (!alive.current) return
    if (voided.current.delete(id)) return
    if (outcome.ok) {
      ledger.write(id, outcome.value)
      setVersion((value) => value + 1)
      if (options.quiet !== true) {
        setFailure((current) => (current?.id === id ? null : current))
      }
      return
    }
    const subjectId = subjectRef.current === null ? null : idOfRef.current(subjectRef.current)
    if (options.quiet === true && subjectId !== id) return
    ledger.forget(id)
    setFailure({ id, message: outcome.failure.message })
  }, [fetch, ledger, detailFlight])

  const ensure = useCallback(async (id: string): Promise<void> => {
    setOlderFailure(null)
    if (ledger.read(id) !== undefined) {
      detailFlight.show(null)
      setFailure(null)
      return
    }
    // loading 先摆到这一条再判在飞：在飞时早退也得让 loading 跟着选中走；再被要一次就撤销作废。
    voided.current.delete(id)
    detailFlight.show(id)
    setFailure(null)
    if (!detailFlight.begin(id)) return
    await read(id)
  }, [ledger, detailFlight, read])

  const prefetch = useCallback((id: string): void => {
    if (ledger.read(id) !== undefined) return
    if (!detailFlight.begin(id)) return
    voided.current.delete(id)
    void read(id, { quiet: true })
  }, [ledger, detailFlight, read])

  const loadOlder = useCallback(async (): Promise<void> => {
    const current = subjectRef.current
    const id = current === null ? undefined : idOfRef.current(current)
    if (id === undefined) return
    const cached = ledger.read(id)
    if (cached === undefined || cached.olderCursor === null) return
    olderFlight.show(id)
    setOlderFailure(null)
    if (!olderFlight.begin(id)) return

    const cursor = cached.olderCursor
    const outcome = await fetch(id, cursor)
    olderFlight.end(id)
    // 卸载后晚到的页不写账本（ADR-0048 边界，同 `read`）。
    if (!alive.current) return
    // 晚到结果只在「用户还在这一条」时落屏。
    const now = subjectRef.current
    if (now === null || idOfRef.current(now) !== id) return
    const latest = ledger.read(id)
    if (latest !== cached) return
    if (outcome.ok) {
      const merged = {
        ...latest,
        blocks: [...outcome.value.blocks, ...latest.blocks],
        olderCursor: outcome.value.olderCursor,
      }
      ledger.write(id, merged)
      setVersion((value) => value + 1)
      return
    }
    setOlderFailure({ id, message: outcome.failure.message })
  }, [fetch, ledger, olderFlight])

  const retry = useCallback((): void => {
    const current = subjectRef.current
    const id = current === null ? undefined : idOfRef.current(current)
    if (id === undefined) return
    setOlderFailure(null)
    void ensure(id)
  }, [ensure])

  const clearOlderFailure = useCallback((): void => {
    setOlderFailure(null)
  }, [])

  const reset = useCallback((id: string): void => {
    // 只有**真的在飞**的那条才需要作废标记：不在飞时没有晚到的读数。
    if (detailFlight.has(id)) voided.current.add(id)
    olderFlight.clear()
    setOlderFailure(null)
  }, [detailFlight, olderFlight])

  /** 丢这条账本缓存（与 `reset` 两步走：reset 只收分页现场、不动缓存——已合并的正文不许被打回 loading）。 */
  const forget = useCallback((id: string): void => {
    ledger.forget(id)
    setVersion((value) => value + 1)
  }, [ledger])

  const clearAll = useCallback((): void => {
    // 代次先走：作废前发出的读数（含当前主体那一拍）落地时 token 对不上，一律丢。
    clearToken.current += 1
    ledger.clear()
    voided.current.clear()
    detailFlight.clear()
    olderFlight.clear()
    setFailure(null)
    setOlderFailure(null)
    setShown(null)
    setVersion((value) => value + 1)
  }, [ledger, detailFlight, olderFlight])

  const detail = useMemo<DetailState<S, D>>(() => {
    if (subject === null) return { kind: 'idle' }
    const subjectId = idOf(subject)
    if (detailShown === subjectId) {
      // 换到一条还没读过的顶层条目：上一条已就绪的详情仍在清单里 ⇒ 先画住它（正文 inert）。
      const hold = topLevel
        && shown !== null
        && shown.topLevel
        && idOf(shown.ready.subject) !== subjectId
        && present(idOf(shown.ready.subject))
      if (hold) return { kind: 'holding', subject: shown.ready.subject, detail: shown.ready.detail }
      return { kind: 'loading', subject }
    }
    const cached = ledger.read(subjectId)
    // 失败先于账本：意图预取可以在失败块挂着时把正文读进账本，但那块失败是用户已经看见的结论。
    if (failure?.id === subjectId) {
      return { kind: 'failed', subject, message: failure.message }
    }
    if (cached !== undefined) return { kind: 'ready', subject, detail: cached }
    return { kind: 'loading', subject }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` 是账本被写入的必然变化信号：memo 不读它本身，只靠它重算。
  }, [subject, idOf, detailShown, failure, version, topLevel, shown, present, ledger])

  /**
   * 兜底那一支：这一条没有在读、账本里也没有。不补这一拍骨架会一直挂着；`autoRead=false`（窄档只移
   * 选中）时不补——显式 `ensure` 才是唯一读入口。
   */
  const orphaned = subject !== null && detail.kind === 'loading' && detailShown !== idOf(subject)
  useEffect(() => {
    if (!autoRead) return
    // 判空在前：`orphaned` 的定义已含「subject 非空」，放后面会被别名收窄判成永假分支。
    if (subject === null || !orphaned) return
    void ensure(idOf(subject))
  }, [autoRead, orphaned, subject, idOf, ensure])

  // 记下最后一条已就绪的详情（保持用）；idle 清掉；失败不清（上一条仍该顶住下一次切换）。
  useEffect(() => {
    if (detail.kind === 'ready') {
      setShown((current) => current !== null
        && idOf(current.ready.subject) === idOf(detail.subject)
        && current.ready.detail === detail.detail
        && current.topLevel === topLevel
        ? current
        : { ready: { subject: detail.subject, detail: detail.detail }, topLevel })
      return
    }
    if (detail.kind === 'idle') setShown(null)
  }, [detail, idOf, topLevel])

  /** 分页失败只对当前主体上屏：切到别的条目时那是别人家的旧账。 */
  const subjectId = subject === null ? null : idOf(subject)
  return {
    detail,
    canNavigate: detail.kind !== 'holding',
    loadingOlder: subjectId !== null && olderShown === subjectId,
    olderFailure: olderFailure !== null && olderFailure.id === subjectId
      ? olderFailure.message
      : null,
    ensure,
    prefetch,
    loadOlder,
    retry,
    clearOlderFailure,
    reset,
    forget,
    clearAll,
  }
}
