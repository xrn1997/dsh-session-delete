/**
 * 撤销横幅的**通知台**：现场、seq、发布 / 熄灭与停留时长。
 *
 * 为什么独立于 Toast 组件：提示的现场要跨槽位存活（菜单行随菜单卸载，`shell.overlay` 里的组件才常驻），
 * 而写入座位与取数编排只需要发布 / 熄灭，不需要 import 一个 `.tsx`。通知台放在这里之后，
 * `undo-toast.tsx` 只做组件并组合恢复座位，`write-seats.ts` 与 `use-trash-query.ts` 只依赖本 module。
 */
import { createStore } from './store.js'

/**
 * 一次待撤销的事。两形：单条删除（主语是会话名）／批量删除（主语是条数）。
 * 同一个 Toast 宿主、同一停留时长；撤销动作按形分派（单条 / 批量），两条都走同一个外部恢复座位
 * （`write-seats.ts` 的 `restoreFromUndo`），单条带 `single: true` 的读法（null 是协议错，不冒充幂等成功）。
 */
export type UndoNotice = {
  /** 每次发布递增：Toast 靠它重挂载，同一段文案连续出现两次也能重新计一次停留。 */
  seq: number
  /** 撤销失败时把原因顶上来：这时不再有「撤销」动作，只剩原文。 */
  failure?: string
} & (
  | {
      kind: 'one'
      /** 回收站条目 id——撤销就是拿它去 `restore`。 */
      entryId: string
      /** 删除那一刻的会话名（菜单槽投影的 `displayTitle`；取不到时是空串）。 */
      title: string
    }
  | {
      kind: 'batch'
      /** 撤销名单：只收成功支里非 null 的条目 id（「被同批带走」的成员跟着组走，不单列）。 */
      entryIds: readonly string[]
      /** 横幅那句的条数 = 那一次成功支的条数（含幂等带走的）——与撤销名单是两个数，各说各的。 */
      n: number
    }
)

const noticeStore = createStore<UndoNotice | null>(null)

/** 删除成功后发布一条撤销提示（单条）。 */
export function publishUndoNotice(input: { entryId: string; title: string }): void {
  noticeStore.publish((seq) => ({
    seq,
    kind: 'one',
    entryId: input.entryId,
    title: input.title,
  }))
}

/** 批量删除成功后发布一条撤销提示：覆盖上一条，只报这一次移走的条数。 */
export function publishUndoBatchNotice(input: {
  entryIds: readonly string[]
  n: number
}): void {
  noticeStore.publish((seq) => ({
    seq,
    kind: 'batch',
    entryIds: input.entryIds,
    n: input.n,
  }))
}

/** 整条横幅不再留：撤销成了、停留时间走完，或清空回收站把所有落点一起清了。
 *  与 `dismissUndoNotice` 的分别是「整条不再留」与「按条目匹配」——清空之后没有条目还能撤销，
 *  所以那一路不需要名单。 */
export function clearUndoNotice(): void {
  noticeStore.set(null)
}

/**
 * 某个条目已经在别处恢复：把指向它的横幅熄掉。
 * 批量里任一命中就清整条——名单少了、计数没变，留着就是一条会骗人的「撤销」动作。
 */
export function dismissUndoNotice(entryIds: readonly string[]): void {
  const wanted = new Set(entryIds)
  noticeStore.update((current) => {
    if (current === null) return current
    if (current.kind === 'one') return wanted.has(current.entryId) ? null : current
    return current.entryIds.some((id) => wanted.has(id)) ? null : current
  })
}

/** 供组件订阅。 */
export function useUndoNotice(): UndoNotice | null {
  return noticeStore.use()
}

/** 测试专用：现场与 seq 归零，用例之间互不串味。 */
export function resetUndoNotice(): void {
  noticeStore.reset()
}

/** 提示停留时长。**6 秒** 定死在本行（比 Toast 默认的 3 秒长）——`docs/ui-spec.md` §2 状态 ③ 只指到这里，不抄这个数。 */
export const UNDO_HOLD_MS = 6000

/** 这次撤销开始时的那条横幅还在吗——期间被新删除覆盖、或由面板恢复熄灭时，旧请求不许改写它。 */
export function ownsNotice(current: UndoNotice): boolean {
  return noticeStore.get() === current
}

/** 撤销失败：把原因换到同一条横幅上（seq 递增 ⇒ Toast 重挂载、重新计停留）。 */
export function failNotice(current: UndoNotice, message: string): void {
  if (!ownsNotice(current)) return
  noticeStore.publish((seq) => ({ ...current, seq, failure: message }))
}
