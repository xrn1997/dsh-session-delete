/** 宿主**浏览器侧** ctx 的本地窄镜像（只声明用到的成员 + 一次强转；不装宿主类型包、不做 `declare module`）。
 *  单独一个文件是因为 `index.tsx` 与 `copy.ts` 都用它，放进入口会绕出循环导入。 */

/** 一个槽位注册项。`label` 允许是 thunk——宿主 `resolveSlotLabel` 的 JSDoc 原文即 "thunks follow the active
 *  locale"，面板行名要随语言走就得走这条。 */
export interface SlotRegistration {
  name: string
  id?: string
  /** keyed 座位（`main`）的键；与 `id` 二者按座位取一。 */
  key?: string
  order?: number
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
  /** 可选服务迟到时的安装面（服务就绪才回调，缺席就一直等）。**缺省调用**：老宿主上没有这个方法。 */
  inject?(deps: readonly string[], callback: (child: ClientContextLike) => unknown): unknown
  /** 挂一个随本插件卸载而撤销的副作用；属性声明（测试当成员读），实现不读 `this`。 */
  effect: (execute: () => unknown, label?: string) => unknown
}
