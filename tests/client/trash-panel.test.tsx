// 回收站清单面板（浏览器半的单元层）。入口迁到全局面板后，本文件只管面板本体：
// 座位与注册形状归 `index.test.tsx`，这里钉交互与状态机。
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives'
import { TrashPanel } from '../../src/client/trash-panel.js'
import { invalidateTrash } from '../../src/client/trash-store.js'

const rows = [
  { id: 'a', sessionId: 'session-a', projectDir: '--p--', workspaceId: 'ws', wasArchived: false, deletedAt: 1, sizeBytes: 224 * 1024, title: '/code-review' },
]

describe('回收站面板', () => {
  it('空回收站显示空态且没有清空按钮', async () => {
    render(<TrashPanel deps={{ list: vi.fn(async () => []), restore: vi.fn(), purge: vi.fn() } as never} />)
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '清空回收站…' })).not.toBeInTheDocument()
  })

  it('恢复按钮调 restore 并带上条目 id', async () => {
    const restore = vi.fn(async () => ({}))
    render(<TrashPanel deps={{ list: vi.fn(async () => rows), restore, purge: vi.fn() } as never} />)
    fireEvent.click(await screen.findByRole('button', { name: '恢复' }))
    await waitFor(() => expect(restore).toHaveBeenCalledWith('a'))
  })

  it('清空要先二次确认，确认后才调 purge（不带 entryId）', async () => {
    const purge = vi.fn(async () => ({ removed: 1, freedBytes: 1 }))
    render(<TrashPanel deps={{ list: vi.fn(async () => rows), restore: vi.fn(), purge } as never} />)
    fireEvent.click(await screen.findByRole('button', { name: '清空回收站…' }))
    expect(purge).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }))
    await waitFor(() => expect(purge).toHaveBeenCalledWith(undefined))
  })

  it('恢复失败的原因写在该行上，不弹全局错误', async () => {
    const restore = vi.fn(async () => { throw Object.assign(new Error('原项目目录已不存在'), { code: 'sessiondelete/project-missing' }) })
    render(<TrashPanel deps={{ list: vi.fn(async () => rows), restore, purge: vi.fn() } as never} />)
    fireEvent.click(await screen.findByRole('button', { name: '恢复' }))
    expect(await screen.findByText(/原项目目录已不存在/)).toBeInTheDocument()
  })
})

describe('回收站面板 · 其余行为', () => {
  it('头部给出条数与合计占用（官方 fileSizeText 口径）', async () => {
    render(<TrashPanel deps={{ list: vi.fn(async () => rows), restore: vi.fn(), purge: vi.fn() } as never} />)
    expect(await screen.findByText('1 个会话 · 共 224KB')).toBeInTheDocument()
  })

  it('头部「刷新」把清单重读一遍', async () => {
    const list = vi.fn(async () => rows)
    render(<TrashPanel deps={{ list, restore: vi.fn(), purge: vi.fn() } as never} />)
    await screen.findByText('/code-review')
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  // 真机反馈：删完在别处（侧栏菜单），面板是"挂载时取一次数"，不切走再回来就看不见新条目。
  // 失效通告台就是为这条存在的：动过回收站的动作戳一下，这里立刻重读。
  it('别处动过回收站（失效通告）时立刻重读清单，不用切走再回来', async () => {
    const list = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(rows)
    render(<TrashPanel deps={{ list, restore: vi.fn(), purge: vi.fn() } as never} />)
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()

    act(() => {
      invalidateTrash()
    })

    expect(await screen.findByText('/code-review')).toBeInTheDocument()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('恢复成功后把清单重新读一遍，那一行就没了', async () => {
    const list = vi.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([])
    render(<TrashPanel deps={{ list, restore: vi.fn(async () => ({})), purge: vi.fn() } as never} />)
    fireEvent.click(await screen.findByRole('button', { name: '恢复' }))
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('失败的行留着，恢复按钮可以再点（不是一次失败就没了）', async () => {
    const restore = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('原项目目录已不存在'), { code: 'sessiondelete/project-missing' }))
      .mockResolvedValueOnce({})
    render(<TrashPanel deps={{ list: vi.fn(async () => rows), restore, purge: vi.fn() } as never} />)
    fireEvent.click(await screen.findByRole('button', { name: '恢复' }))
    expect(await screen.findByText(/原项目目录已不存在/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(2))
  })

  it('单行的「彻底删除…」也要先确认，确认后 purge 带上那一条的 id', async () => {
    const purge = vi.fn(async () => ({ removed: 1, freedBytes: 1 }))
    render(<TrashPanel deps={{ list: vi.fn(async () => rows), restore: vi.fn(), purge } as never} />)
    fireEvent.click(await screen.findByRole('button', { name: '彻底删除…' }))
    expect(purge).not.toHaveBeenCalled()
    expect(screen.getByText(/没有任何副本可以恢复/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }))
    await waitFor(() => expect(purge).toHaveBeenCalledWith('a'))
  })

  it('清空的确认框里点名不可恢复；取消一个字节都不动', async () => {
    const purge = vi.fn()
    render(<TrashPanel deps={{ list: vi.fn(async () => rows), restore: vi.fn(), purge } as never} />)
    fireEvent.click(await screen.findByRole('button', { name: '清空回收站…' }))
    expect(screen.getByText(/没有任何副本可以恢复/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(purge).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('清单本身读不到时把原文摆在面板上，不是空态', async () => {
    const list = vi.fn(async () => {
      throw Object.assign(new Error('回收站清单损坏'), { code: 'sessiondelete/io' })
    })
    render(<TrashPanel deps={{ list, restore: vi.fn(), purge: vi.fn() } as never} />)
    expect(await screen.findByText(/回收站清单损坏/)).toBeInTheDocument()
    expect(screen.queryByText('回收站是空的')).not.toBeInTheDocument()
  })

  it('读失败时给「重试」，点一下把清单重读一遍', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('回收站清单损坏'), { code: 'sessiondelete/io' }))
      .mockResolvedValueOnce(rows)
    render(<TrashPanel deps={{ list, restore: vi.fn(), purge: vi.fn() } as never} />)
    fireEvent.click(await screen.findByRole('button', { name: '重试' }))
    expect(await screen.findByText('/code-review')).toBeInTheDocument()
    expect(list).toHaveBeenCalledTimes(2)
  })

  // 改版前 `entries === null` 那一拍什么都不画：读得慢就是一块没有解释的空。
  it('首读未回时不是空态（不拿「回收站是空的」骗人）', async () => {
    let release: (value: typeof rows) => void = () => {}
    const list = vi.fn(() => new Promise<typeof rows>((resolve) => { release = resolve }))
    render(<TrashPanel deps={{ list, restore: vi.fn(), purge: vi.fn() } as never} />)
    expect(screen.queryByText('回收站是空的')).not.toBeInTheDocument()
    expect(screen.getByText('正在读回收站…')).toBeInTheDocument()
    release(rows)
    expect(await screen.findByText('/code-review')).toBeInTheDocument()
  })
})

describe('回收站面板 · 分组卡片（2026-10-01 视觉改版的结构）', () => {
  // `projectDir` 是宿主 `projectKey` 的产物（`D:\develop\GitHub\dsh-novel` → `--D-develop-GitHub-dsh-novel--`，
  // 分隔符连续只折成一个 `-`），夹具照这个口径写。
  const twoProjects = [
    { ...rows[0], id: 'a', projectDir: '--D-develop-GitHub-dsh-novel--', title: '书源解析回归', deletedAt: 100 },
    { ...rows[0], id: 'b', projectDir: '--D-develop-GitHub-dsh-novel--', title: '合并冲突', deletedAt: 300 },
    { ...rows[0], id: 'c', projectDir: '--C-Users-xrn--', title: '兼容排查', deletedAt: 200 },
  ]

  const groupsOf = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('[data-dsh-session-delete="trash-group"]')) as HTMLElement[]

  it('按项目分组：组头只出现一次，名字是摘掉 `--…--` 裹边的目录名', async () => {
    const { container } = render(
      <TrashPanel deps={{ list: vi.fn(async () => twoProjects), restore: vi.fn(), purge: vi.fn() } as never} />,
    )
    await screen.findByText('书源解析回归')
    const groups = groupsOf(container)
    expect(groups).toHaveLength(2)
    expect(within(groups[0]).getByText('D-develop-GitHub-dsh-novel')).toBeInTheDocument()
    expect(within(groups[0]).getByText('2 个会话')).toBeInTheDocument()
    expect(within(groups[1]).getByText('C-Users-xrn')).toBeInTheDocument()
    expect(within(groups[1]).getByText('1 个会话')).toBeInTheDocument()
    // 项目不再逐行重复：两条组头之下，卡片正文只剩标题与元信息。
    expect(within(groups[0]).getByText('书源解析回归')).toBeInTheDocument()
    expect(within(groups[0]).getByText('合并冲突')).toBeInTheDocument()
  })

  it('组按最新一条倒序，组内也按删除时间倒序', async () => {
    const { container } = render(
      <TrashPanel deps={{ list: vi.fn(async () => twoProjects), restore: vi.fn(), purge: vi.fn() } as never} />,
    )
    await screen.findByText('书源解析回归')
    const groups = groupsOf(container)
    // novel 组内最新是 300 > C-Users 的 200 ⇒ novel 在前；novel 组内 300 那条（合并冲突）排在 100 前面。
    expect(groups[0].textContent).toMatch(/合并冲突[\s\S]*书源解析回归/)
    expect(groups[1].textContent).toContain('兼容排查')
  })

  it('时间走官方 relativeTime 的分桶，绝对时间留在 title 里', async () => {
    const at = Date.now() - (3 * 3600 + 60) * 1000
    render(
      <TrashPanel
        deps={{ list: vi.fn(async () => [{ ...rows[0], deletedAt: at }]), restore: vi.fn(), purge: vi.fn() } as never}
      />,
    )
    const meta = await screen.findByTitle(new Date(at).toLocaleString())
    expect(meta.textContent).toBe(`删除于 3小时前 · ${fileSizeText(rows[0].sizeBytes)}`)
  })

  // 单位词照宿主字典（`time.hours="{n}小时"`，数字与单位不空格），但 `now` 桶不能套
  // 「删除于 …前」那个模板——"删除于 刚刚前"不是话。
  it('now 桶说「刚刚删除」，不写出「删除于 刚刚前」', async () => {
    render(
      <TrashPanel
        deps={{ list: vi.fn(async () => [{ ...rows[0], deletedAt: Date.now() }]), restore: vi.fn(), purge: vi.fn() } as never}
      />,
    )
    expect(await screen.findByText(/刚刚删除 · 224KB/)).toBeInTheDocument()
    expect(screen.queryByText(/删除于 刚刚/)).not.toBeInTheDocument()
  })

  it('组头摘掉 `--…--` 裹边并还原 `~XXXX` 转义；没有目录时不编一个名字出来', async () => {
    const odd = [
      { ...rows[0], id: 'a', projectDir: '--D-develop-~4E2D~6587--', title: '中文目录' },
      { ...rows[0], id: 'b', projectDir: '_no-cwd', title: '无 cwd' },
      { ...rows[0], id: 'c', projectDir: '', title: '空串' },
    ]
    render(<TrashPanel deps={{ list: vi.fn(async () => odd), restore: vi.fn(), purge: vi.fn() } as never} />)
    // projectKey 里 `~` 自己会被编成 `~007E`，所以串里的 `~XXXX` 不含歧义，中文可逆。
    expect(await screen.findByText('D-develop-中文')).toBeInTheDocument()
    expect(screen.getAllByText('未记录项目')).toHaveLength(2)
  })

  // 头注承诺的层级：整页只有一块实心红。这条用例就是让那句承诺没法再漂回注释里。
  it('危险动作分两档：行内只有字色（底留给官方 hover 类），实心红只有「清空回收站…」', async () => {
    render(<TrashPanel deps={{ list: vi.fn(async () => rows), restore: vi.fn(), purge: vi.fn() } as never} />)
    const rowDanger = await screen.findByRole('button', { name: '彻底删除…' })
    expect(rowDanger.getAttribute('data-variant')).toBe('ghost')
    expect(rowDanger.style.color).toBe('var(--dsw-alias-state-error-primary)')
    // 铺了内联 background 就会把 `.ghost:hover` 打死（内联永远赢过类规则）——点错之前就没反馈了。
    expect(rowDanger.style.background).toBe('')

    const bulk = screen.getByRole('button', { name: '清空回收站…' })
    expect(bulk.getAttribute('data-variant')).toBe('primary')
    expect(bulk.style.getPropertyValue('--dsw-alias-button-primary-fill')).toBe(
      'var(--dsw-alias-state-error-primary)',
    )
  })
})
