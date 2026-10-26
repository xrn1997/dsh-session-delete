/**
 * 撤销提示（docs/ui-spec.md 状态 ③）：删除成功后一条可撤销的横幅。
 *
 * 现场与发布住在 `undo-notices.ts`；本文件只做组件，并把通知台与外部恢复座位组合起来。
 * 为什么组件要独立：宿主的菜单行随菜单**一起卸载**（真产物 Menu 的注释原文
 * "the rows unmount with the list"），而提示要在菜单关掉之后还活着。宿主的官方配方同形——
 * 会话行的动作把请求写进一个模块级 store，`shell.overlay` 里的 `workspace.row-toast` 读它。
 */
import { zhTranslate, type Translate } from './copy.js'
import type { OneShotDeps } from './remote.js'
import {
  clearUndoNotice,
  failNotice,
  ownsNotice,
  UNDO_HOLD_MS,
  useUndoNotice,
  type UndoNotice,
} from './undo-notices.js'
import { IconWarningOutlineRegular } from './ui/icons.js'
import { Toast } from './ui/Toast.js'
import { restoreFromUndo } from './write-seats.js'

export type UndoToastDeps = OneShotDeps

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
 * pill all belong here"）：没有待撤销的事时什么都不渲染。
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
