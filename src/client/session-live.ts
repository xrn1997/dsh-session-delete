/**
 * 会话行的 live 读法：菜单行与两枚勾选框行共用这一支。
 *
 * 从 `context-menu-actions.tsx` 分出：那个文件的例外只覆盖**菜单注册**（双轨协商与两个 icon key），
 * 不把勾选行的读法也绑进菜单模块；否则菜单模块会因两类无关原因而变（Divergent Change）。
 *
 * root hook 缺席时走恒等兜底：`running` 判 false、`title` 取空串，hook 顺序不变。
 * 读到 false 不等于「没在跑」；Node 半仍会拒绝 live 删除。
 */

/** 宿主 root hook 交回的会话 state（只窄镜像本插件用到的两格）。 */
export interface SessionRowState {
  byId?: Record<string, { running?: boolean; title?: string } | undefined>
}

/** `ui-session` 通过 `ctx.slots.provideRoot({ hooks: { sessions: ctx.sessions.list } })` 提供的根
 *  hook（asar @22967283 原文）。 */
export type UseSessions = <T>(select: (state: SessionRowState | undefined) => T) => T

/** 菜单贡献的订阅面只读 `running`；与 `SessionRowState` 同源、窄一格。 */
export interface SessionsStateLike {
  byId?: Record<string, { running?: boolean } | undefined>
}

/** 会话是否在跑：state / 条目缺席都按「不知道」判 false（Node 半仍会拒绝 live 删除）。 */
export function runningOf(state: SessionsStateLike | undefined, sessionId: string): boolean {
  return state?.byId?.[sessionId]?.running === true
}

/** 根 hook 缺失时的兜底：对空 state 求值。恒等身份，hook 顺序不变。 */
export const NEVER_SESSIONS: UseSessions = (select) => select({})

/** 槽位行的 live 读法：root hook 缺席走 NEVER_SESSIONS 兜底；菜单行与两枚勾选框行共用这一支。 */
export function useSessionLive(useSessions: UseSessions | undefined, sessionId: string): boolean {
  const select = typeof useSessions === 'function' ? useSessions : NEVER_SESSIONS
  return select((state) => runningOf(state, sessionId))
}
