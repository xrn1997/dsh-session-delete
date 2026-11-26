import { useEffect, useRef } from 'react'
import type { BusyGate } from './busy-gate.js'
import type { OneShotDeps } from './remote.js'
import { getDefaultClientScene, useClientScene } from './scene.js'
import { createStore, useLatest } from './store.js'
import { deleteSessionFromMenu, type TrashMoveTarget } from './write-seats.js'

export interface DeleteActionRequest extends TrashMoveTarget {
  readonly seq: number
}

export interface DeleteActionScene {
  request(input: TrashMoveTarget): void
  clear(expected: DeleteActionRequest): void
  use(): DeleteActionRequest | null
  reset(): void
}

export function createDeleteActionScene(): DeleteActionScene {
  const requestStore = createStore<DeleteActionRequest | null>(null)
  return {
    request(input): void {
      requestStore.publish((seq) => ({ seq, sessionId: input.sessionId, title: input.title }))
    },
    clear(expected): void {
      requestStore.update((current) => (current === expected ? null : current))
    },
    use(): DeleteActionRequest | null {
      return requestStore.use()
    },
    reset(): void {
      requestStore.reset()
    },
  }
}

export function requestDelete(input: TrashMoveTarget): void {
  getDefaultClientScene().deleteAction.request(input)
}

export function useDeleteActionRequest(): DeleteActionRequest | null {
  return useClientScene().deleteAction.use()
}

/**
 * 菜单「移入回收站」的常驻动作宿主（挂 `shell.overlay`，不画界面）：
 * - 按 `handledRef` 认同一个请求对象引用，挡住 React StrictMode 对同一请求的二次 effect；
 * - 按 `inFlightRef` 维护跨 tick 的单会话单飞，同一会话在飞时再点菜单不发第二趟写；
 * - 错误兜底 + finally 清请求，防止 unhandled rejection 或请求悬挂。
 */
export function DeleteActionHost({ deps }: { deps: OneShotDeps }): null {
  const current = useDeleteActionRequest()
  const scene = useClientScene()
  const depsRef = useLatest(deps)
  const handledRef = useRef<DeleteActionRequest | null>(null)
  const inFlightRef = useRef(new Set<string>())

  useEffect(() => {
    if (current === null || handledRef.current === current) return
    handledRef.current = current
    const request = current
    const around: BusyGate['around'] = async (task) => {
      if (inFlightRef.current.has(request.sessionId)) return { kind: 'blocked' }
      inFlightRef.current.add(request.sessionId)
      try {
        return { kind: 'ran', value: await task() }
      } finally {
        inFlightRef.current.delete(request.sessionId)
      }
    }
    void (async () => {
      try {
        const run = await deleteSessionFromMenu(depsRef.current, request, { around })
        if (run.kind === 'blocked') return
        if (run.value !== null) scene.undo.publishFailure(run.value)
      } catch (error: unknown) {
        const message = error instanceof Error && error.message !== '' ? error.message : String(error)
        scene.undo.publishFailure(message)
      } finally {
        scene.deleteAction.clear(request)
      }
    })()
  }, [current, depsRef, scene])

  return null
}
