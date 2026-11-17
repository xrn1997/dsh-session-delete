/**
 * 浏览器半的**场景（scene）seam**：把散在各槽位、模块级的九份现场聚成一个可实例化的对象。
 *
 * 为什么需要：浏览器半有一批跨槽位现场（回收站/归档修订台、首帧快照与详情账本、撤销通知台、
 * 主视图收尾、宿主行登记、批量选中集、两个确认框的请求现场）。它们的 interface 长得像纯函数、
 * 实现是模块级可变单例：调用方必须知道次序（`noteSelection` 无快照时静默、`reloadSucceeded` 按
 * 上一份清单修剪），测试只能靠 `resetClientState()` 的全局复位仪式（19 个文件 / 50 次）。
 * 收成场景之后：**注册面创建一份实例**（跨槽位共享靠实例本身，不需要它们有共同的 React 父级），
 * 测试可以 `createClientScene()` 各造一份互不串味；`reset()` 收场。
 *
 * 兼容：九个现场模块仍导出原来的自由函数/hook，全部委托**默认场景**的实例——旧测试的调用面
 * 不变（`write-seats.test` 只把四枚替身桩换成 `importOriginal` 展开）。生产激活时把创建的那一份
 * 用 {@link installClientScene} 装成默认场景，于是：
 * - `ClientSceneProvider` 把实例交给贡献表里每个槽位贡献的子树（宿主各槽位是独立 React 树，Provider
 *   只做「同一个实例进每棵树」这件事；菜单两行与图标不经 Provider，读默认实例）；
 * - 仍是自由函数的旧调用点（`write-seats.ts` 的收尾、事件处理器里的 `requestDelete` 等）
 *   命中的也是同一份实例——**没有第二份账**。
 *
 * 默认场景**懒建**：`scene.ts` 与九个现场模块互相 import（模块环），如果模块顶层就 `createClientScene()`
 * 并在「测试先 import 某个现场模块」时求值，会踩到对方尚未初始化的 TDZ。懒建把这件事推到第一次
 * 真正读写现场的时候，那时所有模块都已初始化。
 *
 * **环内模块顶层只许字面量初始化**：不要读另一环模块的导出（`batch-confirm` 的目标卡配方就是例子）。
 * 顶层跨模块读取的结果由入口序决定：原生 ESM 直接 TDZ，Vitest 变换下拿到 `undefined`。
 * 回归判据住 `tests/client/scene-cycle.test.tsx`。
 *
 * 与 ADR-0048「模块级」措辞的张力：语义不变（仍是进程内一份、卸载不丢、重启即无），换的只是
 * seam 形状（模块级单例 → 注册面持有的实例 + 默认实例兜底）；这条边界与已知限制住 ADR-0066。
 */
import { createContext, createElement, useContext, type ReactElement, type ReactNode } from 'react'
import { createArchiveRevisionScene, type ArchiveRevisionScene } from './archive-store.js'
import { createBatchConfirmScene, type BatchConfirmScene } from './batch-confirm.js'
import { createBatchSelectionScene, type BatchSelectionScene } from './batch-selection-store.js'
import { createDeleteRequestScene, type DeleteRequestScene } from './delete-confirm.js'
import { createHostRowsScene, type HostRowsScene } from './host-rows.js'
import { createMainViewScene, type MainViewScene } from './main-view.js'
import { createTrashRevisionScene, type TrashRevisionScene } from './trash-store.js'
import { createTrashSnapshotScene, type TrashSnapshotScene } from './trash-snapshot.js'
import { createUndoNoticeScene, type UndoNoticeScene } from './undo-notices.js'

/** 浏览器半的全部跨槽位现场。一份实例 = 一套互不共享的现场（生产一份；测试按需各造）。 */
export interface ClientScene {
  readonly trashRevisions: TrashRevisionScene
  readonly archiveRevisions: ArchiveRevisionScene
  /** 首帧快照与回收站详情账本（`trash-snapshot.ts`）。 */
  readonly snapshot: TrashSnapshotScene
  /** 撤销横幅通知台。 */
  readonly undo: UndoNoticeScene
  /** 主视图关闭/重开记忆。 */
  readonly mainView: MainViewScene
  /** 宿主会话行的可见登记表。 */
  readonly hostRows: HostRowsScene
  /** 宿主列表批量删除的选中集。 */
  readonly batchSelection: BatchSelectionScene
  /** 「删除」确认框的请求现场。 */
  readonly deleteRequest: DeleteRequestScene
  /** 「批量删除」确认框的请求现场。 */
  readonly batchConfirm: BatchConfirmScene
  /** 场景收场：九份现场一起回初值（测试与 HMR 复位只调这一条）。 */
  reset(): void
}

/** 造一份全新场景：每份现场都是独立实例，互不读写。 */
export function createClientScene(): ClientScene {
  const scene: ClientScene = {
    trashRevisions: createTrashRevisionScene(),
    archiveRevisions: createArchiveRevisionScene(),
    snapshot: createTrashSnapshotScene(),
    undo: createUndoNoticeScene(),
    mainView: createMainViewScene(),
    hostRows: createHostRowsScene(),
    batchSelection: createBatchSelectionScene(),
    deleteRequest: createDeleteRequestScene(),
    batchConfirm: createBatchConfirmScene(),
    reset(): void {
      scene.trashRevisions.reset()
      scene.archiveRevisions.reset()
      scene.snapshot.reset()
      scene.undo.reset()
      scene.mainView.reset()
      scene.hostRows.reset()
      scene.batchSelection.reset()
      scene.deleteRequest.reset()
      scene.batchConfirm.reset()
    },
  }
  return scene
}

/** 默认场景：懒建（模块环见文件头注）；生产激活时被 {@link installClientScene} 换成那一份。 */
let defaultScene: ClientScene | null = null

/** 取默认场景（没有就造一份）。自由函数与无 Provider 的测试都落到它。 */
export function getDefaultClientScene(): ClientScene {
  defaultScene ??= createClientScene()
  return defaultScene
}

/**
 * 生产注册面：把 createClientScene() 造的那一份装成默认场景——旧自由函数与 Provider 是同一份账。
 *
 * **已有默认场景时沿用它**（不换新）：测试常在 `apply` 之前先摆现场（`enterSelection()` 早于
 * `bootstrap()`），HMR 二次激活也不该把进程内现场整份换掉。返回实际采用的那一份，调用方必须用它
 * 建 Provider（否则 Provider 与旧自由函数会落在两份账上）。
 */
export function installClientScene(candidate: ClientScene): ClientScene {
  defaultScene ??= candidate
  return defaultScene
}

/** 测试/HMR 复位：默认场景的九份现场一起回初值（`reset-client-state.ts` 的唯一实现）。 */
export function resetDefaultClientScene(): void {
  getDefaultClientScene().reset()
}

const SceneContext = createContext<ClientScene | null>(null)

/** 供组件/钩子读当前场景：Provider 给的那一份，没有 Provider 就回退默认场景（旧测试调用面不变）。 */
export function useClientScene(): ClientScene {
  return useContext(SceneContext) ?? getDefaultClientScene()
}

/**
 * 把同一份场景交给一棵贡献子树。宿主各槽位是互不相邻的 React 树，所以每个贡献各包一次、
 * 拿到的是**同一个实例**——跨槽位共享靠实例本身，不靠 React 树（这是 ADR-0048 的"无共同父级"事实）。
 */
export function ClientSceneProvider({ scene, children }: {
  readonly scene: ClientScene
  readonly children?: ReactNode
}): ReactElement {
  return createElement(SceneContext.Provider, { value: scene }, children)
}
