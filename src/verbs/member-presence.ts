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
 * - 批量恢复的编排（攒 id、批尾一次发）归 `verbs/batch.ts`（ADR-0002）；它经同一份能力面调
 *   `announceRestored(ids)`，本模块只实现这条批量通告（ADR-0019）。
 * - 本模块不决定哪个键算归位：动词在 `tail.onUndone` 里把 `restored(key)` 读成事实再交进来，真值表住这里；
 *   `run` / `undo` 之后补一条通告的**形状**由 {@link withPresenceTail} 拥有。
 * - 本模块用到的三条（`evictLive` / `announceRemoved` / `announceRestored`）按契约不抛（evictLive 三态、
 *   announce* 内部吞异常），这里不再叠 catch。
 */
import type { EvictionOutcome, HostPresencePort } from '../ports/host-port.js'
import type { PresenceCapability } from '../ports/presence-port.js'
import type { Journal, JournalUndo } from './member-journal.js'

/** 本模块实际用到的三条宿主能力。`Pick` 此刻覆盖 `HostPresencePort` 的三条方法，仍留着它当闸：
 *  将来端口多出第四条时，这里不会被动跟着变宽——能力面只暴露这三条，批量通告的编排归 `verbs/batch.ts`。 */
export type MemberPresenceHost = Pick<HostPresencePort, 'evictLive' | 'announceRemoved' | 'announceRestored'>

/** 本仓的在场能力实现：端口形状住 `src/ports/presence-port.ts`，这里只做三态与真值表。
 *  `announceRestored` 直接交宿主那一手：能力面与宿主面同名同签名，再包一层只会多一个转调。 */
export function createMemberPresence(host: MemberPresenceHost): PresenceCapability {
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
    announceRestored: host.announceRestored,
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
export function withPresenceTail(presence: PresenceCapability, journal: Journal, tail: PresenceTail): Journal {
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
