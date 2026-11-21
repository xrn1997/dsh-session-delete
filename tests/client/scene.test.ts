/**
 * 场景 seam（`src/client/scene.ts`）：两份场景互不共享、Provider 下发传入的那一份、无 Provider 回退
 * 进程场景。每个用例一份新场景由 `support/setup.ts` 装好。
 */
import { createElement, type ReactElement } from 'react'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ClientContextLike } from '../../src/client/context.js'
import {
  ClientSceneProvider,
  createClientScene,
  getDefaultClientScene,
  installClientScene,
  type ClientScene,
} from '../../src/client/scene.js'
import type { TrashEntryLike } from '../../src/client/remote.js'
import {
  publishUndoBatchNotice,
  useUndoNotice,
} from '../../src/client/undo-notices.js'
import { useTrashRevision } from '../../src/client/trash-store.js'
import { useSelection } from '../../src/client/batch-selection-store.js'
import { useDeleteRequest } from '../../src/client/delete-confirm.js'
import { useDeleteBatchRequest } from '../../src/client/batch-confirm.js'
import { useVisibleSelectableRows } from '../../src/client/host-rows.js'

const ROW: TrashEntryLike = {
  id: 'a',
  sessionId: 'session-a',
  projectDir: '--p--',
  workspaceId: 'ws',
  wasArchived: false,
  deletedAt: 1,
  sizeBytes: 10,
  releaseBytes: 10,
  title: '条目',
}

/** 一条探测贡献：把四类现场里「组件能读到的那几格」摊成一行文本。 */
function Probe(): ReactElement {
  const revision = useTrashRevision()
  const notice = useUndoNotice()
  const selection = useSelection()
  const deleteRequest = useDeleteRequest()
  const batchRequest = useDeleteBatchRequest()
  const visibleRows = useVisibleSelectableRows(true)
  const state = [
    `rev:${revision}`,
    `notice:${notice === null ? '-' : notice.kind === 'one' ? notice.entryId : `batch:${notice.entryIds.join(',')}`}`,
    `selecting:${selection.selecting ? 'yes' : 'no'}`,
    `delete:${deleteRequest?.sessionId ?? '-'}`,
    `batch:${batchRequest?.items.length ?? 0}`,
    `rows:${visibleRows.length}`,
  ].join('|')
  return createElement('div', { 'data-testid': 'probe' }, state)
}

const probeText = (): string => screen.getByTestId('probe').textContent

/** 一段假 ctx：只给 `main-view` 要的 `uiWorkspace` 服务与 `get`。 */
function ctxWithMainView(current: string, clearMain: () => void): ClientContextLike {
  return {
    get: (name: string) => name === 'uiWorkspace'
      ? {
        selection: { getSnapshot: () => ({ sessionId: current }) },
        sessions: { list: { getSnapshot: () => ({ byId: { [current]: {} } }) } },
        clearMain,
        openSession: () => undefined,
      }
      : undefined,
  } as unknown as ClientContextLike
}

describe('场景实例 · 互不共享', () => {
  it('首帧快照/详情账本：两份场景各写各的，默认场景不受影响', () => {
    const a = createClientScene()
    const b = createClientScene()
    a.snapshot.reloadSucceeded([ROW])
    a.snapshot.noteSelection('a')
    a.snapshot.writeDetail('a', {
      entryId: 'a', cwd: '', createdAt: 0, lastActivity: 0, logTitle: '', models: [],
      turnCount: 0, userMessageCount: 0, assistantMessageCount: 0, toolCallCount: 0,
      injectedCount: 0, blocks: [], olderCursor: null,
    })

    expect(a.snapshot.read()?.selectedId).toBe('a')
    expect(a.snapshot.readDetail('a')?.entryId).toBe('a')
    expect(b.snapshot.read()).toBeNull()
    expect(b.snapshot.readDetail('a')).toBeUndefined()
    expect(getDefaultClientScene().snapshot.read()).toBeNull()
  })

  it('撤销台 / 批量选中 / 两个请求现场：一份实例里的动作不出现在另一份', () => {
    const a = createClientScene()
    const b = createClientScene()
    a.undo.publishOne({ entryId: 'e1', title: '标题' })
    a.batchSelection.enter()
    a.batchSelection.toggle({ sessionId: 'session-a', title: '标题' })
    a.deleteRequest.request({ sessionId: 'session-a', title: '标题' })

    expect(a.undo.read()).toMatchObject({ kind: 'one', entryId: 'e1' })
    expect(a.batchSelection.get().selecting).toBe(true)
    expect(a.batchSelection.get().picks).toHaveLength(1)
    expect(b.batchSelection.get()).toEqual({ selecting: false, picks: [] })
    expect(b.undo.read()).toBeNull()
  })

  it('行登记：两台场景各有一张「当前可见行」表', () => {
    const a = createClientScene()
    const b = createClientScene()
    a.hostRows.register('session-a', { title: '甲', live: false })
    expect(a.hostRows.readVisible()).toEqual([{ sessionId: 'session-a', title: '甲' }])
    expect(a.hostRows.pickable('session-a')?.title).toBe('甲')
    expect(b.hostRows.readVisible()).toEqual([])
    expect(b.hostRows.pickable('session-a')).toBeUndefined()
  })

  it('主视图记忆：一份场景关掉自己的主视图，另一份不受影响', () => {
    const a = createClientScene()
    const b = createClientScene()
    const clearA = vi.fn()
    const clearB = vi.fn()
    a.mainView.bind(ctxWithMainView('session-a', clearA))
    b.mainView.bind(ctxWithMainView('session-a', clearB))

    a.mainView.afterDelete(['session-a'])
    expect(clearA).toHaveBeenCalledTimes(1)
    expect(clearB).not.toHaveBeenCalled()
  })
})

describe('场景实例 · Provider 下发', () => {
  it('Provider 里的组件读到的是传入的那一份（含修订/撤销/选中/请求/行登记）', () => {
    const scene = createClientScene()
    render(
      createElement(
        ClientSceneProvider,
        { scene },
        createElement(Probe),
      ),
    )
    expect(probeText()).toBe('rev:0|notice:-|selecting:no|delete:-|batch:0|rows:0')

    act(() => {
      scene.trashRevisions.invalidate()
      scene.undo.publishOne({ entryId: 'e1', title: '标题' })
      scene.batchSelection.enter()
      scene.deleteRequest.request({ sessionId: 'session-a', title: '标题' })
      scene.batchConfirm.request([{ sessionId: 'session-a', title: '标题' }])
      scene.hostRows.register('session-a', { title: '甲', live: false })
    })
    expect(probeText()).toBe('rev:1|notice:e1|selecting:yes|delete:session-a|batch:1|rows:1')

    // 默认场景（自由函数）里的公告不进这棵 Provider 树。
    act(() => { publishUndoBatchNotice({ entryIds: ['default-only'], n: 9 }) })
    expect(probeText()).toBe('rev:1|notice:e1|selecting:yes|delete:session-a|batch:1|rows:1')
  })

  it('无 Provider：回退进程场景，默认场景 reset 不动私有场景', () => {
    const privateScene = createClientScene()
    privateScene.snapshot.reloadSucceeded([ROW])
    privateScene.undo.publishOne({ entryId: 'private', title: '标题' })

    render(createElement(Probe))
    expect(probeText()).toBe('rev:0|notice:-|selecting:no|delete:-|batch:0|rows:0')

    act(() => { publishUndoBatchNotice({ entryIds: ['e1', 'e2'], n: 2 }) })
    expect(probeText()).toContain('notice:batch:e1,e2')

    act(() => { getDefaultClientScene().reset() })
    expect(probeText()).toBe('rev:0|notice:-|selecting:no|delete:-|batch:0|rows:0')
    // 默认场景被清，私有场景原样。
    expect(privateScene.snapshot.read()?.rows).toHaveLength(1)
  })

  it('`scene.reset()` 收场：九份现场一起回初值', () => {
    const scene: ClientScene = createClientScene()
    scene.snapshot.reloadSucceeded([ROW])
    scene.undo.publishOne({ entryId: 'e1', title: '标题' })
    scene.batchSelection.enter()
    scene.hostRows.register('session-a', { title: '甲', live: false })
    scene.batchConfirm.request([{ sessionId: 'session-a', title: '标题' }])

    scene.reset()

    expect(scene.snapshot.read()).toBeNull()
    expect(scene.undo.read()).toBeNull()
    expect(scene.batchSelection.get()).toEqual({ selecting: false, picks: [] })
    expect(scene.hostRows.readVisible()).toEqual([])
    // 请求现场只能经 hook 读；`reset` 后没有待确认请求 → Provider 里的读数回初值。
    render(createElement(ClientSceneProvider, { scene }, createElement(Probe)))
    expect(probeText()).toBe('rev:0|notice:-|selecting:no|delete:-|batch:0|rows:0')
  })
})

describe('场景安装 · 注册面', () => {
  it('已有默认场景时沿用它：返回默认那一份、旧状态不丢、候选实例不被采纳', () => {
    publishUndoBatchNotice({ entryIds: ['kept'], n: 1 })
    const candidate = createClientScene()
    candidate.undo.publishOne({ entryId: 'candidate', title: '候选' })

    const installed = installClientScene(candidate)

    // 返回值必须是 Provider 要用的那一份（否则生产两份账）；默认已存在 ⇒ 不换新。
    expect(installed).toBe(getDefaultClientScene())
    expect(installed).not.toBe(candidate)
    expect(installed.undo.read()).toMatchObject({ kind: 'batch', entryIds: ['kept'] })
    expect(candidate.undo.read()).toMatchObject({ kind: 'one', entryId: 'candidate' })
  })

  it('省略候选时已安装就不现造：返回默认那一份', () => {
    const installed = installClientScene()
    expect(installed).toBe(getDefaultClientScene())
  })

  it('`replace` 换新：采纳候选、旧现场原样留着，返回的就是候选那一份', () => {
    const before = getDefaultClientScene()
    act(() => { publishUndoBatchNotice({ entryIds: ['old'], n: 1 }) })
    const candidate = createClientScene()

    const installed = installClientScene(candidate, { replace: true })

    expect(installed).toBe(candidate)
    expect(getDefaultClientScene()).toBe(candidate)
    // 旧实例不被清：换新只是让默认指针改道，不是拿它当 reset。
    expect(before.undo.read()).toMatchObject({ kind: 'batch', entryIds: ['old'] })
    expect(installed.undo.read()).toBeNull()
  })

  it('用返回值建 Provider：自由函数写入与 Provider 读数是同一份账', () => {
    const installed = installClientScene(createClientScene())
    render(createElement(ClientSceneProvider, { scene: installed }, createElement(Probe)))
    expect(probeText()).toBe('rev:0|notice:-|selecting:no|delete:-|batch:0|rows:0')

    act(() => { publishUndoBatchNotice({ entryIds: ['same-account'], n: 1 }) })
    expect(probeText()).toContain('notice:batch:same-account')
  })
})
