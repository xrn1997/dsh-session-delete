/**
 * 侧栏面板列表里的「回收站」行（`sidebar.panellist` 的占用者）：**glyph + 拖放投放标记**。
 * 行本体由宿主 `PanelRow` 画（名字来自注册元数据：宿主 `syncPanels` 的 `label`）：
 * 这里不能有按钮、文字或角标，多画一样这一行就与其它三行错位。
 *
 * 拖放（`docs/ui-spec.md` §1、`ADR-0071`）：
 * 4 态 × `sourceOk` 两档、拒收是动效不是状态、全链红色。高亮与命中都认**整块面板行**——行本体是
 * 宿主 DOM，收口在 document 捕获监听；受约束偏离登记在 ADR-0071（只读宿主节点与拖拽载荷，不改
 * 宿主节点）；状态投影成 span 上的 `data-dst-*` attr，`layout.css` 的 `:has` 规则
 * 把红色画在宿主行上。可删性靠三件事说话：图标开合（可删 = 开盖「张嘴等吞」）、胶囊文案、
 * drop 动效（吞入回弹 vs 抖动拒收）。胶囊 portal 到 body、fixed 锚在行下缘并按视口边界收口。
 *
 * 拖放语义（issue #9，`ADR-0071`）：宿主会话行的原生拖拽把 session id 写进 `text/plain`
 * （宿主 `Rows.tsx` 的 `onDragStart`），drop 判定归 `trash-drop.ts`；单条/整集走既有写入座位
 * （无确认框、成功发撤销横幅、在飞由闸挡回）；运行中的行 dropBlocked 抖动拒收、写入被拒播同一动效，
 * 两者均把原因交给裸失败提示——「删不动」只有一套视觉。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { zhTranslate, type Translate } from './copy.js'
import { useBusyGate, type BusyGate } from './busy-gate.js'
import { createDropTargetMachine, type DropTargetEvent, type DropTargetView } from './drop-machine.js'
import { pickableRowOf, registeredHostRowOf } from './host-rows.js'
import type { OneShotDeps } from './remote.js'
import { useLatest } from './store.js'
import { shrinkPicksToFailures } from './batch-selection-store.js'
import { resolveDropPlan, type DropPlan } from './trash-drop.js'
import { publishFailureNotice } from './undo-notices.js'
import { deleteSessionFromMenu, deleteSessionsFromBatch } from './write-seats.js'
import { IconTrashOpen, IconTrashOutlineRegular } from './ui/icons.js'

/** 宿主 `SidebarPanelIconOwnerProps`：请求的方形边长；`deps`/`t` 由 `deps+t` 注入面给。 */
export interface TrashPanelIconProps {
  // 槽位宿主显式传 undefined（`{ size }: { size?: number }` 直转）：props 面可选即含 undefined。
  size?: number | undefined
  active?: boolean
  /** 拖放删除的写入链；glyph 本身不读它。 */
  deps: OneShotDeps
  /** 文案（缺省 = 内置 zh，见 `copy.ts`）。 */
  t?: Translate
}

/** 拒收胶囊自灭时长（1600ms）。 */
const SHAKE_HOLD_MS = 1600
const PILL_EDGE_MARGIN = 12
const PILL_GAP = 8

/** drop 落地：已收窄到可删分支（`single` / `batch`），把座位回执喂回状态机；写入被拒不许静默。 */
function runDrop(
  deps: OneShotDeps,
  gate: BusyGate,
  plan: Extract<DropPlan, { kind: 'single' | 'batch' }>,
  settle: (event: DropTargetEvent, text?: string) => void,
): void {
  const rejectUnhandled = (error: unknown): void => {
    const message = error instanceof Error && error.message !== '' ? error.message : String(error)
    publishFailureNotice(message)
    settle('writeRejected', message)
  }
  if (plan.kind === 'batch') {
    void deleteSessionsFromBatch(deps, plan.items.map((item) => item.sessionId), gate).then((run) => {
      if (run.kind === 'blocked') {
        settle('settled')
        return
      }
      shrinkPicksToFailures([...run.value.keys()])
      if (run.value.size === 0) {
        settle('settled')
        return
      }
      const text = [...new Set(run.value.values())].join(' · ')
      publishFailureNotice(text)
      settle('writeRejected', text)
    }, rejectUnhandled)
    return
  }
  void deleteSessionFromMenu(deps, { sessionId: plan.item.sessionId, title: plan.item.title }, gate).then((run) => {
    if (run.kind === 'blocked') {
      settle('settled')
      return
    }
    if (run.value === null) {
      settle('settled')
      return
    }
    publishFailureNotice(run.value)
    settle('writeRejected', run.value)
  }, rejectUnhandled)
}

export function TrashPanelIcon({ size = 16, deps, t = zhTranslate }: TrashPanelIconProps) {
  const gate = useBusyGate()
  const depsRef = useLatest(deps)
  const gateRef = useLatest(gate)
  const tRef = useLatest(t)
  const wrapRef = useRef<HTMLSpanElement | null>(null)
  const pillRef = useRef<HTMLDivElement | null>(null)
  const machineRef = useRef(createDropTargetMachine())
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unmountedRef = useRef(false)
  const [view, setView] = useState<DropTargetView>(() => machineRef.current.view())
  /** 胶囊锚点：宿主行下缘中央（dragover 时随行位移刷新）。 */
  const [anchor, setAnchor] = useState<{ left: number; top: number; bottom: number } | null>(null)

  useEffect(() => {
    unmountedRef.current = false
    const machine = machineRef.current
    const clearShakeTimer = (): void => {
      if (shakeTimer.current === null) return
      clearTimeout(shakeTimer.current)
      shakeTimer.current = null
    }
    const dispatch = (event: DropTargetEvent, info?: { ok?: boolean; text?: string }): boolean => {
      const ran = machine.send(event, info)
      if (ran && !unmountedRef.current) setView(machine.view())
      return ran
    }
    const armShakeEnd = (): void => {
      clearShakeTimer()
      shakeTimer.current = setTimeout(() => {
        shakeTimer.current = null
        dispatch('shakeEnd')
      }, SHAKE_HOLD_MS)
    }
    const settle = (event: DropTargetEvent, text?: string): void => {
      dispatch(event, text === undefined ? undefined : { text })
      if (event === 'writeRejected') armShakeEnd()
    }
    /** 命中判定：事件落在**含本标记**的那个宿主面板行按钮里（整块栏目任意位置都算）。 */
    const rowOf = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) return null
      const row = target.closest('button')
      return row !== null && wrapRef.current !== null && row.contains(wrapRef.current) ? row : null
    }
    const onDragStart = (event: DragEvent): void => {
      // 只有已登记的宿主会话行起拖才启动状态机；未登记节点与文字拖动不亮框。可删性此刻判（live 不可删）。
      const src = event.target instanceof Element ? event.target.closest('[data-row-key^="session:"]') : null
      if (src === null) return
      const sessionId = (src.getAttribute('data-row-key') ?? '').slice('session:'.length)
      if (sessionId === '' || registeredHostRowOf(sessionId) === undefined) return
      clearShakeTimer()
      dispatch('dragStart', { ok: pickableRowOf(sessionId) !== undefined })
    }
    const onDragStartBubble = (event: DragEvent): void => {
      // 若宿主自己在冒泡阶段阻止了拖动，浏览器不会发 dragend；此处立刻收起高亮。
      if (!event.defaultPrevented) return
      const state = machine.view().state
      if (state === 'armed' || state === 'over') dispatch('dragEnd')
    }
    const onDragEnd = (): void => { dispatch('dragEnd') }
    const onDragOver = (event: DragEvent): void => {
      const row = rowOf(event.target)
      if (row === null || machine.view().state === 'idle') return
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
      dispatch('dragEnter')
      const rect = row.getBoundingClientRect()
      setAnchor((current) => {
        const next = { left: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom }
        return current !== null
          && current.left === next.left
          && current.top === next.top
          && current.bottom === next.bottom
          ? current
          : next
      })
    }
    const onDragLeave = (event: DragEvent): void => {
      const row = rowOf(event.target)
      if (row === null) return
      // dragleave 在 svg 子元素间会抖：只有 relatedTarget 真的离开本行才算。
      if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return
      dispatch('dragLeave')
    }
    const onDrop = (event: DragEvent): void => {
      const row = rowOf(event.target)
      if (row === null || machine.view().state === 'idle') return
      event.preventDefault()
      event.stopPropagation()
      const payload = event.dataTransfer?.getData('text/plain') ?? ''
      const plan = resolveDropPlan(payload)
      if (plan.kind === 'ignore') return
      if (plan.kind === 'refuse-live') {
        const reason = tRef.current('drop.refuseLive')
        publishFailureNotice(reason)
        settle('dropBlocked', reason)
        armShakeEnd()
        return
      }
      // dropOk 是唯一入口态转移；闸挡回（已在飞）时 send 返回 false，第二趟 drop 不再发座位。
      if (!dispatch('dropOk')) return
      runDrop(depsRef.current, gateRef.current, plan, settle)
    }
    // 捕获阶段收口五类拖放事件，不碰点击；另挂冒泡 dragstart 接住宿主取消拖动。deps/gate/t 走 useLatest，
    // 避免 gate 忙闲切换重渲染取消 1.6s 拒收定时器。
    document.addEventListener('dragstart', onDragStart, true)
    document.addEventListener('dragstart', onDragStartBubble, false)
    document.addEventListener('dragend', onDragEnd, true)
    document.addEventListener('dragover', onDragOver, true)
    document.addEventListener('dragleave', onDragLeave, true)
    document.addEventListener('drop', onDrop, true)
    return () => {
      unmountedRef.current = true
      document.removeEventListener('dragstart', onDragStart, true)
      document.removeEventListener('dragstart', onDragStartBubble, false)
      document.removeEventListener('dragend', onDragEnd, true)
      document.removeEventListener('dragover', onDragOver, true)
      document.removeEventListener('dragleave', onDragLeave, true)
      document.removeEventListener('drop', onDrop, true)
      clearShakeTimer()
    }
  }, [depsRef, gateRef, tRef])

  const openInvite = view.sourceOk && (view.state === 'over' || view.state === 'committing')
  const pillText =
    view.shake ? view.shakeText
      : view.state === 'over' ? (view.sourceOk ? t('drop.release') : t('drop.refuseLive'))
        : view.state === 'committing' ? t('drop.deleting')
          : null

  useLayoutEffect(() => {
    const el = pillRef.current
    if (pillText === null || anchor === null || el === null) return
    const rect = el.getBoundingClientRect()
    const half = rect.width / 2
    const minLeft = PILL_EDGE_MARGIN + half
    const maxLeft = Math.max(minLeft, window.innerWidth - PILL_EDGE_MARGIN - half)
    const left = Math.min(Math.max(anchor.left, minLeft), maxLeft)
    const fitsBelow = anchor.bottom + PILL_GAP + rect.height <= window.innerHeight - PILL_EDGE_MARGIN
    const fitsAbove = anchor.top - PILL_GAP - rect.height >= PILL_EDGE_MARGIN
    const top = !fitsBelow && fitsAbove ? anchor.top - PILL_GAP - rect.height : anchor.bottom + PILL_GAP
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [pillText, anchor])

  return (
    <span
      ref={wrapRef}
      data-dsh-session-delete="trash-drop"
      data-dst-state={view.state}
      data-dst-ok={view.sourceOk ? 'true' : 'false'}
      data-dst-shake={view.shake ? 'true' : undefined}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}
    >
      <span data-dst-icon={openInvite ? 'open' : 'closed'} style={{ display: 'inline-flex' }}>
        {openInvite ? <IconTrashOpen size={size} /> : <IconTrashOutlineRegular size={size} />}
      </span>
      {pillText === null || anchor === null
        ? null
        : createPortal(
            <div ref={pillRef} className="sd-drop-pill" role="status" style={{ left: anchor.left, top: anchor.bottom + PILL_GAP }}>
              {pillText}
            </div>,
            document.body,
          )}
    </span>
  )
}
