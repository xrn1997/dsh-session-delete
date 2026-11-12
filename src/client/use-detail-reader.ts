/**
 * 详情读路的**通用机制**：账本 + 在飞去重 + 失败 + 保持 + 分页，账本与取数是**注入的 seam**。
 * 回收站（`use-trash-detail-reader.ts`）与归档（`use-archive-detail-reader.ts`）各是一台薄实例：
 * 各带各的账本（键不同：条目 id / 会话 id；归档的账本只活一次挂载），机制只住这一处。
 *
 * 承重判据（从回收站实例原样搬来）：
 * - **成功才记账**：成功读数写账本；失败不记，也不让上一趟的旧详情替它顶位。
 * - **同一条在飞只发一次**：`fetch` 与「更早一页」各一枚句柄；登记按条目，A 在飞不挡 B。
 * - **保持（holding）**：换到没读过的顶层条目时，上一条**仍在清单里**的已就绪详情顶住画面；
 *   孩子视图不保持（返回键语义会串），首次读数没有上一条可保持。
 * - **晚到的更早页不落屏**：用户切走或账本已被换掉时丢弃；合并后写回账本。
 * - **分页失败只坏分页**：正文仍是 ready，失败原文单独一格。
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
  /** 换到没读过的条目时的「保持」：画的是上一条已就绪的详情，正文 `inert` + `aria-busy`。 */
  | { kind: 'holding'; subject: S; detail: D }
  | { kind: 'ready'; subject: S; detail: D }

export interface DetailReaderInput<S, D extends DetailBody> {
  readonly fetch: (id: string, before?: number) => Promise<RemoteOutcome<D>>
  readonly ledger: DetailLedger<D>
  /** 当前详情主体（孩子视图 / 清单选中）；null = 没有主体。 */
  readonly subject: S | null
  /** 主体的身份（回收站 = 条目 id；归档 = 会话 id）。 */
  readonly idOf: (subject: S) => string
  /** 主体是清单里的顶层行：孩子视图不保持上一条（它的返回键语义在孩子视图上，会串）。 */
  readonly topLevel: boolean
  /** 上一条已就绪的详情是否仍在清单里：被清单换版收走就不再顶住画面。 */
  readonly present: (id: string) => boolean
}

export interface DetailReader<S, D extends DetailBody> {
  readonly detail: DetailState<S, D>
  readonly loadingOlder: boolean
  readonly olderFailure: string | null
  /** 命中账本就摆；没命中才读。`loading` 先摆到这一条，再判在飞。 */
  readonly ensure: (id: string) => Promise<void>
  /** 只热身账本，不改上屏槽，也不把保持中的上一条顶成骨架。 */
  readonly prefetch: (id: string) => void
  /** 按当前主体的 `olderCursor` 读更早一页，合并进账本。 */
  readonly loadOlder: () => Promise<void>
  /** 重读当前主体（失败块的重试；已就绪时不重读）。 */
  readonly retry: () => void
  /** 只收分页的旧失败（切主体 / 回父时）；在飞登记不动。 */
  readonly clearOlderFailure: () => void
  /** 全收分页现场（选中行被清单收走时）：在飞登记 + 失败一起清，并**作废这一条在飞的读数**。 */
  readonly reset: (id: string) => void
  /** 丢这条的账本缓存（与 `reset` 两步走：清场 = forget + reset，再选必须重新读）。 */
  readonly forget: (id: string) => void
  /** 整本作废：丢缓存、在飞、保持与失败，回到首次读数（归档集变更时用）。 */
  readonly clearAll: () => void
}

/** 失败按**哪一条**记：只有失败那条与当前主体同 id 时才会进详情块。 */
interface DetailFailure {
  id: string
  message: string
}

/** 最后一条**已就绪**的详情：换到没读过的条目时拿它顶住，新详情到了整帧换掉。 */
interface ShownDetail<S, D> {
  ready: { readonly subject: S; readonly detail: D }
  topLevel: boolean
}

/** 在飞句柄的动作面：五个方法都是稳定引用，可以放心进 callback / effect 的依赖。 */
interface InFlight {
  show(id: string | null): void
  begin(id: string): boolean
  end(id: string): void
  clear(): void
  /** 这一条这会儿有没有在读：`reset` 只给**真的在飞**的那条挂作废标记。 */
  has(id: string): boolean
}

/**
 * 在飞句柄：`fetch` 与「更早一页」各持一份。判重在**同步**这一侧（`begin`：同一 tick 连点
 * 不发第二条；登记按条目），上屏在 **state** 那一侧（渲染位单槽，只回答「当前这条转不转圈」）。
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
  const { fetch, ledger, subject, idOf, topLevel, present } = input
  /** 输入引用归一，形状同 `store.ts` 的 `useLatest`，但写回**必须留在渲染期**：读路与补页在子组件
   *  的 effect 里问「现在画的是哪一条」，而同一次提交里父侧 effect 排在子侧之后——提交后才写回就让它们读到旧主体。 */
  const subjectRef = useRef<S | null>(subject)
  subjectRef.current = subject
  const idOfRef = useRef(idOf)
  idOfRef.current = idOf

  /**
   * 这一份挂载还在不在。账本（尤其回收站那台模块级的）跨挂载存活，而请求属于某一次挂载：
   * 切走面板后晚到的读数不许再写账本（ADR-0048 边界）。StrictMode 的
   * 挂载→卸载→再挂载由 setup 里重新置真接住。
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
  const [olderShown, olderFlight] = useInFlight()
  const [olderFailure, setOlderFailure] = useState<DetailFailure | null>(null)
  /** 账本被写入后要有一个**必然变化**的 state 把新对象推上屏（极快的响应会把置位/清位合批成净零变化）。 */
  const [version, setVersion] = useState(0)

  /** 一条详情读落地：成功写账本；失败不记账，也不许旧详情替它顶位。
   *  `quiet` = 意图预取：只热身账本，**不碰失败态**；唯一例外是落地时该条已经成了主体
   *  （预取在飞时点中它是正常路径，选中的读路借的是预取那一次请求）。 */
  const read = useCallback(async (
    id: string,
    options: { readonly quiet?: boolean } = {},
  ): Promise<void> => {
    const outcome = await fetch(id)
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
    // loading 先摆到这一条上，**再**判在飞：在飞时早退也得让 loading 跟着选中走。
    // 这一条又被要了（重新选中 / 显式重试）⇒ 撤销 `reset` 的作废：在飞的那一拍就是它要的读数。
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
    // 渲染位先摆到这一条，**再**判在飞（与 `ensure` 同一条顺序）。
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

  /** 丢这条的账本缓存（行被清单收走时与 `reset` 两步走：`reset` 只收分页现场，不动缓存——
   *  「已合并的正文不许被打回 loading」的既有契约）。 */
  const forget = useCallback((id: string): void => {
    ledger.forget(id)
    setVersion((value) => value + 1)
  }, [ledger])

  const clearAll = useCallback((): void => {
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
    // 兜底：选中了、这一拍没有在飞的读、账本里也没有它——先按「读着」摆着，`orphaned` effect 补读。
    return { kind: 'loading', subject }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` 是账本被写入的必然变化信号：memo 不读它本身，只靠它重算。
  }, [subject, idOf, detailShown, failure, version, topLevel, shown, present, ledger])

  /**
   * 兜底那一支的收口：这一条**没有在读、账本里也没有**（账本淘汰 / 被 forget 时才会到这）。
   * 不补这一拍，骨架会一直挂着（详情块的 loading 面没有重试键）。`ensure` 自带在飞去重。
   */
  const orphaned = subject !== null && detail.kind === 'loading' && detailShown !== idOf(subject)
  useEffect(() => {
    // 判空在前：`orphaned` 的定义已含「subject 非空」，放后面会被别名收窄判成永假分支。
    if (subject === null || !orphaned) return
    void ensure(idOf(subject))
  }, [orphaned, subject, idOf, ensure])

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
