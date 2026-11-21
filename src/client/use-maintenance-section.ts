/**
 * 维护卡一段维护的**泛型状态机**：报告 / 失败 / 中性提示 / 第二回执 / 确认框 / 在飞档位 / 最新票 /
 * 清完必重查。孤儿会话、孤儿附件与投影缓存是这台机器按前缀各抄一份的三段，这里收成一台（ADR-0021）。
 * 三条承重规矩：**没有自动扫描**（不挂 effect、没有定时器）；**读不到就说读不到**（失败不折成"没发现"）；
 * **清理后必重查**，回执句子等重查赢了才落地——顺序反了，重查成功会清掉旧提示、把这一趟的后果吞掉。
 * 时序是机器的实现：`afterClean` 的 `preset` 在必发重查前摆，`plan` 在重查赢了之后摆，输家两处都不落地。
 * 不变量由构造保证：开框只有 `openPreview()`、收框只有 `cancel()`；动作不包 `useCallback`（只被点击触发）。
 */
import { useState } from 'react'
import type { RemoteOutcome } from './remote.js'
import { createLatestWins } from './store.js'

/** 一段在飞的动作：检查只读，清理会写。状态行靠它分开说「检查中…」与「清理中…」；`null` = 空闲。 */
export type MaintenancePhase = 'scanning' | 'cleaning'

/** 检查的落地面：失败句由各段自己拼（`text`），机器只负责在赢票之后把它摆上屏。 */
export type MaintenanceScanOutcome<R> =
  | { readonly ok: true; readonly value: R }
  | { readonly ok: false; readonly text: string }

/** 一段维护交给界面的全部：四份读数、一个确认框、一档忙碌，加四个动作。 */
export interface MaintenanceSectionView<R> {
  /** `null` = 还没检查（或上一次检查失败——失败在 `failure` 单独一格，不折成零条）。 */
  readonly report: R | null
  readonly failure: string | null
  /** 「这一组已经不在」/ 上一趟清理的回执——不是失败：单独一条中性提示。 */
  readonly notice: string | null
  /** 同一次清理顺带产生的第二份回执（如孤儿会话清理顺手清掉的图片副本）；下一次检查赢了自然收掉。 */
  readonly secondaryNotice: string | null
  readonly confirm: boolean
  readonly phase: MaintenancePhase | null
  /** 段自己给的忙碌（在飞即忙），不再作为 prop 传递。 */
  readonly busy: boolean
  /** 手动检查（也是失败块的重试）。 */
  scan: () => Promise<void>
  /** 唯一开门：先清旧失败与旧提示再开确认框。 */
  openPreview: () => void
  /** 清完必重查；回执句子由 config 拼。 */
  clean: () => Promise<void>
  /** 只收确认框，不碰提示 / 失败。 */
  cancel: () => void
}

/** `afterClean` 拼出的这一趟要摆的句子；**缺席的格子表示"不碰"**（重查刚摆上的状态保持原样）。 */
export interface MaintenanceSettlePlan {
  readonly notice?: string | null
  readonly failure?: string | null
  readonly secondaryNotice?: string | null
}

/** `afterClean` 的一次判读、两处用途：机器决定各自什么时候落地。 */
export interface MaintenanceAfterClean<R> {
  /** 必发重查起飞前先摆的读数（清理成功后旧报告不再可信时用）；缺席 = 不动。 */
  readonly preset?: R
  /** 重查赢了之后摆的句子；缺席 = 不碰。 */
  readonly plan?: MaintenanceSettlePlan
}

export interface MaintenanceSectionConfig<R, C> {
  /** 手动检查（也是失败块的重试）。交回的已是落地面——通道直接给 `RemoteOutcome`，不会抛。 */
  scan(): Promise<MaintenanceScanOutcome<R>>
  /** 清理写动作；入参是点击那一刻的报告（清理输入由各段自己点名）。报告没活可干时同步回 `null`：
   *  不发请求、只收确认框——"没活"的判据各段不同。交回落地面、不抛；`C` 是这一段的回执形状。 */
  clean(report: R): Promise<RemoteOutcome<C>> | null
  /** 清理落地后的**一次**判读：`preset` 交给必发重查前的读数位，`plan` 等重查赢了再摆。`report` 是这一趟
   *  点击那一刻的报告——回执要按请求名单逐条判读，段自己存名单会在两趟交错时判错。本回调必须无副作用
   *  （只算、不 set）：输赢未定时它已经被调用，副作用会落到输家身上。 */
  afterClean(outcome: RemoteOutcome<C>, report: R): MaintenanceAfterClean<R>
}

export function useMaintenanceSection<R, C>(config: MaintenanceSectionConfig<R, C>): MaintenanceSectionView<R> {
  const [report, setReport] = useState<R | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [secondaryNotice, setSecondaryNotice] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [phase, setPhase] = useState<MaintenancePhase | null>(null)
  const [latest] = useState(createLatestWins)

  /** 一次检查（不碰 phase），回这张票是否仍是赢家：输家什么都不落地，**不许替赢家清 `phase`**——
   *  提前清会在赢家还在飞时把界面摆成空闲。 */
  async function rescan(): Promise<boolean> {
    const ticket = latest.issue()
    // config 交回的已经是落地面（通道直接给 `RemoteOutcome`、不会抛），这里不再包一层。
    const outcome = await config.scan()
    if (!ticket.current) return false
    // 新一次检查是新的只读快照：旧失败、旧提示与上一趟的第二回执一起收掉，不冒充这一次的读数。
    setFailure(null)
    setNotice(null)
    setSecondaryNotice(null)
    if (outcome.ok) {
      setReport(outcome.value)
      return true
    }
    setReport(null)
    setConfirm(false)
    setFailure(outcome.text)
    return true
  }

  async function scan(): Promise<void> {
    setPhase('scanning')
    const current = await rescan()
    if (current) setPhase(null)
  }

  async function clean(): Promise<void> {
    const before = report
    if (before === null) {
      setConfirm(false)
      return
    }
    const pending = config.clean(before)
    if (pending === null) {
      // 没活可干：不发请求、只收框；phase 一档都没进过，界面从头到尾是空闲。
      setConfirm(false)
      return
    }
    setPhase('cleaning')
    // 这一趟起飞后，上一趟的读数与回执都不再是"现在"：先收掉，别让它们在飞着时冒充本次结果。
    setFailure(null)
    setNotice(null)
    setSecondaryNotice(null)
    const outcome = await pending
    setConfirm(false)
    // 一次判读、两处落地：preset 赶在重查起飞前，plan 等重查赢了再摆。
    const { preset, plan } = config.afterClean(outcome, before)
    if (preset !== undefined) setReport(preset)
    const current = await rescan()
    if (!current) return
    // 重查先落地：它会在成功时清掉旧提示；这一趟的后果必须在它之后才摆。
    if (plan?.notice !== undefined) setNotice(plan.notice)
    if (plan?.failure !== undefined) setFailure(plan.failure)
    if (plan?.secondaryNotice !== undefined) setSecondaryNotice(plan.secondaryNotice)
    setPhase(null)
  }

  function openPreview(): void {
    setFailure(null)
    setNotice(null)
    setSecondaryNotice(null)
    setConfirm(true)
  }

  function cancel(): void {
    setConfirm(false)
  }

  return {
    report,
    failure,
    notice,
    secondaryNotice,
    confirm,
    phase,
    busy: phase !== null,
    scan,
    openPreview,
    clean,
    cancel,
  }
}
