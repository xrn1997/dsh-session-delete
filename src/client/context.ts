/** 宿主**浏览器侧** ctx 的本地窄镜像（只声明用到的成员 + 一次强转；不装宿主类型包、不做 `declare module`）。
 *  单独一个文件是因为 `index.tsx` 与 `copy.ts` 都用它，放进入口会绕出循环导入。
 *
 * **成员可缺性表**（缺 `effect` 时各调用面的去处，别把守卫当冗余删掉）。`effect` 按**防御性判空**可缺：
 * 测试窄 ctx 与宿主换代都可能没有这一格，本镜像不按某一代宿主的实测成员面断言它必有。
 * - `copy.ts` 的 `createTranslate`、`context-menu-actions.tsx` 的 `installSessionMenus`：注册照旧，只缺
 *   卸载撤销，各告警一句。代价是受约束的：字典重挂撞名会退回内置 zh、菜单可能与数据动作双轨并存。
 * - `index.tsx` 的三个结构性副作用、`main-view.ts` 的重开取消、`host-archive-watch.ts` 的迟到观察：跳过
 *   不装——监听类副作用缺撤销就是泄漏，宁可不装。 */

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
  /** 挂一个随本插件卸载而撤销的副作用；属性声明（测试当成员读），实现不读 `this`。
   *  **可缺（防御性判空）**：测试窄 ctx 与宿主换代都可能没有这一格，各调用面的去处见文件头的可缺性表。 */
  effect?: (execute: () => unknown, label?: string) => unknown
}
