/**
 * 浏览器半的**场景 seam**：八份跨槽位现场聚成一个实例。进程场景必须由注册面安装（未装即接线错，不懒建第二份账）；
 * 测试每例换新；各槽位经 `ClientSceneProvider` 读同一实例（宿主槽位是互不相邻的 React 树）。
 *
 * **环内模块顶层只许字面量初始化**：本文件与八个现场模块互相 import，顶层读环内导出会踩 TDZ / `undefined`。
 */
import { createContext, createElement, useContext, type ReactElement, type ReactNode } from 'react'
import { createArchiveRevisionScene, type ArchiveRevisionScene } from './archive-store.js'
import { createBatchSelectionScene, type BatchSelectionScene } from './batch-selection-store.js'
import { createDeleteActionScene, type DeleteActionScene } from './delete-action.js'
import { createHostRowsScene, type HostRowsScene } from './host-rows.js'
import { createMainViewScene, type MainViewScene } from './main-view.js'
import { createTrashRevisionScene, type TrashRevisionScene } from './trash-store.js'
import { createTrashSnapshotScene, type TrashSnapshotScene } from './trash-snapshot.js'
import { createUndoNoticeScene, type UndoNoticeScene } from './undo-notices.js'

export interface ClientScene {
  readonly trashRevisions: TrashRevisionScene
  readonly archiveRevisions: ArchiveRevisionScene
  readonly snapshot: TrashSnapshotScene
  readonly undo: UndoNoticeScene
  readonly mainView: MainViewScene
  readonly hostRows: HostRowsScene
  readonly batchSelection: BatchSelectionScene
  readonly deleteAction: DeleteActionScene
  /** 场景收场：八份现场一起回初值（测试收场只调这一条）。 */
  reset(): void
}

export function createClientScene(): ClientScene {
  const scene: ClientScene = {
    trashRevisions: createTrashRevisionScene(),
    archiveRevisions: createArchiveRevisionScene(),
    snapshot: createTrashSnapshotScene(),
    undo: createUndoNoticeScene(),
    mainView: createMainViewScene(),
    hostRows: createHostRowsScene(),
    batchSelection: createBatchSelectionScene(),
    deleteAction: createDeleteActionScene(),
    reset(): void {
      scene.trashRevisions.reset()
      scene.archiveRevisions.reset()
      scene.snapshot.reset()
      scene.undo.reset()
      scene.mainView.reset()
      scene.hostRows.reset()
      scene.batchSelection.reset()
      scene.deleteAction.reset()
    },
  }
  return scene
}

let activeScene: ClientScene | null = null

export function getDefaultClientScene(): ClientScene {
  if (activeScene === null) {
    throw new Error('ClientScene 尚未安装：注册面先 installClientScene()，测试走 tests/client/support/setup.ts')
  }
  return activeScene
}

/** 已有就沿用（HMR 二次激活不换现场）；省略候选时只在未安装时现造一份；`replace` 只给测试。返回 Provider 要用的那一份。 */
export function installClientScene(
  candidate?: ClientScene,
  options: { readonly replace?: boolean } = {},
): ClientScene {
  if (activeScene === null || options.replace === true) activeScene = candidate ?? createClientScene()
  return activeScene
}

const SceneContext = createContext<ClientScene | null>(null)

export function useClientScene(): ClientScene {
  return useContext(SceneContext) ?? getDefaultClientScene()
}

/** 宿主各槽位是互不相邻的 React 树：每个贡献各包一次，拿到的是同一实例（ADR-0048 无共同父级）。 */
export function ClientSceneProvider({ scene, children }: {
  readonly scene: ClientScene
  readonly children?: ReactNode
}): ReactElement {
  return createElement(SceneContext.Provider, { value: scene }, children)
}
