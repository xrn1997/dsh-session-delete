// 回收站的详情块：四态 + 两个动作 + 窄档返回（docs/architecture.md §3.1）
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { zhTranslate } from '../../src/client/copy.js'
import { TrashDetail, type TrashDetailProps, type TrashDetailState } from '../../src/client/trash-detail.js'
import type { TrashDetailLike, TrashEntryLike } from '../../src/client/remote.js'

const DELETED_AT = Date.UTC(2026, 9, 14, 6, 56, 58)

const entry = {
  id: '20261014T065658Z-session-a',
  sessionId: 'session-a',
  projectDir: '--C-develop-GitLab-x--',
  workspaceId: 'ws',
  wasArchived: true,
  deletedAt: DELETED_AT,
  title: '清册标题',
  sizeBytes: 400_000,
} as TrashEntryLike

const detail: TrashDetailLike = {
  entryId: entry.id,
  cwd: 'C:/develop/GitLab/x',
  createdAt: Date.UTC(2026, 9, 12, 1, 0, 0),
  lastActivity: Date.UTC(2026, 9, 13, 9, 30, 0),
  logTitle: '日志标题',
  models: ['m-1', 'm-2'],
  turnCount: 3,
  userMessageCount: 2,
  assistantMessageCount: 2,
  toolCallCount: 40,
  injectedCount: 241,
  omittedByPayloadCap: 0,
  messages: [
    { role: 'user', time: Date.UTC(2026, 9, 12, 1, 0, 0), text: '先看改动', truncated: false },
    { role: 'assistant', time: Date.UTC(2026, 9, 12, 1, 5, 0), text: '改动分四层', truncated: true },
  ],
}

function at(state: TrashDetailState, over: Partial<TrashDetailProps> = {}) {
  const props: TrashDetailProps = {
    state,
    busy: false,
    wide: true,
    onRetry: vi.fn(),
    onBack: vi.fn(),
    t: zhTranslate,
    ...over,
  }
  return render(<TrashDetail {...props} />)
}

describe('回收站详情块 · 四种状态', () => {
  it('未选中：只有引导句，没有任何动作按钮', () => {
    at({ kind: 'idle' })
    expect(screen.getByText('选中一条会话，看它讲了什么')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '彻底删除…' })).not.toBeInTheDocument()
  })

  it('读数中：说在读哪一条，且这里不摆动作（动作住在清单行右侧）', () => {
    at({ kind: 'loading', entry })
    expect(screen.getByText('正在读这条会话…')).toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('读数失败：原文上屏 + 重试，且这块是 role="status"', () => {
    const onRetry = vi.fn()
    at({ kind: 'failed', entry, message: '读会话日志失败：第 2 帧解压失败' }, { onRetry })
    const block = screen.getByRole('status')
    expect(block).toHaveTextContent('这条会话的正文读不出来')
    expect(block).toHaveTextContent('读会话日志失败：第 2 帧解压失败')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('窄档下钻时详情顶部有返回，宽档没有（同屏就有清单）', () => {
    at({ kind: 'ready', entry, detail })
    expect(screen.queryByRole('button', { name: '← 返回清单' })).not.toBeInTheDocument()
  })
})

describe('回收站详情块 · 有内容', () => {
  it('标题优先用清册那一份；元信息按时间→体量→位置摆出来', () => {
    at({ kind: 'ready', entry, detail })
    expect(screen.getByText('清册标题')).toBeInTheDocument()
    expect(screen.queryByText('日志标题')).not.toBeInTheDocument()
    expect(screen.getByText('C:/develop/GitLab/x')).toBeInTheDocument()
    expect(screen.getByText(entry.id)).toBeInTheDocument()
    expect(screen.getByText('m-1, m-2')).toBeInTheDocument()
    expect(screen.getByText('是')).toBeInTheDocument() // 原本归档
    expect(screen.getByText('40')).toBeInTheDocument() // 工具调用条数
    expect(screen.queryByText('241')).not.toBeInTheDocument() // 注入的那 241 条不许混进计数列
  })

  it('清册标题是空串才回落到日志里的 session/title', () => {
    at({ kind: 'ready', entry: { ...entry, title: '' }, detail })
    expect(screen.getByText('日志标题')).toBeInTheDocument()
  })

  it('正文按顺序成列：用户在右、助手在左，截断过的那条尾部有省略号', () => {
    const { container } = at({ kind: 'ready', entry, detail })
    const bubbles = [...container.querySelectorAll('[data-sd-msg]')]
    expect(bubbles.map((el) => el.getAttribute('data-sd-msg'))).toEqual(['user', 'assistant'])
    expect(bubbles[0]!.textContent).toContain('先看改动')
    expect(bubbles[0]!.textContent).toContain('你')
    expect(bubbles[1]!.textContent).toContain('改动分四层…')
    expect(bubbles[1]!.textContent).toContain('助手')
  })

  it('用户提问走原话、助手正文走 markdown：同一段源在两侧长出不同 DOM', () => {
    const md = '`ls -la` 的输出**像**这样'
    const { container } = at({
      kind: 'ready',
      entry,
      detail: {
        ...detail,
        messages: [
          { role: 'user', time: Date.UTC(2026, 9, 12, 1, 0, 0), text: md, truncated: false },
          { role: 'assistant', time: Date.UTC(2026, 9, 12, 1, 5, 0), text: md, truncated: false },
        ],
      },
    })
    const user = container.querySelector('[data-sd-msg="user"]') as Element
    const assistant = container.querySelector('[data-sd-msg="assistant"]') as Element
    // 用户那一侧：反引号与星号**就该看得见**（那是他打过原话）。
    expect(user.textContent).toContain(md)
    expect(user.querySelector('code')).toBeNull()
    expect(user.querySelector('strong')).toBeNull()
    // 助手那一侧：同一串源被渲成 markdown。
    expect(assistant.querySelector('code')?.textContent).toBe('ls -la')
    expect(assistant.querySelector('strong')?.textContent).toBe('像')
  })

  // 2026-10-15 拄宿主时最容易写错的一处：给助手也铺一张卡。宿主的 `.bubble` 只住在用户那一行。
  it('只有用户那一侧有气泡，助手正文铺满栏不铺底', () => {
    const { container } = at({ kind: 'ready', entry, detail })
    const bubbles = container.querySelectorAll('[data-sd-bubble]')
    expect(bubbles).toHaveLength(1)
    expect((bubbles[0] as HTMLElement).parentElement?.getAttribute('data-sd-msg')).toBe('user')
  })

  it('活跃跨度按天说，不到一天按小时说（同一句话的两种量级）', () => {
    at({ kind: 'ready', entry, detail })
    expect(screen.getByText('1 天')).toBeInTheDocument()
    at({
      kind: 'ready',
      entry,
      detail: { ...detail, lastActivity: detail.createdAt + 3 * 3600000 },
    })
    expect(screen.getByText('3 小时')).toBeInTheDocument()
  })

  it('时间戳缺省（日志里没读到）⇒ 三格都降级，不报 1970、也不把"不知道"报成"1 小时"', () => {
    at({ kind: 'ready', entry, detail: { ...detail, createdAt: 0, lastActivity: 0 } })
    expect(screen.queryByText(/1970/)).not.toBeInTheDocument()
    expect(screen.queryByText('1 小时')).not.toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(3)
  })

  it('注入条数与截断条数必须上屏——"少了这么多条"要能跟页面对账', () => {
    at({ kind: 'ready', entry, detail })
    expect(screen.getByText(/另有 241 条宿主注入的上下文未显示/)).toBeInTheDocument()
    expect(screen.queryByText(/还有 \d+ 条未显示/)).not.toBeInTheDocument()
    at({ kind: 'ready', entry, detail: { ...detail, omittedByPayloadCap: 9 } })
    expect(screen.getByText(/还有 9 条未显示/)).toBeInTheDocument()
  })

  it('一条正文都没有 ⇒ 明说"没有可显示的文字"，不装作还在读', () => {
    at({ kind: 'ready', entry, detail: { ...detail, messages: [], userMessageCount: 0, assistantMessageCount: 0 } })
    expect(screen.getByText('这条会话没有可显示的文字')).toBeInTheDocument()
  })

  it('详情里不摆动作按钮（2026-10-15 真机反馈后：动作住在清单行右侧）', () => {
    at({ kind: 'ready', entry, detail })
    expect(screen.queryByRole('button', { name: '恢复' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '彻底删除…' })).not.toBeInTheDocument()
  })
})

describe('回收站详情块 · 两档形态的差别', () => {
  it('宽档不画返回，窄档画并且点了就回清单', () => {
    at({ kind: 'ready', entry, detail })
    expect(screen.queryByRole('button', { name: '← 返回清单' })).not.toBeInTheDocument()

    const onBack = vi.fn()
    at({ kind: 'ready', entry, detail }, { wide: false, onBack })
    fireEvent.click(screen.getByRole('button', { name: '← 返回清单' }))
    expect(onBack).toHaveBeenCalled()
  })

  it('窄档在读失败时也给返回——不能因为正文读不出就把用户关在一块错误里', () => {
    at({ kind: 'failed', entry, message: 'io' }, { wide: false })
    expect(screen.getByRole('button', { name: '← 返回清单' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
})

describe('回收站详情块 · 「删除于」两样都给（docs/architecture.md §3.1 状态⑥）', () => {
  it('相对那句好读、绝对那句好核对，同一格里两个都在', () => {
    at({ kind: 'ready', entry, detail })
    const value = screen.getByText(/前（/).textContent ?? ''
    expect(value).toMatch(/^(刚刚|\d+(分钟|小时|天|个月|年)前)（.+）$/)
    expect(value).toContain(new Date(DELETED_AT).toLocaleString())
  })
})
