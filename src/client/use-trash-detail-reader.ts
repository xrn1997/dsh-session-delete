/**
 * 详情读路：**账本 + 在飞去重 + 失败 + 保持 + 分页**收成一台 module。
 *
 * 在这之前，「详情账本」这个概念的行为分居四处：模块级 Map（`trash-snapshot.ts`）、控制器的
 * 在飞句柄与失败格、`shown` 保持态、`loadOlder` 的分页合并。调用方（控制器 / 视图 / 测试）
 * 因此要同时知道四份状态；`detailVersion` 那种「推一脚模块级 Map」的计数器也只是为了把账本
 * 推过 React。这一层只交出**「这一条读到了没有」+ 六个动作**，其余全是实现。
 *
 * 承重判据（原样保留，位置从控制器搬到这里）：
 * - **成功才记账**：成功读数写账本与首帧快照；失败不记，也不让上一趟的旧详情替它顶位。
 * - **同一条在飞只发一次**：`/detail` 与「更早一页」各一枚句柄；登记按条目，A 在飞不挡 B。
 * - **保持（holding）**：换到没读过的顶层条目时，上一条**仍在清单里**的已就绪详情顶住画面；
 *   孩子视图不保持（返回键语义会串），首次读数没有上一条可保持。
 * - **晚到的更早页不落屏**：用户切走或账本已被换掉时丢弃；合并后写回账本并推版本信号。
 * - **分页失败只坏分页**：正文仍是 ready，失败原文单独一格。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TrashEntryWire } from '../shared/wire.js'
import type { SessionDeleteRemote } from './remote.js'
import {
  forgetTrashDetail,
  readCachedTrashDetail,
  writeTrashDetail,
} from './trash-snapshot.js'
import type { TrashDetailState } from './trash-detail.js'

type DetailDeps = Pick<SessionDeleteRemote, 'detail'>

export interface TrashDetailReaderInput {
  readonly deps: DetailDeps
  /** 当前详情主体（孩子视图 / 清单选中）；null = 没有主体。 */
  readonly subject: TrashEntryWire | null
  /** 主体是清单里的顶层行：孩子视图不保持上一条（它的返回键语义在 `childView` 上，会串）。 */
  readonly topLevel: boolean
  /** 上一条已就绪的详情是否仍在清单里：被清单换版收走就不再顶住画面。 */
  readonly present: (entryId: string) => boolean
}

export interface TrashDetailReader {
  readonly detail: TrashDetailState
  readonly loadingOlder: boolean
  readonly olderFailure: string | null
  /** 命中账本就摆；没命中才读。`loading` 先摆到这一条，再判在飞。 */
  readonly ensure: (entryId: string) => Promise<void>
  /** 只热身账本，不改上屏槽，也不把保持中的上一条顶成骨架。 */
  readonly prefetch: (entryId: string) => void
  /** 按当前主体的 `olderCursor` 读更早一页，合并进账本。 */
  readonly loadOlder: () => Promise<void>
  /** 重读当前主体（失败块的重试；已就绪时不重读）。 */
  readonly retry: () => void
  /** 只收分页的旧失败（切主体 / 回父时）；在飞登记不动——晚到的页自己会按主体判掉。 */
  readonly clearOlderFailure: () => void
  /** 全收分页现场（选中行被清单收走时）：在飞登记 + 失败一起清，并**作废这一条在飞的详情读数**
   *  ——条目已经不在清单里，晚到的成功不许再把它写回模块级账本（账本跨挂载存活）。 */
  readonly reset: (entryId: string) => void
}

/** 失败按**哪一条**记：只有失败那条与当前主体同 id 时才会进详情块。 */
interface DetailFailure {
  entryId: string
  message: string
}

/** 最后一条**已就绪**的详情：换到没读过的条目时拿它顶住，新详情到了整帧换掉。 */
interface ShownDetail {
  ready: Extract<TrashDetailState, { kind: 'ready' }>
  topLevel: boolean
}

/** 在飞句柄的动作面：五个方法都是稳定引用，可以放心进 callback / effect 的依赖。 */
interface InFlight {
  show(id: string | null): void
  begin(id: string): boolean
  end(id: string): void
  clear(): void
  /** 这一条这会儿有没有在读：`reset` 只给**真的在飞**的那条挂作废标记，不留下会长期堆积的 id。 */
  has(id: string): boolean
}

/**
 * 在飞句柄：`/detail` 与「更早一页」各持一份。判重在**同步**这一侧（`begin`：同一 tick 连点
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

export function useTrashDetailReader(input: TrashDetailReaderInput): TrashDetailReader {
  const { deps, subject, topLevel, present } = input
  const subjectRef = useRef<TrashEntryWire | null>(subject)
  subjectRef.current = subject

  /**
   * 这一份挂载还在不在。详情账本与首帧快照都是**模块级**的，而请求属于某一次挂载：切走面板后
   * 晚到的详情读数不许再写账本——否则旧读数会盖掉新挂载刚合并出来的页，晚到的失败还会 `forget`
   * 掉新挂载正显示着的那条（与 `use-trash-query` 的 `alive` 同一条判据，ADR-0048 边界）。StrictMode
   * 的挂载→卸载→再挂载由 setup 里重新置真接住。
   */
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const [detailShown, detailFlight] = useInFlight()
  const [failure, setFailure] = useState<DetailFailure | null>(null)
  const [shown, setShown] = useState<ShownDetail | null>(null)
  /** 已被 `reset` 作废的在飞详情读数：落屏时它还在这张表里 ⇒ 这一拍的成功与失败都不许落地。
   *  条目已经被清单收走，晚到的成功会把它的详情重新写回模块级账本（孩子详情不随清单修剪），
   *  晚到的失败则挂一格没人会看到的失败。落屏时消费掉（delete），同一条再次被选中时能正常读。 */
  const voided = useRef(new Set<string>())
  const [olderShown, olderFlight] = useInFlight()
  const [olderFailure, setOlderFailure] = useState<DetailFailure | null>(null)
  /** 详情账本是模块级 Map：合并更早一页后要有一个**必然变化**的 state 把新对象推上屏
   *  （极快的响应会把分页渲染位的置位/清位合批成净零变化，React 会直接 bail out）。 */
  const [version, setVersion] = useState(0)

  /** 一条详情读落地：成功写账本与首帧快照；失败不记账，也不许旧详情替它顶位。
   *  `quiet` = 意图预取（ADR-0051）：只热身账本，**不碰失败态**——失败不新增、成功也不替用户
   *  把已上屏的失败块换成正文；那要等显式的 `ensure` / `retry`。唯一例外是这一拍落地时该条
   *  已经成了主体：预取在飞时点中它是正常路径（ADR-0051 决定 3），选中的读路借的是预取那一次
   *  请求（在飞去重不发第二条），预取的失败就是选中的失败——再哑掉就只剩一个没有任何在飞、
   *  没有失败块、账本也没命中的 loading，没人再来推它。 */
  const read = useCallback(async (
    entryId: string,
    options: { readonly quiet?: boolean } = {},
  ): Promise<void> => {
    const outcome = await deps.detail(entryId)
    // 只收自己那一拍的 loading：期间已经切到别的条目时，别把新的那一拍按掉。
    detailFlight.end(entryId)
    // 卸载后晚到的读数不落快照（ADR-0048 边界）：旧挂载的响应不许盖掉新挂载刚写下的账本。
    if (!alive.current) return
    // 这一条已被 `reset` 作废（清单把选中行收走了）：成败都不落地。落屏时消费掉这张表，
    // 同一条若再次被选中（理论上要换条目 id）仍能正常读。
    if (voided.current.delete(entryId)) return
    if (outcome.ok) {
      writeTrashDetail(entryId, outcome.value)
      // 账本是模块级 Map：读数落地必须有一个状态信号。`show` / `end` 在同一批里可能互相抵消
      // （同一个 act / 同一 tick 的 show→end 净零），没有这一脚，成功的详情不会重算上屏。
      setVersion((value) => value + 1)
      if (options.quiet !== true) setFailure((current) => (current?.entryId === entryId ? null : current))
      return
    }
    if (options.quiet === true && subjectRef.current?.id !== entryId) return
    forgetTrashDetail(entryId)
    setFailure({ entryId, message: outcome.failure.message })
  }, [deps, detailFlight])

  const ensure = useCallback(async (entryId: string): Promise<void> => {
    setOlderFailure(null)
    if (readCachedTrashDetail(entryId) !== undefined) {
      detailFlight.show(null)
      setFailure(null)
      return
    }
    // loading 先摆到这一条上，**再**判在飞：在飞时早退也得让 loading 跟着选中走。
    // 反过来写会留下一条卡死的路：A 在飞 → 选 B → 再选 A，A 的回执落地时 loading 还指着 B，
    // 没有任何 state 变化，详情块永远停在 loading。
    // 这一条又被要了（重新选中 / 显式重试）⇒ 撤销 `reset` 的作废：在飞的那一拍就是它要的读数。
    voided.current.delete(entryId)
    detailFlight.show(entryId)
    setFailure(null)
    if (!detailFlight.begin(entryId)) return
    await read(entryId)
  }, [detailFlight, read])

  const prefetch = useCallback((entryId: string): void => {
    if (readCachedTrashDetail(entryId) !== undefined) return
    if (!detailFlight.begin(entryId)) return
    // 只有真的发起了这一条新读数才撤销作废：同一条在飞时这一趟不读，原先被 `reset` 作废的
    // 那一拍仍要作废（迟到的意图不许把「清单已收走这条」的结论翻回来）。
    voided.current.delete(entryId)
    void read(entryId, { quiet: true })
  }, [detailFlight, read])

  const loadOlder = useCallback(async (): Promise<void> => {
    const entryId = subjectRef.current?.id
    if (entryId === undefined) return
    const cached = readCachedTrashDetail(entryId)
    if (cached === undefined || cached.olderCursor === null) return
    // 渲染位先摆到这一条，**再**判在飞（与 `ensure` 同一条顺序）：另一条占过这个槽之后切回来点，
    // 这一条其实已经在读——不先摆，按钮看着可点却静默无动作。
    olderFlight.show(entryId)
    setOlderFailure(null)
    if (!olderFlight.begin(entryId)) return

    const cursor = cached.olderCursor
    const outcome = await deps.detail(entryId, cursor)
    olderFlight.end(entryId)
    // 卸载后晚到的页不写账本（ADR-0048 边界，同 `read`）。
    if (!alive.current) return
    // 晚到结果只在「用户还在这一条」时落屏；孩子那一面也比——孩子的 id 从来不等于清单选中。
    if (subjectRef.current?.id !== entryId) return
    const current = readCachedTrashDetail(entryId)
    if (current !== cached) return
    if (outcome.ok) {
      const merged = {
        ...current,
        blocks: [...outcome.value.blocks, ...current.blocks],
        olderCursor: outcome.value.olderCursor,
      }
      // 合并后的详情写回账本与首帧快照：面板重挂时不丢已翻出来的页，也不让 `ensure` 命中旧页。
      writeTrashDetail(entryId, merged)
      setVersion((value) => value + 1)
      return
    }
    setOlderFailure({ entryId, message: outcome.failure.message })
  }, [deps, olderFlight])

  const retry = useCallback((): void => {
    const entryId = subjectRef.current?.id
    if (entryId === undefined) return
    setOlderFailure(null)
    void ensure(entryId)
  }, [ensure])

  const clearOlderFailure = useCallback((): void => {
    setOlderFailure(null)
  }, [])

  const reset = useCallback((entryId: string): void => {
    // 只有**真的在飞**的那条才需要作废标记：不在飞时没有晚到的读数，挂了也只会长期占一个 id。
    if (detailFlight.has(entryId)) voided.current.add(entryId)
    olderFlight.clear()
    setOlderFailure(null)
  }, [detailFlight, olderFlight])

  const detail = useMemo<TrashDetailState>(() => {
    if (subject === null) return { kind: 'idle' }
    if (detailShown === subject.id) {
      // 换到一条还没读过的顶层条目：上一条已就绪的详情仍在清单里 ⇒ 先画住它（正文 inert）。
      const hold = topLevel
        && shown !== null
        && shown.topLevel
        && shown.ready.entry.id !== subject.id
        && present(shown.ready.entry.id)
      if (hold) return { kind: 'holding', entry: shown.ready.entry, detail: shown.ready.detail }
      return { kind: 'loading', entry: subject }
    }
    const cached = readCachedTrashDetail(subject.id)
    // 失败先于账本：意图预取可以在失败块挂着时把正文读进账本（ADR-0051 只热身），但那一块
    // 失败是用户已经看见的结论，换成正文要等显式重试（`ensure` / `retry` 会清掉失败）。
    if (failure?.entryId === subject.id) {
      return { kind: 'failed', entry: subject, message: failure.message }
    }
    if (cached !== undefined) return { kind: 'ready', entry: subject, detail: cached }
    // 兜底：选中了、这一拍没有在飞的读、账本里也没有它——先按「读着」摆着，并由下面那条
    // effect 补一次读（见 `orphaned`）。
    return { kind: 'loading', entry: subject }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` 是账本被 prepend / 写入的必然变化信号：memo 不读它本身，只靠它重算。
  }, [subject, detailShown, failure, version, topLevel, shown, present])

  /**
   * 兜底那一支的收口：这一条**没有在读、账本里也没有**。正常路径不会到这里（`ensure` 先摆
   * loading 再读），只有账本把它淘汰出去时才会——`trash-snapshot.ts` 的 64 条上限按最近写入淘汰，
   * 意图预取与孩子详情都在写，选中那一条若不再有写入就会被挤掉。不补这一拍，骨架会一直挂着
   * （详情块的 loading 面没有重试键，读者只能再点一次这一行）。
   *
   * 判据只用 `detailShown`：「在飞的读」在这里一定是当前主体（选中 / 补读都要先 `show` 它），
   * 所以不相等就说明这一拍没有任何人在读它。`ensure` 自己带着在飞去重，重复调用不会发第二条。
   */
  const orphaned = subject !== null && detail.kind === 'loading' && detailShown !== subject.id
  useEffect(() => {
    if (!orphaned) return
    void ensure(subject.id)
  }, [orphaned, subject, ensure])

  // 记下最后一条已就绪的详情。比较 entry.id / detail 引用 / topLevel 再 set，避免
  // 「memo 因 shown 变化重算 → effect 再 set」的环；idle 清掉（没有主体可保持）。
  // 失败不清：上一条已就绪的详情仍在屏幕上，下一条切换仍该由它顶住（骨架只留给首次）。
  useEffect(() => {
    if (detail.kind === 'ready') {
      setShown((current) => current !== null
        && current.ready.entry.id === detail.entry.id
        && current.ready.detail === detail.detail
        && current.topLevel === topLevel
        ? current
        : { ready: detail, topLevel })
      return
    }
    if (detail.kind === 'idle') setShown(null)
  }, [detail, topLevel])

  /** 分页失败只对当前主体上屏：切到别的条目时那是别人家的旧账。 */
  const subjectId = subject?.id ?? null
  return {
    detail,
    loadingOlder: subjectId !== null && olderShown === subjectId,
    olderFailure: olderFailure !== null && olderFailure.entryId === subjectId
      ? olderFailure.message
      : null,
    ensure,
    prefetch,
    loadOlder,
    retry,
    clearOlderFailure,
    reset,
  }
}
