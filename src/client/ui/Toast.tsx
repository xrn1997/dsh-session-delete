/**
 * `Toast`（**照抄** `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2` 的 Toast，出处与三条改写规则
 * 见 `ui.css` 头注）：顶部居中的一次性横幅——滑入、全不透明停留、淡出，然后回调 `onDone` 让 owner
 * 卸载它。用 body portal 渲染，免得被有 transform / filter 的祖先困在它的盒子里。
 *
 * **保留下来的行为**：
 * - 时长只有一个来源：`holdMs` 同时驱动卸载计时器与样式表的淡出延迟（后者以 `--dsh-toast-hold`
 *   自定义属性读它）⇒ 两者不可能再对不上、把横幅卡在淡出中途卸载。
 * - 同一个 `holdMs` 下，父组件重渲染**不延长**寿命（`onDone` 走 ref，不进 effect 依赖）。
 * - 完成回调拿到的永远是最新的 `onDone`；已经淡完的动作不再接输入（CSS 里那张表面本就穿透点击）。
 * - `tone="success"` 自带官方那枚圆圈对勾（此时忽略传入的 `icon`）。
 *
 * **砍掉的**：`anchor`（把横幅对齐到某个元素的水平中心——本插件的撤销提示就是窗口居中）、
 * `actions[].prefix`（动作文案前的连接词，本插件只用「撤销」两个字）。**没砍 `text`/`icon`/`tone`/
 * `holdMs`/`actions`/`onDone`**：唯一的调用点这几样都在用。
 * **本插件加的**：`paused`（撤销在飞时冻结停留与淡出，失败原文要落回同一条横幅；官方没有这个开关）。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { IconCheckCircleOutlineRegular } from './icons.js'
import './styles.js'

/** 不指定时全不透明的停留时长。 */
const DEFAULT_HOLD_MS = 3000
/** 淡出时长。必须与样式表里 `sd-toast-fade` 的时长一致。 */
const FADE_MS = 1000

export interface ToastAction {
  label: string
  onClick: () => void
  /** 在飞/不可用时按灰并挡住点击（Toast 是本地配方，动作面按调用点的需要长）。 */
  disabled?: boolean
}

export interface ToastProps {
  /** 已解析好的横幅文案（本地化由调用面负责）。 */
  text: string
  /** 前导 glyph；`tone="success"` 时被忽略（那一档自带对勾）。 */
  icon?: ReactNode
  tone?: 'success'
  /** 全不透明停留时长；缺省 3000。 */
  holdMs?: number
  /** 句尾的行内动作（照着句子的顺序排）。 */
  actions?: readonly ToastAction[] | undefined
  /** 暂停自动熄灭：这一趟还有下文（撤销在飞），先把横幅留着——失败原文要靠它上屏。 */
  paused?: boolean | undefined
  /** 淡出完成时调用一次：在这里卸载。 */
  onDone: () => void
}

export function Toast({ text, icon, tone, holdMs = DEFAULT_HOLD_MS, actions, paused = false, onDone }: ToastProps): ReactElement {
  const latestOnDone = useRef(onDone)
  useLayoutEffect(() => {
    latestOnDone.current = onDone
  }, [onDone])
  /** 暂停时剩下的停留时间：`null` = 还没起表（新挂载）。淡出动画被 `animationPlayState` 冻住，
   *  timer 也从同一冻结点续，两者才不会一个先到终点。 */
  const remaining = useRef<number | null>(null)
  useEffect(() => {
    if (paused) return
    const wait = remaining.current ?? holdMs + FADE_MS
    const deadline = Date.now() + wait
    const timer = setTimeout(() => {
      latestOnDone.current()
    }, wait)
    return () => {
      clearTimeout(timer)
      // 暂停（或卸载）时把剩下的停留记下来；恢复时从这里续，不重新计满——重新计时会让
      // 冻住的淡出先走完，留下一条透明却仍占着 `role=alert` 的横幅。
      remaining.current = Math.max(0, deadline - Date.now())
    }
  }, [holdMs, paused])
  return createPortal(
    <div
      className="sd-toast"
      role="alert"
      style={{
        '--dsh-toast-hold': `${String(holdMs)}ms`,
        // 退场动画与 JS timer 同源：暂停时连淡出也一起停住（只停 timer 会留下一条透明但仍占着
        // `role=alert` 的横幅），恢复时两者从同一冻结点继续。
        ...(paused ? { animationPlayState: 'paused' } : {}),
      } as CSSProperties}
    >
      {tone === 'success' ? (
        <span className="sd-toast-icon sd-toast-icon-success" aria-hidden="true">
          <IconCheckCircleOutlineRegular />
        </span>
      ) : icon === undefined ? null : (
        <span className="sd-toast-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="sd-toast-text">
        {text}
        {actions?.map((action) => (
          <button
            key={action.label}
            type="button"
            className="sd-toast-action"
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ))}
      </span>
    </div>,
    document.body,
  )
}
