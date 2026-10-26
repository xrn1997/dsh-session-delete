/**
 * 在场能力：动词只拿到「成员离场 / 归位 / 一批归位」三条，不再拿到宿主的 `evictLive` / `announce*`。
 *
 * 生产实现住 `src/verbs/member-presence.ts`；组合根装配一次，挂在 `CoreDeps.presence`。这样
 * “谁可以摘活体、谁可以发通告”由依赖面回答，而不是靠源码扫描维持。
 */
export interface MemberBackFacts {
  readonly diskBack: boolean
  readonly workspaceBack: boolean
}

export interface PresenceCapability {
  /** 成员已经不在宿主可见列表：摘活体；三态不是 unknown 时发 removed。
   *  `backInTrash: false` 表示目录没退回回收站（恢复回滚失败），此时什么都不做。 */
  memberGone(sessionId: string, facts?: { readonly backInTrash?: boolean }): Promise<void>
  /** 成员已经回到原来的可见状态：目录与账本两件写都回去才发 added。 */
  memberBack(sessionId: string, facts: MemberBackFacts): Promise<void>
  /** 批量恢复的「回来了」通告；单条就是长度为 1 的批。 */
  announceRestored(ids: readonly string[]): Promise<void>
}
