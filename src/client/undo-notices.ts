/**
 * 撤销横幅的**通知台**：现场、seq、发布 / 熄灭与停留时长。提示现场要跨槽位存活，所以独立于 Toast
 * 组件：`undo-toast.tsx` 只做组件，写入座位与取数编排只依赖本 module。实例由 `ClientScene` 聚合。
 */
import { getDefaultClientScene, useClientScene } from './scene.js'
import { createStore } from './store.js'

/** 一次待撤销的事：单条移入回收站（主语是会话名）或批量移入回收站（主语是条数）；撤销动作按形分派，
 *  两条都走同一个外部恢复座位（`write-seats.ts` 的 `restoreFromUndo`）。 */
export type UndoNotice = {
  /** 每次发布递增：Toast 靠它重挂载，同一段文案连续出现两次也能重新计一次停留。 */
  seq: number
  /** 撤销失败时把原因顶上来：这时不再有「撤销」动作，只剩原文。 */
  failure?: string
  /** 这次移走的里有**已归档**会话：撤销后它们回到「归档」（不是回到会话列表），文案追加一句。 */
  archived?: boolean
} & (
  | {
      kind: 'one'
      /** 回收站条目 id——撤销就是拿它去 `restore`。 */
      entryId: string
      /** 移入回收站那一刻的会话名（菜单槽投影的 `displayTitle`；取不到时是空串）。 */
      title: string
    }
  | {
      kind: 'batch'
      /** 撤销名单：只收成功支里非 null 的条目 id（「被同批带走」的成员跟着组走，不单列）。 */
      entryIds: readonly string[]
      /** 横幅那句的条数 = 那一次成功支的条数（含幂等带走的）——与撤销名单是两个数，各说各的。 */
      n: number
      /** 同一批移入回收站部分失败时的摘要：随撤销横幅同屏展示，不等横幅 6 秒过期后再顶上。 */
      partialFailure?: { readonly count: number; readonly reasons: string }
    }
)

/** 一条待显示的撤销失败：撤销在飞时横幅被新的移入回收站覆盖或被面板恢复熄灭，失败就失去了落点；
 *  `failNotice` 把原文留在这里，等当前没有横幅时由 `undo-toast.tsx` 顶上——失败不被吞掉。 */
export interface UndoFailureNotice {
  /** 每次发布递增：Toast 靠它重挂载、重新计停留。 */
  seq: number
  failure: string
}

/** 一台撤销通知台：发布 / 改写 / 熄灭 / 两份读数。 */
export interface UndoNoticeScene {
  /** 移入回收站成功后发布一条撤销提示（单条）。 */
  publishOne(input: { entryId: string; title: string; archived?: boolean }): void
  /** 批量移入回收站成功后发布一条撤销提示：覆盖上一条，只报这一次移走的条数。 */
  publishBatch(input: { entryIds: readonly string[]; n: number; archived?: boolean }): void
  /** 整条横幅不再留。 */
  clear(): void
  /** 指向这些条目的横幅熄掉（任一命中就清整条；清空回收站按发起时名单调它）。 */
  dismiss(entryIds: readonly string[]): void
  /** 当前撤销横幅（当场读；渲染侧用 {@link useNotice}）。 */
  read(): UndoNotice | null
  useNotice(): UndoNotice | null
  /** 当前没有撤销横幅时要顶上来的那条失败（订阅）。 */
  useFailure(): UndoFailureNotice | null
  /** 待显示的失败已经上屏：清掉它。 */
  clearFailure(): void
  /** 这次撤销开始时的那条横幅还在吗——期间被新的移入回收站覆盖、或由面板恢复熄灭时，旧请求不许改写它。 */
  owns(current: UndoNotice): boolean
  /** 撤销失败：把原因换到同一条横幅上；横幅已经不在了就献给待显示队。 */
  fail(current: UndoNotice, message: string): void
  /** 裸失败：没有落点横幅的失败（拖放被拒、单条移入失败、批量全失败）直接上屏，清掉旧成功横幅。 */
  publishFailure(message: string): void
  /** 将同批移入回收站的部分失败摘要附到当前批量撤销横幅上；没有可附横幅时退回裸失败提示。 */
  attachPartialFailure(input: { count: number; reasons: string }): void
  /** 场景收场：两份现场与 seq 归零。 */
  reset(): void
}

export function createUndoNoticeScene(): UndoNoticeScene {
  const noticeStore = createStore<UndoNotice | null>(null)
  const failureStore = createStore<UndoFailureNotice | null>(null)

  /** 横幅还是不是这一条：`fail` 与自由函数 `ownsNotice` 共用（实现不读 `this`，摘下来转交也安全）。 */
  const owns = (current: UndoNotice): boolean => noticeStore.get() === current

  return {
    publishOne(input): void {
      // 旧失败已经上屏（当前无撤销横幅）⇒ 新成功发布时清掉它，避免 6 秒后旧失败回魂；
      // 若当前正挂着撤销横幅，failureStore 里可能躺着刚排队进来的旧撤销失败，继续保留给下个空档。
      if (noticeStore.get() === null) failureStore.set(null)
      noticeStore.publish((seq) => ({
        seq,
        kind: 'one',
        entryId: input.entryId,
        title: input.title,
        ...(input.archived === undefined ? {} : { archived: input.archived }),
      }))
    },
    publishBatch(input): void {
      if (noticeStore.get() === null) failureStore.set(null)
      noticeStore.publish((seq) => ({
        seq,
        kind: 'batch',
        entryIds: input.entryIds,
        n: input.n,
        ...(input.archived === undefined ? {} : { archived: input.archived }),
      }))
    },
    clear(): void {
      noticeStore.set(null)
    },
    dismiss(entryIds: readonly string[]): void {
      const wanted = new Set(entryIds)
      noticeStore.update((current) => {
        if (current === null) return current
        if (current.kind === 'one') return wanted.has(current.entryId) ? null : current
        return current.entryIds.some((id) => wanted.has(id)) ? null : current
      })
    },
    read: (): UndoNotice | null => noticeStore.get(),
    useNotice(): UndoNotice | null {
      return noticeStore.use()
    },
    useFailure(): UndoFailureNotice | null {
      return failureStore.use()
    },
    clearFailure(): void {
      failureStore.set(null)
    },
    owns,
    fail(current: UndoNotice, message: string): void {
      if (!owns(current)) {
        failureStore.publish((seq) => ({ seq, failure: message }))
        return
      }
      noticeStore.publish((seq) => ({ ...current, seq, failure: message }))
    },
    publishFailure(message: string): void {
      // 用户新发起的动作失败要立即可见：撤掉上一条还在倒计时的成功横幅，不被挡住 6 秒。
      noticeStore.set(null)
      failureStore.publish((seq) => ({ seq, failure: message }))
    },
    attachPartialFailure(input): void {
      const updated = noticeStore.update((current) =>
        current !== null && current.kind === 'batch' && current.failure === undefined
          ? { ...current, partialFailure: { count: input.count, reasons: input.reasons } }
          : current,
      )
      if (!updated) {
        noticeStore.set(null)
        failureStore.publish((seq) => ({ seq, failure: input.reasons }))
      }
    },
    reset(): void {
      noticeStore.reset()
      failureStore.reset()
    },
  }
}

/* ── 兼容自由函数（旧调用点与测试）：委托默认场景的实例 ────────────────────────── */

export function publishUndoNotice(input: { entryId: string; title: string; archived?: boolean }): void {
  getDefaultClientScene().undo.publishOne(input)
}

export function publishUndoBatchNotice(input: {
  entryIds: readonly string[]
  n: number
  archived?: boolean
}): void {
  getDefaultClientScene().undo.publishBatch(input)
}

/** 整条横幅不再留（默认场景）。清空回收站不走这里：它按发起时名单调 `dismissUndoNotice`。 */
export function clearUndoNotice(): void {
  getDefaultClientScene().undo.clear()
}

export function dismissUndoNotice(entryIds: readonly string[]): void {
  getDefaultClientScene().undo.dismiss(entryIds)
}

/** 供组件订阅当前横幅（生产走 Provider 的那一份；测试无 Provider 回退默认场景）。 */
export function useUndoNotice(): UndoNotice | null {
  return useClientScene().undo.useNotice()
}

export function useUndoFailure(): UndoFailureNotice | null {
  return useClientScene().undo.useFailure()
}

export function clearUndoFailure(): void {
  getDefaultClientScene().undo.clearFailure()
}

/** 提示停留时长。**6 秒** 定死在本行（比 Toast 默认的 3 秒长）——`docs/ui-spec.md` §2 ③ 只指到这里，不抄这个数。 */
export const UNDO_HOLD_MS = 6000

export function ownsNotice(current: UndoNotice): boolean {
  return getDefaultClientScene().undo.owns(current)
}

export function failNotice(current: UndoNotice, message: string): void {
  getDefaultClientScene().undo.fail(current, message)
}

/** 裸失败提示（无落点横幅的失败）：拖放被拒、单条移入失败、批量全失败直接上屏。 */
export function publishFailureNotice(message: string): void {
  getDefaultClientScene().undo.publishFailure(message)
}

/** 将同批移入回收站的部分失败摘要附到当前批量撤销横幅上。 */
export function attachUndoPartialFailure(input: { count: number; reasons: string }): void {
  getDefaultClientScene().undo.attachPartialFailure(input)
}

/** 批量写逐条失败的**唯一落点判据**：部分失败把摘要附在本批撤销横幅上，全失败走裸失败提示（先撤上一条
 *  成功横幅，不被挡住）；没有失败什么都不发。三个移入回收站批量入口（批量浮条 / 拖放 / 归档档）共用这一条。
 *  交回这一趟的失败摘要原文（无失败是 `undefined`）——拖放的结算态还要拿它落账，不再拼第二遍。 */
export function publishBatchFailures(
  submitted: number,
  failures: ReadonlyMap<string, string>,
): string | undefined {
  if (failures.size === 0) return undefined
  const reasons = [...new Set(failures.values())].join(' · ')
  if (failures.size < submitted) {
    attachUndoPartialFailure({ count: failures.size, reasons })
  } else {
    publishFailureNotice(reasons)
  }
  return reasons
}
