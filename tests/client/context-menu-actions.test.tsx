import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isSelecting } from '../../src/client/batch-selection-store.js'
import {
  createSessionMenuContribution,
  ICON_BATCH,
  ICON_DELETE,
} from '../../src/client/context-menu-actions.js'
import { zhTranslate } from '../../src/client/copy.js'
import { useDeleteRequest } from '../../src/client/delete-confirm.js'
import { resetClientState } from '../../src/client/reset-client-state.js'

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

function DeleteRequestProbe() {
  const request = useDeleteRequest()
  return <div data-testid="request">{request?.sessionId ?? 'none'}</div>
}

beforeEach(() => {
  resetClientState()
})

afterEach(() => {
  resetClientState()
})

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
      label: '删除',
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

  it('删除动作 run 写入确认框现场；运行中改文案并置灰', async () => {
    const b = bench()
    const actions = await b.contribution.resolve(TARGET)
    const deleteAction = actions[1]
    if (deleteAction === undefined) throw new Error('缺少删除动作')
    render(<DeleteRequestProbe />)
    act(() => {
      void deleteAction.run()
    })
    expect(screen.getByTestId('request')).toHaveTextContent('session-a')

    b.setRunning(true)
    const live = await b.contribution.resolve(TARGET)
    expect(live[1]).toMatchObject({ label: '删除（运行中）', disabled: true })
  })

  it('缺 sessions 服务时不 observe，删除保持可用', async () => {
    const b = bench({ sessions: false })
    expect(b.contribution.observe?.(TARGET)).toBeUndefined()
    const actions = await b.contribution.resolve(TARGET)
    expect(actions[1]).toMatchObject({ label: '删除', disabled: false })
  })
})
