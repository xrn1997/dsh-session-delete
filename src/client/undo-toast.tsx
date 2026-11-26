/**
 * 撤销提示（`docs/ui-spec.md` §2 ③）：移入回收站成功后一条可撤销的横幅。现场与发布住 `undo-notices.ts`，
 * 本文件只做组件；「撤销」整趟交给 `write-seats.ts` 的 `restoreFromUndo`。组件必须独立于菜单行：
 * 宿主的菜单行随菜单一起卸载，而提示要在菜单关掉之后还活着（宿主官方配方同形：模块级 store +
 * `shell.overlay` 里的 toast 读它）。
 */
import type { CSSProperties } from 'react'
import { zhTranslate, type Translate } from './copy.js'
import { useBusyGate } from './busy-gate.js'
import type { OneShotDeps } from './remote.js'
import {
  clearUndoFailure,
  clearUndoNotice,
  UNDO_HOLD_MS,
  useUndoFailure,
  useUndoNotice,
  type UndoNotice,
} from './undo-notices.js'
import { IconWarningOutlineRegular } from './ui/icons.js'
import { Toast } from './ui/Toast.js'
import { useWriteProgress } from './use-write-progress.js'
import { restoreFromUndo } from './write-seats.js'
import { WriteProgressLine } from './write-progress.js'

/**
 * 常驻的撤销提示宿主，挂 `shell.overlay`。两种来源共用：**当前横幅**优先；不在时顶上一条待显示的
 * 撤销失败（在飞期间横幅被覆盖/熄灭，失败原文不能跟着消失）。
 */
export function UndoToast({ deps, t = zhTranslate }: { deps: OneShotDeps; t?: Translate }) {
  const current = useUndoNotice()
  const pendingFailure = useUndoFailure()
  if (current === null) {
    if (pendingFailure === null) return null
    // 失败原文只剩这一句（没有撤销动作可给）：到时自己清掉，不留一条没有落点的旧失败。
    return (
      <Toast
        key={`undo-failure-${String(pendingFailure.seq)}`}
        text={pendingFailure.failure}
        icon={<IconWarningOutlineRegular size={16} />}
        holdMs={UNDO_HOLD_MS}
        onDone={clearUndoFailure}
      />
    )
  }
  // 每条通知一个以 seq 为 key 的躯体：闸跟着通知走——旧撤销还在飞时来了新的移入回收站，新横幅的「撤销」不许被按灰。
  return <NoticeToast key={current.seq} deps={deps} current={current} t={t} />
}

/** 批量部分失败副行：与进度行同尺寸排布，字色取深底告警 token（与 `.sd-toast-icon` 同源）。 */
const PARTIAL_FAILURE_LINE: CSSProperties = {
  display: 'block',
  marginBlockStart: 6,
  fontSize: 12,
  lineHeight: '17px',
  color: 'var(--sd-state-warn-label)',
}

/** 一条通知的躯体：busy 生命周期归 `useBusyGate`（连点的同步判重也在闸里），这里只组合呈现。 */
function NoticeToast({ deps, current, t }: { deps: OneShotDeps; current: UndoNotice; t: Translate }) {
  const gate = useBusyGate()
  // 无框恢复也要看得见进度（`docs/ui-spec.md` §2）：restore 的认领名单就是撤销名单（回收站条目 id）。
  const face = useWriteProgress(
    deps,
    { action: 'restore', ids: current.kind === 'one' ? [current.entryId] : current.entryIds },
    gate.busy,
  )
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
        /* 已归档会话撤销是回「归档」，不是回会话列表——整句一个键，不在 JSX 里拼标点（ADR-0060 决定第 1 条）。 */
        current.kind === 'one'
          ? t(current.archived === true ? 'undo.movedArchived' : 'undo.moved', {
            title: current.title === '' ? t('undo.session') : current.title,
          })
          : t(current.archived === true ? 'undo.movedBatchArchived' : 'undo.movedBatch', { n: current.n })
      }
      detail={
        /* 进度行与部分失败副行进横幅副行（按钮之后，免得块级节点把「撤销」挤到下一行）；认领不上只说排队中，不冒领另一趟写的 k/N。
           横幅外层是 `role=alert`，逐 tick 播报会持续打断读屏 ⇒ 进度行只做视觉，播报归横幅本身。 */
        <>
          {current.kind === 'batch' && current.partialFailure !== undefined ? (
            <span style={PARTIAL_FAILURE_LINE}>
              {t('undo.partialFailure', {
                n: current.partialFailure.count,
                reasons: current.partialFailure.reasons,
              })}
            </span>
          ) : null}
          <WriteProgressLine face={face} t={t} announce={false} />
        </>
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
              // 整趟包进这条横幅自己的闸；ids 组装、回执改写与收自己都归 `restoreFromUndo`。
              onClick: () => { void gate.around(() => restoreFromUndo(deps, current, t)) },
            }]
          : undefined
      }
    />
  )
}
