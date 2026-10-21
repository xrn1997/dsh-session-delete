import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientContextLike } from '../../src/client/context.js'
import { bindMainView, closeMainIfDeleted, openMainWhenListed, resetMainView } from '../../src/client/main-view.js'

/** 只给 `get('uiWorkspace')` 的窄 ctx（`slots` 在这一层用不到）。 */
function ctxWith(ui: unknown): ClientContextLike {
  return {
    slots: {} as never,
    get: (name: string) => (name === 'uiWorkspace' ? ui : undefined),
  } as unknown as ClientContextLike
}

function uiWith(over: {
  sessionId?: string
  byId?: Record<string, unknown>
  clearMain?: () => void
  openSession?: (id: string) => void
} = {}) {
  return {
    selection: { getSnapshot: () => ({ ...(over.sessionId === undefined ? {} : { sessionId: over.sessionId }) }) },
    sessions: { list: { getSnapshot: () => ({ byId: over.byId ?? {} }) } },
    clearMain: over.clearMain ?? (() => {}),
    openSession: over.openSession ?? (() => {}),
  }
}

beforeEach(() => resetMainView())
afterEach(() => resetMainView())

describe('主视图的删除/恢复收尾', () => {
  it('删的是当前会话 ⇒ 关掉主视图并交回会话 id', () => {
    const clearMain = vi.fn()
    bindMainView(ctxWith(uiWith({ sessionId: 'session-a', clearMain })))
    expect(closeMainIfDeleted(['session-a'])).toBe('session-a')
    expect(clearMain).toHaveBeenCalledTimes(1)
  })

  it('删的不是当前会话 / 空名单 ⇒ 不碰主视图', () => {
    const clearMain = vi.fn()
    bindMainView(ctxWith(uiWith({ sessionId: 'session-a', clearMain })))
    expect(closeMainIfDeleted(['session-b'])).toBeUndefined()
    expect(closeMainIfDeleted([])).toBeUndefined()
    expect(clearMain).not.toHaveBeenCalled()
  })

  it('uiWorkspace 缺席 / 形状不符 / get 抛错 ⇒ 安静退回，不抛', () => {
    bindMainView(ctxWith(undefined))
    expect(closeMainIfDeleted(['session-a'])).toBeUndefined()

    bindMainView(ctxWith({ selection: { getSnapshot: () => ({ sessionId: 'session-a' }) } }))
    expect(closeMainIfDeleted(['session-a'])).toBeUndefined()

    bindMainView({
      slots: {} as never,
      get: () => { throw new Error('service boom') },
    } as unknown as ClientContextLike)
    expect(closeMainIfDeleted(['session-a'])).toBeUndefined()
  })

  it('撤销恢复后重开：清单已有摘要时立刻开', () => {
    const openSession = vi.fn()
    bindMainView(ctxWith(uiWith({ byId: { 'session-a': {} }, openSession })))
    openMainWhenListed('session-a')
    expect(openSession).toHaveBeenCalledWith('session-a')
  })

  it('撤销恢复后重开：摘要晚一拍才到 ⇒ 等它出现再开', () => {
    vi.useFakeTimers()
    try {
      const openSession = vi.fn()
      let byId: Record<string, unknown> = {}
      bindMainView(ctxWith({
        selection: { getSnapshot: () => ({}) },
        sessions: { list: { getSnapshot: () => ({ byId }) } },
        clearMain: () => {},
        openSession,
      }))
      openMainWhenListed('session-a')
      expect(openSession).not.toHaveBeenCalled()
      byId = { 'session-a': {} }
      vi.advanceTimersByTime(150)
      expect(openSession).toHaveBeenCalledWith('session-a')
    } finally {
      vi.useRealTimers()
    }
  })

  it('等摘要期间用户选了别的会话 ⇒ 不抢焦点；服务抛错也不外溢', () => {
    const openSession = vi.fn()
    bindMainView(ctxWith({
      selection: { getSnapshot: () => ({ sessionId: 'session-b' }) },
      sessions: { list: { getSnapshot: () => ({ byId: { 'session-a': {} } }) } },
      clearMain: () => {},
      openSession,
    }))
    openMainWhenListed('session-a')
    expect(openSession).not.toHaveBeenCalled()

    bindMainView(ctxWith({
      selection: { getSnapshot: () => ({}) },
      sessions: { list: { getSnapshot: () => ({ byId: { 'session-a': {} } }) } },
      clearMain: () => {},
      openSession: () => { throw new Error('open boom') },
    }))
    expect(() => openMainWhenListed('session-a')).not.toThrow()
  })
})
