// 回收站详情**投影**（`trash-detail.tsx`）：显示名/信息行/子会话段/附件的行映射与呈现。
// 通用壳的判据（状态壳、折叠、分页、子会话读数）住 `session-detail.test.tsx` 与
// `use-detail-pager.test.tsx`；这里只钉「这一档的项目对不对」。
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { zhTranslate } from '../../src/client/copy.js'
import { TrashDetail, type TrashDetailProps, type TrashDetailState } from '../../src/client/trash-detail.js'
import type { DetailFrame, DetailPager } from '../../src/client/use-detail-frame.js'
import type { DetailRail } from '../../src/client/use-detail-rail.js'
import type { TrashDetailLike, TrashEntryLike } from '../../src/client/remote.js'
import {
  OFFICIAL_SESSION_DELETE_API_PREFIX,
  type TrashDetailAttachmentWire,
  type TrashDetailBlockWire,
  type TrashDetailTextBlockWire,
  type TrashEntryWire,
} from '../../src/shared/wire.js'
import { pick, must } from '../support/fixture.js'

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

const userBlock = (id: string, time: number, text: string, attachments: TrashDetailAttachmentWire[] = []): TrashDetailTextBlockWire => ({
  kind: 'user', id, time, text, truncated: false, attachments,
})
const assistantBlock = (id: string, time: number, text: string, truncated = false, attachments: TrashDetailAttachmentWire[] = []): TrashDetailTextBlockWire => ({
  kind: 'assistant', id, time, text, truncated, attachments,
})
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
  blocks: [
    userBlock('0', Date.UTC(2026, 9, 12, 1, 0, 0), '先看改动'),
    assistantBlock('1', Date.UTC(2026, 9, 12, 1, 5, 0), '改动分四层', true),
  ],
  olderCursor: null,
}

/** 投影测试不碰提问轨（轨只在栏外壳里渲染，`tests/client/trash-panel.test.tsx` 负责那一段）：
 *  给一份空轨，只为满足帧的形状。 */
const EMPTY_RAIL: DetailRail = {
  prompts: [], loadedIds: new Set(), hasRail: false, disabled: false,
  handle: { activeId: null, busyId: null, notice: null, jump: () => {} },
}

/** 详情帧：两档包装只消费 `state` 做行投影、原样转交其余的格子。
 *  测试仍按分页四样各自的格子覆盖（`{ loadingOlder: true }`），不跟帧的形状一起抖。 */
function frameOf(state: TrashDetailState, pager: DetailPager): DetailFrame<TrashEntryWire, TrashDetailLike> {
  return { state, pager, rail: EMPTY_RAIL }
}

function detailElement(state: TrashDetailState, over: Partial<TrashDetailProps> & Partial<DetailPager> = {}) {
  const { loadingOlder, olderFailure, onLoadOlder, scrollRef, ...rest } = over
  const props: TrashDetailProps = {
    frame: frameOf(state, {
      loadingOlder: loadingOlder ?? false,
      olderFailure: olderFailure ?? null,
      onLoadOlder: onLoadOlder ?? vi.fn(),
      ...(scrollRef === undefined ? {} : { scrollRef }),
    }),
    busy: false,
    wide: true,
    onRetry: vi.fn(),
    onBack: vi.fn(),
    // 导航面（开孩子 / 回父）整体是一个 `detailNav`：判据住控制器，这里只画。
    detailNav: {},
    t: zhTranslate,
    ...rest,
  }
  return <TrashDetail {...props} />
}

type Over = Partial<TrashDetailProps> & Partial<DetailPager>

function at(state: TrashDetailState, over: Over = {}) {
  return render(detailElement(state, over))
}

function withBlocks(blocks: TrashDetailBlockWire[], over: Over = {}) {
  return at({ kind: 'ready', subject: entry, detail: { ...detail, blocks } }, over)
}

describe('回收站详情块 · 有内容', () => {
  it('标题优先用清册那一份；会话信息单表直显、计量行独立成行', () => {
    at({ kind: 'ready', subject: entry, detail })
    expect(screen.getByText('清册标题')).toBeInTheDocument()
    expect(screen.queryByText('日志标题')).not.toBeInTheDocument()
    // 一张表：项目 → 模型 → 创建 → 最后活动 → 会话 id → 回收站目录 → 原本归档，全部默认可见（不折叠）。
    const labels = [...document.querySelectorAll('dt')].map((dt) => dt.textContent)
    expect(labels).toEqual(['项目', '模型', '创建', '最后活动', '会话 id', '回收站目录', '原本归档'])
    expect(screen.getByText('C:/develop/GitLab/x')).toBeInTheDocument()
    expect(screen.getByText('m-1, m-2')).toBeInTheDocument()
    expect(screen.getByText(entry.id)).toBeInTheDocument()
    expect(screen.getByText('是')).toBeInTheDocument() // 原本归档
    // 计量行：大小 → 活跃跨度 → 五个计数，横着扫。
    expect(screen.getByText('40')).toBeInTheDocument() // 工具调用条数
    expect(screen.getByText('注入上下文')).toBeInTheDocument()
    expect(screen.getByText('241')).toBeInTheDocument()
    expect(screen.getByText('1 天')).toBeInTheDocument() // 活跃跨度归计量行
    expect(screen.queryByText(/未显示/)).not.toBeInTheDocument()
  })

  it('清册标题是空串才回落到日志里的 session/title', () => {
    at({ kind: 'ready', subject: { ...entry, title: '' }, detail })
    expect(screen.getByText('日志标题')).toBeInTheDocument()
  })

  it('正文按顺序成列：用户在右、助手在左，截断过的那条尾部标「已截断」', () => {
    const { container } = at({ kind: 'ready', subject: entry, detail })
    const bubbles = [...container.querySelectorAll('[data-sd-msg]')]
    expect(bubbles.map((el) => el.getAttribute('data-sd-msg'))).toEqual(['user', 'assistant'])
    expect(pick(bubbles, 0).textContent).toContain('先看改动')
    expect(pick(bubbles, 0).textContent).toContain('你')
    expect(pick(bubbles, 1).textContent).toContain('改动分四层')
    expect(pick(bubbles, 1).textContent).toContain('已截断')
    expect(pick(bubbles, 1).textContent).toContain('助手')
  })

  it('用户提问走原话、助手正文走 markdown：同一段源在两侧长出不同 DOM', () => {
    const md = '`ls -la` 的输出**像**这样'
    const { container } = withBlocks([
      userBlock('u1', Date.UTC(2026, 9, 12, 1, 0, 0), md),
      assistantBlock('a1', Date.UTC(2026, 9, 12, 1, 5, 0), md),
    ])
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
    const { container } = at({ kind: 'ready', subject: entry, detail })
    const bubbles = container.querySelectorAll('[data-sd-bubble]')
    expect(bubbles).toHaveLength(1)
    expect((bubbles[0] as HTMLElement).parentElement?.getAttribute('data-sd-msg')).toBe('user')
  })

  it('活跃跨度按天说，不到一天按小时说（同一句话的两种量级）', () => {
    at({ kind: 'ready', subject: entry, detail })
    expect(screen.getByText('1 天')).toBeInTheDocument()
    at({
      kind: 'ready',
      subject: entry,
      detail: { ...detail, lastActivity: detail.createdAt + 3 * 3600000 },
    })
    expect(screen.getByText('3 小时')).toBeInTheDocument()
    at({
      kind: 'ready',
      subject: entry,
      detail: { ...detail, lastActivity: detail.createdAt + 10 * 60000 },
    })
    expect(screen.getByText('不足 1 小时')).toBeInTheDocument()
  })

  it('时间戳缺省（日志里没读到）⇒ 三格都降级，不报 1970、也不把"不知道"报成"1 小时"', () => {
    at({ kind: 'ready', subject: entry, detail: { ...detail, createdAt: 0, lastActivity: 0 } })
    expect(screen.queryByText(/1970/)).not.toBeInTheDocument()
    expect(screen.queryByText('1 小时')).not.toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(3)
  })

  it('详情里不摆动作按钮（2026-10-15 真机反馈后：动作住在清单行右侧）', () => {
    at({ kind: 'ready', subject: entry, detail })
    expect(screen.queryByRole('button', { name: '恢复' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '彻底删除' })).not.toBeInTheDocument()
  })
})

describe('回收站详情块 · 移入回收站时间不进详情', () => {
  it('移入回收站时间只在清单行；详情表里没有它（相对/绝对都不重复）', () => {
    at({ kind: 'ready', subject: entry, detail })
    expect(document.querySelector('dt')?.textContent).toBe('项目')
    expect(screen.queryByText(/前（/)).not.toBeInTheDocument()
    expect(screen.queryByText(/移入回收站/)).not.toBeInTheDocument()
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

  it('用户消息里的图片渲染为可点开的缩略图；点开出现放大框', () => {
    withBlocks([userBlock('u1', 1, '看图', [attachment])])
    const img = screen.getByAltText<HTMLImageElement>('shot.png')
    const src = img.getAttribute('src') ?? ''
    expect(src).toContain(`${OFFICIAL_SESSION_DELETE_API_PREFIX}/attachment?`)
    expect(src).toContain(encodeURIComponent(attachment.attachmentId))
    // 引用元数据只给宿主 `attachments.readImage` 做校验（ADR-0035），不参与寻址。
    expect(src).toContain('mediaType=image%2Fpng')
    expect(src).toContain(`bytes=${String(attachment.bytes)}`)
    expect(src).toContain(`width=${String(attachment.width)}`)
    expect(src).toContain(`height=${String(attachment.height)}`)
    fireEvent.click(screen.getByRole('button', { name: '打开图片「shot.png」' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('shot.png')
  })

  it('缩略图懒加载并按 contain 收进框里；放大框那张不带 lazy（点开就要图）', () => {
    withBlocks([userBlock('u1', 1, '看图', [attachment])])
    const thumb = screen.getByAltText<HTMLImageElement>('shot.png')
    // 一段会话可能带几十张图：屏外的先不取，省的是附件段的二进制流量。
    expect(thumb.getAttribute('loading')).toBe('lazy')
    expect(thumb.style.objectFit).toBe('contain')
    fireEvent.click(screen.getByRole('button', { name: '打开图片「shot.png」' }))
    const preview = screen.getByRole('dialog').querySelector('img') as HTMLImageElement
    expect(preview.getAttribute('loading')).toBeNull()
  })

  it('图片加载失败显示占位，不出现破图；占位仍说清是哪一件（名字 + 体量 + 附件不可用）', () => {
    withBlocks([userBlock('u1', 1, '', [attachment])])
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
    // 替身签名收窄到 string：本仓只以字符串 URL 调 fetch（attachmentUrl 回 string），
    // 写成 RequestInfo | URL 是给 String() 留把对象折成 '[object Object]' 的空间。
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () =>
      new Response(new Blob(['x'], { type: 'image/png' }), { headers: { 'content-type': 'image/png' } }))
    const createObjectURL = vi.fn(() => 'blob:test')
    const revokeObjectURL = vi.fn()
    // 捕获原始静态方法用于收场恢复（放进可变对象里：可选属性不会被 const 初始化式窄成"必有"，
    // 空值还原判据才是真判据）。lib.dom 的隐式 this 不会被读，恢复的是同一个函数引用。
    const originals: { create?: typeof URL.createObjectURL; revoke?: typeof URL.revokeObjectURL } = {}
    // eslint-disable-next-line @typescript-eslint/unbound-method -- 只是保存引用、不调用也不脱离 URL，随后原样还原
    Object.assign(originals, { create: URL.createObjectURL, revoke: URL.revokeObjectURL })
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchMock)
    try {
      withBlocks([userBlock('u1', 1, '看图', [attachment])])
      fireEvent.click(screen.getByRole('button', { name: '打开图片「shot.png」' }))
      fireEvent.click(screen.getByRole('button', { name: '另存为' }))
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      expect(pick(fetchMock.mock.calls, 0)[0]).toContain(`${OFFICIAL_SESSION_DELETE_API_PREFIX}/attachment?`)
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(click).toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      if (originals.create === undefined) delete (URL as { createObjectURL?: unknown }).createObjectURL
      else Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originals.create })
      if (originals.revoke === undefined) delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL
      else Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originals.revoke })
    }
  })

  it('另存为遇到 200 + JSON 信封：把服务端原文上屏，不把 HTTP 200 当原因', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error: { code: 'sessiondelete/io', message: '附件不在：sha256:aaaa' } }),
      { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    try {
      withBlocks([userBlock('u1', 1, '看图', [attachment])])
      fireEvent.click(screen.getByRole('button', { name: '打开图片「shot.png」' }))
      fireEvent.click(screen.getByRole('button', { name: '另存为' }))
      expect(await screen.findByText('保存失败：附件不在：sha256:aaaa')).toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('放大框里的图片加载失败也换成占位，不把破图留在浮层里', () => {
    withBlocks([userBlock('u1', 1, '看图', [attachment])])
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
    withBlocks([userBlock('u1', 1, '', [{ attachmentId: fileId, kind: 'file', name: 'a.pdf', bytes: 12 }])])
    const link = screen.getByRole<HTMLAnchorElement>('link', { name: /a.pdf/ })
    expect(link.getAttribute('href')).toContain(encodeURIComponent(fileId))
    expect(link.getAttribute('href')).toContain(`${OFFICIAL_SESSION_DELETE_API_PREFIX}/attachment?`)
    expect(link.getAttribute('download')).toBe('a.pdf')
    // 长文件名要能折行，别把消息条撑破。
    expect(link.style.maxWidth).toBe('100%')
    expect(link.style.wordBreak).toBe('break-all')
  })

  // 文件名是宿主日志里的一串自由文本：它只该落在查询串里（编码后），碰不到寻址路径。
  it('恶意文件名只进查询串且被 URL 编码；href 的路径段与 id/kind 一个字节都不变', () => {
    const fileId = `sha256:${'d'.repeat(64)}`
    const hostile = '../x?a=b&c'
    withBlocks([userBlock('u1', 1, '', [{ attachmentId: fileId, kind: 'file', name: hostile, bytes: 5 }])])
    const link = screen.getByRole<HTMLAnchorElement>('link', { name: /\.\.\/x/ })
    const href = link.getAttribute('href') ?? ''
    const [path, query = ''] = href.split('?')
    // 路径段是端点常量，name 不参与拼路径：`../` 换不掉它。
    expect(path).toBe(`${OFFICIAL_SESSION_DELETE_API_PREFIX}/attachment`)
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
    withBlocks([userBlock('u1', 1, '', [{ attachmentId: fileId, kind: 'file', name: '', bytes: 12 }])])
    const link = screen.getByRole<HTMLAnchorElement>('link', { name: /^文件/ })
    expect(link.getAttribute('href')).toContain(encodeURIComponent(fileId))
    expect(link.getAttribute('href')).not.toContain('name=')
  })

  it('助手消息的附件排在 Markdown 正文之后', () => {
    const { container } = withBlocks([assistantBlock('a1', 1, '**看图**', false, [attachment])])
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
    const { container } = withBlocks([
      userBlock('u1', 1, '看图', [attachment]),
      assistantBlock('a1', 2, '图在这里', false, [attachment]),
    ])
    const strips = [...container.querySelectorAll<HTMLElement>('[data-sd-attachment-strip]')]
    expect(strips).toHaveLength(2)
    expect(pick(strips, 0).closest('[data-sd-msg]')?.getAttribute('data-sd-msg')).toBe('user')
    expect(pick(strips, 0).style.justifyContent).toBe('flex-end')
    expect(pick(strips, 1).closest('[data-sd-msg]')?.getAttribute('data-sd-msg')).toBe('assistant')
    expect(pick(strips, 1).style.justifyContent).toBe('flex-start')
  })

  it('纯图片消息不画空气泡：缩略图就是这一条的内容', () => {
    const { container } = withBlocks([userBlock('u1', 1, '', [attachment])])
    expect(container.querySelectorAll('[data-sd-bubble]')).toHaveLength(0)
    expect(container.querySelector('[data-sd-msg="user"] img')).not.toBeNull()
  })
})

const KID = {
  id: 'kid', sessionId: 'session-kid', projectDir: '--p--', workspaceId: 'ws',
  wasArchived: false, deletedAt: DELETED_AT, title: '孩子会话', sizeBytes: 2048, parentEntryId: entry.id,
} as TrashEntryWire

describe('回收站详情块 · 子会话', () => {
  const strip = (): HTMLButtonElement =>
    must(document.querySelector<HTMLButtonElement>('[data-dsh-session-delete="session-subagents-toggle"]'), '子会话摘要条')

  it('子会话行按 label 显示（与工作中同名），label 缺席才回落清册标题', () => {
    const labeled = { ...KID, label: 'Standards 轴全仓审查' }
    at(
      { kind: 'ready', subject: entry, detail: { ...detail, subagents: [labeled, { ...KID, id: 'kid2', title: '孩子会话二' }] } },
      { detailNav: { onOpenChild: vi.fn() } },
    )
    fireEvent.click(strip())
    expect(screen.getByText('Standards 轴全仓审查')).toBeInTheDocument()
    // 起了 label 的那行不再露主会话那套起名法的清册标题（分清子会话就是这一条的目的）
    expect(screen.queryByText('孩子会话')).not.toBeInTheDocument()
    expect(screen.getByText('孩子会话二')).toBeInTheDocument()
  })

  it('孩子视图的标题排同一条显示名规则：label 优先于清册标题', () => {
    at({ kind: 'ready', subject: { ...KID, label: 'Standards 轴全仓审查' }, detail }, { detailNav: { onOpenChild: vi.fn() } })
    expect(screen.getByText('Standards 轴全仓审查')).toBeInTheDocument()
    expect(screen.queryByText('孩子会话')).not.toBeInTheDocument()
  })

  it('没有父行 label 的独立子会话：详情自己的 descriptor label 压过清册快照标题', () => {
    // 存量条目可能只剩一条独立行（父条目不在回收站），父详情的 catalog 兜不到它；详情读自己的
    // `subagent/descriptor` 补 label，标题排按同一条显示名次序取它，而不是清册里那串主会话标题。
    at({
      kind: 'ready',
      subject: { ...entry, title: '你是一名代码审查员，对整个' },
      detail: { ...detail, label: 'Standards 轴全仓审查' },
    })
    expect(screen.getByText('Standards 轴全仓审查')).toBeInTheDocument()
    expect(screen.queryByText('你是一名代码审查员，对整个')).not.toBeInTheDocument()
  })

  it('父行交来的 label 优先于详情自己的 label（同一名字的两份来源不打架）', () => {
    at({
      kind: 'ready',
      subject: { ...KID, label: '父行登记的 label' },
      detail: { ...detail, label: '详情自己的 label' },
    }, { detailNav: { onOpenChild: vi.fn() } })
    expect(screen.getByText('父行登记的 label')).toBeInTheDocument()
    expect(screen.queryByText('详情自己的 label')).not.toBeInTheDocument()
  })

  it('subagents 缺席：没有子会话段，也没有跳转徽标', () => {
    at({ kind: 'ready', subject: entry, detail }, { detailNav: { onOpenChild: vi.fn() } })
    expect(document.querySelector('[data-dsh-session-delete="session-subagents"]')).toBeNull()
    expect(document.querySelector('[data-dsh-session-delete="session-subagents-jump"]')).toBeNull()
  })

  it('subagentsTotal 出线：摘要条徽标念总数（wire 的截断读数原样交给子会话段）', () => {
    const kid2 = { ...KID, id: 'kid2', title: '孩子会话二', sizeBytes: 1024 }
    at({ kind: 'ready', subject: entry, detail: { ...detail, subagents: [KID, kid2], subagentsTotal: 5 } }, { detailNav: { onOpenChild: vi.fn() } })
    expect(strip().textContent).toContain('5')
  })

  it('子会话行按 id 交接：点一行把孩子的清册 id 交出去（行投影不丢身份）', () => {
    const onOpenChild = vi.fn()
    at({ kind: 'ready', subject: entry, detail: { ...detail, subagents: [KID] } }, { detailNav: { onOpenChild } })
    fireEvent.click(strip())
    fireEvent.click(screen.getByRole('button', { name: /孩子会话/ }))
    expect(onOpenChild).toHaveBeenCalledWith(KID.id)
  })

  it('subagentsSizeBytes 出线：摘要条大小按全量合计，不按已列行', () => {
    const kid2 = { ...KID, id: 'kid2', title: '孩子会话二', sizeBytes: 1024 }
    at({
      kind: 'ready',
      subject: entry,
      detail: { ...detail, subagents: [KID, kid2], subagentsTotal: 5, subagentsSizeBytes: 10 * 1024 },
    }, { detailNav: { onOpenChild: vi.fn() } })
    expect(strip().textContent).toContain('10KB')
  })

  // 合计的家在 Node 半：客户端不拿**已列的前 N 条**求和冒充全量——那是少报（ADR-0055）。
  it('合计读数缺席 ⇒ 摘要条不摆大小格：不拿已列的行求和顶上那一格', () => {
    const kid2 = { ...KID, id: 'kid2', title: '孩子会话二', sizeBytes: 1024 }
    at({ kind: 'ready', subject: entry, detail: { ...detail, subagents: [KID, kid2], subagentsTotal: 5 } }, { detailNav: { onOpenChild: vi.fn() } })
    // 已列两行的和是 3.0KB：它不是全量合计，不许顶上摘要条那一格（那边只有 5 个孩子里的已知数）。
    expect(strip().textContent).not.toContain('KB')
    fireEvent.click(strip())
    // 展开体里逐行的大小照旧：那才是每行自己的读数。
    expect(screen.getByText('孩子会话二')).toBeInTheDocument()
    expect(screen.getAllByText('1.0KB').length).toBeGreaterThan(0)
  })

  it('detailNav 不带 onOpenChild：即使有 subagents 也不画段（组件不自己造动作）', () => {
    at({ kind: 'ready', subject: entry, detail: { ...detail, subagents: [KID] } })
    expect(document.querySelector('[data-dsh-session-delete="session-subagents"]')).toBeNull()
    expect(document.querySelector('[data-dsh-session-delete="session-subagents-jump"]')).toBeNull()
  })

  it('清册标题与日志标题都为空：标题行兜底成未命名，悬停也给全称', () => {
    const { container } = at({ kind: 'ready', subject: { ...entry, title: '' }, detail: { ...detail, logTitle: '' } },
      { wide: false })
    expect(within(container).getByText('(无标题会话)')).toHaveAttribute('title', '(无标题会话)')
    expect(within(container).getByRole('button', { name: '← 返回清单' })).toBeInTheDocument()
  })

})

it('回收站信息行仍含回收站目录与原本归档（两档信息表各画各的行集）', () => {
  at({ kind: 'ready', subject: entry, detail })
  expect(screen.getByText('回收站目录')).toBeInTheDocument()
  expect(screen.getByText('原本归档')).toBeInTheDocument()
})
