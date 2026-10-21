import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientContextLike } from '../../src/client/context.js'
import { afterDelete, afterRestore, bindMainView, resetMainView } from '../../src/client/main-view.js'

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

describe('删除/恢复时主视图的收尾', () => {
  it('afterDelete 关掉当前会话并记住它；afterRestore 重开它', () => {
    const clearMain = vi.fn()
    const openSession = vi.fn()
    bindMainView(ctxWith(uiWith({ sessionId: 'session-a', byId: { 'session-a': {} }, clearMain, openSession })))
    afterDelete(['session-a'])
    expect(clearMain).toHaveBeenCalledTimes(1)
    afterRestore(['session-a'])
    expect(openSession).toHaveBeenCalledWith('session-a')
  })

  it('afterRestore 一个不是自己关掉的会话：不重开', () => {
    const openSession = vi.fn()
    bindMainView(ctxWith(uiWith({ sessionId: 'session-a', byId: { 'session-a': {} }, openSession })))
    afterRestore(['session-a'])
    expect(openSession).not.toHaveBeenCalled()
  })

  it('删的不是当前会话 / 空名单 ⇒ 不碰主视图，也不留重开记忆', () => {
    const clearMain = vi.fn()
    const openSession = vi.fn()
    bindMainView(ctxWith(uiWith({ sessionId: 'session-a', byId: { 'session-a': {} }, clearMain, openSession })))
    afterDelete(['session-b'])
    afterDelete([])
    expect(clearMain).not.toHaveBeenCalled()
    // 没关过就没有"重开"这回事：恢复这两个会话都不该动主视图。
    afterRestore(['session-a', 'session-b'])
    expect(openSession).not.toHaveBeenCalled()
  })

  it('第二次重开取消第一次的等待：只开最新那条', () => {
    vi.useFakeTimers()
    try {
      let selected: { sessionId?: string } = { sessionId: 'session-a' }
      let byId: Record<string, unknown> = {}
      const openSession = vi.fn()
      bindMainView(ctxWith({
        selection: { getSnapshot: () => selected },
        sessions: { list: { getSnapshot: () => ({ byId }) } },
        clearMain: () => { selected = {} },
        openSession,
      }))
      afterDelete(['session-a'])
      selected = { sessionId: 'session-b' }
      afterDelete(['session-b'])
      selected = {}
      afterRestore(['session-a'])
      afterRestore(['session-b'])
      byId = { 'session-a': {}, 'session-b': {} }
      vi.advanceTimersByTime(150)
      expect(openSession).toHaveBeenCalledTimes(1)
      expect(openSession).toHaveBeenCalledWith('session-b')
    } finally {
      vi.useRealTimers()
    }
  })

  it('新的删除取消旧的重开等待：删的不是当前会话也一样', () => {
    vi.useFakeTimers()
    try {
      let selected: { sessionId?: string } = { sessionId: 'session-a' }
      let byId: Record<string, unknown> = {}
      const openSession = vi.fn()
      bindMainView(ctxWith({
        selection: { getSnapshot: () => selected },
        sessions: { list: { getSnapshot: () => ({ byId }) } },
        clearMain: () => { selected = {} },
        openSession,
      }))
      afterDelete(['session-a'])
      afterRestore(['session-a'])
      afterDelete(['session-b'])
      byId = { 'session-a': {} }
      vi.advanceTimersByTime(150)
      expect(openSession).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('新的恢复取消旧的重开等待：恢复一个没关过的会话也一样', () => {
    vi.useFakeTimers()
    try {
      let selected: { sessionId?: string } = { sessionId: 'session-a' }
      let byId: Record<string, unknown> = {}
      const openSession = vi.fn()
      bindMainView(ctxWith({
        selection: { getSnapshot: () => selected },
        sessions: { list: { getSnapshot: () => ({ byId }) } },
        clearMain: () => { selected = {} },
        openSession,
      }))
      afterDelete(['session-a'])
      afterRestore(['session-a'])
      afterRestore(['session-c'])
      byId = { 'session-a': {}, 'session-c': {} }
      vi.advanceTimersByTime(150)
      expect(openSession).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('空名单不打断旧的重开等待：整批失败没有真正删除', () => {
    vi.useFakeTimers()
    try {
      let selected: { sessionId?: string } = { sessionId: 'session-a' }
      let byId: Record<string, unknown> = {}
      const openSession = vi.fn()
      bindMainView(ctxWith({
        selection: { getSnapshot: () => selected },
        sessions: { list: { getSnapshot: () => ({ byId }) } },
        clearMain: () => { selected = {} },
        openSession,
      }))
      afterDelete(['session-a'])
      afterRestore(['session-a'])
      afterDelete([])
      byId = { 'session-a': {} }
      vi.advanceTimersByTime(150)
      expect(openSession).toHaveBeenCalledWith('session-a')
    } finally {
      vi.useRealTimers()
    }
  })

  it('摘要晚一拍才落地 ⇒ 等它出现再开', () => {
    vi.useFakeTimers()
    try {
      const openSession = vi.fn()
      let selected: { sessionId?: string } = { sessionId: 'session-a' }
      let byId: Record<string, unknown> = {}
      bindMainView(ctxWith({
        selection: { getSnapshot: () => selected },
        sessions: { list: { getSnapshot: () => ({ byId }) } },
        clearMain: () => { selected = {} },
        openSession,
      }))
      afterDelete(['session-a'])
      afterRestore(['session-a'])
      vi.advanceTimersByTime(50)
      expect(openSession).not.toHaveBeenCalled()
      byId = { 'session-a': {} }
      vi.advanceTimersByTime(100)
      expect(openSession).toHaveBeenCalledWith('session-a')
    } finally {
      vi.useRealTimers()
    }
  })

  it('等摘要期间用户选了别的会话 ⇒ 不抢焦点', () => {
    const openSession = vi.fn()
    let selected: { sessionId?: string } = { sessionId: 'session-a' }
    bindMainView(ctxWith({
      selection: { getSnapshot: () => selected },
      sessions: { list: { getSnapshot: () => ({ byId: { 'session-a': {} } }) } },
      clearMain: () => { selected = {} },
      openSession,
    }))
    afterDelete(['session-a'])
    selected = { sessionId: 'session-b' }
    afterRestore(['session-a'])
    expect(openSession).not.toHaveBeenCalled()
  })

  it('resetMainView 清掉重开记忆：重绑之后也不再重开', () => {
    const openSession = vi.fn()
    bindMainView(ctxWith(uiWith({ sessionId: 'session-a', byId: { 'session-a': {} }, openSession })))
    afterDelete(['session-a'])
    resetMainView()
    bindMainView(ctxWith(uiWith({ sessionId: 'session-a', byId: { 'session-a': {} }, openSession })))
    afterRestore(['session-a'])
    expect(openSession).not.toHaveBeenCalled()
  })

  it('resetMainView 让在等的重开作废：摘要落地也不再开', () => {
    vi.useFakeTimers()
    try {
      let byId: Record<string, unknown> = {}
      const stale = vi.fn()
      bindMainView(ctxWith({
        selection: { getSnapshot: () => ({ sessionId: 'session-a' }) },
        sessions: { list: { getSnapshot: () => ({ byId }) } },
        clearMain: () => {},
        openSession: stale,
      }))
      afterDelete(['session-a'])
      afterRestore(['session-a'])
      resetMainView()
      byId = { 'session-a': {} }
      vi.advanceTimersByTime(150)
      expect(stale).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('uiWorkspace 缺席 / 形状不符 / get 抛错 ⇒ 安静退回，不抛', () => {
    const openSession = vi.fn()
    const goodUi = () => ctxWith(uiWith({ sessionId: 'session-a', byId: { 'session-a': {} }, openSession }))

    // 先在一个好服务上记下"我们关掉了 session-a"：恢复名单非空，下面每次 afterRestore 才真的走进重开这条支。
    bindMainView(goodUi())
    afterDelete(['session-a'])
    expect(openSession).not.toHaveBeenCalled()

    for (const broken of [
      undefined,
      { selection: { getSnapshot: () => ({ sessionId: 'session-a' }) } },
    ]) {
      bindMainView(ctxWith(broken))
      expect(() => afterDelete(['session-a'])).not.toThrow()
      expect(() => afterRestore(['session-a'])).not.toThrow()
      expect(openSession).not.toHaveBeenCalled()
      // 恢复已把上一条记录摘掉；下一轮重新记一条，坏服务那一轮才不是空转。
      bindMainView(goodUi())
      afterDelete(['session-a'])
      expect(openSession).not.toHaveBeenCalled()
    }

    // `get` 自己抛错：必须直接绑这份 ctx。经 `ctxWith` 包一层的话抛的是服务*值*，会被形状判据先挡下，进不了 catch。
    bindMainView({
      slots: {} as never,
      get: () => { throw new Error('service boom') },
    } as unknown as ClientContextLike)
    expect(() => afterDelete(['session-a'])).not.toThrow()
    expect(() => afterRestore(['session-a'])).not.toThrow()
    expect(openSession).not.toHaveBeenCalled()
  })

  it('宿主服务抛错也不外溢：clearMain 抛 ⇒ 不记重开；openSession 抛 ⇒ 不外溢', () => {
    const openSession = vi.fn()
    bindMainView(ctxWith(uiWith({
      sessionId: 'session-a',
      byId: { 'session-a': {} },
      clearMain: () => { throw new Error('clear boom') },
      openSession,
    })))
    expect(() => afterDelete(['session-a'])).not.toThrow()
    // 没关成就不算"我们关掉的"：恢复不重开。
    afterRestore(['session-a'])
    expect(openSession).not.toHaveBeenCalled()

    bindMainView(ctxWith(uiWith({
      sessionId: 'session-a',
      byId: { 'session-a': {} },
      openSession: () => { throw new Error('open boom') },
    })))
    afterDelete(['session-a'])
    expect(() => afterRestore(['session-a'])).not.toThrow()
  })
})
