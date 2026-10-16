/**
 * 勾选框（2026-10-15 加，回收站多选态用）。
 *
 * 样式与行为抄自 `@deepseek-ai/dsh-client-ui-primitives` 的 `lib/Checkbox.module.css`
 * （那四条声明逐字进了 `ui.css` 的 `.sd-checkbox`）：**本体是原生 `input[type=checkbox]` +
 * `accent-color`，不是自绘的圆框**。参考稿上那种圆形勾选框是别家 App 的形状，抄进来就成了
 * "宿主界面里长出一个外来控件"；原生这一款在深浅两套主题下都跟宿主同形，键盘与读屏也白送。
 *
 * 一处与官方 `Checkbox` 的差异是**结构上的**：官方那版是 `<label>` 包 input + 可见文字，
 * 我们这一格只有框、名字走 `aria-label`（行本身就是可点的整块，再挂一份可见文字是重复）。
 *
 * **`stopPropagation` 不是可有可无的**：清单整行是个点击目标（多选态下"点行=切换勾选"），
 * 勾选框住在行里。不拦住冒泡，点框这一下会被行再处理一次 ⇒ 勾上又立刻取消，看起来像"点不动"。
 */
import { useEffect, useRef, type ReactElement } from 'react'

export interface CheckboxProps {
  checked: boolean
  /**
   * 半选（横杠）。**它不是属性，是 DOM 上的一个 IDL 字段**——`indeterminate` 只能命令式赋值，
   * 写进 JSX 里 React 会当未知属性丢掉。所以这里挂 ref 在 effect 里现设（组头那颗用它说
   * "这个项目只勾了几条"）。
   */
  indeterminate?: boolean
  onChange: (checked: boolean) => void
  /** 只给读屏的名字（视觉上这一格没有文字）。 */
  label: string
  disabled?: boolean
}

export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  label,
  disabled = false,
}: CheckboxProps): ReactElement {
  const input = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (input.current !== null) input.current.indeterminate = indeterminate
  }, [indeterminate])
  return (
    <span className="sd-checkbox" onClick={(event) => { event.stopPropagation() }}>
      <input
        ref={input}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        aria-checked={indeterminate ? 'mixed' : checked}
        onChange={(event) => { onChange(event.target.checked) }}
      />
    </span>
  )
}
