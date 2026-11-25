// Checkbox 的 onClick 透传（2026-11-25）：Shift+点范围勾选要把修饰键读进来——
// onChange 只带 checked，鼠标修饰键只在 click 上有，所以可选透传 onClick。
// stopPropagation 那条红线不变：点框不许顺带打开会话。
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Checkbox } from '../../src/client/ui/Checkbox.js'

describe('Checkbox.onClick 透传', () => {
  it('点击把 MouseEvent 原样交给 onClick（修饰键可读）', () => {
    const onClick = vi.fn()
    const onChange = vi.fn()
    const { getByRole } = render(<Checkbox checked={false} label="挑" onChange={onChange} onClick={onClick} />)
    fireEvent.click(getByRole('checkbox'), { shiftKey: true })
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClick).toHaveBeenCalledWith(expect.objectContaining({ shiftKey: true }))
  })

  it('点框仍不冒泡到外层（打开会话的红线不变）', () => {
    const outer = vi.fn()
    const { getByRole } = render(
      <div onClick={outer}>
        <Checkbox checked={false} label="挑" onChange={() => {}} onClick={() => {}} />
      </div>,
    )
    fireEvent.click(getByRole('checkbox'))
    expect(outer).not.toHaveBeenCalled()
  })

  it('不传 onClick 时行为与现状一致（现有调用点零改动）', () => {
    const onChange = vi.fn()
    const { getByRole } = render(<Checkbox checked={false} label="挑" onChange={onChange} />)
    fireEvent.click(getByRole('checkbox'))
    expect(onChange).toHaveBeenCalledWith(true)
  })
})
