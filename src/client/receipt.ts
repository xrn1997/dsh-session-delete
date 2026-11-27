import type { Translate } from './copy.js'
import {
  ATTACHMENT_CLEANUP_SCHEMA,
  PURGE_STATS_ATTACHMENTS_SCHEMA,
  TRASH_ENTRY_ARCHIVED_SCHEMA,
  TRASH_ENTRY_ID_SCHEMA,
  TRASH_ENTRY_SESSION_ID_SCHEMA,
} from '../shared/apply-values.js'
import {
  ATTACHMENT_SKIPPED_SEPARATOR,
  FAILURE_DETAILS_ATTACHMENTS_KEY,
  SESSION_DELETE_CODES,
  type ApplyAction,
  type ApplyOutcome,
  type ApplyValueByAction,
  type AttachmentCleanupWire,
  type RemoteFailure,
} from '../shared/wire.js'

/**
 * 一条 `/apply` 结果对一个请求 id 的含义（各写入面不许再各自推导）：缺 id 是通道错误，`null` 是幂等成功，
 * orphan-clean 的 `not-found` 是中性提示，**N=1 的 `null` 是协议错**；`applyOne` 与 `runWrite` 只消费同一份 verdict。
 */
export type ReceiptVerdict<A extends ApplyAction> =
  | { readonly kind: 'ok'; readonly id: string; readonly value: Exclude<ApplyValueByAction[A], null> }
  | { readonly kind: 'already-gone'; readonly id: string }
  | { readonly kind: 'failed'; readonly id: string; readonly error: RemoteFailure }
  | { readonly kind: 'neutral'; readonly id: string; readonly error: RemoteFailure }
  | { readonly kind: 'missing'; readonly id: string; readonly message: string }

export interface Receipt<A extends ApplyAction> {
  readonly action: A
  readonly verdicts: readonly ReceiptVerdict<A>[]
  readonly byId: ReadonlyMap<string, ReceiptVerdict<A>>
}

/** 浏览器半自己的未分类诊断码（通道打不通 / 非信封 / 单条协议错）。它不过线，线上失败码仍归 `shared/wire.ts`。 */
export const CLIENT_UNKNOWN_CODE = 'client/unknown'

/** 一个动作在回执读法里的两格语义（值形状住 `shared/apply-values.ts`，回执只读窄格）；
 *  `Record<ApplyAction, …>` 是编译闸：新动作忘了登记就编译不过。 */
interface ReceiptShape {
  /** `not-found` 算中性提示（孤儿清理把「组已不在」当成功）。 */
  readonly neutralOnNotFound: boolean
  /** 可参与撤销/回盘的落地 id 域；`none` = 没有。 */
  readonly landed: 'entry' | 'session' | 'none'
}

const RECEIPT_SHAPE: Record<ApplyAction, ReceiptShape> = {
  delete: { neutralOnNotFound: false, landed: 'entry' },
  restore: { neutralOnNotFound: false, landed: 'session' },
  purge: { neutralOnNotFound: false, landed: 'none' },
  count: { neutralOnNotFound: false, landed: 'none' },
  'orphan-clean': { neutralOnNotFound: true, landed: 'none' },
  // 解除归档没有撤销/回盘座位：清单重读归归档档自己的失效链（`archive-store`）。
  unarchive: { neutralOnNotFound: false, landed: 'none' },
}

export interface ReceiptOptions {
  readonly single?: boolean
}

export type SingleReceiptVerdict<A extends ApplyAction> = Exclude<ReceiptVerdict<A>, { kind: 'already-gone' }>

export interface SingleReceipt<A extends ApplyAction> {
  readonly verdicts: readonly SingleReceiptVerdict<A>[]
  readonly byId: ReadonlyMap<string, SingleReceiptVerdict<A>>
}

export function missingOutcomeMessage(action: ApplyAction, id: string): string {
  return `批量通道没回这一条的结果：${action} ${id}`
}

function singleNullMessage(action: ApplyAction, id: string): string {
  return `单条动作回了幂等空值：${action} ${id}`
}

export type FailureVerdict<A extends ApplyAction> = Extract<
  ReceiptVerdict<A>,
  { kind: 'failed' | 'neutral' | 'missing' }
>

export function failureMessage<A extends ApplyAction>(verdict: FailureVerdict<A>): string {
  return verdict.kind === 'failed' || verdict.kind === 'neutral' ? verdict.error.message : verdict.message
}

function decode<A extends ApplyAction>(
  action: A,
  outcome: ApplyOutcome,
  options: ReceiptOptions,
): ReceiptVerdict<A> | undefined {
  if (outcome.action !== action) return undefined
  const typed = outcome as Extract<ApplyOutcome, { action: A }>
  if (!typed.ok) {
    return RECEIPT_SHAPE[action].neutralOnNotFound && typed.error.code === SESSION_DELETE_CODES['not-found']
      ? { kind: 'neutral', id: typed.id, error: typed.error }
      : { kind: 'failed', id: typed.id, error: typed.error }
  }
  const value = typed.value as ApplyValueByAction[A]
  if (value === null) {
    return options.single === true
      ? {
        kind: 'failed',
        id: typed.id,
        error: { code: CLIENT_UNKNOWN_CODE, message: singleNullMessage(action, typed.id) },
      }
      : { kind: 'already-gone', id: typed.id }
  }
  return { kind: 'ok', id: typed.id, value: value as Exclude<ApplyValueByAction[A], null> }
}

export function readReceipt<A extends ApplyAction>(
  action: A,
  requestedIds: readonly string[],
  outcomes: readonly ApplyOutcome[],
  options: ReceiptOptions = {},
): Receipt<A> {
  const wanted = [...new Set(requestedIds)]
  const wantedSet = new Set(wanted)
  const byId = new Map<string, ReceiptVerdict<A>>()
  for (const outcome of outcomes) {
    if (!wantedSet.has(outcome.id) || byId.has(outcome.id)) continue
    const verdict = decode(action, outcome, options)
    if (verdict !== undefined) byId.set(outcome.id, verdict)
  }
  const verdicts = wanted.map((id): ReceiptVerdict<A> =>
    byId.get(id) ?? { kind: 'missing', id, message: missingOutcomeMessage(action, id) })
  return { action, verdicts, byId: new Map(verdicts.map((verdict) => [verdict.id, verdict])) }
}

/** N=1 读法：`null` 折成协议错，类型面因此不含 `already-gone`（运行期不会产出，过滤只服务类型收窄）。 */
export function readSingleReceipt<A extends ApplyAction>(
  action: A,
  id: string,
  outcomes: readonly ApplyOutcome[],
): SingleReceipt<A> {
  const verdicts = readReceipt(action, [id], outcomes, { single: true }).verdicts
    .filter((verdict): verdict is SingleReceiptVerdict<A> => verdict.kind !== 'already-gone')
  return { verdicts, byId: new Map(verdicts.map((verdict) => [verdict.id, verdict])) }
}

/** 一次写入回执的唯一读法：成功 / 失败 / 中性 / 部分计数 / 落地 id 都从这里出，座位与收尾不再各自 walk `verdicts`。 */
export interface ReceiptSummary {
  readonly successIds: readonly string[]
  readonly neutralIds: readonly string[]
  /** failed + missing（通道没回）；neutral 单独在 `neutralIds`。 */
  readonly failed: readonly { readonly id: string; readonly error: RemoteFailure }[]
  /** 部分计数只住这里：只累加 failed 的 `details`（"删了一半才炸"的释放量）；neutral / missing 不参与。 */
  readonly partial: { readonly removed: number; readonly freedBytes: number }
  /** 真正落地的 id，域由 `action` 定：delete = 条目 id，restore = 会话 id，其余恒空（两个域不混）。 */
  readonly landedIds: readonly string[]
  /** 带**已归档**标记的落地条目（entry 域）：撤销回「归档」而非会话列表，撤销文案据此改口（ADR-0060）。 */
  readonly landedArchivedIds: readonly string[]
  readonly anySuccess: boolean
  /** purge / orphan-clean 的附件读数，按批相加（成功回执 + 失败条 `details` 的同一格）；`skipped` 按出现序分段去重后用 `ATTACHMENT_SKIPPED_SEPARATOR` 拼接。没有读数时缺席——不拿零冒充「清过」。 */
  readonly attachmentCleanup?: AttachmentCleanupWire
}

/** 摘要派生的两样产物：聚合摘要与逐条失败原文（失败表只挂在成功支上，摘要不另存）。 */
export interface ReceiptRead {
  readonly summary: ReceiptSummary
  readonly failures: ReadonlyMap<string, string>
}

function detailNumber(details: Record<string, unknown> | undefined, key: string): number {
  const value = details?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 成功支（含批量幂等 `already-gone`）：筛选与逐条归并共用这一条，防止两处判据漂移。 */
type SuccessVerdict<A extends ApplyAction> = Extract<ReceiptVerdict<A>, { kind: 'ok' | 'already-gone' }>

function isSuccessVerdict<A extends ApplyAction>(
  verdict: ReceiptVerdict<A>,
): verdict is SuccessVerdict<A> {
  return verdict.kind === 'ok' || verdict.kind === 'already-gone'
}

/** 只校附件那一格：`attachments: null` 这类畸形线上值按「没有读数」处理，不在加法里替契约兜底。 */
function statsAttachments(value: unknown): AttachmentCleanupWire | undefined {
  return PURGE_STATS_ATTACHMENTS_SCHEMA.check(value) ? value.attachments : undefined
}

/** 失败条 `details` 里的那一格附件读数（键名两半共用 `wire.ts` 的常量）：与成功回执同 schema，畸形按没有读数。 */
function failureAttachments(details: Record<string, unknown> | undefined): AttachmentCleanupWire | undefined {
  const value = details?.[FAILURE_DETAILS_ATTACHMENTS_KEY]
  return ATTACHMENT_CLEANUP_SCHEMA.check(value) ? value : undefined
}

function summarizeAttachmentCleanup<A extends ApplyAction>(
  receipt: Receipt<A>,
): AttachmentCleanupWire | undefined {
  let removed = 0
  let freedBytes = 0
  let failedCount = 0
  const skippedParts: string[] = []
  const seenSkipped = new Set<string>()
  let seen = false
  for (const verdict of receipt.verdicts) {
    // 成功支读 value 的那一格；失败条读自己 `details` 的同一格（Node 半按组归属挂在那）——
    // 「按批相加」的总量不因条目失败而缺角。
    const attachments = verdict.kind === 'ok'
      ? statsAttachments(verdict.value)
      : verdict.kind === 'failed'
        ? failureAttachments(verdict.error.details)
        : undefined
    if (attachments === undefined) continue
    seen = true
    removed += attachments.removed
    freedBytes += attachments.freedBytes
    failedCount += attachments.failed
    if (attachments.skipped !== undefined) {
      for (const part of attachments.skipped.split(ATTACHMENT_SKIPPED_SEPARATOR)) {
        if (part === '' || seenSkipped.has(part)) continue
        seenSkipped.add(part)
        skippedParts.push(part)
      }
    }
  }
  if (!seen) return undefined
  return skippedParts.length === 0
    ? { removed, freedBytes, failed: failedCount }
    : { removed, freedBytes, failed: failedCount, skipped: skippedParts.join(ATTACHMENT_SKIPPED_SEPARATOR) }
}

/**
 * 附件清理回执的「跳过半句」：`skipped` 是"为什么没敢清"而非失败——原因上屏，`removed > 0` 说「部分」，`failed` 件数追加句尾。
 * 面板与维护卡共用这一判据；没 `skipped` 回 `null`（后半句口径归调用方）。
 */
export function attachmentSkippedSentence(a: AttachmentCleanupWire, t: Translate): string | null {
  if (a.skipped === undefined) return null
  const failedSuffix = a.failed > 0 ? t('trash.attachments.alsoFailed', { count: a.failed }) : ''
  const base = a.removed > 0
    ? t('trash.attachments.skippedPartial', { reason: a.skipped, removed: a.removed })
    : t('trash.attachments.skipped', { reason: a.skipped })
  return `${base}${failedSuffix}`
}

export function summarizeReceipt<A extends ApplyAction>(
  receipt: Receipt<A>,
  sessionIdOfEntry?: (entryId: string) => string | undefined,
): ReceiptRead {
  const successIds = receipt.verdicts.filter(isSuccessVerdict).map((verdict) => verdict.id)
  const failures = new Map<string, string>()
  const neutralIds: string[] = []
  const failed: { id: string; error: RemoteFailure }[] = []
  let partial = { removed: 0, freedBytes: 0 }
  for (const verdict of receipt.verdicts) {
    if (isSuccessVerdict(verdict)) continue
    failures.set(verdict.id, failureMessage(verdict))
    if (verdict.kind === 'neutral') {
      neutralIds.push(verdict.id)
      continue
    }
    if (verdict.kind === 'missing') {
      failed.push({ id: verdict.id, error: { code: CLIENT_UNKNOWN_CODE, message: verdict.message } })
      continue
    }
    failed.push({ id: verdict.id, error: verdict.error })
    partial = {
      removed: partial.removed + detailNumber(verdict.error.details, 'removed'),
      freedBytes: partial.freedBytes + detailNumber(verdict.error.details, 'freedBytes'),
    }
  }
  const landed = RECEIPT_SHAPE[receipt.action].landed
  const landedIds = landed === 'entry'
    ? landedEntryIds(receipt)
    : landed === 'session'
      ? restoredSessionIds(receipt, sessionIdOfEntry)
      : []
  const attachmentCleanup = summarizeAttachmentCleanup(receipt)
  return {
    summary: {
      successIds,
      neutralIds,
      failed,
      partial,
      landedIds,
      landedArchivedIds: landedArchivedEntryIds(receipt),
      anySuccess: successIds.length > 0,
      ...(attachmentCleanup !== undefined ? { attachmentCleanup } : {}),
    },
    failures,
  }
}

function landedArchivedEntryIds<A extends ApplyAction>(receipt: Receipt<A>): string[] {
  const ids: string[] = []
  for (const verdict of receipt.verdicts) {
    if (verdict.kind !== 'ok') continue
    const value: unknown = verdict.value
    if (TRASH_ENTRY_ARCHIVED_SCHEMA.check(value) && value.wasArchived) ids.push(value.id)
  }
  return ids
}

/** delete / restore 成功支的条目 id（purge / count 的值跳过）；already-gone 是「同批前一条已带走」的幂等条，不单列。 */
export function landedEntryIds<A extends ApplyAction>(receipt: Receipt<A>): string[] {
  const ids: string[] = []
  for (const verdict of receipt.verdicts) {
    if (verdict.kind === 'ok' && TRASH_ENTRY_ID_SCHEMA.check(verdict.value)) ids.push(verdict.value.id)
  }
  return ids
}

/** restore 回执里真正回盘的会话 id：`ok` 取 `sessionId`，`already-gone` 由调用方按条目查找兜底。 */
export function restoredSessionIds<A extends ApplyAction>(
  receipt: Receipt<A>,
  sessionIdOfEntry?: (entryId: string) => string | undefined,
): string[] {
  const ids: string[] = []
  for (const verdict of receipt.verdicts) {
    if (verdict.kind === 'ok') {
      if (TRASH_ENTRY_SESSION_ID_SCHEMA.check(verdict.value)) ids.push(verdict.value.sessionId)
      continue
    }
    if (verdict.kind === 'already-gone' && sessionIdOfEntry !== undefined) {
      const sessionId = sessionIdOfEntry(verdict.id)
      if (sessionId !== undefined) ids.push(sessionId)
    }
  }
  return ids
}
