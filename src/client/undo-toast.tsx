/**
 * 撤销提示（设计稿 §7 状态 ③）：删除成功后一条可撤销的横幅。
 *
 * 为什么是**独立组件 + 模块级通知台**，而不是死在菜单行里：宿主的菜单行随菜单**一起卸载**
 * （真产物 Menu 的注释原文 "the rows unmount with the list"），而提示要在菜单关掉之后还活着。
 * 宿主的官方配方同形——会话行的动作把请求写进一个模块级 store，`shell.overlay` 里的
 * `workspace.row-toast` 读它（asar 原文：`inject("shell.overlay", … id: "workspace.row-toast" …
 * inject: rowToastInjected … }, RowActionToast)`，而
 * `rowToastInjected = () => ({ hooks: { toast: rowToast }, dismissToast, undoArchive: unarchiveSession })`）。
 * 本文件就是那份 store + 那个常驻组件。
 *
 * 状态源用 React 自带的 `useSyncExternalStore`——不引 `@deepseek-ai/dsh-client-store`
 * （它在平台表内，但这里用不着；React 就够，少一条平台依赖）。
 */
import { useSyncExternalStore } from 'react'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { callRemote, type SessionDeleteRemote } from './remote.js'
import { invalidateTrash } from './trash-store.js'

export type UndoToastDeps = Pick<SessionDeleteRemote, 'restore'>

export interface UndoNotice {
  /** 每次发布递增：Toast 靠它重挂载，同一段文案连续出现两次也能重新计一次停留。 */
  seq: number
  /** 回收站条目 id——撤销就是拿它去 `restore`。 */
  entryId: string
  /** 删除那一刻的会话名（菜单槽投影的 `displayTitle`；取不到时是空串）。 */
  title: string
  /** 撤销失败时把原因顶上来：这时不再有「撤销」动作，只剩原文。 */
  failure?: string
}

let notice: UndoNotice | null = null
let nextSeq = 0
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const listener of listeners) listener()
}

/** 删除成功后发布一条撤销提示。 */
export function publishUndoNotice(input: { entryId: string; title: string }): void {
  notice = { seq: (nextSeq += 1), entryId: input.entryId, title: input.title }
  emit()
}

/** 撤销成功后把提示收掉（用户点「撤销」、或横幅自己走完停留时间）。 */
export function clearUndoNotice(): void {
  if (notice === null) return
  notice = null
  emit()
}

function getUndoNotice(): UndoNotice | null {
  return notice
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 供组件订阅。 */
export function useUndoNotice(): UndoNotice | null {
  return useSyncExternalStore(subscribe, getUndoNotice, getUndoNotice)
}

/** 提示停留时长。设计稿 §7 定死：**6 秒**（Toast 自己的默认是 3 秒）。 */
export const UNDO_HOLD_MS = 6000

/** 撤销：`restore(entryId)`；失败就把原因换到同一条横幅上，不静默。 */
async function undo(deps: UndoToastDeps, current: UndoNotice): Promise<void> {
  if (current.entryId === '') return
  const outcome = await callRemote(() => deps.restore(current.entryId))
  if (outcome.ok) {
    // 回收站少了一条：让正开着的清单面板重读（撤销也是"从别处动回收站"的一种）。
    invalidateTrash()
    clearUndoNotice()
    return
  }
  notice = { ...current, seq: (nextSeq += 1), failure: outcome.failure.message }
  emit()
}

/**
 * 常驻的撤销提示宿主。挂 `shell.overlay`（框架级浮层；槽位说明原文 "a toast stack or a status
 * pill all belong here"，见 asar 里 `shell.overlay` 的声明）：没有待撤销的事时什么都不渲染。
 */
export function UndoToast({ deps }: { deps: UndoToastDeps }) {
  const current = useUndoNotice()
  if (current === null) return null

  const { seq, entryId, title, failure } = current
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
  return (
    <Toast
      key={seq}
      tone="success"
      text={`${title === '' ? '会话' : title} 已移入回收站`}
      holdMs={UNDO_HOLD_MS}
      actions={
        entryId === ''
          ? undefined
          : [{ label: '撤销', onClick: () => void undo(deps, current) }]
      }
      onDone={clearUndoNotice}
    />
  )
}
