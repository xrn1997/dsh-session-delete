// 提问轨的静态面：刻度数量与标签、悬停/聚焦的预览卡、点一格交出去的动作、键盘在轨内移动。
// 补页与落位不在这里（`use-prompt-rail` 的用例），这份只钉"画出来是什么、点了交给谁"。
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { zhTranslate } from '../../src/client/copy.js'
import { PromptRail } from '../../src/client/prompt-rail.js'
import type { TrashDetailPromptWire } from '../../src/shared/wire.js'

const prompts: TrashDetailPromptWire[] = [
  { id: '0', at: Date.UTC(2026, 10, 7, 5, 4), preview: '先看改动' },
  { id: '2', at: Date.UTC(2026, 10, 7, 5, 41), preview: '标题排要钉在顶上' },
]

function renderRail(over: {
  loaded?: string[]
  activeId?: string | null
  busyId?: string | null
  notice?: 'tooFar' | null
  disabled?: boolean
} = {}) {
  const onJump = vi.fn()
  const view = render(
    <PromptRail
      prompts={prompts}
      loadedIds={new Set(over.loaded ?? ['2'])}
      activeId={over.activeId ?? null}
      busyId={over.busyId ?? null}
      notice={over.notice ?? null}
      onJump={onJump}
      right="max(14px, calc(100% - 860px))"
      disabled={over.disabled ?? false}
      t={zhTranslate}
    />,
  )
  return { ...view, onJump }
}

describe('PromptRail', () => {
  it('右缘由调用方给的表达式决定（不在样式表里写死列宽）', () => {
    const { container } = renderRail()
    const rail = container.querySelector<HTMLElement>('nav.sd-prompt-rail')
    // jsdom 的 CSS 解析会给 `max()` 里补空格/星号，断言按"含哪些片段"来，不逐字比序列化结果。
    expect(rail?.style.right).toContain('max(')
    expect(rail?.style.right).toContain('calc(100% - 860px)')
  })

  it('一句提问一格，标签带序号与预览', () => {
    renderRail()
    const marks = screen.getAllByRole('button')
    expect(marks).toHaveLength(2)
    expect(marks[0]).toHaveAccessibleName('跳到第 1 句提问：先看改动')
    expect(marks[1]).toHaveAccessibleName('跳到第 2 句提问：标题排要钉在顶上')
  })

  it('悬停出预览卡：序号 / 总数、时间、原句，以及"会先补页"的提示', () => {
    renderRail({ loaded: ['0'] })
    fireEvent.pointerEnter(screen.getAllByRole('button')[1] as Element)
    const peek = document.querySelector('.sd-prompt-peek')
    expect(peek?.textContent).toContain('第 2 / 2 句')
    expect(peek?.textContent).toContain('标题排要钉在顶上')
    expect(peek?.textContent).toContain('会先补页')
  })

  it('已加载的那句预览不说"补页"', () => {
    renderRail({ loaded: ['2'] })
    fireEvent.pointerEnter(screen.getAllByRole('button')[1] as Element)
    expect(document.querySelector('.sd-prompt-peek')?.textContent).toContain('点一下跳到这一句')
    expect(document.querySelector('.sd-prompt-peek')?.textContent).not.toContain('会先补页')
  })

  it('点一格把 id 交给上层，并收起预览卡（别让它盖住刚落位的正文）', () => {
    const { onJump } = renderRail()
    const mark = screen.getAllByRole('button')[1] as Element
    fireEvent.pointerEnter(mark)
    expect(document.querySelector('.sd-prompt-peek')).not.toBeNull()
    fireEvent.click(mark)
    expect(onJump).toHaveBeenCalledWith('2')
    expect(document.querySelector('.sd-prompt-peek')).toBeNull()
  })

  it('当前那句挂 aria-current；键盘 ↓ 在轨内移动焦点', () => {
    renderRail({ activeId: '2' })
    const marks = screen.getAllByRole('button')
    expect(marks[1]).toHaveAttribute('aria-current', 'true')
    fireEvent.keyDown(marks[1] as Element, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(marks[0])
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(marks[1])
  })

  it('roving tabindex 只有一个 0；Home / End 把焦点送到首尾', () => {
    renderRail({ activeId: '2' })
    const marks = screen.getAllByRole('button')
    expect(marks.map((mark) => mark.getAttribute('tabindex'))).toEqual(['-1', '0'])

    fireEvent.keyDown(marks[1] as Element, { key: 'Home' })
    expect(document.activeElement).toBe(marks[0])
    expect(marks[0]).toHaveAttribute('tabindex', '0')
    expect(marks[1]).toHaveAttribute('tabindex', '-1')

    fireEvent.keyDown(document.activeElement as Element, { key: 'End' })
    expect(document.activeElement).toBe(marks[1])
    expect(marks[1]).toHaveAttribute('tabindex', '0')
  })

  it('补页中的那一格带 aria-busy 与 data-loading，别格不带', () => {
    renderRail({ busyId: '2' })
    const marks = screen.getAllByRole('button')
    expect(marks[1]).toHaveAttribute('aria-busy', 'true')
    expect(marks[1]).toHaveAttribute('data-loading', 'true')
    expect(marks[0]).not.toHaveAttribute('aria-busy')
    expect(marks[0]).not.toHaveAttribute('data-loading')
  })

  it('「太远」的说明挂在轨上，不混进正文', () => {
    renderRail({ notice: 'tooFar' })
    expect(screen.getByRole('status')).toHaveTextContent('这句离现在太远，先点更近的一条。')
  })

  it('保持期禁用：轨还在，但刻度不可点、不出预览、键盘也不移动', () => {
    const { container, onJump } = renderRail({ disabled: true })
    const rail = container.querySelector<HTMLElement>('nav.sd-prompt-rail')
    expect(rail?.getAttribute('data-disabled')).toBe('true')
    expect(rail?.hasAttribute('inert')).toBe(true)
    const marks = [...container.querySelectorAll<HTMLButtonElement>('.sd-prompt-mark')]
    expect(marks).toHaveLength(2)
    expect(marks.every((mark) => mark.disabled)).toBe(true)

    fireEvent.pointerEnter(marks[0] as Element)
    expect(document.querySelector('.sd-prompt-peek')).toBeNull()
    fireEvent.click(marks[0] as Element)
    expect(onJump).not.toHaveBeenCalled()
    fireEvent.keyDown(marks[0] as Element, { key: 'ArrowDown' })
    expect(document.activeElement).not.toBe(marks[1])
  })

  it('没有提问时整条轨不画', () => {
    const { container } = render(
      <PromptRail
        prompts={[]}
        loadedIds={new Set()}
        activeId={null}
        busyId={null}
        notice={null}
        onJump={vi.fn()}
        right="max(14px, calc(100% - 860px))"
        t={zhTranslate}
      />,
    )
    expect(container.querySelector('.sd-prompt-rail')).toBeNull()
  })
})
