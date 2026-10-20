/**
 * 成员离场 / 归位的通告协议：摘活体、三态判断、成对事件只在这里做。
 *
 * 为什么要有它：delete（成功与回滚）/ restore 回滚 / purge（两个分支）/ orphan-clean
 * 六处调用曾经各写一遍
 * `evictLive → !== 'unknown' → announceRemoved`；删除回滚还要自己拼
 * `movedBack && workspaceBack && visibleBack` 才发 `announceRestored`。
 * 这条协议说错一次就是客户端留着假行、或删掉真行，所以只留一个家。
 *
 * 边界：
 * - 批量恢复的 `announceRestoredBatch` 不进来：一次预取、一批一次通告归 `verbs/batch.ts`（ADR-0002）。
 * - 不读 journal 的失败串：调用方交事实（目录 / 账本 / 可见性是否回去），真值表住这里。
 * - 本模块用到的三条（`evictLive` / `announceRemoved` / `announceRestored`）按契约不抛（evictLive 三态、
 *   announce* 内部吞异常），这里不再叠 catch。
 */
import type { EvictionOutcome, HostPresencePort } from '../ports/host-port.js'

/** 本模块实际用到的三条宿主能力。取窄面而不是整个 `HostPresencePort`：那条协议里还有批量通告与
 *  摘要预取，它们各有自己的家（`verbs/batch.ts`），这里不该因为共用同一颗 adapter 就声明依赖。 */
export type MemberPresenceHost = Pick<HostPresencePort, 'evictLive' | 'announceRemoved' | 'announceRestored'>

export interface MemberBackFacts {
  /** 目录搬回原处了吗。 */
  readonly diskBack: boolean
  /** 账本挂回去了吗（本来没有账目时算 true）。 */
  readonly workspaceBack: boolean
  /** 可见性还原了吗（本来已归档时算 true）。 */
  readonly visibleBack: boolean
}

export interface MemberPresence {
  /** 成员已经不在宿主可见列表：摘活体；三态不是 unknown 时发 removed。
   *  `backInTrash: false` 表示目录没退回回收站（恢复回滚失败），此时什么都不做。 */
  memberGone(sessionId: string, facts?: { readonly backInTrash?: boolean }): Promise<void>
  /** 成员已经回到原来的可见状态：三件写都回去才发 added。 */
  memberBack(sessionId: string, facts: MemberBackFacts): Promise<void>
}

export function createMemberPresence(host: MemberPresenceHost): MemberPresence {
  return {
    async memberGone(sessionId, facts = {}) {
      if (facts.backInTrash === false) return
      const eviction: EvictionOutcome = await host.evictLive(sessionId)
      if (eviction !== 'unknown') await host.announceRemoved(sessionId)
    },
    async memberBack(sessionId, facts) {
      if (!facts.diskBack || !facts.workspaceBack || !facts.visibleBack) return
      await host.announceRestored(sessionId)
    },
  }
}
