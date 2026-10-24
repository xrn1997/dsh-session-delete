/**
 * 撤销提示（docs/ui-spec.md 状态 ③）：删除成功后一条可撤销的横幅。
 *
 * 为什么是**独立组件 + 模块级通知台**，而不是死在菜单行里：宿主的菜单行随菜单**一起卸载**
 * （真产物 Menu 的注释原文 "the rows unmount with the list"），而提示要在菜单关掉之后还活着。
 * 宿主的官方配方同形——会话行的动作把请求写进一个模块级 store，`shell.overlay` 里的
 * `workspace.row-toast` 读它（asar 原文：`inject("shell.overlay", … id: "workspace.row-toast" …
 * inject: rowToastInjected … }, RowActionToast)`，而
 * `rowToastInjected = () => ({ hooks: { toast: rowToast }, dismissToast, undoArchive: unarchiveSession })`）。
 * 本文件就是那份 store + 那个常驻组件。
 *
 * 状态源走 `store.ts` 的 `createStore`（内部用 React 自带的 `useSyncExternalStore`）——
 * 不引 `@deepseek-ai/dsh-client-store`（它在平台表内，但这里用不着；React 就够，少一条平台依赖）。
 */
import { zhTranslate, type Translate } from './copy.js'
import type { OneShotDeps } from './remote.js'
import { createStore } from './store.js'
import { IconWarningOutlineRegular } from './ui/icons.js'
import { Toast } from './ui/Toast.js'
import { restoreFromUndo } from './write-seats.js'

export type UndoToastDeps = OneShotDeps

/**
 * 一次待撤销的事。两形（2026-10-17 起）：单条删除（主语是会话名）／批量删除（主语是条数）。
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

/** 批量删除成功后发布一条撤销提示（2026-10-17）：覆盖上一条，只报这一次移走的条数。 */
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
 *  与下面 `dismissUndoNotice` 的分别是「整条不再留」与「按条目匹配」——清空之后没有条目还能撤销，
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
function ownsNotice(current: UndoNotice): boolean {
  return noticeStore.get() === current
}

/** 撤销失败：把原因换到同一条横幅上（seq 递增 ⇒ Toast 重挂载、重新计停留）。 */
function failNotice(current: UndoNotice, message: string): void {
  if (!ownsNotice(current)) return
  noticeStore.publish((seq) => ({ ...current, seq, failure: message }))
}

/** 撤销：单条与批量都走**一次** `applyOutcomes('restore', ids)`（`runWrite` 判读；单条带 `single: true`，
 *  null 是协议错）；失败就把原因换到同一条横幅上，不静默。 */
async function undo(deps: UndoToastDeps, current: UndoNotice): Promise<void> {
  const ids = current.kind === 'one' ? [current.entryId] : current.entryIds
  if (current.kind === 'one' && current.entryId === '') return
  // 外部恢复座位：settlement 负责重开删除时被关掉的会话（只认 main-view 自己记过的）并让清单重读；
  // 座位**不传 `dismissUndo`**——部分失败的回滚会让 settlement 先熄灭横幅，随后 `failNotice` 因
  // `ownsNotice` 落空而吞掉失败原文。
  const outcome = await restoreFromUndo(deps, { ids, single: current.kind === 'one' })
  if (!outcome.ok) {
    failNotice(current, outcome.failure.message)
    return
  }
  const failure = outcome.failures.values().next().value
  if (failure !== undefined) {
    // 信封成功 ≠ 每一条都撤销成功：逐条失败时横幅要换成失败原文，不能假装撤销成功。
    failNotice(current, failure)
    return
  }
  // 成功只收掉自己那条：期间若已发布新删除的横幅，不能被这次收尾顺手清掉。
  if (ownsNotice(current)) clearUndoNotice()
}

/**
 * 常驻的撤销提示宿主。挂 `shell.overlay`（框架级浮层；槽位说明原文 "a toast stack or a status
 * pill all belong here"，见 asar 里 `shell.overlay` 的声明）：没有待撤销的事时什么都不渲染。
 */
export function UndoToast({ deps, t = zhTranslate }: { deps: UndoToastDeps; t?: Translate }) {
  const current = useUndoNotice()
  if (current === null) return null

  const { seq, failure } = current
  if (failure !== undefined) {
    return (
      <Toast
        key={seq}
        text={failure}
        icon={<IconWarningOutlineRegular size={16} />}
        holdMs={UNDO_HOLD_MS}
        onDone={clearUndoNotice}
      />
    )
  }
  // 没有落点的撤销是假按钮：单条形拿不到条目 id、批量形名单为空，都只出正文不出动作。
  const canUndo = current.kind === 'one' ? current.entryId !== '' : current.entryIds.length > 0
  return (
    <Toast
      key={seq}
      tone="success"
      text={
        current.kind === 'one'
          ? t('undo.moved', { title: current.title === '' ? t('undo.session') : current.title })
          : t('undo.movedBatch', { n: current.n })
      }
      holdMs={UNDO_HOLD_MS}
      actions={
        canUndo ? [{ label: t('undo.undo'), onClick: () => void undo(deps, current) }] : undefined
      }
      onDone={clearUndoNotice}
    />
  )
}
