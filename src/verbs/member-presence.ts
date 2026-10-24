/**
 * 成员离场 / 归位的通告协议：摘活体、三态判断、成对事件只在这里做。
 *
 * 为什么要有它：delete（成功与回滚）/ restore 回滚 / purge（两个分支）/ orphan-clean
 * 六处调用曾经各写一遍
 * `evictLive → !== 'unknown' → announceRemoved`；删除回滚还要自己拼目录与账本两个布尔
 * 才发 `announceRestored`。
 * 这条协议说错一次就是客户端留着假行、或删掉真行，所以只留一个家。
 *
 * 边界：
 * - 批量恢复自己发起的那次通告（`announceRestored(ids)`）归 `verbs/batch.ts`（ADR-0002）：同一个方法、
 *   同一份预取，只是调用方是那一批的主人。这里只判单成员事实。
 * - 本模块不决定哪个键算归位：动词在 `tail.onUndone` 里把 `restored(key)` 读成事实再交进来，真值表住这里；
 *   `run` / `undo` 之后补一条通告的**形状**由 {@link withPresenceTail} 拥有。
 * - 本模块用到的三条（`evictLive` / `announceRemoved` / `announceRestored`）按契约不抛（evictLive 三态、
 *   announce* 内部吞异常），这里不再叠 catch。
 */
import type { EvictionOutcome, HostPresencePort } from '../ports/host-port.js'
import type { Journal, JournalUndo } from './member-journal.js'

/** 本模块实际用到的三条宿主能力。`Pick` 此刻覆盖 `HostPresencePort` 的三条方法，仍留着它当闸：
 *  将来端口多出第四条时，这里不会被动跟着变宽——这里是单成员协议，批量恢复由 `verbs/batch.ts`
 *  自己发起，不该因为共用同一颗 adapter 就在类型上声明依赖。 */
export type MemberPresenceHost = Pick<HostPresencePort, 'evictLive' | 'announceRemoved' | 'announceRestored'>

export interface MemberBackFacts {
  /** 目录搬回原处了吗。 */
  readonly diskBack: boolean
  /** 账本挂回去了吗（本来没有账目时算 true）。 */
  readonly workspaceBack: boolean
}

export interface MemberPresence {
  /** 成员已经不在宿主可见列表：摘活体；三态不是 unknown 时发 removed。
   *  `backInTrash: false` 表示目录没退回回收站（恢复回滚失败），此时什么都不做。 */
  memberGone(sessionId: string, facts?: { readonly backInTrash?: boolean }): Promise<void>
  /** 成员已经回到原来的可见状态：目录与账本两件写都回去才发 added。 */
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
      if (!facts.diskBack || !facts.workspaceBack) return
      await host.announceRestored([sessionId])
    },
  }
}

/** 一次 undo 之后要发哪一条通告：`leave` = 成员已不在可见面，`return` = 已回到原可见状态。 */
export type PresenceAnnounce =
  | { readonly kind: 'leave'; readonly backInTrash: boolean }
  | { readonly kind: 'return'; readonly diskBack: boolean; readonly workspaceBack: boolean }

/** 动词给工厂的那一格：哪个成员、run 成不成功要不要补离场、undo 之后按逐步结果发哪一条。 */
export interface PresenceTail {
  readonly sessionId: string
  /** `run()` 成功后补离场通告（删除用）。省略 = run 不动在场（恢复的 run 本来就不该发东西）。 */
  readonly onDone?: 'leave'
  /** `undo()` 完成后按逐步结果发通告。 */
  onUndone(undo: JournalUndo): PresenceAnnounce
}

/**
 * 给一次成员移动的 journal 补上「在场那条尾巴」：run 完全成功之后离场、undo 之后按事实归位或离场。
 *
 * 为什么是个工厂：删除与恢复此前各手拼一个匿名 journal，形状逐字相同（`journal.run` 加上
 * `presence.memberGone`／`journal.undo` 加上 `presence.memberBack`），只差键 → 事实的映射。
 * 两处各写一遍，就是「补在哪一拍」这条顺序又有第二个家。
 *
 * 边界：`memberGone` 的 `backInTrash:false` 早退与 `memberBack` 的两件齐备真值表仍归 `createMemberPresence`；
 * 这里只把事实原样递过去，不替它判断。
 */
export function withPresenceTail(presence: MemberPresence, journal: Journal, tail: PresenceTail): Journal {
  const announce = async (undo: JournalUndo): Promise<void> => {
    const fact = tail.onUndone(undo)
    if (fact.kind === 'leave') {
      await presence.memberGone(tail.sessionId, { backInTrash: fact.backInTrash })
      return
    }
    await presence.memberBack(tail.sessionId, { diskBack: fact.diskBack, workspaceBack: fact.workspaceBack })
  }
  return {
    async run(): Promise<void> {
      await journal.run()
      if (tail.onDone === 'leave') await presence.memberGone(tail.sessionId)
    },
    async undo(): Promise<JournalUndo> {
      const undo = await journal.undo()
      await announce(undo)
      return undo
    },
  }
}
