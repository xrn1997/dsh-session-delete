// 回收站清单面板（浏览器半的单元层）。入口迁到全局面板后，本文件只管面板本体：
// 座位与注册形状归 `index.test.tsx`，这里钉交互与状态机。
//
// 2026-10-15 两栏改版：断点由 ResizeObserver 的读数决定，所以每个用例先决定"这一趟是宽档还是窄档"
// （`renderWide` / `renderNarrow`，替身见 support/observe-width.ts）。jsdom 没有真实布局，
// `clientWidth` 恒 0 ⇒ 不装替身就是窄档，正好也是"读不到就当窄"那条默认。
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { fileSizeText } from '../../src/client/ui/format.js'
import { TrashPanel } from '../../src/client/trash-panel.js'
import { invalidateTrash } from '../../src/client/trash-store.js'
import type { TrashDetailLike } from '../../src/client/remote.js'
import { installWidthObserver, type WidthObserver } from './support/observe-width.js'
import { firePointer } from './support/pointer.js'

const rows = [
  { id: 'a', sessionId: 'session-a', projectDir: '--p--', workspaceId: 'ws', wasArchived: false, deletedAt: 1, sizeBytes: 224 * 1024, title: '/code-review' },
]

const detailFixture: TrashDetailLike = {
  entryId: 'a', cwd: 'C:/develop/p', createdAt: 1, lastActivity: 2, logTitle: '日志里的标题',
  models: ['m-1'], turnCount: 1, userMessageCount: 1, assistantMessageCount: 1, toolCallCount: 3,
  injectedCount: 7, omittedByPayloadCap: 0,
  messages: [
    { role: 'user', time: 1, text: '先看改动', truncated: false },
    { role: 'assistant', time: 2, text: '改动分四层', truncated: false },
  ],
}

type Deps = { list: ReturnType<typeof vi.fn>; restore: ReturnType<typeof vi.fn>; purge: ReturnType<typeof vi.fn>; detail: ReturnType<typeof vi.fn> }

function makeDeps(over: Partial<Omit<Deps, 'detail'>> & { detail?: ReturnType<typeof vi.fn> } = {}): Deps {
  return {
    list: vi.fn(async () => rows),
    restore: vi.fn(async () => ({})),
    purge: vi.fn(async () => ({ removed: 1, freedBytes: 1 })),
    detail: vi.fn(async () => detailFixture),
    ...over,
  }
}

/** 宽档：RO 交回 1100 ⇒ 左右两栏（清单默认 420 + 详情吃余下）。 */
function renderWide(deps: Deps) {
  const observer: WidthObserver = installWidthObserver()
  const view = render(<TrashPanel deps={deps as never} />)
  act(() => { observer.pump(1100) })
  return { ...view, observer }
}

/** 窄档：RO 交回 400 ⇒ 点行下钻。 */
function renderNarrow(deps: Deps) {
  const observer: WidthObserver = installWidthObserver()
  const view = render(<TrashPanel deps={deps as never} />)
  act(() => { observer.pump(400) })
  return { ...view, observer }
}

describe('回收站面板', () => {
  it('空回收站显示空态且没有清空按钮', async () => {
    render(<TrashPanel deps={makeDeps({ list: vi.fn(async () => []) }) as never} />)
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '清空回收站…' })).not.toBeInTheDocument()
  })

  // 动作住在行右侧（2026-10-15 真机反馈后回到 2026-10-01 的形状，设计稿 §7），所以这条直接点行内那颗。
  it('行右侧的「恢复」调 restore 并带上条目 id（动作住在行内，2026-10-15 真机反馈后回归原形）', async () => {
    const deps = makeDeps()
    renderWide(deps)
    const row = await screen.findByRole('option', { name: /code-review/ })
    fireEvent.click(within(row).getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(deps.restore).toHaveBeenCalledWith('a'))
  })

  it('清空要先二次确认，确认后才调 purge（不带 entryId）', async () => {
    const deps = makeDeps()
    render(<TrashPanel deps={deps as never} />)
    fireEvent.click(await screen.findByRole('button', { name: '清空回收站…' }))
    expect(deps.purge).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }))
    await waitFor(() => expect(deps.purge).toHaveBeenCalledWith(undefined))
  })

  // 动作住在行内 ⇒ 它的失败也就留在行内（与 2026-10-01 那条"失败写在该行上"同一条规则）。
  it('恢复失败的原因写在那一行上，不弹全局错误', async () => {
    const deps = makeDeps({
      restore: vi.fn(async () => {
        throw Object.assign(new Error('原项目目录已不存在'), { code: 'sessiondelete/project-missing' })
      }),
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

  it('一条会话只读一次：切走再切回来不重发 detail', async () => {
    const deps = makeDeps()
    const two = [
      { ...rows[0], id: 'a', title: '第一条' },
      { ...rows[0], id: 'b', title: '第二条' },
    ]
    deps.list = vi.fn(async () => two)
    renderWide(deps)
    fireEvent.click(await screen.findByRole('option', { name: /第二条/ }))
    await waitFor(() => expect(deps.detail).toHaveBeenCalledWith('b'))
    fireEvent.click(screen.getByRole('option', { name: /第一条/ }))
    await waitFor(() => expect(deps.detail).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('option', { name: /第二条/ }))
    await waitFor(() => expect(deps.detail).toHaveBeenCalledTimes(2))
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
  it('头部给出条数与合计占用（官方 fileSizeText 口径）', async () => {
    render(<TrashPanel deps={makeDeps() as never} />)
    expect(await screen.findByText('1 个会话 · 共 224KB')).toBeInTheDocument()
  })

  it('「刷新」降级成图标：没有文字，但按 aria-label 点得动，仍重读一遍', async () => {
    const deps = makeDeps()
    const { container } = render(<TrashPanel deps={deps as never} />)
    await screen.findByText('/code-review')
    expect(screen.queryByRole('button', { name: '刷新' })).toBeNull()
    const refresh = screen.getByRole('button', { name: '重新读一遍回收站' })
    expect(refresh.textContent).toBe('')
    expect(refresh.querySelector('svg')).not.toBeNull()
    // 它住在清单顶端那一排的最右，不住头部了
    expect(container.querySelector('[data-dsh-session-delete="trash-toolbar"]')).toContainElement(refresh)
    fireEvent.click(refresh)
    await waitFor(() => expect(deps.list).toHaveBeenCalledTimes(2))
  })

  // 真机反馈：删完在别处（侧栏菜单），面板是"挂载时取一次数"，不切走再回来就看不见新条目。
  it('别处动过回收站（失效通告）时立刻重读清单，不用切走再回来', async () => {
    const deps = makeDeps({ list: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(rows) })
    render(<TrashPanel deps={deps as never} />)
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
      restore: vi.fn(async () => ({})),
    })
    renderWide(deps)
    const row = await screen.findByRole('option', { name: /code-review/ })
    await screen.findByText('先看改动')
    fireEvent.click(within(row).getByRole('button', { name: '恢复' }))
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
    expect(screen.queryByText('先看改动')).not.toBeInTheDocument()
    expect(deps.list).toHaveBeenCalledTimes(2)
  })

  it('失败的行留着，恢复按钮可以再点（不是一次失败就没了）', async () => {
    const deps = makeDeps({
      restore: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('原项目目录已不存在'), { code: 'sessiondelete/project-missing' }))
        .mockResolvedValueOnce({}),
    })
    renderWide(deps)
    const row = await screen.findByRole('option', { name: /code-review/ })
    fireEvent.click(within(row).getByRole('button', { name: '恢复' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/原项目目录已不存在/)
    fireEvent.click(within(screen.getByRole('option', { name: /code-review/ })).getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(deps.restore).toHaveBeenCalledTimes(2))
  })

  it('行里的「彻底删除…」也要先确认，确认后 purge 带上那一条的 id', async () => {
    const deps = makeDeps()
    renderWide(deps)
    const row = await screen.findByRole('option', { name: /code-review/ })
    fireEvent.click(within(row).getByRole('button', { name: '彻底删除…' }))
    expect(deps.purge).not.toHaveBeenCalled()
    expect(screen.getByText(/没有任何副本可以恢复/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }))
    await waitFor(() => expect(deps.purge).toHaveBeenCalledWith('a'))
  })

  it('清空的确认框里点名不可恢复；取消一个字节都不动', async () => {
    const deps = makeDeps({ purge: vi.fn() })
    render(<TrashPanel deps={deps as never} />)
    fireEvent.click(await screen.findByRole('button', { name: '清空回收站…' }))
    expect(screen.getByText(/没有任何副本可以恢复/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(deps.purge).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('清单本身读不到时把原文摆在面板上，不是空态', async () => {
    const deps = makeDeps({
      list: vi.fn(async () => {
        throw Object.assign(new Error('回收站清单损坏'), { code: 'sessiondelete/io' })
      }),
    })
    render(<TrashPanel deps={deps as never} />)
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
    render(<TrashPanel deps={deps as never} />)
    fireEvent.click(await screen.findByRole('button', { name: '重试' }))
    expect(await screen.findByText('/code-review')).toBeInTheDocument()
    expect(deps.list).toHaveBeenCalledTimes(2)
  })

  // 改版前 `entries === null` 那一拍什么都不画：读得慢就是一块没有解释的空。
  it('首读未回时不是空态（不拿「回收站是空的」骗人）', async () => {
    let release: (value: typeof rows) => void = () => {}
    const deps = makeDeps({ list: vi.fn(() => new Promise<typeof rows>((resolve) => { release = resolve })) })
    render(<TrashPanel deps={deps as never} />)
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
      <TrashPanel deps={makeDeps({ list: vi.fn(async () => twoProjects) }) as never} />,
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
      <TrashPanel deps={makeDeps({ list: vi.fn(async () => twoProjects) }) as never} />,
    )
    await screen.findByText('书源解析回归')
    const groups = groupsOf(container)
    expect(groups[0]!.textContent).toMatch(/合并冲突[\s\S]*书源解析回归/)
    expect(groups[1]!.textContent).toContain('兼容排查')
  })

  it('时间走官方 relativeTime 的分桶，绝对时间留在 title 里', async () => {
    const at = Date.now() - (3 * 3600 + 60) * 1000
    render(<TrashPanel deps={makeDeps({ list: vi.fn(async () => [{ ...rows[0], deletedAt: at }]) }) as never} />)
    const meta = await screen.findByTitle(new Date(at).toLocaleString())
    expect(meta.textContent).toBe(`删除于 3小时前 · ${fileSizeText(rows[0]!.sizeBytes)}`)
  })

  it('now 桶说「刚刚删除」，不写出「删除于 刚刚前」', async () => {
    render(<TrashPanel deps={makeDeps({ list: vi.fn(async () => [{ ...rows[0], deletedAt: Date.now() }]) }) as never} />)
    expect(await screen.findByText(/刚刚删除 · 224KB/)).toBeInTheDocument()
    expect(screen.queryByText(/删除于 刚刚/)).not.toBeInTheDocument()
  })

  it('组头摘掉 `--…--` 裹边并还原 `~XXXX` 转义；没有目录时不编一个名字出来', async () => {
    const odd = [
      { ...rows[0], id: 'a', projectDir: '--D-develop-~4E2D~6587--', title: '中文目录' },
      { ...rows[0], id: 'b', projectDir: '_no-cwd', title: '无 cwd' },
      { ...rows[0], id: 'c', projectDir: '', title: '空串' },
    ]
    render(<TrashPanel deps={makeDeps({ list: vi.fn(async () => odd) }) as never} />)
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
  const depsOf = (): Deps => makeDeps({ list: vi.fn(async () => twoProjects) })
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

describe('回收站面板 · 多选与批量彻底删除（2026-10-15）', () => {
  const three = [
    { ...rows[0], id: 'a', projectDir: '--P-one--', title: '第一条', deletedAt: 300 },
    { ...rows[0], id: 'b', projectDir: '--P-one--', title: '第二条', deletedAt: 200 },
    { ...rows[0], id: 'c', projectDir: '--P-one--', title: '第三条', deletedAt: 100 },
  ]
  const depsOf = (over: { purge?: ReturnType<typeof vi.fn>; list?: ReturnType<typeof vi.fn> } = {}): Deps =>
    makeDeps({ list: over.list ?? vi.fn(async () => three), purge: over.purge ?? vi.fn(async () => ({ removed: 1, freedBytes: 1 })) })

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

  it('页脚那颗换成「彻底删除 N 条」：确认后按清单顺序逐条 purge，并重读一次', async () => {
    // 带签名造这个 mock：`vi.fn()` 空手造出来的调用类型是空元组，`calls[i][0]` 过不了类型检查
    // （断言"按清单顺序逐条删"正是要读那第一个参数）。
    const purge = vi.fn(async (_entryId: string) => ({ removed: 1, freedBytes: 1 }))
    const list = vi.fn(async () => three)
    const { container } = renderNarrow(depsOf({ purge, list }))
    await screen.findByText('第一条')
    fireEvent.click(screen.getByRole('button', { name: '多选' }))
    fireEvent.click(rowOf(container, 'b'))
    fireEvent.click(rowOf(container, 'a'))
    expect(footerButton('彻底删除 2 条').disabled).toBe(false)
    fireEvent.click(footerButton('彻底删除 2 条'))
    expect(await screen.findByText('彻底删除 2 个会话？')).toBeInTheDocument()
    expect(screen.getByText(/没有任何副本可以恢复/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }))
    await waitFor(() => expect(purge).toHaveBeenCalledTimes(2))
    // 顺序按清单从上往下，不按点击顺序——"我勾了哪几条"不该影响删除的读感
    expect(purge.mock.calls.map((call) => call[0])).toEqual(['a', 'b'])
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it('部分失败：删掉的走、没删掉的把原文留在它自己那一行，多选态不退', async () => {
    const purge = vi
      .fn()
      .mockResolvedValueOnce({ removed: 1, freedBytes: 1 })
      .mockRejectedValueOnce(Object.assign(new Error('该会话正被占用'), { code: 'sessiondelete/live' }))
    // 注意 `mockResolvedValue` 调两次是**替换**实现、不是排队（踩过：首屏就直接拿到第二批数据），
    // 要"先给全量、重读后给少一条"必须用 `mockResolvedValueOnce` 起头。
    const list = vi.fn().mockResolvedValueOnce(three).mockResolvedValue([three[1], three[2]])
    const { container } = renderNarrow(depsOf({ purge, list }))
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

describe('回收站面板 · 工具排常驻与组勾选（2026-10-15 同日第三批）', () => {
  const grouped = [
    { ...rows[0], id: 'a', projectDir: '--P-one--', title: '第一条', deletedAt: 300 },
    { ...rows[0], id: 'b', projectDir: '--P-one--', title: '第二条', deletedAt: 200 },
    { ...rows[0], id: 'c', projectDir: '--P-two--', title: '第三条', deletedAt: 100 },
  ]
  const depsOf = (): Deps => makeDeps({ list: vi.fn(async () => grouped) })
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

describe('回收站面板 · 两档边界、右栏的出现条件与键盘落点（2026-10-15 复核批）', () => {
  const threeRows = [
    { ...rows[0]!, id: 'a', title: '甲组第一条', projectDir: '--P-one--' },
    { ...rows[0]!, id: 'b', title: '乙组第一条', projectDir: '--P-two--' },
    { ...rows[0]!, id: 'c', title: '丙组第一条', projectDir: '--P-three--' },
  ]
  const depsOfThree = (): Deps => makeDeps({ list: vi.fn(async () => threeRows) })
  const listColumn = (container: HTMLElement): HTMLElement =>
    container.querySelector('[data-dsh-session-delete="trash-list"]')!.parentElement as HTMLElement
  const renderAt = (width: number, deps: Deps) => {
    const observer: WidthObserver = installWidthObserver()
    const view = render(<TrashPanel deps={deps as never} />)
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

  // 设计稿 2026-10-15 §2.3 第 1 条：清单为空或读数失败时右栏不出现——那一栏没有可选项也没有动作。
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
