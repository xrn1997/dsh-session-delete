import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DeleteActionHost, requestDelete, useDeleteActionRequest } from '../../src/client/delete-action.js'
import { DeleteMenuItem } from '../../src/client/delete-menu-item.js'
import type { OneShotDeps } from '../../src/client/remote.js'
import { fakeApply } from './support/fake-apply.js'
import { createFakeRemote } from './support/fake-remote.js'
import { UndoToast } from '../../src/client/undo-toast.js'

function renderMenu(deps: OneShotDeps, props: { live?: boolean; dismissMenu?: () => void } = {}) {
  return render(
    <>
      <DeleteMenuItem sessionId="session-abc" title="/code-review" {...props} />
      <DeleteActionHost deps={deps} />
      <UndoToast deps={deps} />
    </>,
  )
}

describe('移入回收站菜单项', () => {
  it('点击即移入回收站，不弹确认框，也不问子会话数', async () => {
    const del = vi.fn(async () => ({ id: 'entry-1' }))
    const count = vi.fn(async () => 3)
    const apply = fakeApply({ delete: del, count })
    renderMenu(createFakeRemote({ applyOutcomes: apply }))

    fireEvent.click(screen.getByRole('menuitem', { name: '移入回收站' }))

    await waitFor(() => expect(del).toHaveBeenCalledTimes(1))
    expect(del).toHaveBeenCalledWith('session-abc')
    expect(count).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('同一拍连点只发一次移入回收站', async () => {
    let release: (value: unknown) => void = () => {}
    const del = vi.fn(() => new Promise((resolve) => { release = resolve }))
    renderMenu(createFakeRemote({ applyOutcomes: fakeApply({ delete: del }) }))

    const item = screen.getByRole('menuitem', { name: '移入回收站' })
    act(() => {
      fireEvent.click(item)
      fireEvent.click(item)
    })

    await waitFor(() => expect(del).toHaveBeenCalledTimes(1))
    await act(async () => { release({ id: 'entry-1' }) })
  })

  it('跨 tick 在飞期间对同一会话再次触发，不发第二次移入回收站；不同会话可继续触发', async () => {
    const pending = new Map<string, (value: unknown) => void>()
    const del = vi.fn((id: string) => new Promise((resolve) => { pending.set(id, resolve) }))
    renderMenu(createFakeRemote({ applyOutcomes: fakeApply({ delete: del }) }))
    const request = renderHook(() => useDeleteActionRequest())

    fireEvent.click(screen.getByRole('menuitem', { name: '移入回收站' }))
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1))

    // 同一会话跨 tick 再次点菜单：被宿主按 sessionId 挡回，不再发第二次。
    act(() => { requestDelete({ sessionId: 'session-abc', title: '/code-review' }) })
    await act(async () => { await Promise.resolve() })
    expect(del).toHaveBeenCalledTimes(1)

    // 另一个会话仍可正常发起。
    act(() => { requestDelete({ sessionId: 'session-b', title: '会话乙' }) })
    await waitFor(() => expect(del).toHaveBeenCalledWith('session-b'))

    await act(async () => { pending.get('session-abc')?.({ id: 'entry-a' }) })
    await act(async () => { pending.get('session-b')?.({ id: 'entry-b' }) })
    await waitFor(() => expect(request.result.current).toBeNull())
  })

  it('甲移入成功后紧接着乙移入失败：乙的失败原文立即可见，不被甲的撤销横幅挡住', async () => {
    const del = vi.fn(async (id: string) => {
      if (id === 'session-abc') return { id: 'entry-1' }
      throw Object.assign(new Error('会话乙正在运行'), { code: 'sessiondelete/live' })
    })
    renderMenu(createFakeRemote({ applyOutcomes: fakeApply({ delete: del }) }))

    fireEvent.click(screen.getByRole('menuitem', { name: '移入回收站' }))
    expect(await screen.findByText(/\/code-review 已移入回收站/)).toBeInTheDocument()

    act(() => { requestDelete({ sessionId: 'session-b', title: '乙' }) })
    expect(await screen.findByText('会话乙正在运行')).toBeInTheDocument()
  })

  it('底层意外抛错时不产生未捕获异常，错误上屏且请求清理', async () => {
    const applyOutcomes = vi.fn(async () => { throw new Error('意外中断') })
    renderMenu(createFakeRemote({ applyOutcomes }))
    const request = renderHook(() => useDeleteActionRequest())

    fireEvent.click(screen.getByRole('menuitem', { name: '移入回收站' }))

    expect(await screen.findByText('意外中断')).toBeInTheDocument()
    await waitFor(() => expect(request.result.current).toBeNull())
  })

  it('旧动作晚到完成不清掉后来发布的动作', async () => {
    const pending = new Map<string, (value: unknown) => void>()
    const del = vi.fn((id: string) => new Promise((resolve) => { pending.set(id, resolve) }))
    renderMenu(createFakeRemote({ applyOutcomes: fakeApply({ delete: del }) }))
    const request = renderHook(() => useDeleteActionRequest())

    fireEvent.click(screen.getByRole('menuitem', { name: '移入回收站' }))
    await waitFor(() => expect(del).toHaveBeenCalledWith('session-abc'))
    act(() => { requestDelete({ sessionId: 'session-b', title: '会话乙' }) })
    await waitFor(() => expect(del).toHaveBeenCalledWith('session-b'))

    await act(async () => { pending.get('session-abc')?.({ id: 'entry-a' }) })
    expect(request.result.current?.sessionId).toBe('session-b')
    await act(async () => { pending.get('session-b')?.({ id: 'entry-b' }) })
    await waitFor(() => expect(request.result.current).toBeNull())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('会话在跑时菜单项置灰且点不动', () => {
    const del = vi.fn(async () => ({ id: 'entry-1' }))
    renderMenu(createFakeRemote({ applyOutcomes: fakeApply({ delete: del }) }), { live: true })
    const item = screen.getByRole('menuitem', { name: '移入回收站' })
    expect(item).toBeDisabled()
    fireEvent.click(item)
    expect(del).not.toHaveBeenCalled()
  })

  it('移入回收站失败时错误原文出现在界面上，不静默吞掉', async () => {
    const del = vi.fn(async () => {
      throw Object.assign(new Error('会话正在运行'), { code: 'sessiondelete/live' })
    })
    renderMenu(createFakeRemote({ applyOutcomes: fakeApply({ delete: del }) }))

    fireEvent.click(screen.getByRole('menuitem', { name: '移入回收站' }))

    expect(await screen.findByText(/会话正在运行/)).toBeInTheDocument()
  })

  it('菜单 owner 收到收起', () => {
    const dismissMenu = vi.fn()
    renderMenu(createFakeRemote(), { dismissMenu })
    fireEvent.click(screen.getByRole('menuitem', { name: '移入回收站' }))
    expect(dismissMenu).toHaveBeenCalledTimes(1)
  })

  it('运行中提示说明先停止再移入回收站；空闲时没有这句话', () => {
    const { unmount } = render(
      <DeleteMenuItem sessionId="s" title="t" live />,
    )
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: '移入回收站' }).parentElement as HTMLElement)
    expect(screen.getByText('会话正在运行，先停止再移入回收站')).toBeInTheDocument()
    unmount()
    render(<DeleteMenuItem sessionId="s" title="t" />)
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: '移入回收站' }).parentElement as HTMLElement)
    expect(screen.queryByText(/先停止再移入回收站/)).not.toBeInTheDocument()
  })
})

describe('移入回收站后的撤销', () => {
  it('移入回收站成功后出现撤销提示，撤销调 restore 并带上条目 id', async () => {
    const restore = vi.fn(async () => ({}))
    const deps = createFakeRemote({ applyOutcomes: fakeApply({
      delete: async () => ({ id: 'entry-1' }),
      restore,
    }) })
    renderMenu(deps)

    fireEvent.click(screen.getByRole('menuitem', { name: '移入回收站' }))
    expect(await screen.findByText(/\/code-review 已移入回收站/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(restore).toHaveBeenCalledWith('entry-1'))
  })

  it('撤销失败时把原因摆出来', async () => {
    const restore = vi.fn(async () => {
      throw Object.assign(new Error('原项目目录已不存在'), { code: 'sessiondelete/project-missing' })
    })
    const deps = createFakeRemote({ applyOutcomes: fakeApply({
      delete: async () => ({ id: 'entry-1' }),
      restore,
    }) })
    renderMenu(deps)

    fireEvent.click(screen.getByRole('menuitem', { name: '移入回收站' }))
    fireEvent.click(await screen.findByRole('button', { name: '撤销' }))
    expect(await screen.findByText(/原项目目录已不存在/)).toBeInTheDocument()
  })
})
