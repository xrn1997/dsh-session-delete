/**
 * 测试里的 `/apply` **回执构造器**：浏览器半的用例要造"逐条成败"与"一次写入结局"时只走这里，
 * 不再各自拼信封字面量。
 *
 * 为什么收成一个 module：`ApplyOutcome` 是按 `action` + `ok` 双重可判别的联合，每处手写一遍就要把
 * "哪个动作的成功值长什么样"再抄一遍；抄偏了测试仍然是绿的（界面只读它关心的那半句）。收口到这里之后，
 * `ApplyValueByAction` 那张表多一个动作 ⇒ 本文件编译不过，用例跟着红。
 *
 * 两层口径：
 * - `outcomes` 的默认成功值是该动作**中性**的那一支（`delete` / `restore` 的 `null` 是幂等空值，
 *   `count` 的 0、`purge` / `orphan-clean` 的 0 字节）；要"这一条真的落地了"的用例用各动作自己的构造器。
 * - `writeOutcome` / `writeFailed` 造的是 `runWrite` 的两种结局：信封成功但逐条全 missing（空回执），
 *   或顶层失败把同一句原文铺满每个 id。
 *
 * 本 module 只造数据、不碰宿主：`readReceipt` 是浏览器半的纯读法，所以这里也只用它起空回执。
 */
import { readReceipt, summarizeReceipt, type ReceiptRead } from '../../../src/client/receipt.js'
import type { WriteFailure, WriteSuccess } from '../../../src/client/write.js'
import {
  SESSION_DELETE_CODES,
  type ApplyAction,
  type ApplyOutcome,
  type ApplyValueByAction,
  type TrashRowWire,
} from '../../../src/shared/wire.js'

/** 逐条失败的默认原文：批量删除的用例断言的那一句；其余座位给自己的原文覆盖。 */
const DEFAULT_MESSAGE = '会话目录不在盘上'

/** 一个 id 上的成功值或失败原文；`code` 缺省走 `sessiondelete/io`（与 Node 半同一条兜底码）。 */
export type OutcomeOverride<A extends ApplyAction> =
  | { readonly value: ApplyValueByAction[A] }
  | { readonly message: string; readonly code?: string }

/** 各动作**中性**的成功支：没有落地证据时能表达的最弱成功。
 *  `ApplyValueByAction` 在这里是闸：表里多一个动作而这里没补，编译不过。 */
const NEUTRAL_VALUE: ApplyValueByAction = {
  delete: null,
  restore: null,
  purge: { removed: 0, freedBytes: 0 },
  count: 0,
  'orphan-clean': { removed: 0, freedBytes: 0 },
}

/** 一条成功的逐条回执（`ok` 支）。`ApplyOutcome` 的判别联合只在这一处与 `failed` 里各断言一次。 */
export function ok<A extends ApplyAction>(action: A, id: string, value: ApplyValueByAction[A]): ApplyOutcome {
  return { id, action, ok: true, value } as ApplyOutcome
}

/** 一条失败的逐条回执（`error` 支）；`code` 缺省是兜底码 `sessiondelete/io`。 */
export function failed<A extends ApplyAction>(
  action: A, id: string, message: string, code: string = SESSION_DELETE_CODES.io,
): ApplyOutcome {
  return { id, action, ok: false, error: { code, message } } as ApplyOutcome
}

/** 一组 id 上的逐条回执：`overrides` 按 id 换成成功值或失败原文，缺席走该动作的中性值。 */
export function outcomes<A extends ApplyAction>(
  action: A,
  ids: readonly string[],
  overrides: Readonly<Record<string, OutcomeOverride<A>>> = {},
): ApplyOutcome[] {
  return ids.map((id) => {
    const override: OutcomeOverride<A> | undefined = overrides[id]
    if (override === undefined) return ok(action, id, NEUTRAL_VALUE[action])
    if ('message' in override) return failed(action, id, override.message, override.code)
    return ok(action, id, override.value)
  })
}

/** `count` 的逐条回执：`kids[id]` 有数就给那个数，没有就是 0。
 *  "读不到"由调用方判（那半句整句不出现），不在这里冒充成 0。 */
export function countOutcomes(ids: readonly string[], kids: Readonly<Record<string, number>> = {}): ApplyOutcome[] {
  return ids.map((id) => ok('count', id, kids[id] ?? 0))
}

/** 一条回收站行的缺省：`entryId` 是条目 id、`sessionId` 是会话 id，其余取最安静的值
 *  （回执判读只认这两格：撤销名单取 `value.id`，恢复取 `value.sessionId`）。
 *  带着 `releaseBytes` ⇒ 同一个值既是 `/apply` 成功支里的那一行（`TrashEntryWire`），
 *  也是面板清单里的那一行（`TrashEntryLike`），用例不必再造一份带 `as never` 的窄夹具。 */
export function trashRow(entryId: string, sessionId: string): TrashRowWire {
  return {
    id: entryId, sessionId, projectDir: '--p--', workspaceId: 'ws',
    wasArchived: false, deletedAt: 0, title: entryId, sizeBytes: 0, releaseBytes: 0,
  }
}

/** 逐条删除：`failIds` 里的 id 落失败原文，其余给一行**已进回收站**的条目（条目 id 是 `entry-<id>`）。 */
export function deleteOutcomes(
  ids: readonly string[], failIds: readonly string[] = [], message: string = DEFAULT_MESSAGE,
): ApplyOutcome[] {
  return ids.map((id) => failIds.includes(id)
    ? failed('delete', id, message)
    : ok('delete', id, trashRow(`entry-${id}`, id)))
}

/** 逐条恢复：`failIds` 里的 id 落失败原文，其余给一行**回到清册**的条目（会话 id 是 `session-<id>`）。
 *  单条恢复也用它——N=1 的 `null` 是协议错（`src/client/receipt.ts` 的读法），成功支必须是一行。 */
export function restoreOutcomes(
  ids: readonly string[], failIds: readonly string[] = [], message: string = DEFAULT_MESSAGE,
): ApplyOutcome[] {
  return ids.map((id) => failIds.includes(id)
    ? failed('restore', id, message)
    : ok('restore', id, trashRow(id, `session-${id}`)))
}

/** 逐条彻底删除：`failIds` 里的 id 落失败原文，其余给"这一组带走了一条"的聚合回执。 */
export function purgeOutcomes(
  ids: readonly string[], failIds: readonly string[] = [], message: string = DEFAULT_MESSAGE,
): ApplyOutcome[] {
  return ids.map((id) => failIds.includes(id)
    ? failed('purge', id, message)
    : ok('purge', id, { removed: 1, freedBytes: 1 }))
}

/** `runWrite` 的**信封成功**那一支：回执照 `readReceipt` 的读法起（空 outcomes ⇒ 逐条 missing），
 *  失败表就是那一份 missing 原文、成功名单为空；查询编排只认动作与 id，逐条判读另有用例。
 *  `over` 覆盖这一层的判据。返回值收在成功支（`WriteSuccess` 可当 `WriteOutcome` 用，失败支由 `writeFailed` 造）。 */
function summarizeOutcomes<A extends ApplyAction>(action: A, ids: readonly string[]): ReceiptRead {
  return summarizeReceipt(readReceipt(action, ids, []))
}

export function writeOutcome<A extends ApplyAction>(
  action: A, ids: readonly string[], over: Partial<WriteSuccess<A>> = {},
): WriteSuccess<A> {
  const read = summarizeOutcomes(action, ids)
  const success: WriteSuccess<A> = {
    ok: true,
    action,
    ids,
    summary: read.summary,
    failures: read.failures,
    ...over,
  }
  return success
}

/** `runWrite` 的**顶层失败**那一支：同一句原文铺到每个请求 id（与 `runWrite` 自己造的一致）。 */
export function writeFailed<A extends ApplyAction>(
  action: A, ids: readonly string[], message: string,
): WriteFailure<A> {
  return {
    ok: false,
    action,
    ids,
    failure: { code: SESSION_DELETE_CODES.io, message },
    failures: new Map(ids.map((id) => [id, message] as const)),
  }
}
