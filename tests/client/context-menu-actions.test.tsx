import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { isSelecting } from '../../src/client/batch-selection-store.js'
import {
  createSessionMenuContribution,
  ICON_BATCH,
  ICON_DELETE,
  installSessionMenus,
} from '../../src/client/context-menu-actions.js'
import { zhTranslate } from '../../src/client/copy.js'
import type { ClientContextLike } from '../../src/client/context.js'
import { useDeleteActionRequest } from '../../src/client/delete-action.js'

const TARGET = { sessionId: 'session-a', displayTitle: '/code-review' }

function bench(options: { sessions?: boolean } = {}) {
  const { sessions = true } = options
  let running = false
  const sessionList = {
    getSnapshot: () => ({ byId: { 'session-a': { running } } }),
    subscribe: () => () => undefined,
  }
  const contribution = createSessionMenuContribution(
    zhTranslate,
    sessions ? sessionList : undefined,
  )
  return {
    contribution,
    sessionList,
    setRunning(value: boolean) {
      running = value
    },
  }
}

function DeleteActionProbe() {
  const request = useDeleteActionRequest()
  return <div data-testid="request">{request?.sessionId ?? 'none'}</div>
}



describe('0.2.2 contextMenus 数据动作', () => {
  it('贡献 order 700，返回 afterContent 的多选与删除两行', async () => {
    const b = bench()
    expect(b.contribution.target).toBe('session')
    expect(b.contribution.order).toBe(700)
    expect(b.contribution.observe?.(TARGET)).toEqual([b.sessionList])

    const actions = await b.contribution.resolve(TARGET)
    expect(actions.map((action) => action.id)).toEqual(['batch-select', 'delete'])
    expect(actions[0]).toMatchObject({
      label: '多选',
      afterContent: true,
      separatorBefore: true,
      icon: { key: ICON_BATCH },
    })
    expect(actions[1]).toMatchObject({
      label: '移入回收站',
      disabled: false,
      danger: true,
      afterContent: true,
      icon: { key: ICON_DELETE },
    })
  })

  it('多选动作按当前模式切换文案，run 进入/退出模式', async () => {
    const b = bench()
    const first = await b.contribution.resolve(TARGET)
    expect(first[0]?.label).toBe('多选')
    const firstAction = first[0]
    if (firstAction === undefined) throw new Error('缺少多选动作')

    await firstAction.run()
    expect(isSelecting()).toBe(true)
    const second = await b.contribution.resolve(TARGET)
    expect(second[0]?.label).toBe('退出多选')
    const secondAction = second[0]
    if (secondAction === undefined) throw new Error('缺少退出多选动作')

    await secondAction.run()
    expect(isSelecting()).toBe(false)
  })

  it('删除动作 run 发布即删动作；运行中改文案并置灰', async () => {
    const b = bench()
    const actions = await b.contribution.resolve(TARGET)
    const deleteAction = actions[1]
    if (deleteAction === undefined) throw new Error('缺少删除动作')
    render(<DeleteActionProbe />)
    act(() => {
      void deleteAction.run()
    })
    expect(screen.getByTestId('request')).toHaveTextContent('session-a')

    b.setRunning(true)
    const live = await b.contribution.resolve(TARGET)
    expect(live[1]).toMatchObject({ label: '移入回收站（运行中）', disabled: true })
  })

  it('缺 sessions 服务时不 observe，删除保持可用', async () => {
    const b = bench({ sessions: false })
    expect(b.contribution.observe?.(TARGET)).toBeUndefined()
    const actions = await b.contribution.resolve(TARGET)
    expect(actions[1]).toMatchObject({ label: '移入回收站', disabled: false })
  })

  it('resolve 里抛错：吞成「这两行这次不出现」，原文进 console，不把整张菜单打空', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const b = bench()
    // 让读取阶段抛：目标是线上投影的活对象，字段 getter 抛错是真实存在的失败形态。
    const hostile = {
      get sessionId(): string { throw new Error('投影坏了') },
      displayTitle: 'x',
    }
    await expect(Promise.resolve(b.contribution.resolve(hostile))).resolves.toEqual([])
    expect(warn.mock.calls.some((call) => String(call[0]).includes('会话菜单动作解析失败'))).toBe(true)
    warn.mockRestore()
  })
})

describe('菜单装配 · effect 可缺', () => {
  it('老宿主缺 effect：数据贡献照常注册，legacy 两行不装（告警一句）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const registered: unknown[] = []
      const menus = {
        register(contribution: unknown): () => void {
          registered.push(contribution)
          return () => undefined
        },
      }
      const injected: string[] = []
      const client = {
        slots: {
          inject: (name: string) => { injected.push(name) },
          register: () => undefined,
        },
        get: (name: string): unknown => (name === 'contextMenus' ? menus : undefined),
      } as unknown as ClientContextLike
      installSessionMenus(client, zhTranslate)
      expect(registered).toHaveLength(1)
      // 数据装配成功就不再走 legacy 槽位：只有两枚 `contextMenu.icon` 贡献经 slots 挂上去。
      expect(injected).toEqual(['contextMenu.icon', 'contextMenu.icon'])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('effect 在执行回调前抛错：不调用 menus.register 并回退 legacy 菜单行', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const register = vi.fn(() => () => undefined)
      const injected: string[] = []
      const client: ClientContextLike = {
        slots: {
          inject: (name: string) => { injected.push(name) },
          register: () => undefined,
        },
        get: (name: string): unknown => (name === 'contextMenus' ? { register } : undefined),
        effect: (execute: () => unknown, label?: string) => {
          if (label === 'session-delete: context menu actions') throw new Error('scope disposed')
          return execute()
        },
      }
      installSessionMenus(client, zhTranslate)
      expect(register).not.toHaveBeenCalled()
      expect(injected).toEqual(['sidebar.workspaces.session.menu.item', 'sidebar.workspaces.session.menu.item'])
    } finally {
      warn.mockRestore()
    }
  })

  it('effect 执行回调后抛错：立刻摘除已注册的数据动作并回退 legacy，不双轨并存', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const unregister = vi.fn()
      const register = vi.fn(() => unregister)
      const injected: string[] = []
      const client: ClientContextLike = {
        slots: {
          inject: (name: string) => { injected.push(name) },
          register: () => undefined,
        },
        get: (name: string): unknown => (name === 'contextMenus' ? { register } : undefined),
        effect: (execute: () => unknown, label?: string) => {
          const result = execute()
          if (label === 'session-delete: context menu actions') throw new Error('effect failed')
          return result
        },
      }
      installSessionMenus(client, zhTranslate)
      expect(register).toHaveBeenCalledTimes(1)
      expect(unregister).toHaveBeenCalledTimes(1)
      expect(injected).toEqual(['sidebar.workspaces.session.menu.item', 'sidebar.workspaces.session.menu.item'])
    } finally {
      warn.mockRestore()
    }
  })
})
