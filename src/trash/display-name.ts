/**
 * 回收站条目的**自己的显示名**：从被删会话自己的日志里折出，供没有父详情可兜的条目
 * （独立子会话、旧判据折进来的 fork 孩子）与父详情里没有 catalog 登记的 fork 孩子使用。
 *
 * 为什么不是 `titleOf` 的抄本：`titleOf` 读的是宿主投影缓存（删除那一刻的显示名），
 * 这里是**已经进了回收站的日志**——清册标题已经起错、父日志又没有 catalog 时，它是唯一还能
 * 读到的工作中名字。两份来源不同，判据各自住一处（ADR-0058）。
 */
import { walkSessionLog } from '../log/session-log.js'

/** `subagent/descriptor` 的 label；空/缺席 = 这条 descriptor 没有名字（one-shot 可以不给）。 */
export function descriptorLabelOf(data: Record<string, unknown>): string {
  return typeof data.label === 'string' ? data.label : ''
}

export interface LogDisplayName {
  /** 最后一条 descriptor 的 label；空串 = 没有。 */
  readonly label: string
  /** 最后一条 `session/title`；空串 = 没有。 */
  readonly title: string
}

/**
 * 走一遍日志，折出**这条会话自己**的 descriptor label 与最后一条日志标题。
 *
 * 折叠语义与宿主 `subagent` 投影一致：每遇一条 descriptor 就覆盖（空 label 也覆盖），
 * 所以 fork 种子里祖先的 descriptor 会被子会话自己的那条盖掉。日志标题取**最后一条**：
 * 它是会话改名 / 兜底标题之后的当前值。
 */
export function displayNameOfLog(raw: Buffer): LogDisplayName {
  let label = ''
  let title = ''
  walkSessionLog(raw, (record) => {
    if (record.type === 'subagent/descriptor') {
      label = descriptorLabelOf((record.data ?? {}) as Record<string, unknown>)
      return
    }
    if (record.type === 'session/title') {
      const data = (record.data ?? {}) as Record<string, unknown>
      if (typeof data.title === 'string') title = data.title
    }
  })
  return { label, title }
}
