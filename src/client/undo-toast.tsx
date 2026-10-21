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
import { applyOne, callRemote, type OneShotDeps } from './remote.js'
import { failureMessage, isFailureVerdict, readReceipt } from './receipt.js'
import { createStore } from './store.js'
import { IconWarningOutlineRegular } from './ui/icons.js'
import { Toast } from './ui/Toast.js'
import { commitExternalRestore } from './write-commit.js'

export type UndoToastDeps = OneShotDeps

/**
 * 一次待撤销的事。两形（2026-10-17 起）：单条删除（主语是会话名）／批量删除（主语是条数）。
 * 同一个 Toast 宿主、同一停留时长；撤销动作按形走——单条 `restore`，批量**一次** `applyOutcomes`。
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

/** 撤销成功后把提示收掉（用户点「撤销」、或横幅自己走完停留时间）。 */
export function clearUndoNotice(): void {
  noticeStore.set(null)
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

/** 撤销失败：把原因换到同一条横幅上（seq 递增 ⇒ Toast 重挂载、重新计停留）。 */
function failNotice(current: UndoNotice, message: string): void {
  noticeStore.publish((seq) => ({ ...current, seq, failure: message }))
}

/** 撤销：单条 `restore(entryId)`、批量**一次** `applyOutcomes('restore', entryIds)`；失败就把原因换到同一条横幅上，不静默。 */
async function undo(deps: UndoToastDeps, current: UndoNotice): Promise<void> {
  if (current.kind === 'one' && current.entryId === '') return
  if (current.kind === 'one') {
    const outcome = await callRemote(() => applyOne(deps, 'restore', current.entryId))
    if (!outcome.ok) {
      failNotice(current, outcome.failure.message)
      return
    }
    // 恢复成功后重开删除时被关掉的会话（只认 main-view 自己记过的），并让清单面板重读。
    commitExternalRestore([outcome.value.value.sessionId])
  } else {
    const outcome = await callRemote(() => deps.applyOutcomes('restore', current.entryIds))
    if (!outcome.ok) {
      failNotice(current, outcome.failure.message)
      return
    }
    const receipt = readReceipt('restore', current.entryIds, outcome.value)
    const restored = receipt.verdicts.flatMap((verdict) =>
      verdict.kind === 'ok' && verdict.value !== null ? [verdict.value.sessionId] : [])
    // 信封成功（哪怕逐条有失败）⇒ 成功的那几条已经回盘：照样重开它们、清单照样重读；
    // 逐条失败提前 return 时这次收尾已经做完（全失败时名单为空，多付一次无害的重读）。
    commitExternalRestore(restored)
    const failure = receipt.verdicts.find(isFailureVerdict)
    if (failure !== undefined) {
      // 信封成功 ≠ 每一条都撤销成功：逐条全失败时横幅要换成失败原文，不能假装撤销成功。
      failNotice(current, failureMessage(failure))
      return
    }
  }
  // 走到这里 = 这一次撤销全部成功（失败支都已提前 return 并把原文留在横幅上）。
  clearUndoNotice()
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
