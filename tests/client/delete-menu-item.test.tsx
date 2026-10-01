// 菜单项「删除」+ 确认框 + 撤销提示（浏览器半的单元层）
// 假 adapter 驱动**真实组件**：不 mock 我们的组件，只喂一个假的远程面。
//
// 这里渲染的是**用户的画面**：菜单行（发请求的那个）+ 确认框的宿主。确认框**不住在行里**——
// 菜单行随菜单一起卸载（真产物 `Menu` 是 `open && jsxs(MenuSurface, { … children: [items.map(renderEntry),
// children] })`），住在行里的确认框会被连坐卸载，所以它搬到了 `shell.overlay` 上的宿主里
// （`delete-confirm.tsx`；宿主与行在真实装配里是分开挂的，见 `index.test.tsx` 的门回归用例）。
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { type ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeleteConfirmHost, clearDeleteRequest } from '../../src/client/delete-confirm.js'
import { DeleteMenuItem, type DeleteMenuItemProps } from '../../src/client/delete-menu-item.js'
import type { DeleteConfirmDeps } from '../../src/client/remote.js'
import { UndoToast, clearUndoNotice } from '../../src/client/undo-toast.js'

beforeEach(() => {
  // 撤销提示与删除请求都是**模块级现场**（跨用例存活）：每个用例前清一次，用例之间互不串味。
  clearUndoNotice()
  clearDeleteRequest()
})

/** 行 + 确认框宿主（缺省再挂上撤销提示的宿主），也就是真机上同屏的那几样。 */
function renderScene(
  props: Omit<DeleteMenuItemProps, 'dismissMenu'>,
  deps: DeleteConfirmDeps,
  extra?: ReactElement,
) {
  return render(
    <>
      <DeleteMenuItem {...props} />
      <DeleteConfirmHost deps={deps} />
      {extra}
    </>,
  )
}

describe('菜单项', () => {
  it('未确认前不调用删除；确认后才调一次', async () => {
    const del = vi.fn(async () => ({}))
    renderScene({ sessionId: 'session-abc', title: '/code-review' }, { delete: del } as never)
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    expect(del).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }))
    expect(del).toHaveBeenCalledTimes(1)
    expect(del).toHaveBeenCalledWith('session-abc')
  })

  it('会话在跑时菜单项置灰且点不动', () => {
    const del = vi.fn(async () => ({}))
    renderScene({ sessionId: 's', title: 't', live: true }, { delete: del } as never)
    expect(screen.getByRole('menuitem', { name: '删除' })).toBeDisabled()
  })

  it('删除失败时错误原文出现在界面上，不静默吞掉', async () => {
    const del = vi.fn(async () => {
      throw Object.assign(new Error('会话正在运行'), { code: 'sessiondelete/live' })
    })
    renderScene({ sessionId: 's', title: 't' }, { delete: del } as never)
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }))
    expect(await screen.findByText(/会话正在运行/)).toBeInTheDocument()
  })
})

describe('确认框', () => {
  it('点「取消」一个字节都不动，确认框收起', () => {
    const del = vi.fn(async () => ({}))
    renderScene({ sessionId: 's', title: 't' }, { delete: del } as never)
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(del).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('确认框正文明说可恢复，主按钮不是红色的动作名', () => {
    renderScene({ sessionId: 's', title: 't' }, { delete: vi.fn() } as never)
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    expect(screen.getByRole('dialog', { name: '删除这个会话？' })).toBeInTheDocument()
    expect(screen.getByText(/可以随时恢复/)).toBeInTheDocument()
  })

  it('失败之后再确认一次会重试（不是一次失败就永久锁死）', async () => {
    const del = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('磁盘炸了'), { code: 'sessiondelete/io' }))
      .mockResolvedValueOnce({ id: 'e1' })
    renderScene({ sessionId: 's', title: 't' }, { delete: del } as never)
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }))
    expect(await screen.findByText(/磁盘炸了/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }))
    await waitFor(() => expect(del).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

describe('运行中的提示', () => {
  it('置灰的行把原因摆出来；不在跑的时候没有这句话', () => {
    const { unmount } = render(<DeleteMenuItem sessionId="s" title="t" live />)
    expect(screen.getByText('会话正在运行，先停止再删除')).toBeInTheDocument()
    unmount()
    render(<DeleteMenuItem sessionId="s" title="t" />)
    expect(screen.queryByText('会话正在运行，先停止再删除')).not.toBeInTheDocument()
  })
})

describe('撤销提示', () => {
  it('删除成功后冒出一条可撤销的提示，撤销调 restore 并带上条目 id', async () => {
    const restore = vi.fn(async () => ({}))
    renderScene(
      { sessionId: 'session-abc', title: '/code-review' },
      { delete: vi.fn(async () => ({ id: 'entry-1' })) } as never,
      <UndoToast deps={{ restore } as never} />,
    )
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }))
    expect(await screen.findByText(/\/code-review 已移入回收站/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(restore).toHaveBeenCalledWith('entry-1'))
  })

  it('撤销失败时把原因也摆出来（提示不静默消失）', async () => {
    const restore = vi.fn(async () => {
      throw Object.assign(new Error('原项目目录已不存在'), { code: 'sessiondelete/project-missing' })
    })
    renderScene(
      { sessionId: 'session-abc', title: '/code-review' },
      { delete: vi.fn(async () => ({ id: 'entry-1' })) } as never,
      <UndoToast deps={{ restore } as never} />,
    )
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }))
    fireEvent.click(await screen.findByRole('button', { name: '撤销' }))
    expect(await screen.findByText(/原项目目录已不存在/)).toBeInTheDocument()
  })
})
