/**
 * 拖放目标状态机（`docs/ui-spec.md` §1；判定住 `ADR-0071`，移入回收站的即执行口径统一见 `ADR-0072`）：
 * 4 个驻留态 × `sourceOk` 正交维度，**拒收是动效不是状态**——`dropBlocked` / `writeRejected`
 * 只置 `shake` 视图位（带原因文案），驻留态照常走；`shakeEnd` 清尾巴（胶囊自灭 1.6s 由调用方计时）。
 * 纯模块零 DOM：`trash-entry.tsx` 负责把 DOM 事件翻译成这里的事件、把 view 投影成 attr 与胶囊。
 *
 * 转移表：
 * - idle --dragStart(源=会话行)--> armed（`info.ok` 定 `sourceOk`，live 源 = false）
 * - armed --dragEnter--> over；over --dragLeave--> armed；armed|over --dragEnd--> idle；armed|over --dragStart--> armed（漏收 dragend 时自愈）
 * - over --dropOk--> committing --settled--> idle
 * - over --dropBlocked--> over（shake + 原因；拖起时已知删不动，drop 只补动效）
 * - committing --writeRejected--> idle（shake + 失败原文；拖起时以为能删、服务端拒了）
 * 非法事件返回 false 且不改状态。
 */
export type DropTargetState = 'idle' | 'armed' | 'over' | 'committing'

export type DropTargetEvent =
  | 'dragStart'
  | 'dragEnter'
  | 'dragLeave'
  | 'dragEnd'
  | 'dropOk'
  | 'dropBlocked'
  | 'settled'
  | 'writeRejected'
  | 'shakeEnd'

export interface DropTargetView {
  readonly state: DropTargetState
  /** 拖的源删不删得动（dragStart 时定；其余事件不动它）。 */
  readonly sourceOk: boolean
  /** 拒收动效进行中（dropBlocked / writeRejected 置位，shakeEnd 清）。 */
  readonly shake: boolean
  /** 拒收原因文案（胶囊用）；shake=false 时为空串。 */
  readonly shakeText: string
}

export interface DropTargetMachine {
  /** 非法转移返回 false 且不改状态。`info.ok` 只在 dragStart 读；`info.text` 只在拒收事件读。 */
  send(event: DropTargetEvent, info?: { ok?: boolean; text?: string }): boolean
  view(): DropTargetView
}

const TRANSITIONS: Record<DropTargetState, Partial<Record<DropTargetEvent, DropTargetState>>> = {
  idle: { dragStart: 'armed' },
  armed: { dragEnter: 'over', dragEnd: 'idle', dragStart: 'armed' },
  over: { dragLeave: 'armed', dragEnd: 'idle', dragStart: 'armed', dropOk: 'committing', dropBlocked: 'over' },
  committing: { settled: 'idle', writeRejected: 'idle' },
}

export function createDropTargetMachine(): DropTargetMachine {
  let state: DropTargetState = 'idle'
  let sourceOk = true
  let shake = false
  let shakeText = ''
  return {
    send(event, info) {
      if (event === 'shakeEnd') {
        if (!shake) return false
        shake = false
        shakeText = ''
        return true
      }
      const next = TRANSITIONS[state][event]
      if (next === undefined) return false
      if (event === 'dragStart') {
        sourceOk = !(info?.ok === false)
        shake = false
        shakeText = ''
      } else if (event === 'dropBlocked' || event === 'writeRejected') {
        shake = true
        shakeText = info?.text ?? ''
      }
      state = next
      return true
    },
    view() {
      return { state, sourceOk, shake, shakeText }
    },
  }
}
