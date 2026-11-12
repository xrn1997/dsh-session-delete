/**
 * 维护卡一段维护的**泛型状态机**：报告 / 失败 / 中性提示 / 第二回执 / 确认框 / 在飞档位 / 最新票 /
 * 清完必重查。孤儿会话、孤儿附件与投影缓存是这台机器按前缀各抄一份的三段——这里收成一台，
 * 三段各自只带自己的远程调用、判据与拼句（`use-maintenance.ts` 三次实例化）。
 *
 * 三条承重规矩（ADR-0021）在这一层保证，三段都不可绕过：
 * - **没有自动扫描**：本 module 不挂 effect、没有定时器；挂载只交初始态（报告 `null` = 尚未检查）。
 * - **读不到就说读不到**：检查失败回 `null` + 原文（失败句由各段在 `scan` 的落地面里拼好），
 *   不折成"没有发现"。
 * - **清理后必重查**：清完立刻重读；回执句子由 `afterClean` 拼好后**等重查赢了才落地**——顺序反了，
 *   重查成功会清掉旧提示，把这一趟的后果吞掉。
 *
 * **时序是这台机器的实现，不是调用方的约定**：`scan` / `clean` 只交落地面，`afterClean` 一次判读
 * 两处用途——`preset` 在必发重查之前摆，`plan` 在重查赢了之后摆；被顶掉的输家两处都不落地。
 * 上一版的 `onScanWon` / `beforeRescan` / `settle` 三个按时间点拆开的钩子、以及 glue 里自己手算
 * 赢家/输家的第二回执，都收进了这里。
 *
 * **不变量由构造保证**：开确认框只有 `openPreview()` 一条路（先清旧失败与旧提示再开），收框只有
 * `cancel()`（只收框，不碰提示 / 失败）；界面上写不出"裸把 confirm 摆 true"这种开门，于是
 * "确认框开着、上一趟的失败句还挂着"的组合从类型上就不存在。`busy` 同理由段自己给
 * （在飞即忙），不再作为 prop 逐层传。
 *
 * 动作是每渲染重建的普通闭包、不包 `useCallback`：config 每渲染本来就要重建，包了也稳定不下来；
 * 这些动作只被点击触发，没有按身份依赖它们的 effect（`useIdleClose` 只在调用时读它们）。
 */
import { useState } from 'react'
import type { RemoteOutcome } from './remote.js'
import { createLatestWins } from './store.js'

/** 一段在飞的动作：检查只读，清理会写。状态行靠它分开说「检查中…」与「清理中…」；`null` = 空闲。 */
export type MaintenancePhase = 'scanning' | 'cleaning'

/** 检查的落地面：失败句由各段自己拼（`text`）——机器只负责在赢票之后把它摆上屏。
 *  这样「检查失败怎么说」归 glue，而「什么时候说」仍归机器。 */
export type MaintenanceScanOutcome<R> =
  | { readonly ok: true; readonly value: R }
  | { readonly ok: false; readonly text: string }

/** 一段维护交给界面的全部：四份读数（报告 / 失败 / 中性提示 / 第二回执）、
 *  一个确认框、一档忙碌，加四个动作。 */
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
  /** 清理写动作；入参是点击那一刻的报告（清理输入由各段自己从里面点名）。报告没活可干时
   *  同步回 `null`：不发请求、只收确认框——"没活"的判据各段不同，是各段的业务。
   *  同样交回落地面、不抛。`C` 是这一段的回执形状：状态机不认识它，只把它原样递给
   *  `afterClean`，段那边就不必把 `outcome.value` 擦回 `unknown` 再 `as` 一次。 */
  clean(report: R): Promise<RemoteOutcome<C>> | null
  /** 清理落地后的**一次**判读：`preset` 交给必发重查前的读数位，`plan` 等重查赢了再摆。
   *  `report` 是**这一趟**点击那一刻的报告：回执要按请求名单逐条判读，名单只能随这一趟交下来；
   *  段自己存一份"最近一次清理的名单"会在两趟交错时把上一趟的回执按后一趟的名单判读。
   *  本回调必须无副作用（只算、不 set）：输赢未定时它已经被调用，副作用会落到输家身上。 */
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

  /**
   * 一次检查（不碰 phase）。交回这张票是否仍是赢家：清理后的重查被后发的检查顶掉时，
   * 由赢家负责把读数与 busy 一起收尾，输家什么都不落地。**输家不许替赢家清 `phase`**——phase 归
   * 赢下最新票的那一趟收尾，输家提前清会在赢家还在飞时把界面摆成空闲（忙碌收尾与
   * `use-trash-query.ts` 的空闲判定是两套写法，判据不同源，别互相抄）。
   */
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
