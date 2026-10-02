/**
 * 宿主**浏览器侧** ctx 的本地窄镜像（AGENTS.md 的规矩：只声明用到的成员 + 一次强转；
 * 不装宿主类型包、不做 `declare module` 增强）。
 *
 * 单独一个文件是因为它现在有两个使用者：入口 `index.tsx`（槽位注册）与 `copy.ts`（locale 服务），
 * 放在入口里会绕出一个循环导入。
 */

/** 一个槽位注册项。`label` 允许是 thunk——宿主 `resolveSlotLabel` 的 JSDoc 原文即
 *  "thunks follow the active locale"，面板行名要随语言走就得走这条（见 `copy.ts` 头注）。 */
export interface SlotRegistration {
  name: string
  /** list 座位的占用者 id。 */
  id?: string
  /** keyed 座位（`main`）的键；与 `id` 二者按座位取一。 */
  key?: string
  order?: number
  /** 宿主的行名字（`resolveSlotLabel(options.label)`；`sidebar.panellist` 用它画 `.panelTitle`）。 */
  label?: string | (() => string)
  inject?: () => unknown
}

export interface SlotsLike {
  inject(key: string, contribute: () => unknown): unknown
  register(options: SlotRegistration, component: unknown): unknown
}

export interface ClientContextLike {
  slots: SlotsLike
  /** 可选服务的读面（宿主自己的写法：`ctx.get('…')?.…`）。**缺省调用**：老宿主上没有这个方法。 */
  get?(name: string): unknown
  /** 挂一个随本插件卸载而撤销的副作用（返回的清理函数由框架接管）。 */
  effect(execute: () => unknown, label?: string): unknown
}
