/**
 * 本插件控件的样式装载：把 `ui.css` 的文本挂成一个 `<style>`，**每个 ui 组件 import 本模块**
 * （副作用导入），所以「组件在屏幕上」必然等于「样式在场」。
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

/** 认领标记：既是宿主 HMR 的归档线索，也是「已经装过」的幂等判据。 */
const STYLE_MARKER = 'dsh-session-delete'

function install(): void {
  if (typeof document === 'undefined') return
  const head = document.head
  if (head === null) return
  if (head.querySelector(`style[data-dsh-session-delete="${STYLE_MARKER}"]`) !== null) return
  const element = document.createElement('style')
  element.setAttribute('data-dsh-session-delete', STYLE_MARKER)
  element.textContent = css
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
 */
let pointerModality = false

if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    () => {
      pointerModality = true
    },
    true,
  )
  window.addEventListener(
    'keydown',
    () => {
      pointerModality = false
    },
    true,
  )
}

/** 最近一次输入是否来自指针（仅本插件自用）。 */
export function isPointerModality(): boolean {
  return pointerModality
}
