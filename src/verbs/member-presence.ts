/**
 * 成员离场 / 归位的通告协议：摘活体、三态判断、成对事件只在这里做；协议说错一次就是客户端留假行或删真行。
 * 批量恢复的编排归 `verbs/batch.ts`（ADR-0002）；哪个键算归位由动词在 `tail.onUndone` 里读成事实再交进来（ADR-0019）。
 * `evictLive`/`announce*` 按宿主契约不抛，这里不再叠 catch。
 */
import type { EvictionOutcome, HostPresencePort } from '../ports/host-port.js'
import type { PresenceCapability } from '../ports/presence-port.js'
import type { Journal, JournalUndo } from './member-journal.js'

/** 本模块实际用到的三条宿主能力；`Pick` 是闸：端口多出第四条时这里不会被动跟着变宽。 */
export type MemberPresenceHost = Pick<HostPresencePort, 'evictLive' | 'announceRemoved' | 'announceRestored'>

/** 本仓**唯一**盖 `PresenceCapability` 品牌的地方：品牌是类型层的（unique symbol 不导出），手拼同样三件满足不了那个面
 *  （`tests/deps.test.ts` 钉住）；`announceRestored` 直接交宿主那一手，不再包转调。 */
export function createMemberPresence(host: MemberPresenceHost): PresenceCapability {
  const impl: Pick<PresenceCapability, 'memberGone' | 'memberBack' | 'announceRestored'> = {
    async memberGone(sessionId, facts = { backInTrash: true }) {
      if (!facts.backInTrash) return
      const eviction: EvictionOutcome = await host.evictLive(sessionId)
      if (eviction !== 'unknown') await host.announceRemoved(sessionId)
    },
    async memberBack(sessionId, facts) {
      if (!facts.diskBack || !facts.workspaceBack) return
      await host.announceRestored([sessionId])
    },
    announceRestored: host.announceRestored,
  }
  // 盖章：三条方法先按结构类型（`Pick<PresenceCapability, …>`）逐字校验，`as` 只补品牌这一格。
  return impl as PresenceCapability
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
 * 给一次成员移动的 journal 补上「在场那条尾巴」：run 完全成功之后离场，undo 之后按事实归位或离场。
 * `memberGone` 的早退与 `memberBack` 的两件齐备真值表归 `createMemberPresence`；这里只把事实原样递过去。
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
