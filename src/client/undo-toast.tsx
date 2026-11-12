/**
 * 撤销提示（docs/ui-spec.md 状态 ③）：删除成功后一条可撤销的横幅。
 *
 * 现场与发布住在 `undo-notices.ts`；本文件只做组件：画通知台已有的事实，「撤销」整趟按下交给
 * `write-seats.ts` 的 `restoreFromUndo`（编排归恢复座位，见 ADR-0018 的边界）。
 * 为什么组件要独立：宿主的菜单行随菜单**一起卸载**（真产物 Menu 的注释原文
 * "the rows unmount with the list"），而提示要在菜单关掉之后还活着。宿主的官方配方同形——
 * 会话行的动作把请求写进一个模块级 store，`shell.overlay` 里的 `workspace.row-toast` 读它。
 */
import { zhTranslate, type Translate } from './copy.js'
import { useBusyGate } from './busy-gate.js'
import type { OneShotDeps } from './remote.js'
import { clearUndoNotice, UNDO_HOLD_MS, useUndoNotice, type UndoNotice } from './undo-notices.js'
import { IconWarningOutlineRegular } from './ui/icons.js'
import { Toast } from './ui/Toast.js'
import { restoreFromUndo } from './write-seats.js'

/**
 * 常驻的撤销提示宿主。挂 `shell.overlay`（框架级浮层；槽位说明原文 "a toast stack or a status
 * pill all belong here"）：没有待撤销的事时什么都不渲染。
 */
export function UndoToast({ deps, t = zhTranslate }: { deps: OneShotDeps; t?: Translate }) {
  const current = useUndoNotice()
  if (current === null) return null
  // 每条通知一个以 seq 为 key 的躯体：闸跟着通知走——旧撤销还在飞时来了新删除，新横幅的
  // 「撤销」不许被旧那一趟按灰（issue #8 第 8 条的在飞闸按通知隔离）。
  return <NoticeToast key={current.seq} deps={deps} current={current} t={t} />
}

/** 一条通知的躯体：busy 生命周期归 `useBusyGate`（连点的同步判重也在闸里），这里只组合呈现。 */
function NoticeToast({ deps, current, t }: { deps: OneShotDeps; current: UndoNotice; t: Translate }) {
  const gate = useBusyGate()
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
        // 已归档会话删除后撤销是回「归档」，不是回会话列表——整句一个键，不在 JSX 里拼标点
        // （ADR-0060 决定第 1 条）。
        current.kind === 'one'
          ? t(current.archived === true ? 'undo.movedArchived' : 'undo.moved', {
            title: current.title === '' ? t('undo.session') : current.title,
          })
          : t(current.archived === true ? 'undo.movedBatchArchived' : 'undo.movedBatch', { n: current.n })
      }
      holdMs={UNDO_HOLD_MS}
      // 撤销在飞时横幅不自动熄灭：失败原文要落回这一条，先收掉就只剩一条「失败被吞」。
      // 成功由 `restoreFromUndo` 自己收，失败由 `failNotice` 换 seq 重挂。
      paused={gate.busy}
      onDone={clearUndoNotice}
      actions={
        canUndo
          ? [{
              label: t('undo.undo'),
              disabled: gate.busy,
              // 整趟包进这条横幅自己的闸（连点防重与按灰都归 busy-gate.ts，不在这里另造一套）；
              // ids 组装、回执改写与收自己都归 `restoreFromUndo`，这里只按下。
              onClick: () => { void gate.around(() => restoreFromUndo(deps, current, t)) },
            }]
          : undefined
      }
    />
  )
}
