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
import { invalidateTrash, resetTrashStore } from '../../src/client/trash-store.js'
import type { ApplyAction, ApplyOutcome, TrashDetailLike } from '../../src/client/remote.js'
import { installWidthObserver, type WidthObserver } from './support/observe-width.js'
import { createFakeRemote, type FakeRemote } from './support/fake-remote.js'
import { failed, outcomes, restoreOutcomes } from './support/outcomes.js'
import { firePointer } from './support/pointer.js'

// 修订号是模块级现场（跨用例存活）：每个用例前复位，用例之间互不串味。
beforeEach(() => {
  resetTrashStore()
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
  injectedCount: 7, omittedByPayloadCap: 0,
  messages: [
    { role: 'user', time: 1, text: '先看改动', truncated: false, attachments: [] },
    { role: 'assistant', time: 2, text: '改动分四层', truncated: false, attachments: [] },
  ],
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
    list: vi.fn(async () => rows),
    applyOutcomes: vi.fn(async (action: ApplyAction, ids: readonly string[]) => outcomesOf(action, ids)),
    emptyTrash: vi.fn(async () => ({ removed: 1, freedBytes: 1 })),
    detail: vi.fn(async () => detailFixture),
    ...over,
  })
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

describe('回收站面板', () => {
  it('空回收站显示空态且没有清空按钮', async () => {
    render(<TrashPanel deps={makeDeps({ list: vi.fn(async () => []) })} />)
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '清空回收站…' })).not.toBeInTheDocument()
  })

  // jsdom 没有布局，"居中"只能钉那条链本身：单列外壳与清单容器都吃 `flex:1 1 auto`，
  // 空态块自己的 `flex:1` + `justifyContent:center` 才有高度可居。2026-10-16 真机回归：
  // 两栏改造在清单容器那节把链断在"内容高"上 ⇒ 空态图标贴到左上角。
  it('空态的居中链：单列外壳与清单容器都是 flex:1 1 auto', async () => {
    const { container } = render(<TrashPanel deps={makeDeps({ list: vi.fn(async () => []) })} />)
    await screen.findByText('回收站是空的')
    const listBox = container.querySelector('[data-dsh-session-delete="trash-list"]') as HTMLElement
    expect((listBox.parentElement as HTMLElement).style.flex).toBe('1 1 auto')
    expect(listBox.style.flex).toBe('1 1 auto')
  })

  // 动作住在行右侧（2026-10-15 真机反馈后回到 2026-10-01 的形状，docs/ui-spec.md），所以这条直接点行内那颗。
  it('行右侧的「恢复」调 restore 并带上条目 id（动作住在行内，2026-10-15 真机反馈后回归原形）', async () => {
    const deps = makeDeps()
    renderWide(deps)
    const row = await screen.findByRole('option', { name: /code-review/ })
    fireEvent.click(within(row).getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(deps.applyOutcomes).toHaveBeenCalledWith('restore', ['a']))
  })

  it('窄档点行内动作按钮不顺手下钻：按钮不冒泡成整行点击', async () => {
    const deps = makeDeps()
    renderNarrow(deps)
    const row = await screen.findByRole('option', { name: /code-review/ })
    fireEvent.click(within(row).getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(deps.applyOutcomes).toHaveBeenCalledWith('restore', ['a']))
    // 还在清单里；若按钮点击冒泡到整行，窄档会切到详情、这一行从 DOM 消失。
    expect(screen.getByRole('option', { name: /code-review/ })).toBeInTheDocument()
  })

  // 原工作区已被删掉（宿主的「删除工作区」只删注册、保留日志）⇒ 恢复照常回盘、落在「未分组」。
  // 这句话必须在**点之前**就看得见：它不是某次动作的失败，是这一条要去哪。
  it('原工作区已不存在：行上先说恢复后归入未分组；工作区还在时没有这句', async () => {
    const gone = render(
      <TrashPanel deps={makeDeps({ list: vi.fn(async () => [{ ...rows[0]!, workspaceMissing: true }]) })} />,
    )
    const row = await screen.findByRole('option', { name: /code-review/ })
    expect(within(row).getByText('原工作区已不存在，恢复后归入未分组')).toBeInTheDocument()
    gone.unmount()

    render(<TrashPanel deps={makeDeps()} />)
    await screen.findByRole('option', { name: /code-review/ })
    expect(screen.queryByText(/原工作区已不存在/)).toBeNull()
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
      emptyTrash: vi.fn(async () => {
        throw Object.assign(new Error('清空失败'), { code: 'sessiondelete/io' })
      }),
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
      applyOutcomes: vi.fn(async (action: ApplyAction, ids: readonly string[]): Promise<ApplyOutcome[]> => ids.map((id) => ({
        id, action, ok: false as const,
        error: { code: 'sessiondelete/project-missing', message: '原项目目录已不存在' },
      }))),
    })
    renderWide(deps)
    const row = await screen.findByRole('option', { name: /code-review/ })
    fireEvent.click(within(row).getByRole('button', { name: '恢复' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/原项目目录已不存在/)
  })
})

describe('回收站面板 · 两栏与下钻', () => {
  it('宽档：清单在左（420 定宽、动作在行右侧）、详情在右', async () => {
    const { container } = renderWide(makeDeps())
    const row = await screen.findByRole('option', { name: /code-review/ })
    // 两颗动作住在行里，且点击它们不许把"选中"改掉（选中是点行，不是点按钮）
    expect(within(row).getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['恢复', '彻底删除…'])
    expect(row).toHaveAttribute('aria-selected', 'true') // 宽档自动选中就是这一条
    expect(container.querySelector('[data-dsh-session-delete="trash-list"]')).toBeInTheDocument()
    expect(container.querySelector('[data-dsh-session-delete="trash-detail"]')).toBeInTheDocument()
    // 左栏的定宽 = 面板常量（box-sizing:border-box，含给滚动条的 10px 内边距）
    expect((container.querySelector('[data-dsh-session-delete="trash-list"]')!.parentElement as HTMLElement).style.width).toBe('420px')
  })

  it('窄档：先只有清单（动作照样在行右侧），点行才下钻出详情；「← 返回清单」回得去且选中还在', async () => {
    const deps = makeDeps()
    const { container } = renderNarrow(deps)
    const row = await screen.findByRole('option', { name: /code-review/ })
    expect(within(row).getByRole('button', { name: '恢复' })).toBeInTheDocument()
    expect(container.querySelector('[data-dsh-session-delete="trash-detail"]')).not.toBeInTheDocument()

    fireEvent.click(row)
    expect(await screen.findByText('先看改动')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '← 返回清单' }))
    expect(screen.getByRole('option', { name: /code-review/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('button', { name: '← 返回清单' })).not.toBeInTheDocument()
    expect(deps.detail).toHaveBeenCalledTimes(1)
  })

  it('宽度是跟着中央列走的：从宽变窄不重取数，选中还在，再点一下就回到那条详情', async () => {
    const deps = makeDeps()
    const view = renderWide(deps)
    fireEvent.click(await screen.findByRole('option', { name: /code-review/ }))
    await screen.findByText('先看改动')
    // 变窄之后不硬塞一个"正在下的钻"：回到清单，选中留着，点一下就用缓存回来了（不重读、不重列）
    act(() => { view.observer.pump(400) })
    expect(screen.getByRole('option', { name: /code-review/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByText('先看改动')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: /code-review/ }))
    expect(await screen.findByText('先看改动')).toBeInTheDocument()
    expect(deps.detail).toHaveBeenCalledTimes(1)
    expect(deps.list).toHaveBeenCalledTimes(1)
  })

  it('宽档首读完成后自动选中第一条（右栏不该空着）', async () => {
    const deps = makeDeps()
    renderWide(deps)
    expect(await screen.findByText('先看改动')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /code-review/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('详情读失败只坏详情那一块：清单仍可选、行内动作仍可点', async () => {
    const deps = makeDeps({
      detail: vi.fn(async () => {
        throw Object.assign(new Error('读会话日志失败：第 2 帧解压失败'), { code: 'sessiondelete/io' })
      }),
    })
    renderWide(deps)
    expect(await screen.findByRole('status')).toHaveTextContent(/第 2 帧解压失败/)
    const row = screen.getByRole('option', { name: /code-review/ })
    expect(within(row).getByRole('button', { name: '恢复' })).toBeEnabled()
    // 「重试」只重读那一条，不牵清单
    deps.detail.mockResolvedValue(detailFixture)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('先看改动')).toBeInTheDocument()
    expect(deps.list).toHaveBeenCalledTimes(1)
  })
})

describe('回收站面板 · 键盘', () => {
  const two = [
    { ...rows[0], id: 'a', projectDir: '--p--', title: '第一条', deletedAt: 300 },
    { ...rows[0], id: 'b', projectDir: '--p--', title: '第二条', deletedAt: 100 },
  ]

  it('ArrowDown 第一次落到第一条、第二次走到下一条；Enter 在窄档进下钻', async () => {
    const deps = makeDeps({ list: vi.fn(async () => two) })
    renderNarrow(deps)
    const first = await screen.findByRole('option', { name: /第一条/ })
    // 还没选中任何东西时，ArrowDown 的标准语义是"落到第一项"，不是跳过第一项
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: /第一条/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: /第二条/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(screen.getByRole('option', { name: /第二条/ }), { key: 'Enter' })
    expect(await screen.findByRole('button', { name: '← 返回清单' })).toBeInTheDocument()
    expect(screen.getByText('先看改动')).toBeInTheDocument()
  })

  it('ArrowUp 从第一条回到最后一条（清单里是环，不是撞墙）', async () => {
    const deps = makeDeps({ list: vi.fn(async () => two) })
    renderNarrow(deps)
    const first = await screen.findByRole('option', { name: /第一条/ })
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('option', { name: /第一条/ }), { key: 'ArrowUp' })
    expect(screen.getByRole('option', { name: /第二条/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('下钻里按 Esc 退回清单：选中不变，焦点交还给那一行', async () => {
    const deps = makeDeps({ list: vi.fn(async () => two) })
    renderNarrow(deps)
    fireEvent.click(await screen.findByRole('option', { name: /第二条/ }))
    await screen.findByRole('button', { name: '← 返回清单' })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: '← 返回清单' })).not.toBeInTheDocument()
    const row = screen.getByRole('option', { name: /第二条/ })
    expect(row).toHaveAttribute('aria-selected', 'true')
    expect(document.activeElement).toBe(row)
    expect(deps.detail).toHaveBeenCalledTimes(1)
  })

  it('下钻里打开确认框：Esc 只关框，下钻不退；再按才回清单', async () => {
    const deps = makeDeps({ list: vi.fn(async () => two) })
    renderNarrow(deps)
    fireEvent.click(await screen.findByRole('option', { name: /第二条/ }))
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
      list: vi.fn(async () => two),
      emptyTrash: vi.fn(() => new Promise((resolve) => {
        finish = () => { resolve({ removed: 2, freedBytes: 2 }) }
      })),
    })
    renderNarrow(deps)
    fireEvent.click(await screen.findByRole('option', { name: /第二条/ }))
    await screen.findByRole('button', { name: '← 返回清单' })
    fireEvent.click(screen.getByRole('button', { name: '清空回收站…' }))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: '彻底删除' }))
    const cancel = dialog.getByRole('button', { name: '取消' }) as HTMLButtonElement
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

  it('清单那一块是 listbox：每行一个 option，选中的带 aria-selected', async () => {
    const deps = makeDeps({ list: vi.fn(async () => two) })
    renderWide(deps)
    const list = await screen.findByRole('listbox')
    expect(list).toHaveAccessibleName('回收站清单')
    expect(within(list).getAllByRole('option')).toHaveLength(2)
    expect(within(list).getAllByRole('option').filter((row) => row.getAttribute('aria-selected') === 'true')).toHaveLength(1)
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
    expect(within(toolbar).getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['全部折叠', '多选'])
    expect(screen.queryByRole('button', { name: '重新读一遍回收站' })).toBeNull()
  })

  // 真机反馈：删完在别处（侧栏菜单），面板是"挂载时取一次数"，不切走再回来就看不见新条目。
  it('别处动过回收站（失效通告）时立刻重读清单，不用切走再回来', async () => {
    const deps = makeDeps({ list: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(rows) })
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
      list: vi.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([]),
      })
    renderWide(deps)
    const row = await screen.findByRole('option', { name: /code-review/ })
    await screen.findByText('先看改动')
    fireEvent.click(within(row).getByRole('button', { name: '恢复' }))
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
    expect(screen.queryByText('先看改动')).not.toBeInTheDocument()
    expect(deps.list).toHaveBeenCalledTimes(2)
  })

  it('行里的「彻底删除…」也要先确认，确认后走一次 purge（N=1 的批量）', async () => {
    const deps = makeDeps()
    renderWide(deps)
    const row = await screen.findByRole('option', { name: /code-review/ })
    fireEvent.click(within(row).getByRole('button', { name: '彻底删除…' }))
    expect(deps.applyOutcomes).not.toHaveBeenCalled()
    expect(screen.getByText(/没有任何副本可以恢复/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }))
    await waitFor(() => expect(deps.applyOutcomes).toHaveBeenCalledWith('purge', ['a']))
  })

  // 附件清理是**上一趟写的后果**：清单照常重读，但这句警告要留在面板顶部（面板把回执里那半句交给 query，
  // 再读 `attachmentNotice` 渲染）。任务简报里写的"给 query 夹具塞 attachmentNotice"在这里不适用——
  // 本文件用真 hook + 假远端整块渲染，所以这条从真回执走上来，断言的是接线而不是夹具。
  it('彻底删除的回执说「N 个附件未清」⇒ 面板顶部摆出那句警告', async () => {
    const deps = makeDeps({
      applyOutcomes: vi.fn(async (_action: ApplyAction, ids: readonly string[]) => outcomes('purge', ids, {
        a: { value: { removed: 1, freedBytes: 1, attachments: { removed: 0, freedBytes: 0, failed: 2 } } },
      })),
    })
    renderWide(deps)
    const row = await screen.findByRole('option', { name: /code-review/ })
    fireEvent.click(within(row).getByRole('button', { name: '彻底删除…' }))
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }))
    expect(await screen.findByText('已删除会话，但 2 个附件未能清理')).toBeInTheDocument()
  })

  // 彻底删除按组走（组语义见 src/trash/groups.ts）⇒ 点下去页脚合计掉的是「父 + 全部孩子」。确认框那一格说的是
  // "我即将失去多少"，所以它必须是同一个口径，不能只报父自己那一格（issue #2）。
  it('单条彻底删除的确认卡片报的是整组要释放的字节（父 + 孩子）', async () => {
    const group = [{ ...rows[0]!, sizeBytes: 1024, releaseBytes: 1536, subagentCount: 2, subagentBytes: 512 }]
    const deps = makeDeps({ list: vi.fn(async () => group) })
    renderWide(deps)
    const row = await screen.findByRole('option', { name: /code-review/ })
    fireEvent.click(within(row).getByRole('button', { name: '彻底删除…' }))
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
      list: vi.fn(async () => {
        throw Object.assign(new Error('回收站清单损坏'), { code: 'sessiondelete/io' })
      }),
    })
    render(<TrashPanel deps={deps} />)
    expect(await screen.findByText(/回收站清单损坏/)).toBeInTheDocument()
    expect(screen.queryByText('回收站是空的')).not.toBeInTheDocument()
  })

  it('读失败时给「重试」，点一下把清单重读一遍', async () => {
    const deps = makeDeps({
      list: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('回收站清单损坏'), { code: 'sessiondelete/io' }))
        .mockResolvedValueOnce(rows),
    })
    render(<TrashPanel deps={deps} />)
    await waitFor(() => expect(deps.list).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByRole('button', { name: '重试' }))
    expect(await screen.findByText('/code-review')).toBeInTheDocument()
    expect(deps.list).toHaveBeenCalledTimes(2)
  })

  // 改版前 `entries === null` 那一拍什么都不画：读得慢就是一块没有解释的空。
  it('首读未回时不是空态（不拿「回收站是空的」骗人）', async () => {
    let release: (value: typeof rows) => void = () => {}
    const deps = makeDeps({ list: vi.fn(() => new Promise<typeof rows>((resolve) => { release = resolve })) })
    render(<TrashPanel deps={deps} />)
    expect(screen.queryByText('回收站是空的')).not.toBeInTheDocument()
    expect(screen.getByText('正在读回收站…')).toBeInTheDocument()
    release(rows)
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
    Array.from(container.querySelectorAll('[data-dsh-session-delete="trash-group"]')) as HTMLElement[]

  it('按项目分组：组头只出现一次，名字是摘掉 `--…--` 裹边的目录名', async () => {
    const { container } = render(
      <TrashPanel deps={makeDeps({ list: vi.fn(async () => twoProjects) })} />,
    )
    await screen.findByText('书源解析回归')
    const groups = groupsOf(container)
    expect(groups).toHaveLength(2)
    expect(within(groups[0]!).getByText('D-develop-GitHub-dsh-novel')).toBeInTheDocument()
    expect(within(groups[0]!).getByText('2 个会话')).toBeInTheDocument()
    expect(within(groups[1]!).getByText('C-Users-xrn')).toBeInTheDocument()
    expect(within(groups[1]!).getByText('1 个会话')).toBeInTheDocument()
    expect(within(groups[0]!).getByText('书源解析回归')).toBeInTheDocument()
    expect(within(groups[0]!).getByText('合并冲突')).toBeInTheDocument()
  })

  it('组按最新一条倒序，组内也按删除时间倒序', async () => {
    const { container } = render(
      <TrashPanel deps={makeDeps({ list: vi.fn(async () => twoProjects) })} />,
    )
    await screen.findByText('书源解析回归')
    const groups = groupsOf(container)
    expect(groups[0]!.textContent).toMatch(/合并冲突[\s\S]*书源解析回归/)
    expect(groups[1]!.textContent).toContain('兼容排查')
  })

  it('时间走官方 relativeTime 的分桶，绝对时间留在 title 里', async () => {
    const at = Date.now() - (3 * 3600 + 60) * 1000
    render(<TrashPanel deps={makeDeps({ list: vi.fn(async () => [{ ...rows[0], deletedAt: at }]) })} />)
    const meta = await screen.findByTitle(new Date(at).toLocaleString())
    expect(meta.textContent).toBe(`删除于 3小时前 · ${fileSizeText(rows[0]!.sizeBytes)}`)
  })

  it('now 桶说「刚刚删除」，不写出「删除于 刚刚前」', async () => {
    render(<TrashPanel deps={makeDeps({ list: vi.fn(async () => [{ ...rows[0], deletedAt: Date.now() }]) })} />)
    expect(await screen.findByText(/刚刚删除 · 224KB/)).toBeInTheDocument()
    expect(screen.queryByText(/删除于 刚刚/)).not.toBeInTheDocument()
  })

  // 宿主客户端把 `origin:"subagent"` 的行整排藏掉（连「未分组」那一桶也过同一个过滤器）⇒ 删了父会话之后
  // 还剩多少孩子，用户从界面上**一个字都看不见**。这一栏就是把那个数说出来；没有计数时（宿主服务没挂、
  // 或这一条确实没孩子）半句都不许出现——不许拿「含 0 个」冒充「不知道」。
  it('行上如实显示「含 N 个子会话」', async () => {
    render(<TrashPanel deps={makeDeps({ list: vi.fn(async () => [{ ...rows[0], subagentCount: 3 }]) })} />)
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
    render(<TrashPanel deps={makeDeps({ list: vi.fn(async () => [{ ...rows[0], strandedSubagents: 4 }]) })} />)
    expect(await screen.findByText(/盘上还剩 4 个子会话/)).toBeInTheDocument()
    expect(screen.queryByText(/含 4 个子会话/)).not.toBeInTheDocument()
  })

  it('两组都有 ⇒ 先说带进来的，再说还剩的（两个数各自站开）', async () => {
    render(<TrashPanel deps={makeDeps({ list: vi.fn(async () => [{ ...rows[0], subagentCount: 2, strandedSubagents: 4 }]) })} />)
    const line = await screen.findByText(/含 2 个子会话/)
    expect(line.textContent).toContain('含 2 个子会话')
    expect(line.textContent).toContain('还剩 4 个')
  })

  it('头部合计要把组里孩子的字节算上（孩子不单独列行，只加父那一格就会少报）', async () => {
    render(<TrashPanel deps={makeDeps({
      list: vi.fn(async () => [{ ...rows[0], sizeBytes: 1024, releaseBytes: 1536, subagentCount: 2, subagentBytes: 512 }]),
    })} />)
    expect(await screen.findByText(/1.5KB/)).toBeInTheDocument()
  })

  // 盘上还剩的孩子也会被彻底删除/清空连带带走（`purgeTrash`），所以"共多少"与确认框那句
  // 「我即将失去多少」都读 Node 半算好的 `releaseBytes`（唯一算式在 `api/trash-rows.ts` 的 `toWire`），
  // 同一屏不许两套口径。
  it('头部合计与单条彻底删除确认都算上 strandedBytes', async () => {
    const row = { ...rows[0]!, strandedSubagents: 2, strandedBytes: 2 * 1024, releaseBytes: 224 * 1024 + 2 * 1024 }
    const deps = makeDeps({ list: vi.fn(async () => [row]) })
    renderWide(deps)
    expect(await screen.findByText(/可释放 226KB/)).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('option', { name: /code-review/ })).getByRole('button', { name: '彻底删除…' }))
    expect(within(screen.getByRole('dialog')).getByText(/226KB/)).toBeInTheDocument()
  })

  it('组头摘掉 `--…--` 裹边并还原 `~XXXX` 转义；没有目录时不编一个名字出来', async () => {
    const odd = [
      { ...rows[0], id: 'a', projectDir: '--D-develop-~4E2D~6587--', title: '中文目录' },
      { ...rows[0], id: 'b', projectDir: '_no-cwd', title: '无 cwd' },
      { ...rows[0], id: 'c', projectDir: '', title: '空串' },
    ]
    render(<TrashPanel deps={makeDeps({ list: vi.fn(async () => odd) })} />)
    expect(await screen.findByText('D-develop-中文')).toBeInTheDocument()
    expect(screen.getAllByText('未记录项目')).toHaveLength(2)
  })

  // 整页只有一块实心红（2026-10-01 立的层级，两栏改版一步没让）。
  it('危险动作分两档：行内那把只有字色，实心红仍然只有「清空回收站…」', async () => {
    renderWide(makeDeps())
    const row = await screen.findByRole('option', { name: /code-review/ })
    const danger = within(row).getByRole('button', { name: '彻底删除…' })
    expect(danger.classList.contains('sd-button-ghost')).toBe(true)
    expect(danger.style.color).toBe('var(--dsw-alias-state-error-primary)')
    // 铺了内联 background 就会把 `.sd-button-ghost:hover` 打死（内联永远赢过类规则）——点错之前就没反馈了。
    expect(danger.style.background).toBe('')

    const bulk = screen.getByRole('button', { name: '清空回收站…' })
    expect(bulk.classList.contains('sd-button-primary')).toBe(true)
    expect(bulk.style.getPropertyValue('--dsw-alias-button-primary-fill')).toBe(
      'var(--dsw-alias-state-error-primary)',
    )
  })

  it('选中的行换成宿主"选中"那一档的两枚 token，未选中的还是卡片配方', async () => {
    const twoRows = [
      rows[0]!,
      { ...rows[0]!, id: 'b', sessionId: 'session-b', title: '另一条会话' },
    ]
    const { container } = renderWide(makeDeps({ list: vi.fn(async () => twoRows) }))
    const row = await screen.findByRole('option', { name: /code-review/ })
    expect(row.style.background).toBe('var(--dsw-alias-button-ghost-active-fill)')
    expect(row.style.border).toContain('var(--dsw-alias-button-ghost-active-border)')
    // 两行才谈得上"未选中"：只渲一行时宽档必然把那唯一一行自动选中，未选中那一侧无从断言。
    const unselected = container.querySelectorAll('[aria-selected="false"]')
    expect(unselected).toHaveLength(1)
    expect((unselected[0] as HTMLElement).style.background).toBe('var(--dsw-alias-bg-layer-2)')
  })
})

describe('回收站面板 · 折叠 / 收起 / 拖栏（2026-10-15 视图三件）', () => {
  const twoProjects = [
    { ...rows[0], id: 'a', projectDir: '--P-one--', title: '甲组第一条', deletedAt: 300 },
    { ...rows[0], id: 'b', projectDir: '--P-one--', title: '甲组第二条', deletedAt: 200 },
    { ...rows[0], id: 'c', projectDir: '--P-two--', title: '乙组第一条', deletedAt: 100 },
  ]
  const depsOf = (): FakeRemote => makeDeps({ list: vi.fn(async () => twoProjects) })
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
    expect(heads(container)[0]!.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(heads(container)[0]!)
    expect(screen.queryByText('甲组第一条')).not.toBeInTheDocument()
    expect(screen.queryByText('甲组第二条')).not.toBeInTheDocument()
    expect(screen.getByText('乙组第一条')).toBeInTheDocument()
    expect(heads(container)[0]!.getAttribute('aria-expanded')).toBe('false')
    // 组头本身不能被一起收掉——收掉就没有再点开的地方了
    expect(heads(container)).toHaveLength(2)
  })

  it('折叠掉的组不参与 ↑↓：键盘序列只走看得见的行', async () => {
    const { container } = renderNarrow(depsOf())
    await screen.findByText('甲组第一条')
    fireEvent.click(heads(container)[0]!)
    expect(visibleRows(container)).toEqual(['c'])
    fireEvent.keyDown(container.querySelector('[data-dsh-session-delete="trash-list"]')!, { key: 'ArrowDown' })
    const selected = container.querySelector('[data-dsh-session-delete="trash-row"][aria-selected="true"]') as HTMLElement
    expect(selected.getAttribute('data-entry-id')).toBe('c')
  })

  it('选中那条被折叠起来时，aria-activedescendant 不指向一个不在 DOM 的 id', async () => {
    const { container } = renderWide(depsOf())
    await screen.findByText('甲组第一条')
    const list = container.querySelector('[data-dsh-session-delete="trash-list"]')!
    expect(list.getAttribute('aria-activedescendant')).toBe('sd-trash-a')
    fireEvent.click(heads(container)[0]!)
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
    await screen.findByText('甲组第一条')
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
    await screen.findByText('甲组第一条')
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
    await screen.findByText('甲组第一条')
    const handle = container.querySelector('[role="separator"]') as HTMLElement
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(columnOf(container).style.width).toBe('440px')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(columnOf(container).style.width).toBe('420px')
  })

  it('折叠与拖宽互不干扰：拖过之后折叠状态与条目可见性都照旧', async () => {
    const { container } = renderWide(depsOf())
    await screen.findByText('甲组第一条')
    fireEvent.click(heads(container)[0]!)
    const handle = container.querySelector('[role="separator"]') as HTMLElement
    firePointer(handle, 'pointerdown', { clientX: 500 })
    firePointer(handle, 'pointermove', { clientX: 600 })
    firePointer(handle, 'pointerup', { clientX: 600 })
    expect(columnOf(container).style.width).toBe('520px')
    expect(visibleRows(container)).toEqual(['c'])
    expect(heads(container)[0]!.getAttribute('aria-expanded')).toBe('false')
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
      list: over.list ?? vi.fn(async () => three),
      applyOutcomes: over.applyOutcomes ?? vi.fn(async (action: ApplyAction, ids: readonly string[]) => outcomesOf(action, ids)),
    })

  const boxes = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-dsh-session-delete="trash-row"] input[type="checkbox"]')] as HTMLInputElement[]
  const rowOf = (container: HTMLElement, id: string) =>
    container.querySelector(`[data-dsh-session-delete="trash-row"][data-entry-id="${id}"]`) as HTMLElement
  const footerButton = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement

  it('进多选：行内两颗按钮退场，每行左侧出勾选框，头部给计数', async () => {
    const { container } = renderNarrow(depsOf())
    await screen.findByText('第一条')
    expect(screen.getAllByRole('button', { name: '恢复' })).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    expect(screen.queryByRole('button', { name: '恢复' })).toBeNull()
    expect(screen.queryByRole('button', { name: '彻底删除…' })).toBeNull()
    expect(boxes(container)).toHaveLength(3)
    expect(screen.getByText('已选 0 条')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '退出多选' })).toBeInTheDocument()
  })

  it('点行 = 切换勾选；再点回退；详情那条不动', async () => {
    const { container } = renderWide(depsOf())
    await screen.findByText('第一条')
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
    fireEvent.click(boxes(container)[0]!)
    expect(boxes(container)[0]!.checked).toBe(true)
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
    const applyOutcomes = vi.fn(async (action: ApplyAction, ids: readonly string[]) => outcomesOf(action, ids))
    const list = vi.fn(async () => three)
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
    const list = vi.fn().mockResolvedValueOnce(rows).mockResolvedValue([])
    const { container } = renderNarrow(depsOf({ list }))
    await screen.findByText('/code-review')
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    fireEvent.click(rowOf(container, 'a'))
    fireEvent.click(footerButton('彻底删除 1 条'))
    fireEvent.click(await screen.findByRole('button', { name: '彻底删除' }))
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
    const exit = screen.getByRole('button', { name: '退出多选' }) as HTMLButtonElement
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
    const applyOutcomes = vi.fn(async (action: ApplyAction, ids: readonly string[]) => outcomesOf(action, ids))
    const list = vi.fn().mockResolvedValueOnce(crossed).mockResolvedValue([])
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
    const applyOutcomes = vi.fn(async (_action: string, ids: readonly string[]) =>
      outcomesOf('purge', ids, { b: '该会话正被占用' }))
    // 注意 `mockResolvedValue` 调两次是**替换**实现、不是排队（踩过：首屏就直接拿到第二份数据），
    // 要"先给全量、重读后给少一条"必须用 `mockResolvedValueOnce` 起头。
    const list = vi.fn().mockResolvedValueOnce(three).mockResolvedValue([three[1], three[2]])
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
    const list = vi.fn().mockResolvedValueOnce(three).mockResolvedValue([three[0], three[1]])
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
    const applyOutcomes = vi.fn(async (action: ApplyAction, ids: readonly string[]) => outcomesOf(action, ids))
    const list = vi.fn().mockResolvedValueOnce(three).mockResolvedValue([three[2]])
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
    const { container } = renderNarrow(depsOf({ list: vi.fn(async () => flagged) }))
    await screen.findByText('第二条')
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    fireEvent.click(rowOf(container, 'b'))
    fireEvent.click(footerButton('恢复 1 条'))
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('原工作区已不存在，恢复后归入未分组')).toBeInTheDocument()
  })

  it('批量恢复部分失败：成功的走、失败的把原文留在它自己那一行', async () => {
    const applyOutcomes = vi.fn(async (_action: string, ids: readonly string[]) =>
      outcomesOf('restore', ids, { b: '原项目目录已不存在' }))
    const list = vi.fn().mockResolvedValueOnce(three).mockResolvedValue([three[1]])
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
  it('重读只应用**最新一次**的结果：慢的旧响应后到也不许把清单盖回去', async () => {
    const open = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
      let resolve!: (value: T) => void
      const promise = new Promise<T>((inResolve) => { resolve = inResolve })
      return { promise, resolve }
    }
    const first = open<typeof three>()
    const second = open<typeof three>()
    const list = vi
      .fn<() => Promise<typeof three>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    renderNarrow(depsOf({ list }))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    act(() => { invalidateTrash() })
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    // 第二次**先**落地、第一次更晚才回 ⇒ 后到的那份旧数据必须被丢掉
    second.resolve([three[2]])
    expect(await screen.findByText('第三条')).toBeInTheDocument()
    first.resolve(three)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText('第一条')).toBeNull()
  })

  it('多选态：listbox 声明可多选，aria-selected 说的是勾选；退出后回到"选中看详情"那套', async () => {
    // 用宽档：窄档点行会下钻，清单整块离开 DOM，那时候量不到 listbox 的 aria。
    const { container } = renderWide(depsOf())
    await screen.findByText('第一条')
    const list = container.querySelector('[data-dsh-session-delete="trash-list"]')!
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
    await screen.findByText('第一条')
    const list = container.querySelector('[data-dsh-session-delete="trash-list"]')!
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
  const depsOf = (): FakeRemote => makeDeps({ list: vi.fn(async () => grouped) })
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
    fireEvent.click(heads(container)[0]!)
    expect(visibleRows(container)).toEqual(['c'])
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    fireEvent.click(groupBoxes(container)[0]!)
    expect(screen.getByText('已选 2 条')).toBeInTheDocument()
    fireEvent.click(groupBoxes(container)[0]!)
    expect(screen.getByText('已选 0 条')).toBeInTheDocument()
  })

  it('组头那颗是三态：只勾了几条是半选（mixed），勾满才是选中，再点清空', async () => {
    const { container } = renderNarrow(depsOf())
    await screen.findByText('第一条')
    const rowOf = (id: string) =>
      container.querySelector(`[data-dsh-session-delete="trash-row"][data-entry-id="${id}"]`) as HTMLElement
    const groupOne = () => groupBoxes(container)[0]!
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
    fireEvent.click(groupBoxes(container)[0]!)
    expect(heads(container)[0]!.getAttribute('aria-expanded')).toBe('true')
    expect(visibleRows(container)).toEqual(['a', 'b', 'c'])
  })

  // 组头是 `<button>`，UA 的 `text-align:center` 会渗到里面的文字（宿主那份是 div，没这问题）——
  // 真机上项目名整个居中就是这个。显式 `start` 是这条的钉子。
  it('组头标题左对齐（button 的 UA 居中必须显式压掉）', async () => {
    const { container } = renderNarrow(depsOf())
    await screen.findByText('第一条')
    expect(heads(container)[0]!.style.textAlign).toBe('start')
  })
})

describe('回收站面板 · 两档边界、右栏的出现条件与键盘落点（2026-10-15）', () => {
  const threeRows = [
    { ...rows[0]!, id: 'a', title: '甲组第一条', projectDir: '--P-one--' },
    { ...rows[0]!, id: 'b', title: '乙组第一条', projectDir: '--P-two--' },
    { ...rows[0]!, id: 'c', title: '丙组第一条', projectDir: '--P-three--' },
  ]
  const depsOfThree = (): FakeRemote => makeDeps({ list: vi.fn(async () => threeRows) })
  const listColumn = (container: HTMLElement): HTMLElement =>
    container.querySelector('[data-dsh-session-delete="trash-list"]')!.parentElement as HTMLElement
  const renderAt = (width: number, deps: FakeRemote) => {
    const observer: WidthObserver = installWidthObserver()
    const view = render(<TrashPanel deps={deps} />)
    act(() => { observer.pump(width) })
    return { ...view, observer }
  }

  it('盒子正好 900 就分栏（断点是含边界的 ≥）', async () => {
    const { container } = renderAt(900, makeDeps())
    await screen.findByRole('option', { name: /code-review/ })
    expect(container.querySelector('[role="separator"]')).not.toBeNull()
    expect(container.querySelector('[data-dsh-session-delete="trash-detail"]')).not.toBeNull()
  })

  it('差 1 px（899）就走下钻：既没有把手也没有右栏', async () => {
    const { container } = renderAt(899, makeDeps())
    await screen.findByRole('option', { name: /code-review/ })
    expect(container.querySelector('[role="separator"]')).toBeNull()
    expect(container.querySelector('[data-dsh-session-delete="trash-detail"]')).toBeNull()
  })

  // docs/ui-spec.md：清单为空或读数失败时右栏不出现——那一栏没有可选项也没有动作。
  it('空回收站即便盒子够宽也不出右栏（也没把手可拖）', async () => {
    const { container } = renderAt(1100, makeDeps({ list: vi.fn(async () => []) }))
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
    expect(container.querySelector('[data-dsh-session-delete="trash-detail"]')).toBeNull()
    expect(container.querySelector('[role="separator"]')).toBeNull()
  })

  it('清单读不到时也只摆清单那一块：原文 +「重试」负责把清单读回来', async () => {
    const { container } = renderAt(1100, makeDeps({ list: vi.fn(async () => { throw new Error('磁盘忙') }) }))
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
    expect(tabStops[0]!.textContent).toContain('甲组第一条')
  })

  it('选中之后落点跟着那一行走（其余全退回 -1，roving tabindex 只有一个）', async () => {
    const { container } = renderWide(depsOfThree())
    await screen.findByText('甲组第一条')
    fireEvent.click(screen.getByRole('option', { name: /乙组第一条/ }))
    const rows = [...container.querySelectorAll('[data-dsh-session-delete="trash-row"]')]
    const tabStops = rows.filter((row) => (row as HTMLElement).tabIndex === 0)
    expect(tabStops).toHaveLength(1)
    expect(tabStops[0]!.textContent).toContain('乙组第一条')
  })
})

// 回收站之外的无主子会话（父既不在宿主语料、也不在清册）2026-10-19 挂在面板上，
// 2026-10-27 搬进插件设置页的维护卡（手动检查 → 预览 → 清理）。面板不再自动扫、也不再摆那块警告条：
// 那三条界面规则（报告非空才出、读不到是可见失败、清理仍走 `/apply` 的第五个动作）连同用例
// 一起住 `orphan-maintenance.test.tsx` / `maintenance-settings.test.tsx` 与 `use-maintenance.test.tsx`。
// 这里只钉"面板这一侧真的没有了"：给假远端一份非空孤儿报告，面板一次都不去问。
describe('回收站面板 · 不再自动扫无主子会话（2026-10-27 搬家后）', () => {
  it('挂载与写后重读都不发 /orphans，面板上也没有孤儿提示', async () => {
    const deps = makeDeps({ scanOrphans: vi.fn(async () => ORPHANS) })
    renderWide(deps)
    await screen.findByRole('option', { name: /code-review/ })
    // 写后重读（失效通告）也不许顺手扫一次。
    act(() => { invalidateTrash() })
    await waitFor(() => expect(deps.list).toHaveBeenCalledTimes(2))
    expect(deps.scanOrphans).not.toHaveBeenCalled()
    expect(screen.queryByText(/无主子会话/)).not.toBeInTheDocument()
    expect(document.querySelector('[data-dsh-session-delete="orphan-banner"]')).toBeNull()
  })
})
