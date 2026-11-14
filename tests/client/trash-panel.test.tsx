// 回收站清单面板（浏览器半的单元层）。入口迁到全局面板后，本文件只管面板本体：
// 座位与注册形状归 `index.test.tsx`，这里钉交互与状态机。
//
// 2026-10-15 两栏改版：断点由 ResizeObserver 的读数决定，所以每个用例先决定"这一趟是宽档还是窄档"
// （`renderWide` / `renderNarrow`，替身见 support/observe-width.ts）。jsdom 没有真实布局，
// `clientWidth` 恒 0 ⇒ 不装替身就是窄档，正好也是"读不到就当窄"那条默认。
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fileSizeText } from '../../src/client/ui/format.js'
import { TrashPanel } from '../../src/client/trash-panel.js'
import { DeleteConfirmHost } from '../../src/client/delete-confirm.js'
import { UndoToast } from '../../src/client/undo-toast.js'
import {
  readCachedTrashDetail,
  readTrashSnapshot,
  writeTrashDetail,
  reloadSucceeded,
  noteSelection,
} from '../../src/client/trash-snapshot.js'
import { invalidateTrash } from '../../src/client/trash-store.js'
import { resetClientState } from '../../src/client/reset-client-state.js'
import type { ApplyAction, ApplyOutcome } from '../../src/shared/wire.js'
import type { ArchiveDetailLike, PurgeResultLike, RemoteOutcome, TrashDetailLike } from '../../src/client/remote.js'
import type { ArchiveListWire } from '../../src/shared/wire.js'
import type { ArchiveRowWire } from '../../src/shared/wire.js'
import { installWidthObserver, type WidthObserver } from './support/observe-width.js'
import { createFakeRemote, remoteFail, remoteOk, type FakeRemote } from './support/fake-remote.js'
import { failed, ok, outcomes, restoreOutcomes, trashRow } from './support/outcomes.js'
import { firePointer } from './support/pointer.js'
import { must, pick } from '../support/fixture.js'

// 修订号与首帧快照都是模块级现场（跨用例存活）：每个用例前复位，用例之间互不串味。
beforeEach(() => {
  resetClientState()
})

const rows = [
  { id: 'a', sessionId: 'session-a', projectDir: '--p--', workspaceId: 'ws', wasArchived: false, deletedAt: 1, sizeBytes: 224 * 1024, releaseBytes: 224 * 1024, title: '/code-review' },
]

/** `ORPHANS` = 有一组两个孩子的残留（"盘上干净"那一份是假远端的缺省，不必在本文件再写一遍）。
 *  形状就是 `shared/wire.ts` 的 `OrphanReportWire`，`roots` 是**每组那个"父没了"的 subagent 自己**的 id。
 *  本文件只拿它当"盘上确实有残留"的现场，证明面板不再自动扫、也不再摆提示；检查/清理的用例
 *  住 `orphan-maintenance.test.tsx` / `maintenance-settings.test.tsx` / `use-maintenance.test.tsx`。 */
const ORPHANS = {
  roots: ['session-root'], totalSessions: 2, totalBytes: 2 * 1024, missingParents: 1,
  groups: [{ projectDir: '--p--', sessions: 2, bytes: 2 * 1024 }],
}

const detailFixture: TrashDetailLike = {
  entryId: 'a', cwd: 'C:/develop/p', createdAt: 1, lastActivity: 2, logTitle: '日志里的标题',
  models: ['m-1'], turnCount: 1, userMessageCount: 1, assistantMessageCount: 1, toolCallCount: 3,
  injectedCount: 7,
  blocks: [
    { kind: 'user', id: '0', time: 1, text: '先看改动', truncated: false, attachments: [] },
    { kind: 'assistant', id: '1', time: 2, text: '改动分四层', truncated: false, attachments: [] },
  ],
  olderCursor: null,
}

/** 逐条 `/apply` 回执：面板的恢复走单条读法（N=1 的 `null` 是协议错）⇒ 成功支要让 support 给真行，
 *  其余动作按动作的中性默认值；`fail` 里点名的 id 换成那一句失败原文。 */
function outcomesOf(
  action: ApplyAction, ids: readonly string[], fail: Readonly<Record<string, string>> = {},
): ApplyOutcome[] {
  const receipts = action === 'restore' ? restoreOutcomes(ids) : outcomes(action, ids)
  return receipts.map((outcome) => {
    const message = fail[outcome.id]
    return message === undefined ? outcome : failed(action, outcome.id, message)
  })
}

function makeDeps(over: Partial<FakeRemote> = {}): FakeRemote {
  return createFakeRemote({
    list: vi.fn(async () => remoteOk(rows)),
    applyOutcomes: vi.fn(async (action: ApplyAction, ids: readonly string[]) => remoteOk(outcomesOf(action, ids))),
    emptyTrash: vi.fn(async () => remoteOk({ removed: 1, freedBytes: 1 })),
    detail: vi.fn(async () => remoteOk(detailFixture)),
    ...over,
  })
}

/** 一段可以手动决定何时落地的 promise（测「保持旧详情」用）。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((inResolve) => { resolve = inResolve })
  return { promise, resolve }
}

/** 宽档：RO 交回 1100 ⇒ 左右两栏（清单默认 420 + 详情吃余下）。 */
function renderWide(deps: FakeRemote) {
  const observer: WidthObserver = installWidthObserver()
  const view = render(<TrashPanel deps={deps} />)
  act(() => { observer.pump(1100) })
  return { ...view, observer }
}

/** 窄档：RO 交回 400 ⇒ 点行下钻。 */
function renderNarrow(deps: FakeRemote) {
  const observer: WidthObserver = installWidthObserver()
  const view = render(<TrashPanel deps={deps} />)
  act(() => { observer.pump(400) })
  return { ...view, observer }
}

/* 下面那些 `await screen.findByText(标题)` 是**清单画出来了**这道就绪屏障，不判内容。宽档两栏同时在
 * 屏上，同一个标题会出现在清单行与详情头两处（详情标题优先用清册那一份），那 10 处只能写
 * `findAllByText`：份数不在屏障上判，各用例自己按 DOM 与 aria 断言。窄档只有一栏，照旧写严格的
 * `findByText`——多画一份就该红。 */

describe('回收站面板', () => {
  it('空回收站显示空态且没有清空按钮', async () => {
    render(<TrashPanel deps={makeDeps({ list: vi.fn(async () => remoteOk([])) })} />)
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '清空回收站…' })).not.toBeInTheDocument()
    // 空态是普通内容块，不是「空的 grid」：没有行时不挂 grid 与它的 aria（ADR-0028）。
    expect(screen.queryByRole('grid')).toBeNull()
  })

  // jsdom 没有布局，"居中"只能钉那条链本身：单列外壳与清单容器都吃 `flex:1 1 auto`，
  // 空态块自己的 `flex:1` + `justifyContent:center` 才有高度可居。2026-10-16 真机回归：
  // 两栏改造在清单容器那节把链断在"内容高"上 ⇒ 空态图标贴到左上角。
  it('空态的居中链：单列外壳与清单容器都是 flex:1 1 auto', async () => {
    const { container } = render(<TrashPanel deps={makeDeps({ list: vi.fn(async () => remoteOk([])) })} />)
    await screen.findByText('回收站是空的')
    const listBox = container.querySelector('[data-dsh-session-delete="trash-list"]') as HTMLElement
    expect((listBox.parentElement as HTMLElement).style.flex).toBe('1 1 auto')
    expect(listBox.style.flex).toBe('1 1 auto')
  })

  // 动作住在行右侧（2026-10-15 真机反馈后回到 2026-10-01 的形状，docs/ui-spec.md），所以这条直接点行内那颗。
  it('行右侧的「恢复」调 restore 并带上条目 id（动作住在行内，2026-10-15 真机反馈后回归原形）', async () => {
    const deps = makeDeps()
    renderWide(deps)
    const row = await screen.findByRole('row', { name: /code-review/ })
    fireEvent.click(within(row).getByRole('button', { name: /^恢复/ }))
    await waitFor(() => expect(deps.applyOutcomes).toHaveBeenCalledWith('restore', ['a']))
  })

  it('窄档点行内动作按钮不顺手下钻：按钮不冒泡成整行点击', async () => {
    const deps = makeDeps()
    renderNarrow(deps)
    const row = await screen.findByRole('row', { name: /code-review/ })
    fireEvent.click(within(row).getByRole('button', { name: /^恢复/ }))
    await waitFor(() => expect(deps.applyOutcomes).toHaveBeenCalledWith('restore', ['a']))
    // 还在清单里；若按钮点击冒泡到整行，窄档会切到详情、这一行从 DOM 消失。
    expect(screen.getByRole('row', { name: /code-review/ })).toBeInTheDocument()
  })

  // 工作区已被删掉（宿主的「删除工作区」只删注册、保留日志）⇒ 条目直接归入「未分组」组。
  // 分组本身就是去向的说明，行上不再挂一句提示。
  it('工作区已不存在的条目归入「未分组」组（沉底），行上不再挂提示', async () => {
    const gone = render(
      <TrashPanel deps={makeDeps({ list: vi.fn(async () => remoteOk([{ ...pick(rows, 0), workspaceMissing: true }])) })} />,
    )
    expect(await screen.findByRole('row', { name: /code-review/ })).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /未分组/ })).toBeInTheDocument()
    expect(screen.queryByText(/原工作区已不存在/)).toBeNull()
    gone.unmount()

    render(<TrashPanel deps={makeDeps()} />)
    await screen.findByRole('row', { name: /code-review/ })
    expect(screen.queryByRole('row', { name: /未分组/ })).toBeNull()
  })

  it('清空要先二次确认，确认后才调清空（一段一次）', async () => {
    const deps = makeDeps()
    render(<TrashPanel deps={deps} />)
    fireEvent.click(await screen.findByRole('button', { name: '清空回收站…' }))
    expect(deps.emptyTrash).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }))
    await waitFor(() => expect(deps.emptyTrash).toHaveBeenCalledTimes(1))
  })

  it('清空失败 ⇒ 清单失败块上屏，旧行的页脚动作不再出现', async () => {
    const deps = makeDeps({
      emptyTrash: vi.fn(async () => remoteFail({ code: 'sessiondelete/io', message: '清空失败' })),
    })
    render(<TrashPanel deps={deps} />)
    fireEvent.click(await screen.findByRole('button', { name: '清空回收站…' }))
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }))
    expect(await screen.findByText(/清空失败/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '清空回收站…' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^彻底删除/ })).not.toBeInTheDocument()
  })

  // 动作住在行内 ⇒ 它的失败也就留在行内（与 2026-10-01 那条"失败写在该行上"同一条规则）。
  it('恢复失败的原因写在那一行上，不弹全局错误', async () => {
    const deps = makeDeps({
      applyOutcomes: vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk(ids.map((id) => ({
        id, action, ok: false as const,
        error: { code: 'sessiondelete/project-missing', message: '原项目目录已不存在' },
      })))),
    })
    renderWide(deps)
    const row = await screen.findByRole('row', { name: /code-review/ })
    fireEvent.click(within(row).getByRole('button', { name: /^恢复/ }))
    expect(await screen.findByRole('status')).toHaveTextContent(/原项目目录已不存在/)
  })
})

describe('回收站面板 · 两栏与下钻', () => {
  it('宽档：清单在左（420 定宽、动作在行右侧）、详情在右', async () => {
    const { container } = renderWide(makeDeps())
    const row = await screen.findByRole('row', { name: /code-review/ })
    // 两颗动作住在行里（图标按钮，无文字），且点击它们不许把"选中"改掉（选中是点行，不是点按钮）
    const actions = within(row).getAllByRole('button')
    expect(actions).toHaveLength(2)
    expect(actions.map((button) => button.className)).toEqual(['sd-icon-btn', 'sd-icon-btn sd-icon-btn-danger'])
    expect(row).toHaveAttribute('aria-selected', 'true') // 宽档自动选中就是这一条
    expect(container.querySelector('[data-dsh-session-delete="trash-list"]')).toBeInTheDocument()
    expect(container.querySelector('[data-dsh-session-delete="trash-detail"]')).toBeInTheDocument()
    // 左栏的定宽 = 面板常量（box-sizing:border-box，含给滚动条的 10px 内边距）
    expect((must(container.querySelector('[data-dsh-session-delete="trash-list"]'), 'trash-list 元素').parentElement as HTMLElement).style.width).toBe('420px')
  })

  it('窄档：先只有清单（动作照样在行右侧），点行才下钻出详情；「← 返回清单」回得去且选中还在', async () => {
    const deps = makeDeps()
    const { container } = renderNarrow(deps)
    const row = await screen.findByRole('row', { name: /code-review/ })
    expect(within(row).getByRole('button', { name: /^恢复/ })).toBeInTheDocument()
    expect(container.querySelector('[data-dsh-session-delete="trash-detail"]')).not.toBeInTheDocument()

    fireEvent.click(row)
    expect(await screen.findByText('先看改动')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '← 返回清单' }))
    expect(screen.getByRole('row', { name: /code-review/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('button', { name: '← 返回清单' })).not.toBeInTheDocument()
    expect(deps.detail).toHaveBeenCalledTimes(1)
  })

  it('宽度是跟着中央列走的：从宽变窄不重取数，选中还在，再点一下就回到那条详情', async () => {
    const deps = makeDeps()
    const view = renderWide(deps)
    fireEvent.click(await screen.findByRole('row', { name: /code-review/ }))
    await screen.findByText('先看改动')
    // 变窄之后不硬塞一个"正在下的钻"：回到清单，选中留着，点一下就用账本回来了（不重读、不重列）
    act(() => { view.observer.pump(400) })
    expect(screen.getByRole('row', { name: /code-review/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByText('先看改动')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('row', { name: /code-review/ }))
    expect(await screen.findByText('先看改动')).toBeInTheDocument()
    expect(deps.detail).toHaveBeenCalledTimes(1)
    expect(deps.list).toHaveBeenCalledTimes(1)
  })

  it('宽档首读完成后自动选中第一条（右栏不该空着）', async () => {
    const deps = makeDeps()
    renderWide(deps)
    expect(await screen.findByText('先看改动')).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /code-review/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('详情读失败只坏详情那一块：清单仍可选、行内动作仍可点', async () => {
    const deps = makeDeps({
      detail: vi.fn(async () => remoteFail({ code: 'sessiondelete/io', message: '读会话日志失败：第 2 帧解压失败' })),
    })
    renderWide(deps)
    expect(await screen.findByRole('status')).toHaveTextContent(/第 2 帧解压失败/)
    const row = screen.getByRole('row', { name: /code-review/ })
    expect(within(row).getByRole('button', { name: /^恢复/ })).toBeEnabled()
    // 「重试」只重读那一条，不牵清单
    deps.detail.mockResolvedValue({ ok: true, value: detailFixture })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('先看改动')).toBeInTheDocument()
    expect(deps.list).toHaveBeenCalledTimes(1)
  })
})

describe('回收站面板 · 详情分页与折叠状态', () => {
  const reasoningBlock = (id: string, text: string) => ({
    kind: 'reasoning' as const, id, time: 1, text, truncated: false, attachments: [],
  })

  it('点「加载更早」补页：二次 /detail 带游标，早页 prepend 在尾页之前', async () => {
    const tail: TrashDetailLike = {
      ...detailFixture,
      blocks: [{ kind: 'user', id: '10', time: 1, text: '尾页正文', truncated: false, attachments: [] }],
      olderCursor: 10,
    }
    const older: TrashDetailLike = {
      ...detailFixture,
      blocks: [{ kind: 'user', id: '7', time: 1, text: '更早正文', truncated: false, attachments: [] }],
      olderCursor: null,
    }
    const deps = makeDeps({
      detail: vi.fn(async (_entryId: string, before?: number) => remoteOk((before === undefined ? tail : older))),
    })
    const { container } = renderWide(deps)

    expect(await screen.findByText('尾页正文')).toBeInTheDocument()
    // 分页只由读者点按钮发起（ADR-0057）：滚动不再代劳，jsdom 里也不必伪造 scrollTop。
    fireEvent.click(await screen.findByRole('button', { name: '加载更早' }))
    expect(await screen.findByText('更早正文')).toBeInTheDocument()
    expect(deps.detail).toHaveBeenLastCalledWith('a', 10)

    const messages = [...container.querySelectorAll('[data-dsh-session-delete="trash-detail"] [data-sd-msg]')]
      .map((node) => node.textContent)
    expect(messages[0]).toContain('更早正文')
    expect(messages[1]).toContain('尾页正文')
  })

  it('详情带提问索引时右缘出提问轨：点已加载的那句高亮，点没加载的走补页再落位', async () => {
    const tail: TrashDetailLike = {
      ...detailFixture,
      prompts: [
        { id: '0', at: 1, preview: '先看改动' },
        { id: '2', at: 3, preview: '更早的一句' },
      ],
      blocks: [{ kind: 'user', id: '0', time: 1, text: '先看改动', truncated: false, attachments: [] }],
      olderCursor: 2,
    }
    const older: TrashDetailLike = {
      ...tail,
      blocks: [{ kind: 'user', id: '2', time: 3, text: '更早的一句', truncated: false, attachments: [] }],
      olderCursor: null,
    }
    const deps = makeDeps({
      detail: vi.fn(async (_entryId: string, before?: number) => remoteOk((before === undefined ? tail : older))),
    })
    const { container } = renderWide(deps)

    expect(await screen.findByText('先看改动')).toBeInTheDocument()
    const marks = [...container.querySelectorAll('.sd-prompt-mark')]
    expect(marks).toHaveLength(2)
    // 右缘是正文列宽的函数，由面板算好以行内 `right` 交给轨——样式表里不写死列宽。
    const rail = container.querySelector<HTMLElement>('nav.sd-prompt-rail')
    expect(rail?.style.right).toContain('calc(100% - ')

    // 已加载的那句：不发请求，直接落位（只对齐、不画落地框；jsdom 没有 scrollIntoView）。
    fireEvent.click(marks[0] as Element)
    expect(deps.detail).toHaveBeenCalledTimes(1)
    expect(marks[0]).toHaveAttribute('aria-current', 'true')

    // 没加载的那句：按当前游标补一页，目标进窗后落位。
    fireEvent.click(marks[1] as Element)
    await waitFor(() => {
      expect(marks[1]).toHaveAttribute('aria-current', 'true')
    })
    expect(deps.detail).toHaveBeenLastCalledWith('a', 2)
  })

  it('窄档未下钻不画提问轨；下钻后随详情挂上，退回清单再收掉', async () => {
    const withPrompts: TrashDetailLike = {
      ...detailFixture,
      prompts: [{ id: '0', at: 1, preview: '先看改动' }],
    }
    const { container } = renderNarrow(makeDeps({ detail: vi.fn(async () => remoteOk(withPrompts)) }))
    const row = await screen.findByRole('row', { name: /code-review/ })
    // 详情栏不在 DOM 里时轨也不许提前挂——它挂在详情栏外壳上。
    expect(container.querySelector('.sd-prompt-rail')).toBeNull()

    fireEvent.click(row)
    await screen.findByRole('button', { name: '← 返回清单' })
    await waitFor(() => { expect(container.querySelectorAll('.sd-prompt-mark')).toHaveLength(1) })

    fireEvent.click(screen.getByRole('button', { name: '← 返回清单' }))
    expect(container.querySelector('.sd-prompt-rail')).toBeNull()
  })

  it('切换条目重置折叠：A 展开的块不带去 B，切回 A 也回到默认折叠', async () => {
    const two = [
      { ...pick(rows, 0), id: 'a', title: '第一条' },
      { ...pick(rows, 0), id: 'b', title: '第二条' },
    ]
    const deps = makeDeps({
      list: vi.fn(async () => remoteOk(two)),
      detail: vi.fn(async (entryId: string) => remoteOk(({
        ...detailFixture,
        entryId,
        blocks: [reasoningBlock(entryId, `${entryId} 的思考正文`)],
      }))),
    })
    const { container } = renderWide(deps)

    // 逐块折叠的判据住在「详细」档（默认标准档把过程块收成一组）。
    fireEvent.click(await screen.findByRole('button', { name: '详细' }))
    const fold = await screen.findByRole('button', { name: /思考/ })
    fireEvent.click(fold)
    expect(fold).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(screen.getByRole('row', { name: /第二条/ }))
    // 换条目先保持上一条（A）的详情，正文整块 inert；等 B 的详情头出现再切档，
    // 否则点到的是被保持住的 A 的那一颗。
    const pane = must(
      container.querySelector<HTMLElement>('[data-dsh-session-delete="trash-detail"]'),
      '两栏详情栏',
    )
    await waitFor(() => { expect(within(pane).queryByText('第二条')).not.toBeNull() })
    // 换条目重挂载详情：档位也回到默认「标准」；切到详细再验这一条的折叠是新的。
    fireEvent.click(await screen.findByRole('button', { name: '详细' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /思考/ })).toHaveAttribute('aria-expanded', 'false'))
    expect(screen.getByText('b 的思考正文')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('row', { name: /第一条/ }))
    // 切回来先把档位切到详细，才看得见块；正文与折叠状态都是新的。
    fireEvent.click(await screen.findByRole('button', { name: '详细' }))
    await waitFor(() => expect(screen.getByText('a 的思考正文')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /思考/ })).toHaveAttribute('aria-expanded', 'false')
    // 切回来读的是账本，不重发 /detail。
    expect(deps.detail).toHaveBeenCalledTimes(2)
  })
})

describe('回收站面板 · 切换稳定性', () => {
  const two = [
    { ...pick(rows, 0), id: 'a', title: '第一条' },
    { ...pick(rows, 0), id: 'b', title: '第二条' },
  ]

  /** 按条目给一份带独立正文的详情，「A 的正文 / B 的正文」用来判断画的是哪一帧。 */
  function detailOf(id: string, text: string): TrashDetailLike {
    return {
      ...detailFixture,
      entryId: id,
      blocks: [{ kind: 'user', id: '0', time: 1, text, truncated: false, attachments: [] }],
    }
  }

  it('有首帧快照时首帧画旧行与旧详情，不出「正在读回收站…」', async () => {
    reloadSucceeded(rows)
    noteSelection('a')
    writeTrashDetail('a', detailFixture)
    const pending = deferred<RemoteOutcome<typeof rows>>()
    const { container } = renderWide(makeDeps({ list: vi.fn(() => pending.promise) }))

    // 首帧就是快照的那三份行：份数钉死（多画一份 = 快照与新一份同时在屏上）。
    expect(screen.queryByText('正在读回收站…')).not.toBeInTheDocument()
    expect(container.querySelectorAll('[data-dsh-session-delete="trash-row"]')).toHaveLength(rows.length)
    expect(screen.getByText('先看改动')).toBeInTheDocument()
    // 重读在飞只挂 `aria-busy`，不画「更新中」字样（ADR-0048 的刷新中不是第四态）。
    expect(must(container.querySelector('[data-dsh-session-delete="trash-list"]'), 'trash-list 元素')
      .getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByText('更新中')).not.toBeInTheDocument()
    await act(async () => { pending.resolve(remoteOk(rows)) })
    expect(must(container.querySelector('[data-dsh-session-delete="trash-list"]'), 'trash-list 元素')
      .hasAttribute('aria-busy')).toBe(false)
  })

  it('切到没读过的条目：上一帧详情留到新数据落地，落地后整帧换', async () => {
    const pending = deferred<RemoteOutcome<TrashDetailLike>>()
    const deps = makeDeps({
      list: vi.fn(async () => remoteOk(two)),
      detail: vi.fn((entryId: string) => entryId === 'a'
        ? Promise.resolve(remoteOk(detailOf('a', 'A 的正文')))
        : pending.promise),
    })
    renderWide(deps)

    expect(await screen.findByText('A 的正文')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('row', { name: /第二条/ }))
    expect(screen.getByText('A 的正文')).toBeInTheDocument()
    expect(document.querySelectorAll('.sd-skeleton-bar')).toHaveLength(0)

    await act(async () => { pending.resolve(remoteOk(detailOf('b', 'B 的正文'))) })
    expect(await screen.findByText('B 的正文')).toBeInTheDocument()
  })

  it('切到没读过的条目：保持期轨跟着上一条禁用顶住，新详情到了再恢复', async () => {
    const pending = deferred<RemoteOutcome<TrashDetailLike>>()
    const withPrompts = (id: string, text: string): TrashDetailLike => ({
      ...detailOf(id, text),
      prompts: [{ id: '0', at: 1, preview: `${text} 的提问` }],
    })
    const deps = makeDeps({
      list: vi.fn(async () => remoteOk(two)),
      detail: vi.fn((entryId: string) => entryId === 'a'
        ? Promise.resolve(remoteOk(withPrompts('a', 'A 的正文')))
        : pending.promise),
    })
    const { container } = renderWide(deps)
    expect(await screen.findByText('A 的正文')).toBeInTheDocument()
    const rail = (): HTMLElement | null => container.querySelector<HTMLElement>('nav.sd-prompt-rail')
    const marks = (): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>('.sd-prompt-mark')]
    expect(rail()?.getAttribute('data-disabled')).toBeNull()

    fireEvent.click(screen.getByRole('row', { name: /第二条/ }))
    expect(screen.getByText('A 的正文')).toBeInTheDocument()
    expect(rail()).not.toBeNull()
    expect(rail()?.getAttribute('data-disabled')).toBe('true')
    expect(marks().length).toBeGreaterThan(0)
    expect(marks().every((mark) => mark.disabled)).toBe(true)

    await act(async () => { pending.resolve(remoteOk(withPrompts('b', 'B 的正文'))) })
    expect(await screen.findByText('B 的正文')).toBeInTheDocument()
    expect(rail()?.getAttribute('data-disabled')).toBeNull()
    expect(marks().every((mark) => mark.disabled)).toBe(false)
  })

  it('切到已读条目：详情滚动位置回到顶部', async () => {
    const deps = makeDeps({
      list: vi.fn(async () => remoteOk(two)),
      detail: vi.fn(async (entryId: string) => remoteOk(detailOf(entryId, `${entryId} 的正文`))),
    })
    const { container } = renderWide(deps)
    expect(await screen.findByText('a 的正文')).toBeInTheDocument()
    const pane = container.querySelector<HTMLElement>('[data-dsh-session-delete="trash-detail"]')
    expect(pane).not.toBeNull()
    if (pane !== null) pane.scrollTop = 120

    fireEvent.click(screen.getByRole('row', { name: /第二条/ }))
    expect(await screen.findByText('b 的正文')).toBeInTheDocument()
    expect(pane?.scrollTop).toBe(0)

    if (pane !== null) pane.scrollTop = 90
    fireEvent.click(screen.getByRole('row', { name: /第一条/ }))
    expect(await screen.findByText('a 的正文')).toBeInTheDocument()
    expect(pane?.scrollTop).toBe(0)
  })

  it('两栏都无条件预留滚动条槽', async () => {
    const { container } = renderWide(makeDeps())
    await screen.findAllByText('/code-review')
    expect(container.querySelectorAll('.sd-stable-scroll')).toHaveLength(2)
  })

  it('hover 一条 150ms 后才预取；提前移开不读', async () => {
    const deps = makeDeps({
      list: vi.fn(async () => remoteOk(two)),
      detail: vi.fn(async (entryId: string) => remoteOk(detailOf(entryId, `${entryId} 的正文`))),
    })
    renderWide(deps)
    expect(await screen.findByText('a 的正文')).toBeInTheDocument()
    const calls = (): unknown[] => deps.detail.mock.calls.map((call) => call[0])
    expect(calls()).toEqual(['a'])

    const rowB = screen.getByRole('row', { name: /第二条/ })
    fireEvent.pointerOver(rowB)
    fireEvent.pointerOut(rowB)
    await new Promise((resolve) => { setTimeout(resolve, 200) })
    expect(calls()).toEqual(['a'])

    fireEvent.pointerOver(rowB)
    await waitFor(() => { expect(calls()).toEqual(['a', 'b']) })
  })

  it('键盘落到一条 150ms 后也预取', async () => {
    const deps = makeDeps({
      list: vi.fn(async () => remoteOk(two)),
      detail: vi.fn(async (entryId: string) => remoteOk(detailOf(entryId, `${entryId} 的正文`))),
    })
    renderWide(deps)
    expect(await screen.findByText('a 的正文')).toBeInTheDocument()

    fireEvent.focusIn(screen.getByRole('row', { name: /第二条/ }))
    await waitFor(() => { expect(deps.detail.mock.calls.map((call) => call[0])).toEqual(['a', 'b']) })
  })
})

describe('回收站面板 · 键盘', () => {
  const two = [
    { ...rows[0], id: 'a', projectDir: '--p--', title: '第一条', deletedAt: 300 },
    { ...rows[0], id: 'b', projectDir: '--p--', title: '第二条', deletedAt: 100 },
  ]

  it('ArrowDown 第一次落到第一条、第二次走到下一条；Enter 在窄档进下钻', async () => {
    const deps = makeDeps({ list: vi.fn(async () => remoteOk(two)) })
    renderNarrow(deps)
    const first = await screen.findByRole('row', { name: /第一条/ })
    // 还没选中任何东西时，ArrowDown 的标准语义是"落到第一项"，不是跳过第一项
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(screen.getByRole('row', { name: /第一条/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(screen.getByRole('row', { name: /第二条/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(screen.getByRole('row', { name: /第二条/ }), { key: 'Enter' })
    expect(await screen.findByRole('button', { name: '← 返回清单' })).toBeInTheDocument()
    expect(screen.getByText('先看改动')).toBeInTheDocument()
  })

  it('ArrowUp 从第一条回到最后一条（清单里是环，不是撞墙）', async () => {
    const deps = makeDeps({ list: vi.fn(async () => remoteOk(two)) })
    renderNarrow(deps)
    const first = await screen.findByRole('row', { name: /第一条/ })
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('row', { name: /第一条/ }), { key: 'ArrowUp' })
    expect(screen.getByRole('row', { name: /第二条/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('下钻里按 Esc 退回清单：选中不变，焦点交还给那一行', async () => {
    const deps = makeDeps({ list: vi.fn(async () => remoteOk(two)) })
    renderNarrow(deps)
    fireEvent.click(await screen.findByRole('row', { name: /第二条/ }))
    await screen.findByRole('button', { name: '← 返回清单' })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: '← 返回清单' })).not.toBeInTheDocument()
    const row = screen.getByRole('row', { name: /第二条/ })
    expect(row).toHaveAttribute('aria-selected', 'true')
    expect(document.activeElement).toBe(row)
    expect(deps.detail).toHaveBeenCalledTimes(1)
  })

  it('条目 id 带引号：交还焦点仍按属性值找行，不把 id 拼进选择器', async () => {
    const awkward = [{ ...rows[0], id: 'a"b', projectDir: '--p--', title: '带引号的那条', deletedAt: 300 }]
    const deps = makeDeps({ list: vi.fn(async () => remoteOk(awkward)) })
    renderNarrow(deps)
    fireEvent.click(await screen.findByRole('row', { name: /带引号的那条/ }))
    await screen.findByRole('button', { name: '← 返回清单' })
    fireEvent.keyDown(document, { key: 'Escape' })
    const row = screen.getByRole('row', { name: /带引号的那条/ })
    expect(row).toHaveAttribute('aria-selected', 'true')
    expect(document.activeElement).toBe(row)
  })

  it('条目 id 含空白：DOM id 合法且与 aria-activedescendant 同源，data-entry-id 仍是原始 id', async () => {
    // 目录名只挡路径分隔符，空白是合法字符：HTML id 归 DOM 侧编码，entry id 本身不许改形
    // （它是回收站目录名，恢复要按它反推原目录名）。issue #8 第 7 条。
    const awkward = [{ ...pick(rows, 0), id: '20261019T120000Z-my session', title: '带空白的那条' }]
    const { container } = renderWide(makeDeps({ list: vi.fn(async () => remoteOk(awkward)) }))
    const row = await screen.findByRole('row', { name: /带空白的那条/ })
    expect(row.id).not.toMatch(/\s/)
    expect(row.id).toBe(`sd-trash-${encodeURIComponent('20261019T120000Z-my session')}`)
    expect(row.getAttribute('data-entry-id')).toBe('20261019T120000Z-my session')
    // 宽档自动选中第一条 ⇒ activedescendant 必须指向同一枚 DOM id
    await waitFor(() =>
      expect(must(container.querySelector('[data-dsh-session-delete="trash-list"]'), 'trash-list 元素').getAttribute('aria-activedescendant')).toBe(row.id))
  })

  it('下钻里打开确认框：Esc 只关框，下钻不退；再按才回清单', async () => {
    const deps = makeDeps({ list: vi.fn(async () => remoteOk(two)) })
    renderNarrow(deps)
    fireEvent.click(await screen.findByRole('row', { name: /第二条/ }))
    await screen.findByRole('button', { name: '← 返回清单' })
    fireEvent.click(screen.getByRole('button', { name: '清空回收站…' }))
    await screen.findByRole('dialog')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '← 返回清单' })).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: '← 返回清单' })).not.toBeInTheDocument()
  })

  it('写入在飞时 Esc 不关框也不退下钻，焦点留在框里', async () => {
    let finish: (() => void) | undefined
    const deps = makeDeps({
      list: vi.fn(async () => remoteOk(two)),
      emptyTrash: vi.fn(() => new Promise<RemoteOutcome<PurgeResultLike>>((resolve) => {
        finish = () => { resolve(remoteOk({ removed: 2, freedBytes: 2 })) }
      })),
    })
    renderNarrow(deps)
    fireEvent.click(await screen.findByRole('row', { name: /第二条/ }))
    await screen.findByRole('button', { name: '← 返回清单' })
    fireEvent.click(screen.getByRole('button', { name: '清空回收站…' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: '彻底删除' }))
    const cancel = dialog.getByRole<HTMLButtonElement>('button', { name: '取消' })
    await waitFor(() => expect(cancel.disabled).toBe(true))
    const close = dialog.getByRole('button', { name: '关闭' })
    close.focus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '← 返回清单' })).toBeInTheDocument()
    expect(document.activeElement).toBe(close)
    await act(async () => { finish?.() })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('清单那一块是 grid：每行一个 row，选中的带 aria-selected；组是带名字的 rowgroup', async () => {
    const deps = makeDeps({ list: vi.fn(async () => remoteOk(two)) })
    renderWide(deps)
    const list = await screen.findByRole('grid')
    expect(list).toHaveAccessibleName('回收站清单')
    // 组头行没有 aria-selected，用它把条目行从 row 总数里分出来。
    const rows = within(list).getAllByRole('row').filter((row) => row.hasAttribute('aria-selected'))
    expect(rows).toHaveLength(2)
    expect(rows.filter((row) => row.getAttribute('aria-selected') === 'true')).toHaveLength(1)
    // 组不再是具名 section（映射成 region，会打断 grid→row 的所有权链）：是带名字的 rowgroup。
    const group = within(list).getByRole('rowgroup')
    expect(group).toHaveAccessibleName(group.querySelector('.sd-disclosure-title')?.textContent ?? '')
  })

  it('行内动作按钮住在 gridcell 里、树里没有任何 option（option 的后代会被 AT 抹平）', async () => {
    const deps = makeDeps({ list: vi.fn(async () => remoteOk(rows)) })
    renderWide(deps)
    const row = await screen.findByRole('row', { name: /code-review/ })
    expect(document.querySelector('[role="option"]')).toBeNull()
    expect(within(row).getAllByRole('gridcell').length).toBeGreaterThan(0)
    for (const button of within(row).getAllByRole('button')) {
      expect(button.closest('[role="gridcell"]')).not.toBeNull()
    }
  })

  it('列数一致是显式声明的：grid 带 colcount，组头一格 colspan 横跨，条目行恒两格（多选态不变）', async () => {
    const deps = makeDeps({ list: vi.fn(async () => remoteOk(two)) })
    renderWide(deps)
    const list = await screen.findByRole('grid')
    expect(list).toHaveAttribute('aria-colcount', '2')
    // 组头行也是 row：唯一一格横跨整行，列数才与条目行对得上。
    const headRow = within(list).getAllByRole('row').find((row) => !row.hasAttribute('aria-selected'))
    const headCells = within(must(headRow, '组头行')).getAllByRole('gridcell')
    expect(headCells).toHaveLength(1)
    expect(headCells[0]).toHaveAttribute('aria-colspan', '2')
    const entryRows = within(list).getAllByRole('row').filter((row) => row.hasAttribute('aria-selected'))
    for (const row of entryRows) expect(within(row).getAllByRole('gridcell')).toHaveLength(2)
    // 多选态勾选框占内容前的一格、动作列退场：格数与列数声明都不变。
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    expect(list).toHaveAttribute('aria-colcount', '2')
    for (const row of entryRows) expect(within(row).getAllByRole('gridcell')).toHaveLength(2)
  })
})

describe('回收站面板 · 其余行为', () => {
  it('头部给出条数与共可释放量（与彻底删除确认同一口径）', async () => {
    render(<TrashPanel deps={makeDeps()} />)
    expect(await screen.findByText('1 个会话 · 可释放 224KB')).toBeInTheDocument()
  })

  // 「刷新」图标 2026-10-16 按用户裁定删除（清单每次读都对账，它没有别人替代不了的活）；
  // 这里钉住"它确实没了"，免得哪天又被顺手加回来。
  it('那一排只有「全部折叠」「多选」两颗钮（「刷新」已删）', async () => {
    const { container } = render(<TrashPanel deps={makeDeps()} />)
    await screen.findByText('/code-review')
    const toolbar = container.querySelector('[data-dsh-session-delete="trash-toolbar"]') as HTMLElement
    expect(within(toolbar).getAllByRole('button').map((b) => b.textContent.trim())).toEqual(['全部折叠', '多选'])
    expect(screen.queryByRole('button', { name: '重新读一遍回收站' })).toBeNull()
  })

  // 真机反馈：删完在别处（侧栏菜单），面板是"挂载时取一次数"，不切走再回来就看不见新条目。
  it('别处动过回收站（失效通告）时立刻重读清单，不用切走再回来', async () => {
    const deps = makeDeps({ list: vi.fn().mockResolvedValueOnce(remoteOk([])).mockResolvedValueOnce(remoteOk(rows)) })
    render(<TrashPanel deps={deps} />)
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()

    act(() => {
      invalidateTrash()
    })

    expect(await screen.findByText('/code-review')).toBeInTheDocument()
    expect(deps.list).toHaveBeenCalledTimes(2)
  })

  it('恢复成功后把清单重新读一遍，那一行就没了、详情让位', async () => {
    const deps = makeDeps({
      list: vi.fn().mockResolvedValueOnce(remoteOk(rows)).mockResolvedValueOnce(remoteOk([])),
      })
    renderWide(deps)
    const row = await screen.findByRole('row', { name: /code-review/ })
    await screen.findByText('先看改动')
    fireEvent.click(within(row).getByRole('button', { name: /^恢复/ }))
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
    expect(screen.queryByText('先看改动')).not.toBeInTheDocument()
    expect(deps.list).toHaveBeenCalledTimes(2)
  })

  it('行里的「彻底删除」也要先确认，确认后走一次 purge（N=1 的批量）', async () => {
    const deps = makeDeps()
    renderWide(deps)
    const row = await screen.findByRole('row', { name: /code-review/ })
    fireEvent.click(within(row).getByRole('button', { name: /^彻底删除/ }))
    expect(deps.applyOutcomes).not.toHaveBeenCalled()
    expect(screen.getByText(/没有任何副本可以恢复/)).toBeInTheDocument()
    // 危险层级跟动作走，不跟入口大小走：单条彻底删除同样是实心红（六张框各传各的 `danger`）。
    expect(screen.getByRole('button', { name: '彻底删除' })
      .style.getPropertyValue('--sd-button-primary-fill')).toBe('var(--dsw-alias-state-error-primary)')
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }))
    await waitFor(() => expect(deps.applyOutcomes).toHaveBeenCalledWith('purge', ['a']))
  })

  // 附件清理是**上一趟写的后果**：清单照常重读，但这句警告要留在面板顶部（面板把回执里那半句交给 query，
  // 再读 `attachmentNotice` 渲染）。任务简报里写的"给 query 夹具塞 attachmentNotice"在这里不适用——
  // 本文件用真 hook + 假远端整块渲染，所以这条从真回执走上来，断言的是接线而不是夹具。
  it('彻底删除的回执说「N 个附件未清」⇒ 面板顶部摆出那句警告', async () => {
    const deps = makeDeps({
      applyOutcomes: vi.fn(async (_action: ApplyAction, ids: readonly string[]) => remoteOk(outcomes('purge', ids, {
        a: { value: { removed: 1, freedBytes: 1, attachments: { removed: 0, freedBytes: 0, failed: 2 } } },
      }))),
    })
    renderWide(deps)
    const row = await screen.findByRole('row', { name: /code-review/ })
    fireEvent.click(within(row).getByRole('button', { name: /^彻底删除/ }))
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }))
    expect(await screen.findByText('已删除会话，但 2 个附件未能清理')).toBeInTheDocument()
  })

  // 彻底删除按组走（组语义见 src/trash/groups.ts）⇒ 点下去页脚合计掉的是「父 + 全部孩子」。确认框那一格说的是
  // "我即将失去多少"，所以它必须是同一个口径，不能只报父自己那一格（issue #2）。
  it('单条彻底删除的确认卡片报的是整组要释放的字节（父 + 孩子）', async () => {
    const group = [{ ...pick(rows, 0), sizeBytes: 1024, releaseBytes: 1536, subagentCount: 2, subagentBytes: 512 }]
    const deps = makeDeps({ list: vi.fn(async () => remoteOk(group)) })
    renderWide(deps)
    const row = await screen.findByRole('row', { name: /code-review/ })
    fireEvent.click(within(row).getByRole('button', { name: /^彻底删除/ }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/1\.5KB/)).toBeInTheDocument()
    expect(within(dialog).queryByText(/1\.0KB/)).not.toBeInTheDocument()
  })

  it('清空的确认框里点名不可恢复；取消一个字节都不动', async () => {
    const deps = makeDeps({ emptyTrash: vi.fn() })
    render(<TrashPanel deps={deps} />)
    fireEvent.click(await screen.findByRole('button', { name: '清空回收站…' }))
    expect(screen.getByText(/没有任何副本可以恢复/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(deps.emptyTrash).not.toHaveBeenCalled()
    expect(deps.applyOutcomes).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('清单本身读不到时把原文摆在面板上，不是空态', async () => {
    const deps = makeDeps({
      list: vi.fn(async () => remoteFail({ code: 'sessiondelete/io', message: '回收站清单损坏' })),
    })
    render(<TrashPanel deps={deps} />)
    expect(await screen.findByText(/回收站清单损坏/)).toBeInTheDocument()
    expect(screen.queryByText('回收站是空的')).not.toBeInTheDocument()
  })

  it('读失败时给「重试」，点一下把清单重读一遍', async () => {
    const deps = makeDeps({
      list: vi
        .fn()
        .mockResolvedValueOnce(remoteFail({ code: 'sessiondelete/io', message: '回收站清单损坏' }))
        .mockResolvedValueOnce(remoteOk(rows)),
    })
    render(<TrashPanel deps={deps} />)
    await waitFor(() => expect(deps.list).toHaveBeenCalledTimes(1))
    // 读数失败也是普通内容块：没有可导航的行，就不挂 grid。
    expect(screen.queryByRole('grid')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: '重试' }))
    expect(await screen.findByText('/code-review')).toBeInTheDocument()
    expect(deps.list).toHaveBeenCalledTimes(2)
  })

  // 改版前 `entries === null` 那一拍什么都不画：读得慢就是一块没有解释的空。
  it('首读未回时不是空态（不拿「回收站是空的」骗人）', async () => {
    let release: (value: RemoteOutcome<typeof rows>) => void = () => {}
    const deps = makeDeps({ list: vi.fn(() => new Promise<RemoteOutcome<typeof rows>>((resolve) => { release = resolve })) })
    render(<TrashPanel deps={deps} />)
    expect(screen.queryByText('回收站是空的')).not.toBeInTheDocument()
    expect(screen.getByText('正在读回收站…')).toBeInTheDocument()
    // 加载中也还没有行：容器不挂 grid（ADR-0028）。
    expect(screen.queryByRole('grid')).toBeNull()
    // 挂载读排到生命周期微任务：先等它真的发出，再结算这份悬挂的响应。
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
    release(remoteOk(rows))
    expect(await screen.findByRole('grid')).toBeInTheDocument()
    expect(await screen.findByText('/code-review')).toBeInTheDocument()
  })
})

describe('回收站面板 · 分组卡片（2026-10-01 视觉改版的结构，两栏之后一条没让）', () => {
  const twoProjects = [
    { ...rows[0], id: 'a', projectDir: '--D-develop-GitHub-dsh-novel--', title: '书源解析回归', deletedAt: 100 },
    { ...rows[0], id: 'b', projectDir: '--D-develop-GitHub-dsh-novel--', title: '合并冲突', deletedAt: 300 },
    { ...rows[0], id: 'c', projectDir: '--C-Users-xrn--', title: '兼容排查', deletedAt: 200 },
  ]

  const groupsOf = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLElement>('[data-dsh-session-delete="trash-group"]'))

  it('按项目分组：组头只出现一次，名字是摘掉 `--…--` 裹边的目录名', async () => {
    const { container } = render(
      <TrashPanel deps={makeDeps({ list: vi.fn(async () => remoteOk(twoProjects)) })} />,
    )
    await screen.findByText('书源解析回归')
    const groups = groupsOf(container)
    expect(groups).toHaveLength(2)
    expect(within(pick(groups, 0)).getByText('D-develop-GitHub-dsh-novel')).toBeInTheDocument()
    expect(within(pick(groups, 0)).getByText('2 个会话')).toBeInTheDocument()
    expect(within(pick(groups, 1)).getByText('C-Users-xrn')).toBeInTheDocument()
    expect(within(pick(groups, 1)).getByText('1 个会话')).toBeInTheDocument()
    expect(within(pick(groups, 0)).getByText('书源解析回归')).toBeInTheDocument()
    expect(within(pick(groups, 0)).getByText('合并冲突')).toBeInTheDocument()
  })

  it('组按最新一条倒序，组内也按删除时间倒序', async () => {
    const { container } = render(
      <TrashPanel deps={makeDeps({ list: vi.fn(async () => remoteOk(twoProjects)) })} />,
    )
    await screen.findByText('书源解析回归')
    const groups = groupsOf(container)
    expect(pick(groups, 0).textContent).toMatch(/合并冲突[\s\S]*书源解析回归/)
    expect(pick(groups, 1).textContent).toContain('兼容排查')
  })

  it('时间走官方 relativeTime 的分桶，绝对时间留在 title 里', async () => {
    const at = Date.now() - (3 * 3600 + 60) * 1000
    render(<TrashPanel deps={makeDeps({ list: vi.fn(async () => remoteOk([{ ...rows[0], deletedAt: at }])) })} />)
    const meta = await screen.findByTitle(new Date(at).toLocaleString())
    expect(meta.textContent).toBe(`删除于 3小时前 · ${fileSizeText(pick(rows, 0).sizeBytes)}`)
  })

  it('now 桶说「刚刚删除」，不写出「删除于 刚刚前」', async () => {
    render(<TrashPanel deps={makeDeps({ list: vi.fn(async () => remoteOk([{ ...rows[0], deletedAt: Date.now() }])) })} />)
    expect(await screen.findByText(/刚刚删除 · 224KB/)).toBeInTheDocument()
    expect(screen.queryByText(/删除于 刚刚/)).not.toBeInTheDocument()
  })

  // 宿主客户端把 `origin:"subagent"` 的行整排藏掉（连「未分组」那一桶也过同一个过滤器）⇒ 删了父会话之后
  // 还剩多少孩子，用户从界面上**一个字都看不见**。这一栏就是把那个数说出来；没有计数时（宿主服务没挂、
  // 或这一条确实没孩子）半句都不许出现——不许拿「含 0 个」冒充「不知道」。
  it('行上如实显示「含 N 个子会话」', async () => {
    render(<TrashPanel deps={makeDeps({ list: vi.fn(async () => remoteOk([{ ...pick(rows, 0), subagentCount: 3 }])) })} />)
    expect(await screen.findByText(/含 3 个子会话/)).toBeInTheDocument()
  })

  it('没有计数 ⇒ 这半句一个字都不出现', async () => {
    const { container } = render(<TrashPanel deps={makeDeps()} />)
    const row = () => container.querySelector('[data-dsh-session-delete="trash-row"]')
    // 先证明这一行确实渲染了（否则"没有"是因为整行都没有），再证明那半句不在
    await waitFor(() => expect(row()?.textContent).toContain('224KB'))
    expect(row()?.textContent).not.toContain('子会话')
  })

  // 两个数不能互相冒充：`subagentCount` 是**跟着父一起进回收站**的孩子，
  // `strandedSubagents` 是**还留在盘上没被带走**的（级联落地之前删掉的那些存量）。
  // 后者说"含"就成了假话——用户会以为回收站里有它们、恢复能捞回来。
  it('盘上还剩的孩子说「还剩」，不许说成「含」', async () => {
    render(<TrashPanel deps={makeDeps({ list: vi.fn(async () => remoteOk([{ ...pick(rows, 0), strandedSubagents: 4 }])) })} />)
    expect(await screen.findByText(/盘上还剩 4 个子会话/)).toBeInTheDocument()
    expect(screen.queryByText(/含 4 个子会话/)).not.toBeInTheDocument()
  })

  it('两组都有 ⇒ 先说带进来的，再说还剩的（两个数各自站开）', async () => {
    render(<TrashPanel deps={makeDeps({ list: vi.fn(async () => remoteOk([{ ...pick(rows, 0), subagentCount: 2, strandedSubagents: 4 }])) })} />)
    const line = await screen.findByText(/含 2 个子会话/)
    expect(line.textContent).toContain('含 2 个子会话')
    expect(line.textContent).toContain('还剩 4 个')
  })

  it('头部合计要把组里孩子的字节算上（孩子不单独列行，只加父那一格就会少报）', async () => {
    render(<TrashPanel deps={makeDeps({
      list: vi.fn(async () => remoteOk([{ ...pick(rows, 0), sizeBytes: 1024, releaseBytes: 1536, subagentCount: 2, subagentBytes: 512 }])),
    })} />)
    expect(await screen.findByText(/1.5KB/)).toBeInTheDocument()
  })

  // 盘上还剩的孩子也会被彻底删除/清空连带带走（清册作用域的 `purge`），所以"共多少"与确认框那句
  // 「我即将失去多少」都读 Node 半算好的 `releaseBytes`（唯一算式在 `api/trash-rows.ts` 的 `toWire`），
  // 同一屏不许两套口径。
  it('头部合计与单条彻底删除确认都算上 strandedBytes', async () => {
    const row = { ...pick(rows, 0), strandedSubagents: 2, strandedBytes: 2 * 1024, releaseBytes: 224 * 1024 + 2 * 1024 }
    const deps = makeDeps({ list: vi.fn(async () => remoteOk([row])) })
    renderWide(deps)
    expect(await screen.findByText(/可释放 226KB/)).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('row', { name: /code-review/ })).getByRole('button', { name: /^彻底删除/ }))
    expect(within(screen.getByRole('dialog')).getByText(/226KB/)).toBeInTheDocument()
  })

  it('组头摘掉 `--…--` 裹边并还原 `~XXXX` 转义；没有目录时不编一个名字出来', async () => {
    const odd = [
      { ...rows[0], id: 'a', projectDir: '--D-develop-~4E2D~6587--', title: '中文目录' },
      { ...rows[0], id: 'b', projectDir: '_no-cwd', title: '无 cwd' },
      { ...rows[0], id: 'c', projectDir: '', title: '空串' },
    ]
    render(<TrashPanel deps={makeDeps({ list: vi.fn(async () => remoteOk(odd)) })} />)
    expect(await screen.findByText('D-develop-中文')).toBeInTheDocument()
    expect(screen.getAllByText('未记录项目')).toHaveLength(2)
  })

  // 整页只有一块实心红（2026-10-01 立的层级，两栏改版一步没让）。
  it('危险动作分两档：行内那颗图标只有字色，实心红仍然只有「清空回收站…」', async () => {
    renderWide(makeDeps())
    const row = await screen.findByRole('row', { name: /code-review/ })
    const danger = within(row).getByRole('button', { name: /^彻底删除/ })
    expect(danger.classList.contains('sd-icon-btn-danger')).toBe(true)
    // 图标按钮不铺底、不描边：危险层级只靠字色与悬停；实心红仍是页脚那一颗。
    expect(danger.style.background).toBe('')
    expect(danger.style.border).toBe('')

    const bulk = screen.getByRole('button', { name: '清空回收站…' })
    expect(bulk.classList.contains('sd-button-primary')).toBe(true)
    // 覆盖的是本插件别名层：别名在 `body` 上已把 `var(--dsw-…, 兜底)` 算完，元素上覆盖底层 token
    // 传不进继承值（见 `trash-view.ts` 的 `BULK_DANGER`）。
    expect(bulk.style.getPropertyValue('--sd-button-primary-fill')).toBe(
      'var(--dsw-alias-state-error-primary)',
    )
  })

  it('选中的行只换底色；未选中的行不带底色也不带描边', async () => {
    const twoRows = [
      pick(rows, 0),
      { ...pick(rows, 0), id: 'b', sessionId: 'session-b', title: '另一条会话' },
    ]
    const { container } = renderWide(makeDeps({ list: vi.fn(async () => remoteOk(twoRows)) }))
    const row = await screen.findByRole('row', { name: /code-review/ })
    expect(row.style.background).toBe('var(--sd-button-ghost-active-fill)')
    // 选中不再加描边：一列带框的行叠起来就是"一叠卡片"，那是这一版要去掉的长相。
    // 底色留在元素上而不是伪类里，是为了压过 `layout.css` 的悬停底色（元素声明优先于样式表规则）。
    expect(row.style.border).toBe('')
    // 两行才谈得上"未选中"：只渲一行时宽档必然把那唯一一行自动选中，未选中那一侧无从断言。
    const unselected = container.querySelectorAll('[aria-selected="false"]')
    expect(unselected).toHaveLength(1)
    const plain = unselected[0] as HTMLElement
    expect(plain.style.background).toBe('')
    expect(plain.style.border).toBe('')
    // 圆角仍然留着：悬停与选中的底色要靠它收边，去掉就变成一整条通栏。
    expect(plain.style.borderRadius).toBe('var(--sd-radius-lg)')
  })

  it('动作列住在自己的 gridcell 里，两颗图标按钮仍在可访问性树里', async () => {
    renderWide(makeDeps({ list: vi.fn(async () => remoteOk([pick(rows, 0)])) }))
    const row = await screen.findByRole('row', { name: /code-review/ })
    // 图标按钮的类名是 `layout.css` 提亮条件的接缝（上面那条已钉过）；这里钉它们仍住在同一格
    // `gridcell` 里：row 的直接子代必须是 cell，动作与内容走同一条 ARIA 判据。
    const buttons = within(row).getAllByRole('button')
    expect(buttons).toHaveLength(2)
    const cell = buttons[0]?.parentElement
    expect(cell?.getAttribute('role')).toBe('gridcell')
    expect(buttons[1]?.parentElement).toBe(cell)
    // 图标按钮常驻（默认低强调），两颗始终在可访问性树里：恢复只报动作（行名已经把标题念过
    // 一遍），彻底删除带对象——它要避开确认框那颗同名的「彻底删除」（判据住 copy.ts 的 `trash.row.purgeOne`）。
    expect(within(row).getByRole('button', { name: '恢复' })).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: /^彻底删除/ })).toBeInTheDocument()
  })

  it('窄档面板根挂 sd-narrow，宽档不挂（触屏动作常亮只认窄档）', async () => {
    const narrow = renderNarrow(makeDeps())
    await screen.findByRole('row', { name: /code-review/ })
    expect(must(narrow.container.querySelector<HTMLElement>('[data-dsh-session-delete="trash-panel"]'), '窄档面板根').classList.contains('sd-narrow')).toBe(true)
    narrow.unmount()

    const wide = renderWide(makeDeps())
    await screen.findByRole('row', { name: /code-review/ })
    expect(must(wide.container.querySelector<HTMLElement>('[data-dsh-session-delete="trash-panel"]'), '宽档面板根').classList.contains('sd-narrow')).toBe(false)
  })
})

describe('回收站面板 · 折叠 / 收起 / 拖栏（2026-10-15 视图三件）', () => {
  const twoProjects = [
    { ...rows[0], id: 'a', projectDir: '--P-one--', title: '甲组第一条', deletedAt: 300 },
    { ...rows[0], id: 'b', projectDir: '--P-one--', title: '甲组第二条', deletedAt: 200 },
    { ...rows[0], id: 'c', projectDir: '--P-two--', title: '乙组第一条', deletedAt: 100 },
  ]
  const depsOf = (): FakeRemote => makeDeps({ list: vi.fn(async () => remoteOk(twoProjects)) })
  const heads = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-dsh-session-delete="trash-group-head"]')] as HTMLElement[]
  const columnOf = (container: HTMLElement): HTMLElement =>
    (container.querySelector('[data-dsh-session-delete="trash-list"]') as HTMLElement).parentElement as HTMLElement
  const visibleRows = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-dsh-session-delete="trash-row"]')].map((el) => el.getAttribute('data-entry-id'))

  it('组头是带 aria-expanded 的按钮：折叠那一组后条目**不进 DOM**，别组照在', async () => {
    const { container } = renderNarrow(depsOf())
    await screen.findByText('甲组第一条')
    expect(heads(container)).toHaveLength(2)
    expect(pick(heads(container), 0).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(pick(heads(container), 0))
    expect(screen.queryByText('甲组第一条')).not.toBeInTheDocument()
    expect(screen.queryByText('甲组第二条')).not.toBeInTheDocument()
    expect(screen.getByText('乙组第一条')).toBeInTheDocument()
    expect(pick(heads(container), 0).getAttribute('aria-expanded')).toBe('false')
    // 组头本身不能被一起收掉——收掉就没有再点开的地方了
    expect(heads(container)).toHaveLength(2)
  })

  // 开合指示学宿主工作区行：默认官方文件夹图标（开/闭随状态），悬停换成实心三角并旋转（条件住 layout.css）。
  it('组头文件夹随开合换字形；三角的旋转类跟着状态走', async () => {
    const { container } = renderNarrow(depsOf())
    await screen.findByText('甲组第一条')
    const head = pick(heads(container), 0)
    const folder = head.querySelector('.sd-group-folder')
    const arrow = head.querySelector('.sd-group-arrow')
    expect(folder).not.toBeNull()
    expect(arrow).not.toBeNull()
    // 展开：开盖文件夹（官方 folder-open 里那一片 0.16 填充）+ 三角旋转 90°。
    expect(folder?.innerHTML).toContain('opacity="0.16"')
    expect(arrow?.classList.contains('sd-group-arrow-open')).toBe(true)
    fireEvent.click(head)
    // 收起：闭盖文件夹 + 三角回正。
    expect(folder?.innerHTML).not.toContain('opacity="0.16"')
    expect(arrow?.classList.contains('sd-group-arrow-open')).toBe(false)
    // 旧的下折/右折 chevron 不再出现在组头里（那一套已换成宿主的工作区行做法）。
    expect(head.querySelector('.sd-group-chevron svg')).not.toBeNull()
    expect(head.querySelectorAll('.sd-disclosure-leading')).toHaveLength(2)
  })

  it('折叠掉的组不参与 ↑↓：键盘序列只走看得见的行', async () => {
    const { container } = renderNarrow(depsOf())
    await screen.findByText('甲组第一条')
    fireEvent.click(pick(heads(container), 0))
    expect(visibleRows(container)).toEqual(['c'])
    fireEvent.keyDown(must(container.querySelector('[data-dsh-session-delete="trash-list"]'), 'trash-list 元素'), { key: 'ArrowDown' })
    const selected = container.querySelector('[data-dsh-session-delete="trash-row"][aria-selected="true"]') as HTMLElement
    expect(selected.getAttribute('data-entry-id')).toBe('c')
  })

  it('选中那条被折叠起来时，aria-activedescendant 不指向一个不在 DOM 的 id', async () => {
    const { container } = renderWide(depsOf())
    await screen.findAllByText('甲组第一条')
    const list = must(container.querySelector('[data-dsh-session-delete="trash-list"]'), 'trash-list 元素')
    expect(list.getAttribute('aria-activedescendant')).toBe('sd-trash-a')
    fireEvent.click(pick(heads(container), 0))
    expect(list.hasAttribute('aria-activedescendant')).toBe(false)
    // 详情不跟着折叠走：右栏读的还是那一条（标题优先用清册那一份，见 trash-detail 头注③）
    const detail = container.querySelector('[data-dsh-session-delete="trash-detail"]') as HTMLElement
    expect(detail.textContent).toContain('甲组第一条')
  })

  it('「全部折叠」一次收掉所有组，那颗钮换成「全部展开」，再点回来', async () => {
    const { container } = renderNarrow(depsOf())
    await screen.findByText('甲组第一条')
    fireEvent.click(screen.getByRole('button', { name: '全部折叠' }))
    expect(visibleRows(container)).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '全部展开' }))
    expect(visibleRows(container)).toEqual(['a', 'b', 'c'])
  })

  // 那一排住面板体顶端、不住清单列里：它原先在滚动容器内，长清单滚到底会把开关滚走。
  it('那一排是面板的直接子级，不在清单列的滚动容器里', async () => {
    const { container } = renderWide(depsOf())
    await screen.findAllByText('甲组第一条')
    const toolbar = container.querySelector('[data-dsh-session-delete="trash-toolbar"]') as HTMLElement
    expect(toolbar.parentElement).toBe(container.querySelector('[data-dsh-session-delete="trash-panel"]'))
    expect(container.querySelector('[data-dsh-session-delete="trash-list"]')).not.toContainElement(toolbar)
    // 宽度上限跟着清单列走（拖到多宽，那一排就多宽，视觉上仍"属于清单"）
    expect(toolbar.style.maxWidth).toBe('420px')
  })

  it('窄档没有分隔线（本来就一列，没有可让位的对象）', async () => {
    const { container } = renderNarrow(depsOf())
    await screen.findByText('甲组第一条')
    expect(container.querySelector('[role="separator"]')).toBeNull()
  })

  it('分隔线可拖：清单列宽跟着读数走，夹在上限里（1100 − 489 = 611）', async () => {
    const { container } = renderWide(depsOf())
    await screen.findAllByText('甲组第一条')
    const handle = container.querySelector('[role="separator"]') as HTMLElement
    expect(handle.getAttribute('aria-valuemin')).toBe('330')
    expect(handle.getAttribute('aria-valuenow')).toBe('420')
    expect(handle.getAttribute('aria-valuemax')).toBe('611')
    expect(handle.getAttribute('aria-label')).toBe('调整左右分栏宽度')
    expect(columnOf(container).style.width).toBe('420px')
    firePointer(handle, 'pointerdown', { clientX: 500 })
    firePointer(handle, 'pointermove', { clientX: 560 })
    expect(columnOf(container).style.width).toBe('480px')
    firePointer(handle, 'pointermove', { clientX: 9000 })
    expect(columnOf(container).style.width).toBe('611px')
    firePointer(handle, 'pointerup', { clientX: 9000 })
    expect(handle.hasAttribute('data-dragging')).toBe(false)
  })

  it('分隔线键盘：→ 一格 20px、Home 回默认 420', async () => {
    const { container } = renderWide(depsOf())
    await screen.findAllByText('甲组第一条')
    const handle = container.querySelector('[role="separator"]') as HTMLElement
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(columnOf(container).style.width).toBe('440px')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(columnOf(container).style.width).toBe('420px')
  })

  it('折叠与拖宽互不干扰：拖过之后折叠状态与条目可见性都照旧', async () => {
    const { container } = renderWide(depsOf())
    await screen.findAllByText('甲组第一条')
    fireEvent.click(pick(heads(container), 0))
    const handle = container.querySelector('[role="separator"]') as HTMLElement
    firePointer(handle, 'pointerdown', { clientX: 500 })
    firePointer(handle, 'pointermove', { clientX: 600 })
    firePointer(handle, 'pointerup', { clientX: 600 })
    expect(columnOf(container).style.width).toBe('520px')
    expect(visibleRows(container)).toEqual(['c'])
    expect(pick(heads(container), 0).getAttribute('aria-expanded')).toBe('false')
  })
})

describe('回收站面板 · 多选与批量动作（2026-10-15 删；2026-10-17 补恢复）', () => {
  const three = [
    { ...rows[0], id: 'a', projectDir: '--P-one--', title: '第一条', deletedAt: 300 },
    { ...rows[0], id: 'b', projectDir: '--P-one--', title: '第二条', deletedAt: 200 },
    { ...rows[0], id: 'c', projectDir: '--P-one--', title: '第三条', deletedAt: 100 },
  ]
  const depsOf = (
    over: {
      list?: ReturnType<typeof vi.fn>
      restore?: ReturnType<typeof vi.fn>
      applyOutcomes?: ReturnType<typeof vi.fn>
    } = {},
  ): FakeRemote =>
    makeDeps({
      list: over.list ?? vi.fn(async () => remoteOk(three)),
      applyOutcomes: over.applyOutcomes ?? vi.fn(async (action: ApplyAction, ids: readonly string[]) => remoteOk(outcomesOf(action, ids))),
    })

  const boxes = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLInputElement>('[data-dsh-session-delete="trash-row"] input[type="checkbox"]')]
  const rowOf = (container: HTMLElement, id: string) =>
    container.querySelector(`[data-dsh-session-delete="trash-row"][data-entry-id="${id}"]`) as HTMLElement
  const footerButton = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name })

  it('进多选：行内两颗按钮退场，每行左侧出勾选框，头部给计数', async () => {
    const { container } = renderNarrow(depsOf())
    await screen.findByText('第一条')
    expect(screen.getAllByRole('button', { name: /^恢复/ })).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    // 行内两颗动作退场（页脚还有「恢复 0 条 / 彻底删除 0 条」，所以按行断言，不按全页名字）。
    for (const row of container.querySelectorAll('[data-dsh-session-delete="trash-row"]')) {
      expect(within(row as HTMLElement).queryAllByRole('button')).toHaveLength(0)
    }
    expect(boxes(container)).toHaveLength(3)
    expect(screen.getByText('已选 0 条')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '退出多选' })).toBeInTheDocument()
  })

  it('点行 = 切换勾选；再点回退；详情那条不动', async () => {
    const { container } = renderWide(depsOf())
    await screen.findAllByText('第一条')
    const detail = () => (container.querySelector('[data-dsh-session-delete="trash-detail"]') as HTMLElement).textContent
    const before = detail()
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    fireEvent.click(rowOf(container, 'b'))
    expect(boxes(container).map((box) => box.checked)).toEqual([false, true, false])
    expect(screen.getByText('已选 1 条')).toBeInTheDocument()
    fireEvent.click(rowOf(container, 'b'))
    expect(screen.getByText('已选 0 条')).toBeInTheDocument()
    expect(detail()).toBe(before)
  })

  // `Checkbox` 里那句 stopPropagation 的钉子：不拦住冒泡，点框这一下会被行再处理一次 ⇒ 看着像点不动。
  it('直接点勾选框只翻一次（不被行的点击再翻回去）', async () => {
    const { container } = renderNarrow(depsOf())
    await screen.findByText('第一条')
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    fireEvent.click(pick(boxes(container), 0))
    expect(pick(boxes(container), 0).checked).toBe(true)
    expect(screen.getByText('已选 1 条')).toBeInTheDocument()
  })

  it('一条没勾时页脚那颗置灰，点它不弹确认', async () => {
    renderNarrow(depsOf())
    await screen.findByText('第一条')
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    const bulk = footerButton('彻底删除 0 条')
    expect(bulk.disabled).toBe(true)
    fireEvent.click(bulk)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('页脚那颗换成「彻底删除 N 条」：**一次** apply 带走整批（顺序仍是清单从上往下），并重读一次', async () => {
    const applyOutcomes = vi.fn(async (action: ApplyAction, ids: readonly string[]) => remoteOk(outcomesOf(action, ids)))
    const list = vi.fn(async () => remoteOk(three))
    const { container } = renderNarrow(depsOf({ applyOutcomes, list }))
    await screen.findByText('第一条')
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    fireEvent.click(rowOf(container, 'b'))
    fireEvent.click(rowOf(container, 'a'))
    expect(footerButton('彻底删除 2 条').disabled).toBe(false)
    fireEvent.click(footerButton('彻底删除 2 条'))
    expect(await screen.findByText('彻底删除 2 个会话？')).toBeInTheDocument()
    expect(screen.getByText(/没有任何副本可以恢复/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }))
    await waitFor(() => expect(applyOutcomes).toHaveBeenCalledTimes(1))
    // 顺序按清单从上往下，不按点击顺序；**不是**每条一次请求（那是"恢复很慢"的那个形状）
    expect(applyOutcomes).toHaveBeenCalledWith('purge', ['a', 'b'])
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it('清单清空后多选态仍有出口：退出按钮可用，点它回到普通态', async () => {
    const list = vi.fn().mockResolvedValueOnce(remoteOk(rows)).mockResolvedValue(remoteOk([]))
    const { container } = renderNarrow(depsOf({ list }))
    await screen.findByText('/code-review')
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    fireEvent.click(rowOf(container, 'a'))
    fireEvent.click(footerButton('彻底删除 1 条'))
    fireEvent.click(await screen.findByRole('button', { name: '彻底删除' }))
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
    const exit = screen.getByRole<HTMLButtonElement>('button', { name: '退出多选' })
    expect(exit.disabled).toBe(false)
    fireEvent.click(exit)
    expect(screen.getByRole('button', { name: '多选' })).toBeInTheDocument()
  })

  // 跨项目多选是**扁平 entries 序**与**屏幕分组序**唯一会分叉的地方：组间按各组最新一条排，
  // 组内按删除时间排；顺序若取扁平序，批量动作的"清单从上往下"就是假话。
  it('跨项目多选：批量顺序按屏幕上的分组顺序（组间最新一条、组内删除时间），不是扁平 deletedAt 序', async () => {
    const crossed = [
      { ...rows[0], id: 'a', projectDir: '--P-one--', title: 'A1', deletedAt: 300 },
      { ...rows[0], id: 'b', projectDir: '--P-two--', title: 'B1', deletedAt: 250 },
      { ...rows[0], id: 'c', projectDir: '--P-one--', title: 'A2', deletedAt: 100 },
    ]
    const applyOutcomes = vi.fn(async (action: ApplyAction, ids: readonly string[]) => remoteOk(outcomesOf(action, ids)))
    const list = vi.fn().mockResolvedValueOnce(remoteOk(crossed)).mockResolvedValue(remoteOk([]))
    const { container } = renderNarrow(depsOf({ applyOutcomes, list }))
    await screen.findByText('A1')
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    for (const id of ['a', 'b', 'c']) fireEvent.click(rowOf(container, id))
    fireEvent.click(footerButton('恢复 3 条'))
    const dialog = within(await screen.findByRole('dialog'))
    // 确认框列出的顺序与批量执行共用同一份 checkedIds（A1、A2 同组，B1 在下一组）
    expect(dialog.getAllByText(/^[AB][12]$/).map((node) => node.textContent)).toEqual(['A1', 'A2', 'B1'])
    fireEvent.click(dialog.getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(applyOutcomes).toHaveBeenCalledWith('restore', ['a', 'c', 'b']))
  })

  it('部分失败：删掉的走、没删掉的把原文留在它自己那一行，多选态不退', async () => {
    const applyOutcomes = vi.fn(async (_action: string, ids: readonly string[]) => remoteOk(
      outcomesOf('purge', ids, { b: '该会话正被占用' })))
    // 注意 `mockResolvedValue` 调两次是**替换**实现、不是排队（踩过：首屏就直接拿到第二份数据），
    // 要"先给全量、重读后给少一条"必须用 `mockResolvedValueOnce` 起头。
    const list = vi.fn().mockResolvedValueOnce(remoteOk(three)).mockResolvedValue(remoteOk([three[1], three[2]]))
    const { container } = renderNarrow(depsOf({ applyOutcomes, list }))
    await screen.findByText('第一条')
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    fireEvent.click(rowOf(container, 'a'))
    fireEvent.click(rowOf(container, 'b'))
    fireEvent.click(footerButton('彻底删除 2 条'))
    fireEvent.click(await screen.findByRole('button', { name: '彻底删除' }))
    expect(await screen.findByText('该会话正被占用')).toBeInTheDocument()
    expect(rowOf(container, 'b').textContent).toContain('该会话正被占用')
    expect(screen.getByRole('button', { name: '退出多选' })).toBeInTheDocument()
  })

  it('别处动过清单（重读）之后，已经不存在的 id 从勾选里剔掉', async () => {
    const list = vi.fn().mockResolvedValueOnce(remoteOk(three)).mockResolvedValue(remoteOk([three[0], three[1]]))
    const { container } = renderNarrow(depsOf({ list }))
    await screen.findByText('第一条')
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    fireEvent.click(rowOf(container, 'a'))
    fireEvent.click(rowOf(container, 'c'))
    expect(screen.getByText('已选 2 条')).toBeInTheDocument()
    act(() => {
      invalidateTrash()
    })
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(screen.getByText('已选 1 条')).toBeInTheDocument()
    expect(boxes(container).map((box) => box.checked)).toEqual([true, false])
  })

  it('一条没勾时批量恢复也置灰，点它不弹确认', async () => {
    renderNarrow(depsOf())
    await screen.findByText('第一条')
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    const bulk = footerButton('恢复 0 条')
    expect(bulk.disabled).toBe(true)
    fireEvent.click(bulk)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('批量恢复走确认框：列出条目、确认后**一次** apply 带回整批顺序，恢复成功的不留行', async () => {
    const applyOutcomes = vi.fn(async (action: ApplyAction, ids: readonly string[]) => remoteOk(outcomesOf(action, ids)))
    const list = vi.fn().mockResolvedValueOnce(remoteOk(three)).mockResolvedValue(remoteOk([three[2]]))
    const { container } = renderNarrow(depsOf({ applyOutcomes, list }))
    await screen.findByText('第一条')
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    fireEvent.click(rowOf(container, 'b'))
    fireEvent.click(rowOf(container, 'a'))
    expect(footerButton('恢复 2 条').disabled).toBe(false)
    fireEvent.click(footerButton('恢复 2 条'))
    const dialog = within(await screen.findByRole('dialog'))
    // 确认框把要恢复的条目列出来（标题各一份）；恢复不是破坏性动作，不提"不可恢复"
    expect(dialog.getByText('恢复 2 个会话？')).toBeInTheDocument()
    expect(dialog.getByText('第二条')).toBeInTheDocument()
    expect(dialog.getByText(/原项目目录/)).toBeInTheDocument()
    expect(dialog.queryByText(/没有任何副本可以恢复/)).toBeNull()
    // 恢复不是破坏性动作：确认键仍是普通 primary，没有危险层级的 token 覆盖。
    expect(dialog.getByRole('button', { name: '恢复' })
      .style.getPropertyValue('--sd-button-primary-fill')).toBe('')
    // 确认框那颗与页脚那颗不同名（「恢复」vs「恢复 2 条」，同「彻底删除」那对的形状）
    fireEvent.click(dialog.getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(applyOutcomes).toHaveBeenCalledTimes(1))
    // 顺序按清单从上往下（同批量彻底删除），不按点击顺序；一次请求带走整批
    expect(applyOutcomes).toHaveBeenCalledWith('restore', ['a', 'b'])
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('第三条')).toBeInTheDocument()
    expect(screen.queryByText('第一条')).toBeNull()
    // 多选态不退：成功的勾选随行消失，头部计数跟着降
    expect(screen.getByRole('button', { name: '退出多选' })).toBeInTheDocument()
    expect(screen.getByText('已选 0 条')).toBeInTheDocument()
  })

  it('批量恢复的确认框里，原工作区不存在的条目也逐条说清去向', async () => {
    const flagged = three.map((e) => (e.id === 'b' ? { ...e, workspaceMissing: true } : e))
    const { container } = renderNarrow(depsOf({ list: vi.fn(async () => remoteOk(flagged)) }))
    await screen.findByText('第二条')
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    fireEvent.click(rowOf(container, 'b'))
    fireEvent.click(footerButton('恢复 1 条'))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('原工作区已不存在，恢复后归入未分组')).toBeInTheDocument()
  })

  it('批量恢复部分失败：成功的走、失败的把原文留在它自己那一行', async () => {
    const applyOutcomes = vi.fn(async (_action: string, ids: readonly string[]) => remoteOk(
      outcomesOf('restore', ids, { b: '原项目目录已不存在' })))
    const list = vi.fn().mockResolvedValueOnce(remoteOk(three)).mockResolvedValue(remoteOk([three[1]]))
    const { container } = renderNarrow(depsOf({ applyOutcomes, list }))
    await screen.findByText('第一条')
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    fireEvent.click(rowOf(container, 'a'))
    fireEvent.click(rowOf(container, 'b'))
    fireEvent.click(footerButton('恢复 2 条'))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '恢复' }))
    expect(await screen.findByText('原项目目录已不存在')).toBeInTheDocument()
    expect(rowOf(container, 'b').textContent).toContain('原项目目录已不存在')
    expect(screen.queryByText('第一条')).toBeNull()
    expect(screen.getByRole('button', { name: '退出多选' })).toBeInTheDocument()
  })

  // 在飞的 `list` 不保证按发起顺序落地（对账耗时随盘上条目数摆动）——后到的旧响应不许盖掉新状态。
  it('在飞期间失效只置脏：结算后追补一轮，最终态以新读为准（旧响应不盖新态）', async () => {
    const open = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
      let resolve!: (value: T) => void
      const promise = new Promise<T>((inResolve) => { resolve = inResolve })
      return { promise, resolve }
    }
    const first = open<RemoteOutcome<typeof three>>()
    const second = open<RemoteOutcome<typeof three>>()
    const list = vi
      .fn<() => Promise<RemoteOutcome<typeof three>>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    renderNarrow(depsOf({ list }))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    // 在飞期间失效只置脏：单飞，不并发第二条读。
    act(() => { invalidateTrash() })
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
    expect(list).toHaveBeenCalledTimes(1)
    // 旧读先落地：界面可以短暂看到旧清单。
    first.resolve(remoteOk(three))
    // 结算后恰好一轮追补，最终态以新读为准。
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    second.resolve(remoteOk([pick(three, 2)]))
    expect(await screen.findByText('第三条')).toBeInTheDocument()
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
    expect(screen.queryByText('第一条')).toBeNull()
  })

  it('多选态：grid 声明可多选，aria-selected 说的是勾选；退出后回到"选中看详情"那套', async () => {
    // 用宽档：窄档点行会下钻，清单整块离开 DOM，那时候量不到 grid 的 aria。
    const { container } = renderWide(depsOf())
    await screen.findAllByText('第一条')
    const list = must(container.querySelector('[data-dsh-session-delete="trash-list"]'), 'trash-list 元素')
    expect(list.getAttribute('aria-multiselectable')).toBeNull()
    fireEvent.click(rowOf(container, 'a'))
    expect(rowOf(container, 'a').getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    expect(list.getAttribute('aria-multiselectable')).toBe('true')
    expect(rowOf(container, 'a').getAttribute('aria-selected')).toBe('false')
    fireEvent.click(rowOf(container, 'c'))
    expect(rowOf(container, 'c').getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '退出多选' }))
    expect(list.getAttribute('aria-multiselectable')).toBeNull()
  })

  it('多选态下 Enter / Space 切换当前行的勾选（↑↓ 仍是移动光标）', async () => {
    // 宽档：首读完成会自动选中第一条，光标有个确定的起点（窄档没人选中，第一下 ArrowDown 是"落到第一条"）。
    const { container } = renderWide(depsOf())
    await screen.findAllByText('第一条')
    const list = must(container.querySelector('[data-dsh-session-delete="trash-list"]'), 'trash-list 元素')
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: ' ' })
    expect(screen.getByText('已选 1 条')).toBeInTheDocument()
    expect(boxes(container).map((box) => box.checked)).toEqual([false, true, false])
    // 光标还在第二条：再按 Enter 是**取消勾选**同一条（切换语义，不是"确认"）。要勾第三条得先下去。
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(boxes(container).map((box) => box.checked)).toEqual([false, true, true])
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(boxes(container).map((box) => box.checked)).toEqual([false, true, false])
  })
})

describe('回收站面板 · 工具排常驻与组勾选（2026-10-15）', () => {
  const grouped = [
    { ...rows[0], id: 'a', projectDir: '--P-one--', title: '第一条', deletedAt: 300 },
    { ...rows[0], id: 'b', projectDir: '--P-one--', title: '第二条', deletedAt: 200 },
    { ...rows[0], id: 'c', projectDir: '--P-two--', title: '第三条', deletedAt: 100 },
  ]
  const depsOf = (): FakeRemote => makeDeps({ list: vi.fn(async () => remoteOk(grouped)) })
  const heads = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-dsh-session-delete="trash-group-head"]')] as HTMLElement[]
  // 组头那一行里的勾选框（行内的另一颗住在条目行里，选择器带 trash-group 才分得开）
  const groupBoxes = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-dsh-session-delete="trash-group-row"] input[type="checkbox"]')] as HTMLInputElement[]
  const visibleRows = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-dsh-session-delete="trash-row"]')].map((el) => el.getAttribute('data-entry-id'))

  it('多选态下每个组头一颗勾选框；非多选态一颗都没有', async () => {
    const { container } = renderNarrow(depsOf())
    await screen.findByText('第一条')
    expect(groupBoxes(container)).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    expect(groupBoxes(container)).toHaveLength(2)
  })

  it('点组头那颗 = 该项目全部会话入选，**包括折叠起来看不见的**；再点全取消', async () => {
    const { container } = renderNarrow(depsOf())
    await screen.findByText('第一条')
    fireEvent.click(pick(heads(container), 0))
    expect(visibleRows(container)).toEqual(['c'])
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    fireEvent.click(pick(groupBoxes(container), 0))
    expect(screen.getByText('已选 2 条')).toBeInTheDocument()
    fireEvent.click(pick(groupBoxes(container), 0))
    expect(screen.getByText('已选 0 条')).toBeInTheDocument()
  })

  it('组头那颗是三态：只勾了几条是半选（mixed），勾满才是选中，再点清空', async () => {
    const { container } = renderNarrow(depsOf())
    await screen.findByText('第一条')
    const rowOf = (id: string) =>
      container.querySelector(`[data-dsh-session-delete="trash-row"][data-entry-id="${id}"]`) as HTMLElement
    const groupOne = () => pick(groupBoxes(container), 0)
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    expect(groupOne().checked).toBe(false)
    expect(groupOne().indeterminate).toBe(false)
    // 只勾组里一条 ⇒ 半选：既不是勾着，也不是空着
    fireEvent.click(rowOf('a'))
    expect(groupOne().checked).toBe(false)
    expect(groupOne().indeterminate).toBe(true)
    expect(groupOne().getAttribute('aria-checked')).toBe('mixed')
    // 补齐 ⇒ 实心选中
    fireEvent.click(rowOf('b'))
    expect(groupOne().checked).toBe(true)
    expect(groupOne().indeterminate).toBe(false)
    // 全勾着的时候再点组头 = 整组取消（不是"取消到半选"）
    fireEvent.click(groupOne())
    expect(groupOne().checked).toBe(false)
    expect(groupOne().indeterminate).toBe(false)
    expect(screen.getByText('已选 0 条')).toBeInTheDocument()
  })

  it('点组头勾选框不会顺手把那一组折叠掉（两颗各有各的位置）', async () => {
    const { container } = renderNarrow(depsOf())
    await screen.findByText('第一条')
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    fireEvent.click(pick(groupBoxes(container), 0))
    expect(pick(heads(container), 0).getAttribute('aria-expanded')).toBe('true')
    expect(visibleRows(container)).toEqual(['a', 'b', 'c'])
  })

  // 组头是 `<button>`，UA 的 `text-align:center` 会渗到里面的文字（宿主那份是 div，没这问题）——
  // 真机上项目名整个居中就是这个。显式 `start` 是这条的钉子。
  it('组头标题左对齐（button 的 UA 居中必须显式压掉）', async () => {
    const { container } = renderNarrow(depsOf())
    await screen.findByText('第一条')
    expect(pick(heads(container), 0).style.textAlign).toBe('start')
  })
})

describe('回收站面板 · 两档边界、右栏的出现条件与键盘落点（2026-10-15）', () => {
  const threeRows = [
    { ...pick(rows, 0), id: 'a', title: '甲组第一条', projectDir: '--P-one--' },
    { ...pick(rows, 0), id: 'b', title: '乙组第一条', projectDir: '--P-two--' },
    { ...pick(rows, 0), id: 'c', title: '丙组第一条', projectDir: '--P-three--' },
  ]
  const depsOfThree = (): FakeRemote => makeDeps({ list: vi.fn(async () => remoteOk(threeRows)) })
  const listColumn = (container: HTMLElement): HTMLElement =>
    must(container.querySelector('[data-dsh-session-delete="trash-list"]'), 'trash-list 元素').parentElement as HTMLElement
  const renderAt = (width: number, deps: FakeRemote) => {
    const observer: WidthObserver = installWidthObserver()
    const view = render(<TrashPanel deps={deps} />)
    act(() => { observer.pump(width) })
    return { ...view, observer }
  }

  it('盒子正好 900 就分栏（断点是含边界的 ≥）', async () => {
    const { container } = renderAt(900, makeDeps())
    await screen.findByRole('row', { name: /code-review/ })
    expect(container.querySelector('[role="separator"]')).not.toBeNull()
    expect(container.querySelector('[data-dsh-session-delete="trash-detail"]')).not.toBeNull()
  })

  it('差 1 px（899）就走下钻：既没有把手也没有右栏', async () => {
    const { container } = renderAt(899, makeDeps())
    await screen.findByRole('row', { name: /code-review/ })
    expect(container.querySelector('[role="separator"]')).toBeNull()
    expect(container.querySelector('[data-dsh-session-delete="trash-detail"]')).toBeNull()
  })

  // docs/ui-spec.md：清单为空或读数失败时右栏不出现——那一栏没有可选项也没有动作。
  it('空回收站即便盒子够宽也不出右栏（也没把手可拖）', async () => {
    const { container } = renderAt(1100, makeDeps({ list: vi.fn(async () => remoteOk([])) }))
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
    expect(container.querySelector('[data-dsh-session-delete="trash-detail"]')).toBeNull()
    expect(container.querySelector('[role="separator"]')).toBeNull()
  })

  it('清单读不到时也只摆清单那一块：原文 +「重试」负责把清单读回来', async () => {
    const { container } = renderAt(1100, makeDeps({ list: vi.fn(async () => remoteFail({ code: 'client/unknown', message: '磁盘忙' })) }))
    expect(await screen.findByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(container.querySelector('[data-dsh-session-delete="trash-detail"]')).toBeNull()
  })

  it('窄档那一列铺满：不再限宽 760、也不再居中', async () => {
    const { container } = renderNarrow(depsOfThree())
    await screen.findByText('甲组第一条')
    const style = listColumn(container).style
    expect(style.maxWidth).toBe('')
    expect(style.margin).toBe('')
  })

  it('窄档一次没点过时，第一行拿着清单里唯一的 tab 落点', async () => {
    const { container } = renderNarrow(depsOfThree())
    await screen.findByText('甲组第一条')
    const rows = [...container.querySelectorAll('[data-dsh-session-delete="trash-row"]')]
    const tabStops = rows.filter((row) => (row as HTMLElement).tabIndex === 0)
    expect(tabStops).toHaveLength(1)
    expect(pick(tabStops, 0).textContent).toContain('甲组第一条')
  })

  it('选中之后落点跟着那一行走（其余全退回 -1，roving tabindex 只有一个）', async () => {
    const { container } = renderWide(depsOfThree())
    await screen.findAllByText('甲组第一条')
    fireEvent.click(screen.getByRole('row', { name: /乙组第一条/ }))
    const rows = [...container.querySelectorAll('[data-dsh-session-delete="trash-row"]')]
    const tabStops = rows.filter((row) => (row as HTMLElement).tabIndex === 0)
    expect(tabStops).toHaveLength(1)
    expect(pick(tabStops, 0).textContent).toContain('乙组第一条')
  })
})

// 回收站之外的无主子会话（父既不在宿主语料、也不在清册）2026-10-19 挂在面板上，
// 2026-10-27 搬进插件设置页的维护卡（手动检查 → 预览 → 清理）。面板不再自动扫、也不再摆那块警告条：
// 那三条界面规则（报告非空才出、读不到是可见失败、清理仍走 `/apply` 的第五个动作）连同用例
// 一起住 `orphan-maintenance.test.tsx` / `maintenance-settings.test.tsx` 与 `use-maintenance.test.tsx`。
// 这里只钉"面板这一侧真的没有了"：给假远端一份非空孤儿报告，面板一次都不去问。
describe('回收站面板 · 不再自动扫无主子会话（2026-10-27 搬家后）', () => {
  it('挂载与写后重读都不发 /orphans，面板上也没有孤儿提示', async () => {
    const deps = makeDeps({ scanOrphans: vi.fn(async () => remoteOk(ORPHANS)) })
    renderWide(deps)
    await screen.findByRole('row', { name: /code-review/ })
    // 写后重读（失效通告）也不许顺手扫一次。
    act(() => { invalidateTrash() })
    await waitFor(() => expect(deps.list).toHaveBeenCalledTimes(2))
    expect(deps.scanOrphans).not.toHaveBeenCalled()
    expect(screen.queryByText(/无主子会话/)).not.toBeInTheDocument()
    expect(document.querySelector('[data-dsh-session-delete="orphan-banner"]')).toBeNull()
  })
})

const KID_ROW = {
  id: 'kid', sessionId: 'session-kid', projectDir: '--p--', workspaceId: 'ws',
  wasArchived: false, deletedAt: 1, title: '孩子会话', sizeBytes: 1024, parentEntryId: 'a',
}

function kidDeps(): FakeRemote {
  return makeDeps({
    list: vi.fn(async () => remoteOk([{ ...pick(rows, 0), subagentCount: 1, subagentBytes: 1024 }])),
    detail: vi.fn(async (id: string) => remoteOk(id === 'kid'
      ? { ...detailFixture, entryId: 'kid', blocks: [{ kind: 'user', id: '0', time: 1, text: '孩子的正文', truncated: false, attachments: [] }] }
      : { ...detailFixture, subagents: [KID_ROW] })),
  })
}

describe('回收站面板 · 子会话详情', () => {
  /** 子会话段默认收起（ui-spec 状态⑥）：点摘要条才展开出孩子行。 */
  function openSubagents(): void {
    fireEvent.click(must(document.querySelector<HTMLButtonElement>('[data-dsh-session-delete="session-subagents-toggle"]'), '子会话摘要条'))
  }

  it('宽档：父详情点子会话 → 孩子正文上屏，清单选中仍在父行；返回父会话可回', async () => {
    renderWide(kidDeps())
    await screen.findByText('先看改动')
    openSubagents()
    fireEvent.click(screen.getByText('孩子会话'))
    expect(await screen.findByText('孩子的正文')).toBeInTheDocument()
    // 清单选中仍是父行（aria-selected 钉在父行的 id 上）
    const parentRow = document.getElementById('sd-trash-a')
    expect(parentRow?.getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '← 返回父会话' }))
    expect(await screen.findByText('先看改动')).toBeInTheDocument()
  })

  it('窄档：下钻到父 → 孩子 → 返回父（仍下钻）→ 返回清单', async () => {
    renderNarrow(kidDeps())
    fireEvent.click(await screen.findByText('/code-review'))
    await screen.findByText('先看改动')
    openSubagents()
    fireEvent.click(screen.getByText('孩子会话'))
    expect(await screen.findByText('孩子的正文')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '← 返回父会话' }))
    await screen.findByText('先看改动')
    // 仍在下钻：清单不在 DOM，「返回清单」还在
    fireEvent.click(screen.getByRole('button', { name: '← 返回清单' }))
    expect(await screen.findByText('/code-review')).toBeInTheDocument()
  })

  // 单级（ADR-0055）：下一层的入口只在主体是清单选中那条时交出。更深一代自己不折进父行、占清单行
  // （判据住 `src/trash/groups.ts`），走清单可达——在孩子视图里再开一层会让那颗返回指着孙辈说话。
  it('宽档：孩子视图里不再画「子会话」段，返回仍交还清单选中那条', async () => {
    const deps = makeDeps({
      list: vi.fn(async () => remoteOk([{ ...pick(rows, 0), subagentCount: 1, subagentBytes: 1024 }])),
      detail: vi.fn(async (id: string) => remoteOk(id === 'kid'
        ? {
          ...detailFixture,
          entryId: 'kid',
          subagents: [{ ...KID_ROW, id: 'grandkid', sessionId: 'session-grandkid', title: '孙辈会话', parentEntryId: 'kid' }],
          blocks: [{ kind: 'user', id: '0', time: 1, text: '孩子的正文', truncated: false, attachments: [] }],
        }
        : { ...detailFixture, subagents: [KID_ROW] })),
    })
    renderWide(deps)
    await screen.findByText('先看改动')
    expect(document.querySelector('[data-dsh-session-delete="session-subagents-toggle"]')).not.toBeNull()
    openSubagents()
    fireEvent.click(screen.getByText('孩子会话'))
    await screen.findByText('孩子的正文')
    expect(screen.queryByText('孙辈会话')).not.toBeInTheDocument()
    expect(document.querySelector('[data-dsh-session-delete="session-subagents"]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '← 返回父会话' }))
    expect(await screen.findByText('先看改动')).toBeInTheDocument()
  })

  // 孩子视图不是死路：孩子的详情读失败时宽档既没有段（失败态不画正文）也没有「返回清单」，
  // 清单行就是那一扇出口——`select` 无条件收掉孩子视图（判据住 ADR-0055 与状态⑥）。
  it('宽档：孩子详情读失败后点清单行仍能脱身', async () => {
    const deps = kidDeps()
    renderWide(deps)
    await screen.findByText('先看改动')
    deps.detail.mockResolvedValueOnce({ ok: false, failure: { code: 'client/unknown', message: '回收站目录不在' } })
    openSubagents()
    fireEvent.click(screen.getByText('孩子会话'))
    expect(await screen.findByText('回收站目录不在')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '← 返回清单' })).not.toBeInTheDocument()

    fireEvent.click(must(document.getElementById('sd-trash-a'), '甲组那条行'))
    expect(await screen.findByText('先看改动')).toBeInTheDocument()
    expect(screen.queryByText('回收站目录不在')).not.toBeInTheDocument()
  })
})

describe('归档档（平级分段）', () => {
  const archiveRow = (sessionId: string, over: Partial<ArchiveRowWire> = {}): ArchiveRowWire => ({
    sessionId, projectDir: '--p--', title: `${sessionId}-标题`, updatedAt: 100, updatedAtSource: 'prompt',
    subagent: false, ...over,
  })
  const archiveDetailOf = (sessionId: string): ArchiveDetailLike => ({
    sessionId, archived: true, cwd: 'C:/p', createdAt: 1, lastActivity: 2, logTitle: '', models: [],
    turnCount: 0, userMessageCount: 0, assistantMessageCount: 0, toolCallCount: 0,
    injectedCount: 0, blocks: [], olderCursor: null,
  })
  function makeArchiveDeps(over: Partial<FakeRemote> = {}) {
    return makeDeps({
      archiveList: vi.fn(async (): Promise<RemoteOutcome<ArchiveListWire>> => remoteOk({
        available: true,
        rows: [archiveRow('session-x', { label: '子任务名' }), archiveRow('session-y')],
        totalBytes: 0, missingSizeCount: 0,
      })),
      archiveDetail: vi.fn(async (sessionId: string): Promise<RemoteOutcome<ArchiveDetailLike>> => remoteOk(archiveDetailOf(sessionId))),
      ...over,
    })
  }
  const archiveTab = () => screen.getByRole('button', { name: '归档' })
  const rowCount = (container: HTMLElement, attr: string) =>
    container.querySelectorAll(`[data-dsh-session-delete="${attr}"]`).length
  /** 组头在多选态也有一颗勾选框；这里的用例要的是行自己的那几颗。 */
  const rowCheckboxes = () => screen.getAllByRole('checkbox')
    .filter((box) => box.closest('[data-dsh-session-delete="archive-row"]') !== null)

  it('面板头是平级分段：回收站 N | 归档 M；M 惰性（挂载只读 /list，切档才读归档）', async () => {
    const deps = makeArchiveDeps()
    const { container } = renderWide(deps)
    await waitFor(() => { expect(rowCount(container, 'trash-row')).toBe(1) })
    expect(screen.getByRole('button', { name: '回收站' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '归档' })).toBeInTheDocument()
    // 默认档是回收站：挂载即读 /list、不读 /archive-list（不为可能不打开的档付全语料读）。
    expect(deps.list).toHaveBeenCalled()
    expect(deps.archiveList).not.toHaveBeenCalled()
    expect(document.querySelector('[data-dsh-session-delete="archive-count"]')).toBeNull()
    // 切到归档档才读；M 在首次成功读取后出现。
    fireEvent.click(archiveTab())
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(2) })
    expect(deps.archiveList).toHaveBeenCalledTimes(1)
    // 拍板形态「回收站 N | 归档 M」：两档计数都在分段里（M 首次成功读取后才出现）。
    expect(must(container.querySelector('[data-dsh-session-delete="trash-count"]'), '回收站计数应在场').textContent).toBe('1')
    expect(must(container.querySelector('[data-dsh-session-delete="archive-count"]'), '归档计数应在场').textContent).toBe('2')
    // 计数由 `aria-describedby` 带进可及描述：按钮名仍是纯档名，描述里能读到 N/M。
    const trashButton = screen.getByRole('button', { name: '回收站' })
    const archiveButton = screen.getByRole('button', { name: '归档' })
    const trashDescribed = trashButton.getAttribute('aria-describedby')
    const archiveDescribed = archiveButton.getAttribute('aria-describedby')
    expect(trashDescribed).not.toBeNull()
    expect(archiveDescribed).not.toBeNull()
    expect(document.getElementById(trashDescribed ?? '')?.textContent).toBe('1')
    expect(document.getElementById(archiveDescribed ?? '')?.textContent).toBe('2')
  })

  it('归档副标题：合计只加已知大小，读不出来的行数追加「N 条大小缺席」', async () => {
    const deps = makeArchiveDeps({
      archiveList: vi.fn(async (): Promise<RemoteOutcome<ArchiveListWire>> => remoteOk({
        available: true,
        rows: [archiveRow('session-x', { sizeBytes: 1024 }), archiveRow('session-y'), archiveRow('session-z')],
        totalBytes: 1024, missingSizeCount: 2,
      })),
    })
    const { container } = renderWide(deps)
    fireEvent.click(archiveTab())
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(3) })
    // 「—」在行上，合计里不占数；副标题必须把「两行没有可信读数」说出来，不拿 0 冒充。
    expect(screen.getByText(/2 条大小缺席/)).toBeInTheDocument()
    expect(screen.getByText(/3 个已归档会话 · 合计/)).toBeInTheDocument()
  })

  it('面板头两档用大号分段（与旧版 H1 同档，回收站与归档同尺寸）', async () => {
    const deps = makeArchiveDeps()
    renderWide(deps)
    await waitFor(() => { expect(deps.list).toHaveBeenCalled() })
    expect(screen.getByRole('group', { name: '面板档位' })).toHaveClass('sd-seg', 'sd-seg-lg')
  })

  it('宽档归档首读完成后自动选中第一条（右栏不空，与回收站同一条）', async () => {
    const deps = makeArchiveDeps()
    const { container } = renderWide(deps)
    fireEvent.click(archiveTab())
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(2) })
    await waitFor(() => { expect(deps.archiveDetail).toHaveBeenCalledWith('session-x', undefined, undefined) })
    expect(screen.getByRole('row', { name: /子任务名/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('父详情里的未归档孩子只读打开：带父 id 读、孩子视图可返回父', async () => {
    const deps = makeArchiveDeps({
      archiveDetail: vi.fn(async (sessionId: string, _before?: number, _rootSessionId?: string): Promise<RemoteOutcome<ArchiveDetailLike>> => {
        if (sessionId === 'session-x') {
          return remoteOk({
            ...archiveDetailOf(sessionId),
            subagents: [{ sessionId: 'kid-1', archived: false, projectDir: '--p--', title: '孩子一' }],
          })
        }
        return remoteOk(sessionId === 'kid-1' ? { ...archiveDetailOf(sessionId), archived: false } : archiveDetailOf(sessionId))
      }),
    })
    const { container } = renderWide(deps)
    fireEvent.click(archiveTab())
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(2) })
    await waitFor(() => { expect(deps.archiveDetail).toHaveBeenCalledWith('session-x', undefined, undefined) })

    fireEvent.click(must(container.querySelector('[data-dsh-session-delete="session-subagents-toggle"]'), '子会话摘要条'))
    const child = must(container.querySelector('[data-dsh-session-delete="session-subagent-row"]'), '可点孩子行')
    fireEvent.click(child)
    await waitFor(() => { expect(deps.archiveDetail).toHaveBeenCalledWith('kid-1', undefined, 'session-x') })
    expect(await screen.findByText('随归档父会话查看')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /返回父会话/ }))
    expect(await screen.findByText('已归档')).toBeInTheDocument()
    expect(screen.queryByText('随归档父会话查看')).not.toBeInTheDocument()
  })

  it('已归档但不在清单行里的孩子：点开照实说「已归档」，不误标「随归档父会话查看」', async () => {
    // 归档清单 = 归档集 ∩ `listSessions`：被清单跳过的已归档孩子（冷无 cwd 之列）不在行里，
    // 却在父闭包里、正文读得出。状态行认主体自己的归档态（wire 的 `archived`），不认
    // 「孩子视图」这个导航道——「找不到清单行」不等于「未归档」。
    const deps = makeArchiveDeps({
      archiveDetail: vi.fn(async (sessionId: string, _before?: number, _rootSessionId?: string): Promise<RemoteOutcome<ArchiveDetailLike>> => {
        if (sessionId === 'session-x') {
          return remoteOk({
            ...archiveDetailOf(sessionId),
            subagents: [{ sessionId: 'kid-1', archived: true, projectDir: '--p--', title: '孩子一' }],
          })
        }
        return remoteOk(archiveDetailOf(sessionId))
      }),
    })
    const { container } = renderWide(deps)
    fireEvent.click(archiveTab())
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(2) })
    await waitFor(() => { expect(deps.archiveDetail).toHaveBeenCalledWith('session-x', undefined, undefined) })

    fireEvent.click(must(container.querySelector('[data-dsh-session-delete="session-subagents-toggle"]'), '子会话摘要条'))
    fireEvent.click(must(container.querySelector('[data-dsh-session-delete="session-subagent-row"]'), '可点孩子行'))
    await waitFor(() => { expect(deps.archiveDetail).toHaveBeenCalledWith('kid-1', undefined, 'session-x') })
    expect(await screen.findByText('已归档')).toBeInTheDocument()
    expect(screen.queryByText('随归档父会话查看')).not.toBeInTheDocument()
  })

  it('归档多选态组头有组勾选框：一点选中整组（含折叠起来的）', async () => {
    const deps = makeArchiveDeps()
    const { container } = renderWide(deps)
    fireEvent.click(archiveTab())
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(2) })
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /勾选「p」这 2 条会话/ }))
    expect(await screen.findByRole('button', { name: '解除所选 2 条' })).toBeInTheDocument()
  })

  it('归档详情与回收站同一套提问轨：prompts 过线时右缘出现提问导航', async () => {
    const deps = makeArchiveDeps({
      archiveDetail: vi.fn(async (sessionId: string): Promise<RemoteOutcome<ArchiveDetailLike>> => remoteOk({
        ...archiveDetailOf(sessionId),
        prompts: [{ id: 'p1', at: 1, preview: '先看改动' }],
        blocks: [{ kind: 'user', id: 'p1', time: 1, text: '先看改动', truncated: false, attachments: [] }],
      })),
    })
    const { container } = renderWide(deps)
    fireEvent.click(archiveTab())
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(2) })
    expect(await screen.findByRole('navigation', { name: '提问导航' })).toBeInTheDocument()
  })

  it('多选勾选框的无障碍名是显示名（未命名行也有）', async () => {
    const deps = makeArchiveDeps({
      archiveList: vi.fn(async (): Promise<RemoteOutcome<ArchiveListWire>> => remoteOk({
        available: true,
        rows: [archiveRow('session-z', { title: '' })],
        totalBytes: 0, missingSizeCount: 0,
      })),
    })
    const { container } = renderWide(deps)
    fireEvent.click(archiveTab())
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(1) })
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    // 未命名行（无 label、无 title）：勾选框的无障碍名走「未命名 · <短 id>」兜底，不是空串。
    expect(screen.getByRole('checkbox', { name: /^未命名/ })).toBeInTheDocument()
  })

  it('切档清空选中（双向）；两档折叠集互不影响', async () => {
    const deps = makeArchiveDeps()
    const { container } = renderWide(deps)
    await waitFor(() => { expect(rowCount(container, 'trash-row')).toBe(1) })
    // 回收站：进多选勾一条，切档往返 ⇒ 勾选与多选态一起被清（exitSelect）。
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    fireEvent.click(must(screen.getAllByRole('checkbox')[0], '勾选框应在场'))
    fireEvent.click(archiveTab())
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(2) })
    fireEvent.click(screen.getByRole('button', { name: '回收站' }))
    await waitFor(() => { expect(rowCount(container, 'trash-row')).toBe(1) })
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)

    // 归档档：进多选勾两条，切档往返 ⇒ 同样被清（双向）。
    fireEvent.click(archiveTab())
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(2) })
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    for (const box of rowCheckboxes()) fireEvent.click(box)
    await screen.findByRole('button', { name: '删除所选 2 条' })
    fireEvent.click(screen.getByRole('button', { name: '回收站' }))
    await waitFor(() => { expect(rowCount(container, 'trash-row')).toBe(1) })
    fireEvent.click(archiveTab())
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(2) })
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)

    // 折叠集按档独立：回收站「全部折叠」收掉 trash 行，归档档的行不受影响。
    fireEvent.click(screen.getByRole('button', { name: '回收站' }))
    await waitFor(() => { expect(rowCount(container, 'trash-row')).toBe(1) })
    fireEvent.click(screen.getByRole('button', { name: '全部折叠' }))
    expect(rowCount(container, 'trash-row')).toBe(0)
    fireEvent.click(archiveTab())
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(2) })
  })

  it('归档行渲染：显示名 label 优先、时间标签、大小缺席 —、两枚图标按钮带 aria-label', async () => {
    const deps = makeArchiveDeps()
    const { container } = renderWide(deps)
    fireEvent.click(archiveTab())
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(2) })
    // label 优先（session-x 显示「子任务名」）；session-y 回落日志标题。
    expect(screen.getAllByText('子任务名').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('session-y-标题').length).toBeGreaterThanOrEqual(1) // 无 label 的行回落 title
    expect(screen.getAllByText(/最后活动/).length).toBeGreaterThanOrEqual(1)
    // 两行都无 sizeBytes ⇒ 行内元信息各显式「—」，不拿 0 冒充。
    const renderedRows = container.querySelectorAll('[data-dsh-session-delete="archive-row"]')
    expect(renderedRows).toHaveLength(2)
    for (const rendered of renderedRows) expect(rendered.textContent).toContain('—')
    expect(screen.getAllByRole('button', { name: '解除归档' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '删除' })).toHaveLength(2)
  })

  it('归档清单是 grid：rowgroup/row/gridcell、aria-activedescendant 与 roving tabindex', async () => {
    const deps = makeArchiveDeps()
    const { container } = renderWide(deps)
    fireEvent.click(archiveTab())
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(2) })
    const grid = screen.getByRole('grid', { name: '归档' })
    expect(grid).toHaveAttribute('aria-colcount', '2')
    expect(within(grid).getAllByRole('rowgroup')).toHaveLength(1)
    const rows = within(grid).getAllByRole('row').filter((row) => row.hasAttribute('aria-selected'))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAttribute('tabindex', '0')
    expect(rows[1]).toHaveAttribute('tabindex', '-1')
    // 每个行内动作都住在 gridcell 里（row 的直接子代必须是 cell）。
    for (const row of rows) {
      expect(within(row).getAllByRole('gridcell').length).toBeGreaterThan(0)
      for (const button of within(row).getAllByRole('button')) {
        expect(button.closest('[role="gridcell"]')).not.toBeNull()
      }
    }
  })

  it('归档清单键盘：窄档方向键只移动活动行，Enter 下钻，Esc 回清单', async () => {
    const deps = makeArchiveDeps()
    const { container } = renderNarrow(deps)
    fireEvent.click(archiveTab())
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(2) })
    const grid = screen.getByRole('grid', { name: '归档' })
    const rows = within(grid).getAllByRole('row').filter((row) => row.hasAttribute('aria-selected'))
    const first = must(rows[0], '第一条归档行')
    const second = must(rows[1], '第二条归档行')

    // 首按 ↓ 未选中 ⇒ 落第一条；再按一次才到下一条（与回收站清单同一条走环规则）。
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(grid).toHaveAttribute('aria-activedescendant', first.id)
    expect(first).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(second).toHaveAttribute('aria-selected', 'true')
    expect(grid).toHaveAttribute('aria-activedescendant', second.id)
    // 方向键只移动活动行：还没读详情、也没进下钻。
    expect(deps.archiveDetail).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '← 返回清单' })).not.toBeInTheDocument()

    fireEvent.keyDown(second, { key: 'Enter' })
    await waitFor(() => { expect(deps.archiveDetail).toHaveBeenCalled() })
    expect(await screen.findByRole('button', { name: '← 返回清单' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(2) })
  })

  // 两档的导航同时挂在一次挂载里（各自一台 `useTrashNav`，都听 `document` 的 Esc）。屏上只有当前档，
  // 所以按键归属也只能是当前档：另一档的下钻状态不许被这一次 Esc 悄悄收走（ADR-0060 决定第 4 条：
  // 两档状态互不相通）。
  it('窄档：一档的下钻不被另一档的 Esc 收走（键盘契约只跟着当前档）', async () => {
    const deps = makeArchiveDeps()
    const { container } = renderNarrow(deps)

    // 归档档下钻 → 切到回收站档 → 一次 Esc → 回归档档：还在详情里。
    fireEvent.click(archiveTab())
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(2) })
    const archiveGrid = screen.getByRole('grid', { name: '归档' })
    const archiveFirst = must(
      within(archiveGrid).getAllByRole('row').filter((row) => row.hasAttribute('aria-selected'))[0],
      '第一条归档行',
    )
    fireEvent.keyDown(archiveFirst, { key: 'Enter' })
    expect(await screen.findByRole('button', { name: '← 返回清单' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '回收站' }))
    await waitFor(() => { expect(rowCount(container, 'trash-row')).toBe(1) })
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(archiveTab())
    expect(screen.getByRole('button', { name: '← 返回清单' })).toBeInTheDocument()

    // 反方向：回收站档下钻 → 切到归档档 → 一次 Esc → 回回收站档：也还在详情里。
    fireEvent.click(screen.getByRole('button', { name: '← 返回清单' }))
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(2) })
    fireEvent.click(screen.getByRole('button', { name: '回收站' }))
    await waitFor(() => { expect(rowCount(container, 'trash-row')).toBe(1) })
    fireEvent.click(must(container.querySelector('[data-dsh-session-delete="trash-row"]'), '回收站行应在场'))
    expect(await screen.findByRole('button', { name: '← 返回清单' })).toBeInTheDocument()
    fireEvent.click(archiveTab())
    await waitFor(() => { expect(rowCount(container, 'trash-row')).toBe(0) })
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '回收站' }))
    expect(screen.getByRole('button', { name: '← 返回清单' })).toBeInTheDocument()
  })

  it('corpus-missing 是独立块带重试，不折成空态', async () => {
    const deps = makeArchiveDeps({
      archiveList: vi.fn(async (): Promise<RemoteOutcome<ArchiveListWire>> => remoteOk({ available: false })),
    })
    renderWide(deps)
    fireEvent.click(archiveTab())
    await screen.findByText('语料不可见')
    expect(screen.getByText('宿主的会话查询服务不可用，归档清单读不出来。')).toBeInTheDocument()
    expect(screen.queryByText('没有已归档的会话')).not.toBeInTheDocument()
    // 重试：换成可用后走 ready（空态）。
    must(deps.archiveList, 'archiveList 假件应在场').mockResolvedValue({ ok: true, value: { available: true, rows: [], totalBytes: 0, missingSizeCount: 0 } })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByText('没有已归档的会话')
  })

  it('读失败上屏带重试，不折成空态', async () => {
    const failing = makeArchiveDeps({
      archiveList: vi.fn(async () => remoteFail({ code: 'client/unknown', message: 'boom' })),
    })
    renderWide(failing)
    fireEvent.click(archiveTab())
    await screen.findByText('归档读不到')
    expect(screen.getByText('boom')).toBeInTheDocument()
    expect(screen.queryByText('没有已归档的会话')).not.toBeInTheDocument()
  })

  it('归档档页脚 = 解除所选/删除所选；回收站档页脚不变', async () => {
    const deps = makeArchiveDeps()
    const { container } = renderWide(deps)
    fireEvent.click(archiveTab())
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(2) })
    // 进多选、勾两条（工具行随档位：这里点多选 = 归档档自己的选择面）。
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    const boxes = rowCheckboxes()
    fireEvent.click(must(boxes[0], '勾选框应在场'))
    fireEvent.click(must(boxes[1], '勾选框应在场'))
    expect(await screen.findByRole('button', { name: '解除所选 2 条' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '删除所选 2 条' })).toBeInTheDocument()
    // 页脚那颗把**两条勾选 id** 一次交给 /apply 的 unarchive（不是逐条发、也不是只发第一条）。
    fireEvent.click(screen.getByRole('button', { name: '解除所选 2 条' }))
    await waitFor(() => { expect(deps.applyOutcomes).toHaveBeenCalled() })
    const [action, ids] = must(deps.applyOutcomes.mock.calls.at(-1), 'unarchive 应发过一趟')
    expect(action).toBe('unarchive')
    expect([...ids].sort()).toEqual(['session-x', 'session-y'])
    // 回收站档页脚不变（清空回收站仍在）。
    fireEvent.click(screen.getByRole('button', { name: '回收站' }))
    await waitFor(() => { expect(rowCount(container, 'trash-row')).toBe(1) })
    expect(screen.getByRole('button', { name: '清空回收站…' })).toBeInTheDocument()
  })

  it('归档档选中/详情不写 trash-snapshot（noteSelection 与详情账本零触碰）', async () => {
    const deps = makeArchiveDeps()
    const { container } = renderWide(deps)
    fireEvent.click(archiveTab())
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(2) })
    fireEvent.click(must(container.querySelector('[data-dsh-session-delete="archive-row"]'), '归档行应已渲染'))
    await waitFor(() => { expect(deps.archiveDetail).toHaveBeenCalled() })
    // 回收站档自己的快照（含宽档自动选中）是它自己的；要钉的是**归档选中/详情零触碰**：
    // 点归档行前后快照一字不变（选中不进 noteSelection），详情不进回收站账本（键域两套）。
    const before = readTrashSnapshot()
    fireEvent.click(must(container.querySelector('[data-dsh-session-delete="archive-row"]'), '归档行应已渲染'))
    await waitFor(() => { expect(deps.archiveDetail).toHaveBeenCalled() })
    expect(readTrashSnapshot()).toEqual(before)
    expect(readCachedTrashDetail('session-x')).toBeUndefined()
  })

  it('删除已归档会话后撤销横幅带归档句：面板 → 确认框 → 撤销提示整条链', async () => {
    const deps = makeArchiveDeps({
      applyOutcomes: vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<RemoteOutcome<ApplyOutcome[]>> => remoteOk(
        (action === 'delete'
          ? ids.map((id) => ok('delete', id, { ...trashRow(`entry-${id}`, id), wasArchived: true }))
          : outcomes(action, ids)))),
    })
    const { container } = render(
      <>
        <TrashPanel deps={deps} />
        <DeleteConfirmHost deps={deps} />
        <UndoToast deps={deps} />
      </>,
    )
    fireEvent.click(archiveTab())
    await waitFor(() => { expect(rowCount(container, 'archive-row')).toBe(2) })
    const archiveRow = must(container.querySelector<HTMLElement>('[data-dsh-session-delete="archive-row"]'), '归档行应已渲染')
    fireEvent.click(within(archiveRow).getByRole('button', { name: '删除' }))
    fireEvent.click(await screen.findByRole('button', { name: '移入回收站' }))
    await waitFor(() => {
      expect(screen.getByText(/撤销后回到「归档」/)).toBeInTheDocument()
    })
    expect(deps.applyOutcomes).toHaveBeenCalledWith('delete', ['session-x'])
  })
})
