// 回收站的详情块：四态 + 两个动作 + 窄档返回（docs/ui-spec.md）
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { zhTranslate } from '../../src/client/copy.js'
import { TrashDetail, type TrashDetailProps, type TrashDetailState } from '../../src/client/trash-detail.js'
import type { TrashDetailLike, TrashEntryLike } from '../../src/client/remote.js'
import type { TrashDetailAttachmentWire } from '../../src/shared/wire.js'

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
    { role: 'user', time: Date.UTC(2026, 9, 12, 1, 0, 0), text: '先看改动', truncated: false, attachments: [] },
    { role: 'assistant', time: Date.UTC(2026, 9, 12, 1, 5, 0), text: '改动分四层', truncated: true, attachments: [] },
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
          { role: 'user', time: Date.UTC(2026, 9, 12, 1, 0, 0), text: md, truncated: false, attachments: [] },
          { role: 'assistant', time: Date.UTC(2026, 9, 12, 1, 5, 0), text: md, truncated: false, attachments: [] },
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

describe('回收站详情块 · 「删除于」两样都给（docs/ui-spec.md 状态⑥）', () => {
  it('相对那句好读、绝对那句好核对，同一格里两个都在', () => {
    at({ kind: 'ready', entry, detail })
    const value = screen.getByText(/前（/).textContent ?? ''
    expect(value).toMatch(/^(刚刚|\d+(分钟|小时|天|个月|年)前)（.+）$/)
    expect(value).toContain(new Date(DELETED_AT).toLocaleString())
  })
})

// 附件：图片走缩略图 + 放大框，文件走下载 chip；地址只由 id/kind 拼（`/attachment` 段的契约）。
describe('回收站详情块 · 附件', () => {
  const attachment: TrashDetailAttachmentWire = {
    attachmentId: `sha256:${'a'.repeat(64)}`,
    kind: 'image',
    mediaType: 'image/png',
    bytes: 3,
    width: 10,
    height: 20,
    name: 'shot.png',
  }

  function withMessages(messages: TrashDetailLike['messages']) {
    return at({ kind: 'ready', entry, detail: { ...detail, messages } })
  }

  it('用户消息里的图片渲染为可点开的缩略图；点开出现放大框', () => {
    withMessages([{ role: 'user', time: 1, text: '看图', truncated: false, attachments: [attachment] }])
    const img = screen.getByAltText('shot.png') as HTMLImageElement
    expect(img.getAttribute('src')).toContain('/dsh-session-delete-api/attachment?')
    expect(img.getAttribute('src')).toContain(encodeURIComponent(attachment.attachmentId))
    fireEvent.click(screen.getByRole('button', { name: '打开图片「shot.png」' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('shot.png')
  })

  it('缩略图懒加载并按 contain 收进框里；放大框那张不带 lazy（点开就要图）', () => {
    withMessages([{ role: 'user', time: 1, text: '看图', truncated: false, attachments: [attachment] }])
    const thumb = screen.getByAltText('shot.png') as HTMLImageElement
    // 一段会话可能带几十张图：屏外的先不取，省的是附件段的二进制流量。
    expect(thumb.getAttribute('loading')).toBe('lazy')
    expect(thumb.style.objectFit).toBe('contain')
    fireEvent.click(screen.getByRole('button', { name: '打开图片「shot.png」' }))
    const preview = screen.getByRole('dialog').querySelector('img') as HTMLImageElement
    expect(preview.getAttribute('loading')).toBeNull()
  })

  it('图片加载失败显示占位，不出现破图；占位仍说清是哪一件（名字 + 体量 + 附件不可用）', () => {
    withMessages([{ role: 'user', time: 1, text: '', truncated: false, attachments: [attachment] }])
    fireEvent.error(screen.getByAltText('shot.png'))
    const label = screen.getByText('附件不可用')
    expect(label).toBeInTheDocument()
    expect(screen.queryByAltText('shot.png')).not.toBeInTheDocument()
    // 「附件不可用」单独剩一句等于把"哪张图没了"也丢了：占位那一格里名字、体量、图标都还在。
    const placeholder = label.parentElement as HTMLElement
    expect(placeholder).toHaveTextContent('shot.png')
    expect(placeholder).toHaveTextContent('3B')
    expect(placeholder.querySelector('svg')).not.toBeNull()
  })

  it('放大框可另存为：先取字节、按 Content-Type 补扩展名，再触发下载', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(new Blob(['x'], { type: 'image/png' }), { headers: { 'content-type': 'image/png' } }))
    const createObjectURL = vi.fn(() => 'blob:test')
    const revokeObjectURL = vi.fn()
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchMock)
    try {
      withMessages([{ role: 'user', time: 1, text: '看图', truncated: false, attachments: [attachment] }])
      fireEvent.click(screen.getByRole('button', { name: '打开图片「shot.png」' }))
      fireEvent.click(screen.getByRole('button', { name: '另存为' }))
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      expect(String(fetchMock.mock.calls[0]![0])).toContain('/dsh-session-delete-api/attachment?')
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(click).toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      if (originalCreate === undefined) delete (URL as { createObjectURL?: unknown }).createObjectURL
      else Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreate })
      if (originalRevoke === undefined) delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL
      else Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevoke })
    }
  })

  it('另存为遇到 200 + JSON 信封：把服务端原文上屏，不把 HTTP 200 当原因', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error: { code: 'sessiondelete/io', message: '附件不在：sha256:aaaa' } }),
      { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    try {
      withMessages([{ role: 'user', time: 1, text: '看图', truncated: false, attachments: [attachment] }])
      fireEvent.click(screen.getByRole('button', { name: '打开图片「shot.png」' }))
      fireEvent.click(screen.getByRole('button', { name: '另存为' }))
      expect(await screen.findByText('保存失败：附件不在：sha256:aaaa')).toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('放大框里的图片加载失败也换成占位，不把破图留在浮层里', () => {
    withMessages([{ role: 'user', time: 1, text: '看图', truncated: false, attachments: [attachment] }])
    fireEvent.click(screen.getByRole('button', { name: '打开图片「shot.png」' }))
    const dialog = screen.getByRole('dialog')
    const preview = dialog.querySelector('img') as HTMLImageElement
    fireEvent.error(preview)
    expect(dialog.querySelector('img')).toBeNull()
    expect(dialog).toHaveTextContent('附件不可用')
    expect(dialog).toHaveTextContent('shot.png')
  })

  it('文件附件渲染为下载 chip', () => {
    const fileId = `sha256:${'b'.repeat(64)}`
    withMessages([{
      role: 'user', time: 1, text: '', truncated: false,
      attachments: [{ attachmentId: fileId, kind: 'file', name: 'a.pdf', bytes: 12 }],
    }])
    const link = screen.getByRole('link', { name: /a.pdf/ }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toContain(encodeURIComponent(fileId))
    expect(link.getAttribute('href')).toContain('/dsh-session-delete-api/attachment?')
    expect(link.getAttribute('download')).toBe('a.pdf')
    // 长文件名要能折行，别把消息条撑破。
    expect(link.style.maxWidth).toBe('100%')
    expect(link.style.wordBreak).toBe('break-all')
  })

  // 文件名是宿主日志里的一串自由文本：它只该落在查询串里（编码后），碰不到寻址路径。
  it('恶意文件名只进查询串且被 URL 编码；href 的路径段与 id/kind 一个字节都不变', () => {
    const fileId = `sha256:${'d'.repeat(64)}`
    const hostile = '../x?a=b&c'
    withMessages([{
      role: 'user', time: 1, text: '', truncated: false,
      attachments: [{ attachmentId: fileId, kind: 'file', name: hostile, bytes: 5 }],
    }])
    const link = screen.getByRole('link', { name: /\.\.\/x/ }) as HTMLAnchorElement
    const href = link.getAttribute('href') ?? ''
    const [path, query = ''] = href.split('?')
    // 路径段是端点常量，name 不参与拼路径：`../` 换不掉它。
    expect(path).toBe('/dsh-session-delete-api/attachment')
    expect(href.split('?')).toHaveLength(2) // name 里的 `?` 没造出第二个问号
    expect(query).not.toContain('../x')
    expect(query).not.toContain('&c') // name 里的 `&` 没造出第四个参数
    expect(new URLSearchParams(query).getAll('id')).toEqual([fileId])
    expect(new URLSearchParams(query).getAll('kind')).toEqual(['file'])
    expect(new URLSearchParams(query).get('name')).toBe(hostile)
    expect(query).toContain(`name=${encodeURIComponent(hostile)}`)
    // download 只是建议名；它不参与寻址，原样交出去由浏览器清洗。
    expect(link.getAttribute('download')).toBe(hostile)
  })

  it('文件名是空串 ⇒ 用「文件」兜底，且不把 name 塞进查询串', () => {
    const fileId = `sha256:${'c'.repeat(64)}`
    withMessages([{
      role: 'user', time: 1, text: '', truncated: false,
      attachments: [{ attachmentId: fileId, kind: 'file', name: '', bytes: 12 }],
    }])
    const link = screen.getByRole('link', { name: /^文件/ }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toContain(encodeURIComponent(fileId))
    expect(link.getAttribute('href')).not.toContain('name=')
  })

  it('助手消息的附件排在 Markdown 正文之后', () => {
    const { container } = withMessages([
      { role: 'assistant', time: 1, text: '**看图**', truncated: false, attachments: [attachment] },
    ])
    const row = container.querySelector('[data-sd-msg="assistant"]') as Element
    const markdown = row.querySelector('.sd-md') as Element
    const img = row.querySelector('img') as Element
    expect(markdown).not.toBeNull()
    expect(img).not.toBeNull()
    // DOCUMENT_POSITION_FOLLOWING：img 在 markdown 之后。
    expect(markdown.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // 用户行是 alignItems:'flex-end'（靠气泡那侧），助手行不铺底、正文铺满栏：附件条得跟着各自的行走。
  it('附件条跟消息行走：用户侧靠右、助手侧靠左（助手不再被硬拉到右边）', () => {
    const { container } = withMessages([
      { role: 'user', time: 1, text: '看图', truncated: false, attachments: [attachment] },
      { role: 'assistant', time: 2, text: '图在这里', truncated: false, attachments: [attachment] },
    ])
    const strips = [...container.querySelectorAll<HTMLElement>('[data-sd-attachment-strip]')]
    expect(strips).toHaveLength(2)
    expect(strips[0]!.closest('[data-sd-msg]')?.getAttribute('data-sd-msg')).toBe('user')
    expect(strips[0]!.style.justifyContent).toBe('flex-end')
    expect(strips[1]!.closest('[data-sd-msg]')?.getAttribute('data-sd-msg')).toBe('assistant')
    expect(strips[1]!.style.justifyContent).toBe('flex-start')
  })

  it('文本与附件都空的消息整行不画（附件总量闸用尽后的防御形态）', () => {
    const { container } = withMessages([
      { role: 'user', time: 1, text: '', truncated: false, attachments: [] },
      { role: 'assistant', time: 2, text: '还有内容', truncated: false, attachments: [] },
    ])
    const rows = [...container.querySelectorAll('[data-sd-msg]')]
    expect(rows.map((row) => row.getAttribute('data-sd-msg'))).toEqual(['assistant'])
  })

  it('纯图片消息不画空气泡：缩略图就是这一条的内容', () => {
    const { container } = withMessages([
      { role: 'user', time: 1, text: '', truncated: false, attachments: [attachment] },
    ])
    expect(container.querySelectorAll('[data-sd-bubble]')).toHaveLength(0)
    expect(container.querySelector('[data-sd-msg="user"] img')).not.toBeNull()
  })
})
