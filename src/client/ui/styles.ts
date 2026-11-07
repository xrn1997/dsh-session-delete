/**
 * 本插件控件的样式装载：把 `ui.css` / `markdown.css` / `forms.css` / `layout.css` 的文本挂成一个 `<style>`，
 * **每个 ui 组件 import 本模块**（副作用导入），所以「组件在屏幕上」必然等于「样式在场」。
 *
 * 为什么是往 DOM 里注 `<style>`、而不是构建期抽成 `.css` 资产：
 * 宿主对客户端插件的样式**本来就有这条一等公民通道**——浏览器半的模块表在**工厂物化**
 * （factory materialization）时会把插件自己注入的 `<style>` 认领归档（真产物原文：*"Claim and
 * inventory the `<style>` tags a factory injected during materialization: preset-emitted tags arrive
 * pre-tagged with `data-plugin`; any untagged tag is claimed for the materializing plugin (HMR
 * bookkeeping)"*），卸载与换代时由它统一摘掉。这就是官方给插件 UI 的处方
 * （`references/ui-plugin.md`：「Component-local styles can render as React elements so unmounting
 * removes them」）。
 *
 * 因此装载点选在**模块作用域**而不是 `apply()` 里：模块作用域正好落在物化那一刻，能进宿主的认领表；
 * 挂在 `apply` 里就晚了一拍。反复装载由 `data-dsh-session-delete` 标记挡住（同一插件在同一文档里
 * 是单例，模块也只物化一次，这一层是给 HMR 换代留下的保险）。
 *
 * **不发布任何全局状态**：官方的 `pointerModality` 会往 `document.documentElement` 写
 * `data-input-modality` 属性，那是宿主自己那份 primitives 的职责（它已经在跑），我们只在本文件里
 * 记一个本地标志位（见 `Tooltip.tsx`）。
 */
import css from './ui.css'
import formsCss from './forms.css'
import layoutCss from './layout.css'
import markdownCss from './markdown.css'

/** 认领标记：既是宿主 HMR 的归档线索，也是「已经装过」的幂等判据。 */
const STYLE_MARKER = 'dsh-session-delete'

function install(): void {
  if (typeof document === 'undefined') return
  const head = document.head
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- lib.dom 把 document.head 钉成非空，但运行时（早期文档/异常环境）可能为 null；这是「镜像钉死≠运行时必有」。
  if (head === null) return
  if (head.querySelector(`style[data-dsh-session-delete="${STYLE_MARKER}"]`) !== null) return
  const element = document.createElement('style')
  element.setAttribute('data-dsh-session-delete', STYLE_MARKER)
  // `markdown.css` 与控件那几份**分开写、一起装**：`markdown.css` 是我们给会话正文排的字阶（吃宿主
  // markdown token），`forms.css` 是设置表单控件、`layout.css` 是清单行 / 行内动作 / 工作步骤开关与
  // 组头图标的伪类（inline style 表达不了 `:hover` / `:focus-within`），三份都不属于抄本对照表；
  // `ui.css` 是照官方明文逐字抄的那份表（核对口径见 docs/development.md 的界面保真复核门：按文件头
  // 那张来源表逐属性零差异，条数不钉在这里）——四份的来源与核对方式不同，装运可以同一趟。
  element.textContent = `${css}\n${markdownCss}\n${formsCss}\n${layoutCss}`
  head.appendChild(element)
}

install()

/**
 * 输入模态：最近一次输入是**指针**还是**键盘**。
 *
 * `Tooltip` 用它挡掉「指针交互之后紧接着到来的 focus」——菜单收起时宿主会把焦点还给触发按钮，
 * 那一拍不该把我们的提示顶出来（官方 `pointerModality()` 的同一条契约，实现也一样：
 * `pointerdown` 置真、`keydown` 置假）。官方还会据此发布 `data-input-modality` 去控制焦点环的
 * 显隐，**那件事不复制**：宿主自己那份 primitives 已经在同一份文档上发布了它，我们再来一份就是
 * 两个写入者抢同一个属性。
 *
 * 监听器归 `apply` 的 effect（`src/client/index.tsx` 的 `installPointerModality`）：用户在
 * 卸载 / HMR 换代时要把它们摘掉，模块作用域装上就没人负责收了。样式本身仍是模块作用域——
 * 宿主在工厂物化时认领 `<style>` 并在条目卸载时统一摘除，这是它给插件 UI 的正式通道。
 */
let pointerModality = false

/** 装上两个捕获阶段的监听器，返回摘除函数。重复调用会装两套，所以调用点只该是 `apply` 的一个 effect。 */
export function installPointerModality(): () => void {
  if (typeof window === 'undefined') return () => undefined
  const onPointerDown = (): void => {
    pointerModality = true
  }
  const onKeyDown = (): void => {
    pointerModality = false
  }
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('keydown', onKeyDown, true)
  return () => {
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('keydown', onKeyDown, true)
  }
}

/** 最近一次输入是否来自指针（仅本插件自用）。 */
export function isPointerModality(): boolean {
  return pointerModality
}
