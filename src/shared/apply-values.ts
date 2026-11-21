/**
 * `/apply` 成功值的**唯一声明**：清册行、聚合回执、数字三族形状各一枚 schema。
 * **值形状只声明一次、guard 由 schema 派生**：`wire.ts` 的类型与 `WIRE_VALUE_GUARDS.apply` 都从这里来。
 */
import { boolean, finiteNumber, nullable, object, optional, pick, string, type ValueSchema } from './value-schema.js'
import type { ApplyAction } from './wire.js'

/** 清册行的线上形状：`/list`、详情子会话段与 `delete` / `restore` 成功值共用这一份身份格。
 *  线上只发这里列的东西；落地形状另有运行期必填清单（见 `entry.ts`）。 */
export const TRASH_ENTRY_SCHEMA = object({
  id: string(),
  sessionId: string(),
  projectDir: string(),
  workspaceId: string(),
  wasArchived: boolean(),
  deletedAt: finiteNumber(),
  title: string(),
  sizeBytes: finiteNumber(),
  /** 跟着父一起进回收站的子会话 ⇒ 父那一行的条目 id；缺席 = 父行或单独删除。 */
  parentEntryId: optional(string()),
  /** 子会话显示名（ADR-0058）；只在详情 `subagents` 行过线，缺席 = 界面回落 `title`。 */
  label: optional(string()),
})

/** 附件清理读数：`skipped` 有值 = 部分或整体没清，`removed` 仍可能 > 0（跳过不是失败）。 */
export const ATTACHMENT_CLEANUP_SCHEMA = object({
  removed: finiteNumber(),
  freedBytes: finiteNumber(),
  failed: finiteNumber(),
  skipped: optional(string()),
})

/** 清空 / 彻底删除 / 孤儿清理的聚合回执；`attachments` 缺席 = 没有附件清理读数（不拿零冒充）。 */
export const PURGE_STATS_SCHEMA = object({
  removed: finiteNumber(),
  freedBytes: finiteNumber(),
  attachments: optional(ATTACHMENT_CLEANUP_SCHEMA),
})

/** 清册行或 `null`：`null` = 这一条已被同批前一条带走（幂等 no-op），只有 delete / restore。 */
export const TRASH_ENTRY_OR_NULL_SCHEMA = nullable(TRASH_ENTRY_SCHEMA)

/** 一个数（count / unarchive；两个数的语义各归各的动词）。 */
export const NUMBER_SCHEMA = finiteNumber()

/** 回执的窄读：只校要读的那几格，字段名与种类由 schema 派生。 */
export const TRASH_ENTRY_ID_SCHEMA = pick(TRASH_ENTRY_SCHEMA, 'id')
export const TRASH_ENTRY_SESSION_ID_SCHEMA = pick(TRASH_ENTRY_SCHEMA, 'sessionId')
export const TRASH_ENTRY_ARCHIVED_SCHEMA = pick(TRASH_ENTRY_SCHEMA, 'id', 'wasArchived')
export const PURGE_STATS_ATTACHMENTS_SCHEMA = pick(PURGE_STATS_SCHEMA, 'attachments')

/** 六个动作的成功值：delete / restore 是清册行或 null，purge / orphan-clean 是聚合回执，
 *  count / unarchive 是一个数。**动作 → 值形状的唯一一份**（`satisfies` 是编译闸）。 */
export const APPLY_VALUE_SCHEMAS = {
  delete: TRASH_ENTRY_OR_NULL_SCHEMA,
  restore: TRASH_ENTRY_OR_NULL_SCHEMA,
  purge: PURGE_STATS_SCHEMA,
  count: NUMBER_SCHEMA,
  'orphan-clean': PURGE_STATS_SCHEMA,
  unarchive: NUMBER_SCHEMA,
} satisfies Record<ApplyAction, ValueSchema<unknown>>
