/**
 * 平台模块 `@deepseek-ai/dsh-client-ui-primitives` 在**单元测试期的替身**。
 *
 * 为什么必须替：它是宿主**冻结平台模块表**里的静态键，真机运行时由加载器注入真实实例
 * （我们 bundle 里只留 `require('@deepseek-ai/dsh-client-ui-primitives')`，见 tsdown.config.ts
 * 的 neverBundle）。但在 vitest 里 `import` 会落到 node_modules 里那个真包，而它的
 * `lib/index.js` 顶层 import 了 `shiki` / `simple-icons` / `katex` / `@deepseek-ai/dsh-client-store`
 * 等**它自己的 devDependencies**（不随包发布）⇒ 测试进程根本加载不起来。装那一串等于给
 * 本仓加十条依赖，违反「不新增依赖」。所以这里的做法是**替换平台模块实现**（不是 mock 我们
 * 自己的代码）：只实现本插件用到的那几个组件，DOM 契约逐条抄自真包产物。
 *
 * 契约来源（逐条可复现）：真产物 `node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js`
 * 与本包 `lib/*.module.css` 直接可读；asar 里的取数用
 * `node -e 'const fs=require("fs");const s=fs.readFileSync(process.argv[1]).toString("latin1");
 * const i=s.indexOf(<字面量>);console.log(s.slice(i-200,i+800).replace(/[^\x20-\x7e]/g,"."))' <app.asar>`。
 *
 * - `MenuItemButton`（真产物 @150120 起）：`<div class=itemWrap>` 内含
 *   `<button type="button" role="menuitem" disabled={disabled} aria-keyshortcuts={shortcut?.aria}
 *   onClick={onSelect}>`，子节点依次是 icon span、label span（= children）、shortcut span。
 *   **`disabled` 落在原生属性上** —— jest-dom 的 `toBeDisabled()` 只认 `disabled` 属性
 *   （`isElementOrAncestorDisabled` → `canElementBeDisabled && element.hasAttribute('disabled')`，
 *   见 jest-dom@6 dist/matchers；`aria-disabled` **不算**），所以菜单行的「运行中」在本平台上
 *   唯一可实现的形态就是原生 `disabled`。
 * - `Button`（真产物 Button.d.ts）：native button + `ButtonHTMLAttributes` 透传（含 `style`/`disabled`）。
 * - `Modal`（真产物 @200898 起）：`createPortal` 到 `document.body`，外面一层 `role="presentation"`，
 *   卡片 `role="dialog" aria-modal="true" aria-label={title}`；非 headless 时有 `<h2>{title}</h2>`
 *   与 `aria-label={closeLabel}` 的关闭按钮；`footer` 渲染在卡片底部。
 * - `Toast`（真产物 @332246 起）：`createPortal` 到 body，`<span class=text>{text}` + 每个 action
 *   渲染 `<button type="button" class=action onClick>{label}</button>`（`prefix` 在按钮前）。
 *   hold 计时由 CSS 动画与定时器共同驱动；替身不自动跑计时器，`onDone` 由测试自己触发。
 * - `Tooltip`（真产物 Tooltip.d.ts）：克隆 anchor 子元素注入 ref/事件；替身直接把 children
 *   渲染进一个 span，并在未 `disabled` 时把 `label` 渲染成 `role="tooltip"` 的节点。
 * - `fileSizeText`（真产物 @332246 起）：逐字照抄真实现的取整规则。
 * - `relativeTime`（真产物 `lib/relative-time.ts`）：逐字照抄分桶阈值——**它只回 `{unit, n}`，
 *    措辞归各面自己的字典**，所以回收站面板上「N 小时前」那些字是本仓写的，不是替身给的。
 *
 * 落差（写在这里而不是让读者自己猜；**真机验收照单核**——每一条都可能让本套用例比真机宽松）：
 * ① **不做 portal 位置计算、不做 ResizeObserver**。所以「浮层摆在哪儿、量不到尺寸时显不显示」这类
 *    几何行为零覆盖。
 * ② **不做键盘漫游与 focus 归还**。菜单行的方向键漫游、Esc 关菜单、关闭后焦点回到触发者，都只在
 *    真机上成立（宿主的菜单容器负责）。
 * ③ **`Tooltip` 无条件渲染 label 文本**（替身直接把它渲染成 `role="tooltip"` 的节点）。真 `Tooltip`
 *    只在 **hover / focus** 且**量到锚点尺寸之后**才显示——所以「置灰行把原因摆出来」
 *    （`delete-menu-item.test.tsx` 的「运行中的提示」）钉住的是**传给 `Tooltip` 的 label 原文**，
 *    不是「用户一定能看见」；真机上它还取决于悬停与测量（设计稿 §8 门 4）。
 * ④ **`Modal.className` 落在 `role="presentation"` 外框上，不落在 `.dialog` 卡片上**。真 `Modal` 把
 *    `className` 交给卡片（`styles.ts` 的宽度覆盖就靠这一点）。所以本套用例**证不了**「880px 的宽度
 *    覆盖真的落在卡片上」——那是纯视觉项，只能真机核（设计稿 §8 门 4；`styles.ts` 头注已声明）。
 * ⑤ **`onDone` 永不触发**（替身不跑 CSS 动画与定时器）。所以 `undo-toast.tsx` 的 Toast
 *    **自动消失路径零覆盖**：`holdMs=6000` 到点后 `clearUndoNotice` 收不收掉横幅，本套用例测不到。
 * ⑥ **不做 CSS 模块类名**（替身不渲染 `*.module.css` 的类）。样式相关的断言因此只在本插件自己写死的
 *    `data-*` / 结构属性上有意义。
 * ⑦ **替身里不有的东西，本套用例永远看不见它缺席**（2026-10-01 补，最要命的一条）：`vitest.config.ts`
 *    把整个 `@deepseek-ai/dsh-client-ui-primitives` alias 到本文件，所以**真产物里少一个具名导出、
 *    或改了名，不会让任何用例转红**——构建产物是 `require(模块)` 之后按属性取（`lib/client.js` 里
 *    `(0, _primitives.relativeTime)(…)`），模块名命中冻结表就成功、不校验成员，于是缺席发生在**渲染期**
 *    （`TypeError` / `Element type is invalid`），不是加载期。而**回收站面板的卡片分支只在有条目时
 *    才渲染**：隔离 home 的空回收站走的是空态，`relativeTime` 与组头那个 folder glyph 一次都没被调用过
 *    ⇒ 「单测全绿 + 隔离宿主空态读数正常」对这条路径是 0 覆盖。用新的具名导出时，要么在活宿主上
 *    **塞一条真条目**再量一次（设计稿 §8 门 4），要么先按字面量在宿主产物里核它在不在。本轮核过：
 *    app.asar 里 primitives 的那一条 `export { … }`（@22431684…@22438297，锚 `relativeTime,` 在 @22438122）
 *    逐字含 `relativeTime`、`IconFolderOpenOutlineRegular`、`IconTrashOutlineRegular`、
 *    `IconWarningOutlineRegular`、`IconRefreshOutlineRegular`、`fileSizeText` ⇒ 名字在运行中的宿主上都在，
 *    缺具名导出这条风险已排除。**卡片分支后来在真宿主上渲染过了**（2026-10-01 浅色真机：3 条 / 2 组，
 *    组头、`relativeTime` 分桶、两档危险动作都出得来），所以这条落差**本轮已闭合**——但它仍然是这条
 *    免疫性的存在理由：下一次换用新具名导出时，"核名字 + 真宿主塞一条非空条目"两件事都要重做。
 *
 * ⑧ **替身里没有 `Menu` 这个组件**（本插件不渲染菜单壳，菜单容器归宿主）。而真 `Menu` 有一条会改变
 *    生命周期的门：`const list = open && jsxs(MenuSurface, { … children: [items.map(renderEntry),
 *    children] })`（asar @22074291 逐字）——`open === false` 时**槽位行根本不渲染**，行连同它的整棵
 *    子树卸载（`createPortal` 只改 DOM 归属、不改 React 生命周期）。本套用例原来**对这条门是盲的**
 *    （假的 `useMenuOpenState` 只把 `open=false` 记进局部变量，行还在），所以「先关菜单、再开确认框」
 *    看起来通过、真机上永远点不到「移入回收站」。现在 `index.test.tsx` 的 `Scene` 自己复刻了这条门
 *    （假 `Menu` + 假 hook：`open === false` ⇒ 不渲染那一行），回归用例就钉在它上面；**列表之外**那些
 *    只渲染单行、不套菜单的用例仍然不经过这条门（真机手感仍归真机验收）。
 *
 * 一句话：单元测试钉住的是**本插件的交互与状态机**，「像素与真机手感」是真机验收的事（设计稿 §8 门 4）。
 */
import { type ButtonHTMLAttributes, type ReactNode, createElement } from 'react'
import { createPortal } from 'react-dom'

/* ── Button ─────────────────────────────────────────────── */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
  size?: 'md' | 'sm'
  icon?: ReactNode
}

export function Button({ variant = 'ghost', size = 'md', icon, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      data-variant={variant}
      data-size={size}
      {...rest}
    >
      {icon === undefined ? null : <span data-slot="icon">{icon}</span>}
      {children}
    </button>
  )
}

/* ── MenuItemButton ─────────────────────────────────────── */
export interface MenuItemButtonProps {
  children: ReactNode
  shortcut?: { keys: readonly string[]; aria?: string | undefined } | undefined
  icon?: ReactNode
  disabled?: boolean
  danger?: boolean
  separatorBefore?: boolean
  onSelect: () => void
}

export function MenuItemButton({
  children,
  shortcut,
  icon,
  disabled = false,
  danger = false,
  separatorBefore = false,
  onSelect,
}: MenuItemButtonProps) {
  return (
    <div data-slot="menu-item-wrap">
      {separatorBefore ? <div role="separator" /> : null}
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        data-danger={danger || undefined}
        aria-keyshortcuts={shortcut?.aria}
        onClick={onSelect}
      >
        {icon === undefined ? null : <span data-slot="menu-item-icon">{icon}</span>}
        <span data-slot="menu-item-label">{children}</span>
        {shortcut === undefined ? null : (
          <span aria-hidden="true" data-slot="menu-item-shortcut">
            {shortcut.keys.join('+')}
          </span>
        )}
      </button>
    </div>
  )
}

/* ── Modal ──────────────────────────────────────────────── */
export interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  closeLabel?: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  headless?: boolean
  className?: string
  contentClassName?: string
}

export function Modal({
  open,
  onClose,
  title,
  closeLabel,
  description,
  children,
  footer,
  headless = false,
  className,
  contentClassName,
}: ModalProps) {
  if (!open) return null
  const body = headless ? (
    children
  ) : (
    <>
      <div className={contentClassName}>
        <div data-slot="modal-header">
          <h2>{title}</h2>
          <button type="button" aria-label={closeLabel} onClick={onClose} />
        </div>
        {description === undefined || description === '' ? null : <p>{description}</p>}
        <div data-slot="modal-body">{children}</div>
      </div>
      {footer === undefined ? null : <div data-slot="modal-footer">{footer}</div>}
    </>
  )
  return createPortal(
    <div role="presentation" className={className}>
      <div aria-hidden="true" onClick={onClose} data-slot="modal-mask" />
      <div role="dialog" aria-modal="true" aria-label={title}>
        {body}
      </div>
    </div>,
    document.body,
  )
}

/* ── Toast ──────────────────────────────────────────────── */
export interface ToastAction {
  label: string
  prefix?: string
  onClick: () => void
}

export function Toast({
  text,
  icon,
  actions,
  onDone,
}: {
  text: string
  icon?: ReactNode
  tone?: 'success'
  anchor?: HTMLElement | null
  holdMs?: number
  actions?: readonly ToastAction[]
  onDone: () => void
}) {
  void onDone // 真实现由 CSS 动画 + 定时器在淡出后回调；替身不跑计时器。
  return createPortal(
    <div data-slot="toast">
      {icon === undefined ? null : <span aria-hidden="true">{icon}</span>}
      <span data-slot="toast-text">
        {text}
        {(actions ?? []).map((action) => (
          <span key={action.label}>
            {action.prefix}
            <button type="button" onClick={action.onClick}>
              {action.label}
            </button>
          </span>
        ))}
      </span>
    </div>,
    document.body,
  )
}

/* ── Tooltip ────────────────────────────────────────────── */
export function Tooltip({
  label,
  disabled = false,
  children,
}: {
  label: string | (() => string)
  shortcutKeys?: readonly string[] | undefined
  side?: 'right' | 'bottom' | 'top'
  align?: 'center' | 'end'
  delayMs?: number
  focusDelayMs?: number
  gap?: number
  disabled?: boolean
  portal?: boolean
  maxWidth?: number
  openOnClick?: boolean
  children: ReactNode
}) {
  return (
    <span data-slot="tooltip-anchor">
      {children}
      {disabled ? null : (
        <span role="tooltip">{typeof label === 'function' ? label() : label}</span>
      )}
    </span>
  )
}

/* ── Tag ────────────────────────────────────────────────── */
export function Tag({
  tone = 'outline',
  className,
  children,
}: {
  tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
  className?: string
  children?: ReactNode
}) {
  return (
    <span className={className} data-tone={tone}>
      {children}
    </span>
  )
}

/* ── relativeTime（照抄真实现：`lib/relative-time.ts`，桶与量、不带措辞） ── */
export type RelativeTimeUnit = 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'

export interface RelativeTime {
  unit: RelativeTimeUnit
  n: number
}

export function relativeTime(at: number, now: number): RelativeTime {
  const MIN = 6e4
  const HOUR = 36e5
  const DAY = 864e5
  const diff = Math.max(0, now - at)
  if (diff < MIN) return { unit: 'now', n: 0 }
  if (diff < HOUR) return { unit: 'minutes', n: Math.floor(diff / MIN) }
  if (diff < DAY) return { unit: 'hours', n: Math.floor(diff / HOUR) }
  if (diff < 30 * DAY) return { unit: 'days', n: Math.floor(diff / DAY) }
  if (diff < 365 * DAY) return { unit: 'months', n: Math.floor(diff / (30 * DAY)) }
  return { unit: 'years', n: Math.floor(diff / (365 * DAY)) }
}

/* ── 图标（真实现是每个图标一个 SVG 组件；契约只有 IconProps：size + className，色走 currentColor） ── */
const icon = (name: string) => (props: { size?: number; className?: string }) =>
  createElement('svg', {
    'aria-hidden': 'true',
    'data-icon': name,
    width: props.size,
    height: props.size,
    className: props.className,
  })

export const IconTrashOutlineRegular = icon('IconTrashOutlineRegular')
export const IconWarningOutlineRegular = icon('IconWarningOutlineRegular')
export const IconRefreshOutlineRegular = icon('IconRefreshOutlineRegular')
export const IconFolderOpenOutlineRegular = icon('IconFolderOpenOutlineRegular')

/* ── fileSizeText（照抄真实现） ───────────────────────────── */
export function fileSizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)}KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)}MB`
  const gb = mb / 1024
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)}GB`
}
