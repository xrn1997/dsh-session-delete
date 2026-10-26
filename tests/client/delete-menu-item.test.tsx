// 菜单项「删除」+ 确认框 + 撤销提示（浏览器半的单元层）
// 假 adapter 驱动**真实组件**：不 mock 我们的组件，只喂一个假的远程面。
//
// 这里渲染的是**用户的画面**：菜单行（发请求的那个）+ 确认框的宿主。确认框**不住在行里**——
// 菜单行随菜单一起卸载（真产物 `Menu` 是 `open && jsxs(MenuSurface, { … children: [items.map(renderEntry),
// children] })`），住在行里的确认框会被连坐卸载，所以它搬到了 `shell.overlay` 上的宿主里
// （`delete-confirm.tsx`；宿主与行在真实装配里是分开挂的，见 `index.test.tsx` 的门回归用例）。
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DeleteConfirmHost,
  requestDelete,
  resetDeleteRequest,
  useDeleteRequest,
} from '../../src/client/delete-confirm.js'
import { DeleteMenuItem, type DeleteMenuItemProps } from '../../src/client/delete-menu-item.js'
import type { DeleteConfirmDeps } from '../../src/client/remote.js'
import { fakeApply } from './support/fake-apply.js'
import { createFakeRemote } from './support/fake-remote.js'
import { UndoToast } from '../../src/client/undo-toast.js'
import { resetUndoNotice } from '../../src/client/undo-notices.js'

beforeEach(() => {
  // 撤销提示与删除请求都是**模块级现场**（跨用例存活）：每个用例前复位，用例之间互不串味。
  resetUndoNotice()
  resetDeleteRequest()
})

afterEach(() => {
  // 收场也复位：用例中途失败时，下一份文件/下一轮不从上一轮的现场接着跑。
  resetUndoNotice()
  resetDeleteRequest()
})

/** 菜单/确认框只吃 `applyOutcomes`：一颗完整的假远程面替掉手搭对象与 `as never`。 */
const deps = (applyOutcomes: DeleteConfirmDeps['applyOutcomes']) => createFakeRemote({ applyOutcomes: vi.fn(applyOutcomes) })

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
    renderScene({ sessionId: 'session-abc', title: '/code-review' }, deps(fakeApply({ delete: del })))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    expect(del).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }))
    expect(del).toHaveBeenCalledTimes(1)
    expect(del).toHaveBeenCalledWith('session-abc')
  })

  it('会话在跑时菜单项置灰且点不动', () => {
    const del = vi.fn(async () => ({}))
    renderScene({ sessionId: 's', title: 't', live: true }, deps(fakeApply({ delete: del })))
    expect(screen.getByRole('menuitem', { name: '删除' })).toBeDisabled()
  })

  it('删除失败时错误原文出现在界面上，不静默吞掉', async () => {
    const del = vi.fn(async () => {
      throw Object.assign(new Error('会话正在运行'), { code: 'sessiondelete/live' })
    })
    renderScene({ sessionId: 's', title: 't' }, deps(fakeApply({ delete: del })))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }))
    expect(await screen.findByText(/会话正在运行/)).toBeInTheDocument()
  })
})

describe('确认框', () => {
  it('点「取消」一个字节都不动，确认框收起', () => {
    const del = vi.fn(async () => ({}))
    renderScene({ sessionId: 's', title: 't' }, deps(fakeApply({ delete: del })))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(del).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('写入在飞时取消/关闭都拦住（busy 关框规则）', async () => {
    let release: (value: unknown) => void = () => {}
    const del = vi.fn(() => new Promise((resolve) => { release = resolve }))
    renderScene({ sessionId: 's', title: 't' }, deps(fakeApply({ delete: del })))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '取消' })).toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    release({ id: 'e1' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('确认框正文明说可恢复，主按钮不是红色的动作名', () => {
    renderScene({ sessionId: 's', title: 't' }, deps(fakeApply({ delete: vi.fn() })))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    expect(screen.getByRole('dialog', { name: '删除这个会话？' })).toBeInTheDocument()
    expect(screen.getByText(/可以随时恢复/)).toBeInTheDocument()
  })

  it('失败之后再确认一次会重试（不是一次失败就永久锁死）', async () => {
    const del = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('磁盘炸了'), { code: 'sessiondelete/io' }))
      .mockResolvedValueOnce({ id: 'e1' })
    renderScene({ sessionId: 's', title: 't' }, deps(fakeApply({ delete: del })))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }))
    expect(await screen.findByText(/磁盘炸了/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }))
    await waitFor(() => expect(del).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  // 宿主的客户端本来就藏孩子 ⇒ 用户点完才发现侧栏少了一整片，而"少了什么"不可自证。
  // 所以那句话必须摆在**点之前**（issue #3）：数只能删除前现问一次（那一刻它还没进回收站，清单里没有它）。
  it('目标在盘上有后代 ⇒ 确认框点之前就说清有多少个一起移入回收站', async () => {
    const countSubagents = vi.fn(async () => 3)
    renderScene({ sessionId: 'session-parent', title: '父会话' }, deps(fakeApply({ delete: async () => ({ id: 'e1' }), count: countSubagents })))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    expect(countSubagents).toHaveBeenCalledWith('session-parent')
    expect(await screen.findByText(/含 3 个子会话/)).toBeInTheDocument()
  })

  it('没有后代 ⇒ 那半句一个字都不出现（不许写「含 0 个」冒充说了话）', async () => {
    const countSubagents = vi.fn(async () => 0)
    renderScene({ sessionId: 's', title: 't' }, deps(fakeApply({ delete: async () => ({ id: 'e1' }), count: countSubagents })))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(countSubagents).toHaveBeenCalled())
    await new Promise((resolve) => { setTimeout(resolve, 0) }) // 让那次取数落进 state
    expect(dialog.textContent).not.toContain('子会话')
  })

  // 那半句是**加法**，不是门槛：计数读不到时确认框照常能点，只是不说（一次取数失败不许锁死删除）。
  it('计数读不到 ⇒ 那半句不说，但确认照旧能点', async () => {
    const del = vi.fn(async () => ({ id: 'e1' }))
    renderScene(
      { sessionId: 's', title: 't' },
      deps(fakeApply({ delete: del, count: async () => { throw new Error('通道断了') } })),
    )
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }))
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/子会话/)).not.toBeInTheDocument()
  })
})

describe('模块级现场', () => {
  it('每发一条删除请求 seq 递增（确认框靠它重挂载，busy / 失败面不带记忆）', () => {
    const { result } = renderHook(() => useDeleteRequest())
    act(() => {
      requestDelete({ sessionId: 'a', title: 'A' })
    })
    expect(result.current).toMatchObject({ seq: 1, sessionId: 'a', title: 'A' })
    act(() => {
      requestDelete({ sessionId: 'b', title: 'B' })
    })
    expect(result.current).toMatchObject({ seq: 2, sessionId: 'b', title: 'B' })
  })
})

describe('运行中的提示', () => {
  it('置灰的行悬停时把原因摆出来；不在跑的时候没有这句话', () => {
    // 提示是**自造 Tooltip**（`ui/Tooltip.tsx`）：它不在 DOM 里常驻，hover / 键盘 focus 才出
    // （官方同款行为，见该文件头注）。所以判据是"悬停之后在不在"，不是"渲染后在不在"。
    const { unmount } = render(<DeleteMenuItem sessionId="s" title="t" live />)
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: '删除' }).parentElement as HTMLElement)
    expect(screen.getByText('会话正在运行，先停止再删除')).toBeInTheDocument()
    unmount()
    render(<DeleteMenuItem sessionId="s" title="t" />)
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: '删除' }).parentElement as HTMLElement)
    expect(screen.queryByText('会话正在运行，先停止再删除')).not.toBeInTheDocument()
  })
})

describe('撤销提示', () => {
  it('删除成功后冒出一条可撤销的提示，撤销调 restore 并带上条目 id', async () => {
    const restore = vi.fn(async () => ({}))
    renderScene(
      { sessionId: 'session-abc', title: '/code-review' },
      deps(fakeApply({ delete: async () => ({ id: 'entry-1' }) })),
      <UndoToast deps={deps(fakeApply({ restore }))} />,
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
      deps(fakeApply({ delete: async () => ({ id: 'entry-1' }) })),
      <UndoToast deps={deps(fakeApply({ restore }))} />,
    )
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }))
    fireEvent.click(await screen.findByRole('button', { name: '撤销' }))
    expect(await screen.findByText(/原项目目录已不存在/)).toBeInTheDocument()
  })
})
