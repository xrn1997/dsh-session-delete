// ⋯ 菜单里的「多选」入口（第十三批①改版：常驻勾选被用户打回，改成显式模式）
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchSelectMenuItem } from '../../src/client/batch-menu-item.js'
import { exitSelection, getPicks, isSelecting, togglePick } from '../../src/client/batch-select.js'

beforeEach(() => {
  exitSelection()
})

describe('⋯ 菜单的多选入口', () => {
  it('点「多选」进入模式并收菜单；再点「退出多选」退出并清空名单', () => {
    const dismissMenu = vi.fn()
    render(<BatchSelectMenuItem dismissMenu={dismissMenu} />)
    fireEvent.click(screen.getByRole('menuitem', { name: '多选' }))
    expect(isSelecting()).toBe(true)
    expect(dismissMenu).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('menuitem', { name: '退出多选' })).toBeInTheDocument()

    togglePick({ sessionId: 'a', title: 'A' })
    fireEvent.click(screen.getByRole('menuitem', { name: '退出多选' }))
    expect(isSelecting()).toBe(false)
    expect(getPicks()).toEqual([])
    expect(dismissMenu).toHaveBeenCalledTimes(2)
  })
})
