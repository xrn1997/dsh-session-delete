/**
 * 子会话摘要的**三条判据**（回收站详情与归档详情共用一份）：条数闸、超闸才报总数、合计覆盖全部孩子。
 *
 * 为什么单独一个纯 module：两条读路的数据源与行显示模型都不同（回收站是清册行 `TrashEntryWire`，
 * 归档是宿主闭包 + `session-rows` 的 `ArchiveSubagentWire`），但「列多少条、总数什么时候说、
 * 合计按谁算」是同一组口径（ADR-0055；归档侧读面见 ADR-0064）。两处各写一遍时，
 * 改上限或改「合计是否含显示外孩子」要双改、也各自钉一份同样语义的用例。
 *
 * 本文件零 import、不碰盘 / 端口：输入是孩子总数、条数闸与全量大小的合计 / 缺席计数，
 * 输出是显示条数、总数是否出线与合计是否出线。行的投影不在这里。
 */

/** 子会话摘要最多列多少条（缺省值）：超出时只过线前 N 条，总数另走 `total`。 */
export const SUBAGENT_SUMMARY_LIMIT = 200

/** 一次摘要要显示多少条孩子：`min(孩子总数, 条数闸)`；闸缺省取 {@link SUBAGENT_SUMMARY_LIMIT}。
 *  负数闸按 0 处理（"一条都不显示"）；调用方必须用这个数去切片，别自己再算一遍。 */
export function displayedSubagentCount(count: number, limit?: number): number {
  const gate = limit ?? SUBAGENT_SUMMARY_LIMIT
  return Math.max(0, Math.min(count, gate))
}

/** 全量孩子的大小合计与缺席计数：合计**覆盖全部孩子**，不是已列前 N 条的和。 */
export interface SubagentSizes {
  /** 已知大小之和。 */
  readonly sum: number
  /** 缺大小的孩子条数（大小读面缺席 / 单条没有可信读数）。 */
  readonly missing: number
}

export interface SubagentSummaryInput {
  /** 孩子的**总数**（不是显示条数）。 */
  readonly count: number
  /** 条数闸；缺省取 {@link SUBAGENT_SUMMARY_LIMIT}。 */
  readonly limit?: number | undefined
  readonly sizes: SubagentSizes
}

export interface SubagentSummary {
  /** 这次要装配 / 显示的孩子条数；调用方用它切片。 */
  readonly displayed: number
  /** 超闸时的孩子总数；**没超闸不落键**（`0` 与「没有这一格」是两件事）。 */
  readonly total?: number
  /** 全部孩子的已知大小合计（不是显示行的和）。 */
  readonly sizeBytes: number
  /** 合计这一格出不出线：全部孩子都缺大小时不出（归档档据此不落键；0 条孩子也照此不出）。
   *  回收站档的清册大小每条都有（`missing` 恒 0），所以这一格在那条路上只是数据契约的兜底。 */
  readonly sizeBytesIncluded: boolean
}

/**
 * 摘要的三条判据一次算完：`displayed` / `total`（仅超闸）/ `sizeBytes` 与 `sizeBytesIncluded`。
 * 纯函数：同样的输入永远同样的输出，调用方只交数据源。
 */
export function summarizeSubagents(input: SubagentSummaryInput): SubagentSummary {
  const gate = input.limit ?? SUBAGENT_SUMMARY_LIMIT
  return {
    displayed: displayedSubagentCount(input.count, gate),
    ...(input.count > gate ? { total: input.count } : {}),
    sizeBytes: input.sizes.sum,
    // 全部孩子都缺大小 ⇒ 合计是"0 个已知"而不是"0 字节"，不出线；部分缺时出线并只加已知的那几条。
    sizeBytesIncluded: input.sizes.missing < input.count,
  }
}
