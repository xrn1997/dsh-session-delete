/**
 * 会话行的 live 读法（菜单行与两枚勾选框行共用）：root hook 缺席时走恒等兜底，`running` 判 false、`title` 取空串，hook 顺序不变。
 * 读到 false 不等于「没在跑」——Node 半仍会拒绝 live 删除。
 */

/** 宿主 root hook 交回的会话 state（只窄镜像本插件用到的两格）。 */
export interface SessionRowState {
  byId?: Record<string, { running?: boolean; title?: string } | undefined>
}

/** `ui-session` 通过 `ctx.slots.provideRoot({ hooks: { sessions: ctx.sessions.list } })` 提供的根 hook（asar @22967283 原文）。 */
export type UseSessions = <T>(select: (state: SessionRowState | undefined) => T) => T

export interface SessionsStateLike {
  byId?: Record<string, { running?: boolean } | undefined>
}

export function runningOf(state: SessionsStateLike | undefined, sessionId: string): boolean {
  return state?.byId?.[sessionId]?.running === true
}

export const NEVER_SESSIONS: UseSessions = (select) => select({})

export function useSessionLive(useSessions: UseSessions | undefined, sessionId: string): boolean {
  const select = typeof useSessions === 'function' ? useSessions : NEVER_SESSIONS
  return select((state) => runningOf(state, sessionId))
}
