// 回收站的详情块：四态 + 可折叠的正文块 + 分页（docs/ui-spec.md）
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { zhTranslate, type Translate } from '../../src/client/copy.js'
import { TrashDetail, type DetailPager, type TrashDetailProps, type TrashDetailState } from '../../src/client/trash-detail.js'
import type { TrashDetailLike, TrashEntryLike } from '../../src/client/remote.js'
import {
  OFFICIAL_SESSION_DELETE_API_PREFIX,
  type TrashDetailAttachmentWire,
  type TrashDetailBlockWire,
  type TrashDetailInjectionBlockWire,
  type TrashDetailTextBlockWire,
  type TrashDetailToolBlockWire,
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
const reasoningBlock = (id: string, time: number, text: string, truncated = false): TrashDetailTextBlockWire => ({
  kind: 'reasoning', id, time, text, truncated, attachments: [],
})
const injectionBlock = (id: string, time: number, sourceKind: string, text: string): TrashDetailInjectionBlockWire => ({
  kind: 'injection', id, time, sourceKind, text, truncated: false, attachments: [],
})
const toolBlock = (id: string, time: number, over: Partial<{ name: string; status: 'ok' | 'error' | 'unfinished'; args: string; result: string; argsTruncated: boolean; resultTruncated: boolean; attachments: TrashDetailAttachmentWire[] }> = {}): TrashDetailToolBlockWire => ({
  kind: 'tool', id, time, callId: `call-${id}`, name: 'read', status: 'ok',
  args: '{"file_path":"a.ts"}', argsTruncated: false, result: '文件内容', resultTruncated: false, attachments: [],
  ...over,
})
const systemBlock = (id: string, time: number, text: string): TrashDetailTextBlockWire => ({
  kind: 'system', id, time, text, truncated: false, attachments: [],
})
const compactionBlock = (id: string, time: number, text: string): TrashDetailTextBlockWire => ({
  kind: 'compaction', id, time, text, truncated: false, attachments: [],
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

/** 组件面把分页四样打包过手（`pager`），测试仍按各自的格子覆盖（`{ loadingOlder: true }`）：
 *  这里只做拼装，断言的是行为，不跟 props 形状一起抖。 */
function detailElement(state: TrashDetailState, over: Partial<TrashDetailProps> & Partial<DetailPager> = {}) {
  const { loadingOlder, olderFailure, onLoadOlder, scrollRef, ...rest } = over
  const props: TrashDetailProps = {
    state,
    busy: false,
    wide: true,
    onRetry: vi.fn(),
    onBack: vi.fn(),
    // 导航面（开孩子 / 回父）整体是一个 `detailNav`：判据住控制器，这里只画。
    detailNav: {},
    pager: {
      loadingOlder: loadingOlder ?? false,
      olderFailure: olderFailure ?? null,
      onLoadOlder: onLoadOlder ?? vi.fn(),
      ...(scrollRef === undefined ? {} : { scrollRef }),
    },
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
  return at({ kind: 'ready', entry, detail: { ...detail, blocks } }, over)
}

/** 逐块折叠的判据住在「详细」档：默认「标准」把连续的过程块收成一组（docs/ui-spec.md 状态⑥）。 */
function detailedMode(): void {
  fireEvent.click(screen.getByRole('button', { name: '详细' }))
}

describe('回收站详情块 · 四种状态', () => {
  it('未选中：只有引导句，没有任何动作按钮', () => {
    at({ kind: 'idle' })
    expect(screen.getByText('选中一条会话，看它讲了什么')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '彻底删除' })).not.toBeInTheDocument()
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
    const { container: narrowPane } = at({ kind: 'ready', entry, detail }, { wide: false })
    expect(within(narrowPane).getByRole('button', { name: '← 返回清单' })).toBeInTheDocument()

    const { container: widePane } = at({ kind: 'ready', entry, detail }, { wide: true })
    expect(within(widePane).queryByRole('button', { name: '← 返回清单' })).not.toBeInTheDocument()
  })
})

describe('回收站详情块 · 有内容', () => {
  it('标题优先用清册那一份；会话信息单表直显、计量行独立成行', () => {
    at({ kind: 'ready', entry, detail })
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
    at({ kind: 'ready', entry: { ...entry, title: '' }, detail })
    expect(screen.getByText('日志标题')).toBeInTheDocument()
  })

  it('正文按顺序成列：用户在右、助手在左，截断过的那条尾部标「已截断」', () => {
    const { container } = at({ kind: 'ready', entry, detail })
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
    at({
      kind: 'ready',
      entry,
      detail: { ...detail, lastActivity: detail.createdAt + 10 * 60000 },
    })
    expect(screen.getByText('不足 1 小时')).toBeInTheDocument()
  })

  it('时间戳缺省（日志里没读到）⇒ 三格都降级，不报 1970、也不把"不知道"报成"1 小时"', () => {
    at({ kind: 'ready', entry, detail: { ...detail, createdAt: 0, lastActivity: 0 } })
    expect(screen.queryByText(/1970/)).not.toBeInTheDocument()
    expect(screen.queryByText('1 小时')).not.toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(3)
  })

  it('一条正文都没有 ⇒ 明说"没有可显示的内容"，不装作还在读', () => {
    at({ kind: 'ready', entry, detail: { ...detail, blocks: [], userMessageCount: 0, assistantMessageCount: 0 } })
    expect(screen.getByText('这条会话没有可显示的内容')).toBeInTheDocument()
  })

  it('详情里不摆动作按钮（2026-10-15 真机反馈后：动作住在清单行右侧）', () => {
    at({ kind: 'ready', entry, detail })
    expect(screen.queryByRole('button', { name: '恢复' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '彻底删除' })).not.toBeInTheDocument()
  })
})

describe('回收站详情块 · 折叠', () => {
  it('思考默认折叠：折叠头给摘要，点开才出现正文', () => {
    withBlocks([reasoningBlock('r1', 1, '先分析需求\n正文里的独有句子')])
    detailedMode()
    const header = screen.getByRole('button', { name: /思考/ })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('正文里的独有句子')).not.toBeInTheDocument()
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/正文里的独有句子/)).toBeInTheDocument()
  })

  it('工具调用默认折叠：折叠头给工具名与状态，展开才有参数和结果', () => {
    withBlocks([toolBlock('t1', 1, { name: 'read', status: 'ok' })])
    detailedMode()
    const header = screen.getByRole('button', { name: /read/ })
    expect(header).toHaveTextContent('成功')
    expect(screen.queryByText('参数')).not.toBeInTheDocument()
    fireEvent.click(header)
    expect(screen.getByText('参数')).toBeInTheDocument()
    expect(screen.getByText('结果')).toBeInTheDocument()
    const body = document.querySelector('[data-sd-block-body]') as HTMLElement
    expect(body).toHaveTextContent('{"file_path":"a.ts"}')
    expect(body).toHaveTextContent('文件内容')
  })

  it('工具失败与未完成各有自己的状态字', () => {
    withBlocks([
      toolBlock('t1', 1, { name: 'bash', status: 'error', result: '炸了' }),
      toolBlock('t2', 2, { name: 'write', status: 'unfinished', args: '{}', result: '' }),
    ])
    detailedMode()
    expect(screen.getByRole('button', { name: /bash/ })).toHaveTextContent('失败')
    expect(screen.getByRole('button', { name: /write/ })).toHaveTextContent('未完成')
  })

  it('注入上下文默认折叠：折叠头给来源标签，展开才出现原文', () => {
    withBlocks([injectionBlock('i1', 1, 'runtime-context', '摘要行\n上下文正文独有')])
    detailedMode()
    const header = screen.getByRole('button', { name: /上下文注入/ })
    expect(header).toHaveTextContent('运行上下文')
    expect(screen.queryByText('上下文正文独有')).not.toBeInTheDocument()
    fireEvent.click(header)
    expect(screen.getByText(/上下文正文独有/)).toBeInTheDocument()
  })

  // 宿主实际发过的来源都要有人话：只映射四个老值会让「子会话消息」「后台任务」等以英文 slug 出镜。
  it.each([
    ['agent-message', '子会话消息'],
    ['subagent-settled', '子会话结束'],
    ['tool-jobs', '后台任务'],
    ['skill-invocation', '技能调用'],
    ['user-approval', '用户批准'],
    ['goal', '目标'],
  ] as const)('注入来源 %s 映射成「%s」，不把宿主 slug 露在正文', (kind, label) => {
    withBlocks([injectionBlock('i1', 1, kind, '正文')])
    detailedMode()
    const header = screen.getByRole('button', { name: /上下文注入/ })
    expect(header).toHaveTextContent(label)
    expect(header).not.toHaveTextContent(kind)
  })

  it('认不出的注入来源落「其他上下文」，原串只留在 title', () => {
    withBlocks([injectionBlock('i1', 1, 'future-kind', '正文')])
    detailedMode()
    const header = screen.getByRole('button', { name: /上下文注入/ })
    expect(header).toHaveTextContent('其他上下文')
    expect(header).not.toHaveTextContent('future-kind')
    expect(screen.getByTitle('上下文注入 · future-kind')).toBeInTheDocument()
  })

  it('系统消息与压缩摘要也默认折叠', () => {
    withBlocks([
      systemBlock('s1', 1, '系统摘要\n系统正文独有'),
      compactionBlock('c1', 2, '压缩摘要\n压缩正文独有'),
    ])
    detailedMode()
    expect(screen.getByRole('button', { name: /系统消息/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: /上下文已压缩/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('系统正文独有')).not.toBeInTheDocument()
    expect(screen.queryByText('压缩正文独有')).not.toBeInTheDocument()
  })

  it('工作步骤四档：标准收组、简洁只看对话、详细逐条、完全展开一次铺开', () => {
    withBlocks([
      reasoningBlock('r1', 1, '思考摘要\n思考正文独有'),
      toolBlock('t1', 2),
      injectionBlock('i1', 3, 'time-context', '时间摘要\n时间正文独有'),
    ])
    // 默认「标准」：连续过程块收成一组，块本身不直接出场；点开组才逐条出现（仍各自折叠）。
    expect(screen.getByRole('button', { name: /工作步骤/ })).toHaveTextContent('3 步')
    expect(screen.queryByRole('button', { name: /思考/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /工作步骤/ }))
    expect(screen.getByRole('button', { name: /思考/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('思考正文独有')).not.toBeInTheDocument()
    // 详细：过程块逐条列出（各自折叠）。
    fireEvent.click(screen.getByRole('button', { name: '详细' }))
    expect(screen.getByRole('button', { name: /思考/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('思考正文独有')).not.toBeInTheDocument()
    // 简洁：过程块整段不出现。
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))
    expect(screen.queryByRole('button', { name: /思考/ })).not.toBeInTheDocument()
    // 完全展开：这一页的过程块一次铺开；逐条仍可再收起。
    fireEvent.click(screen.getByRole('button', { name: '完全展开' }))
    expect(screen.getByText(/思考正文独有/)).toBeInTheDocument()
    expect(screen.getByText('参数')).toBeInTheDocument()
    expect(screen.getByText(/时间正文独有/)).toBeInTheDocument()
    const header = screen.getByRole('button', { name: /思考/ })
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('思考正文独有')).not.toBeInTheDocument()
  })

  it('再点一次「完全展开」不会把读者刚收起的块重新铺开', () => {
    withBlocks([reasoningBlock('r1', 1, '思考正文独有')])
    const verbose = screen.getByRole('button', { name: '完全展开' })
    fireEvent.click(verbose)
    fireEvent.click(screen.getByRole('button', { name: /思考/ }))
    expect(screen.getByRole('button', { name: /思考/ })).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(verbose)
    expect(screen.getByRole('button', { name: /思考/ })).toHaveAttribute('aria-expanded', 'false')
    // 折叠时摘要仍会念出首行，正文体才是「有没有铺开」的判据。
    expect(document.querySelector('[data-sd-block-body]')).toBeNull()
  })

  it('离开「完全展开」时收回这一页铺开的块，回到详细档的逐条折叠', () => {
    withBlocks([reasoningBlock('r1', 1, '思考正文独有'), toolBlock('t1', 2)])
    fireEvent.click(screen.getByRole('button', { name: '完全展开' }))
    expect(document.querySelectorAll('[data-sd-block-body]')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: '详细' }))
    expect(screen.getByRole('button', { name: /思考/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: /read/ })).toHaveAttribute('aria-expanded', 'false')
    expect(document.querySelectorAll('[data-sd-block-body]')).toHaveLength(0)
  })

  it('标准档的步数走单复数：一块时说单数，不写成 "1 steps"', () => {
    const t: Translate = (key, params) => {
      if (key === 'detail.process.step') return '1 step'
      if (key === 'detail.process.steps') return `${String(params?.n)} steps`
      return zhTranslate(key, params)
    }
    withBlocks([toolBlock('t1', 1)], { t })
    expect(screen.getByRole('button', { name: /工作步骤/ })).toHaveTextContent('1 step')
  })

  it('简洁档自动连翻在飞时不再说「点加载更早」：按钮此刻按不动', () => {
    render(detailElement(
      { kind: 'ready', entry, detail: { ...detail, blocks: [toolBlock('9', 1)], olderCursor: 9 } },
      { loadingOlder: true },
    ))
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))
    expect(screen.queryByText('这一页只有过程内容；点「加载更早」继续往前看。')).not.toBeInTheDocument()
  })

  it('简洁档遇到只有过程内容的会话：明说去哪看，不留一块空白', () => {
    withBlocks([reasoningBlock('r1', 1, '只有过程')])
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))
    expect(screen.getByText('这段会话只有过程内容；切到「标准」可以看到。')).toBeInTheDocument()
  })

  it('简洁档还有更早页时只说这一页只有过程内容，不冒充整条会话', () => {
    at({
      kind: 'ready',
      entry,
      detail: { ...detail, blocks: [reasoningBlock('r1', 1, '只有过程')], olderCursor: 1 },
    })
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))
    expect(screen.getByText('这一页只有过程内容；点「加载更早」继续往前看。')).toBeInTheDocument()
    expect(screen.queryByText('这段会话只有过程内容；切到「标准」可以看到。')).not.toBeInTheDocument()
  })

  it('切到简洁档时当前页全是过程块：自动连翻一页，不用先点「加载更早」', () => {
    const onLoadOlder = vi.fn()
    render(detailElement(
      { kind: 'ready', entry, detail: { ...detail, blocks: [toolBlock('9', 1)], olderCursor: 9 } },
      { onLoadOlder },
    ))
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
  })

  it('切到简洁档时当前页有对话：不自动请求更早页', () => {
    const onLoadOlder = vi.fn()
    render(detailElement(
      {
        kind: 'ready',
        entry,
        detail: { ...detail, blocks: [userBlock('10', 1, '尾页'), toolBlock('9', 2)], olderCursor: 9 },
      },
      { onLoadOlder },
    ))
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))
    expect(onLoadOlder).not.toHaveBeenCalled()
  })

  it('自动连翻有上限：到 AUTO_OLDER_PAGE_LIMIT 页就停，之后的新页不再请求', () => {
    const onLoadOlder = vi.fn()
    let blocks: TrashDetailBlockWire[] = [toolBlock('100', 1)]
    let cursor: number | null = 99
    const { rerender } = render(detailElement(
      { kind: 'ready', entry, detail: { ...detail, blocks, olderCursor: 100 } },
      { onLoadOlder },
    ))
    // 切到简洁档时当前页全是过程块 ⇒ 首屏就自动连翻，不要求先点按钮。
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    // 连续 11 页都只有过程块：前 10 页自动请求，第 11 页落地时预算已尽。
    for (let page = 0; page < 11; page += 1) {
      blocks = [toolBlock(String(90 - page), 1), ...blocks]
      rerender(detailElement(
        { kind: 'ready', entry, detail: { ...detail, blocks, olderCursor: cursor } },
        { onLoadOlder },
      ))
      cursor = cursor === null ? null : cursor - 1
    }
    expect(onLoadOlder).toHaveBeenCalledTimes(11)
    expect(screen.getByText('这一页只有过程内容；点「加载更早」继续往前看。')).toBeInTheDocument()
  })

  it('自动连翻遇到游标耗尽就停，并改说整条会话只有过程内容', () => {
    const onLoadOlder = vi.fn()
    const tail = [toolBlock('10', 1)]
    const { rerender } = render(detailElement(
      { kind: 'ready', entry, detail: { ...detail, blocks: tail, olderCursor: 10 } },
      { onLoadOlder },
    ))
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    rerender(detailElement(
      { kind: 'ready', entry, detail: { ...detail, blocks: [toolBlock('9', 1), ...tail], olderCursor: null } },
      { onLoadOlder },
    ))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
    expect(screen.getByText('这段会话只有过程内容；切到「标准」可以看到。')).toBeInTheDocument()
  })

  it('默认「标准」档：过程组展开后工具头仍带状态、仍各自折叠', () => {
    withBlocks([toolBlock('t1', 1, { name: 'read', status: 'error', result: '炸了' })])
    fireEvent.click(screen.getByRole('button', { name: /工作步骤/ }))
    const header = screen.getByRole('button', { name: /read/ })
    expect(header).toHaveTextContent('失败')
    expect(header).toHaveAttribute('aria-expanded', 'false')
  })

  it('标准档 prepend 更早过程块合并进同一组：已展开的组不收回', () => {
    const tail = [toolBlock('9', 2)]
    const { rerender } = render(detailElement({
      kind: 'ready',
      entry,
      detail: { ...detail, blocks: tail, olderCursor: 9 },
    }))
    fireEvent.click(screen.getByRole('button', { name: /工作步骤/ }))
    expect(screen.getByRole('button', { name: /read/ })).toHaveAttribute('aria-expanded', 'false')

    // 更早一页带来一块同样是过程内容的块，两页在这里合并成同一组；组的键取「组后那条对话」，
    // 不随 prepend 改动，所以读者已经点开的那一组仍在。
    rerender(detailElement({
      kind: 'ready',
      entry,
      detail: { ...detail, blocks: [toolBlock('8', 1), ...tail], olderCursor: 8 },
    }))
    expect(screen.getAllByRole('button', { name: /read/ })).toHaveLength(2)
  })

  it('截断过的块在展开体里标"已截断"，不把少掉的字说成完整', () => {
    withBlocks([reasoningBlock('r1', 1, '只剩这一段', true)])
    detailedMode()
    fireEvent.click(screen.getByRole('button', { name: /思考/ }))
    expect(screen.getByText('已截断')).toBeInTheDocument()
  })

  it('用户与助手块截断时也标「已截断」，不只画省略号', () => {
    const { container } = withBlocks([
      { ...userBlock('u1', 1, '只剩这一段'), truncated: true },
      assistantBlock('a1', 2, '只剩这一段', true),
    ])
    expect(screen.getAllByText('已截断')).toHaveLength(2)
    const rows = [...container.querySelectorAll('[data-sd-msg]')]
    // Element.textContent 在 lib.dom 里就是 string（不会是 null）；断言"没有省略号"不变。
    expect(rows.every((row) => !row.textContent.includes('…'))).toBe(true)
  })

  it('折叠头摘要只给 Markdown 块去粗体星号；工具与注入照原样', () => {
    withBlocks([
      reasoningBlock('r1', 1, '**想**'),
      toolBlock('t1', 2, { result: 'a ** b' }),
      injectionBlock('i1', 3, 'time-context', '**注入**'),
    ])
    detailedMode()
    expect(screen.getByRole('button', { name: /思考/ })).not.toHaveTextContent('**')
    expect(screen.getByRole('button', { name: /read/ })).toHaveTextContent('a ** b')
    expect(screen.getByRole('button', { name: /上下文注入/ })).toHaveTextContent('**注入**')
  })

  it('简洁档「加载更早」自动连翻：整页过程块被隐藏时就继续往前，直到出现对话内容', () => {
    const onLoadOlder = vi.fn()
    const tail = [userBlock('10', 1, '尾页正文')]
    const { rerender } = render(detailElement(
      { kind: 'ready', entry, detail: { ...detail, blocks: tail, olderCursor: 10 } },
      { onLoadOlder },
    ))
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))
    fireEvent.click(screen.getByRole('button', { name: '加载更早' }))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    // 第一页全是过程块：简洁档下不可见 ⇒ 自动再翻一页。
    rerender(detailElement(
      { kind: 'ready', entry, detail: { ...detail, blocks: [toolBlock('9', 1), ...tail], olderCursor: 9 } },
      { onLoadOlder },
    ))
    expect(onLoadOlder).toHaveBeenCalledTimes(2)

    // 第二页带回用户提问 ⇒ 停在这一页，不再自动翻。
    rerender(detailElement(
      { kind: 'ready', entry, detail: { ...detail, blocks: [userBlock('8', 1, '更早的提问'), toolBlock('9', 1), ...tail], olderCursor: 8 } },
      { onLoadOlder },
    ))
    expect(screen.getByText('更早的提问')).toBeInTheDocument()
    expect(onLoadOlder).toHaveBeenCalledTimes(2)
  })

  it('详细档「加载更早」一次只翻一页（过程块本身可见，不触发自动连翻）', () => {
    const onLoadOlder = vi.fn()
    const tail = [userBlock('10', 1, '尾页正文')]
    const { rerender } = render(detailElement(
      { kind: 'ready', entry, detail: { ...detail, blocks: tail, olderCursor: 10 } },
      { onLoadOlder },
    ))
    fireEvent.click(screen.getByRole('button', { name: '详细' }))
    fireEvent.click(screen.getByRole('button', { name: '加载更早' }))
    rerender(detailElement(
      { kind: 'ready', entry, detail: { ...detail, blocks: [toolBlock('9', 1), ...tail], olderCursor: 9 } },
      { onLoadOlder },
    ))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /read/ })).toBeInTheDocument()
  })

  it('prepend 更早一页保留已展开的块：开合挂在块 id 上，不随页重排', () => {
    const tail = [toolBlock('10', 1), reasoningBlock('11', 2, '思考摘要\n思考正文独有')]
    const { rerender } = render(detailElement({ kind: 'ready', entry, detail: { ...detail, blocks: tail, olderCursor: 10 } }))
    detailedMode()
    fireEvent.click(screen.getByRole('button', { name: /read/ }))
    expect(screen.getByRole('button', { name: /read/ })).toHaveAttribute('aria-expanded', 'true')

    rerender(detailElement({
      kind: 'ready',
      entry,
      detail: { ...detail, blocks: [reasoningBlock('7', 1, '更早的思考\n更早正文独有'), ...tail], olderCursor: 7 },
    }))
    // 原来展开的那块还展开着；新 prepend 进来的按默认折叠摆。
    expect(screen.getByRole('button', { name: /read/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('参数')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /思考/ })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /思考/ }).every((fold) => fold.getAttribute('aria-expanded') === 'false')).toBe(true)
  })
})

describe('回收站详情块 · 加载更早', () => {
  it('有 olderCursor 才出按钮；点了把意图交给上层', () => {
    const onLoadOlder = vi.fn()
    withBlocks([userBlock('10', 1, '尾页')])
    expect(screen.queryByRole('button', { name: '加载更早' })).not.toBeInTheDocument()

    at({ kind: 'ready', entry, detail: { ...detail, blocks: [userBlock('10', 1, '尾页')], olderCursor: 10 } }, { onLoadOlder })
    fireEvent.click(screen.getByRole('button', { name: '加载更早' }))
    expect(onLoadOlder).toHaveBeenCalled()
  })

  it('在飞时按钮变"正在加载更早…"且禁用', () => {
    at({
      kind: 'ready',
      entry,
      detail: { ...detail, blocks: [userBlock('10', 1, '尾页')], olderCursor: 10 },
    }, { loadingOlder: true })
    expect(screen.getByRole('button', { name: '正在加载更早…' })).toBeDisabled()
  })

  it('加载失败原文单独上屏，已有正文不按掉', () => {
    at({
      kind: 'ready',
      entry,
      detail: { ...detail, blocks: [userBlock('10', 1, '尾页')], olderCursor: 10 },
    }, { olderFailure: '更早的页读不出来' })
    expect(screen.getByRole('status')).toHaveTextContent('更早的页读不出来')
    expect(screen.getByText('尾页')).toBeInTheDocument()
  })

  it('prepend 后按滚动高度差补偿位置：正看着的那块不因上方长出新内容而跳走', () => {
    const scroll = { scrollHeight: 1000, scrollTop: 480 }
    const scrollRef = { current: scroll as unknown as HTMLDivElement }
    const tailPage = { ...detail, blocks: [userBlock('10', 1, '尾页')], olderCursor: 10 }
    const { rerender } = render(detailElement({ kind: 'ready', entry, detail: tailPage }, { scrollRef }))

    fireEvent.click(screen.getByRole('button', { name: '加载更早' }))
    rerender(detailElement({ kind: 'ready', entry, detail: tailPage }, { scrollRef, loadingOlder: true }))

    // 更早三块落到屏上、容器高了 620 ⇒ 视口跟着下移同样的量。
    scroll.scrollHeight = 1620
    rerender(detailElement({
      kind: 'ready',
      entry,
      detail: { ...detail, blocks: [userBlock('7', 1, '更早一'), userBlock('8', 1, '更早二'), userBlock('9', 1, '更早三'), userBlock('10', 1, '尾页')], olderCursor: 7 },
    }, { scrollRef }))
    expect(scroll.scrollTop).toBe(1100)
  })

  it('加载更早期间读者继续滚动：补偿加在当前视口上，不把人拽回点击位置', () => {
    const scroll = { scrollHeight: 1000, scrollTop: 480 }
    const scrollRef = { current: scroll as unknown as HTMLDivElement }
    const tailPage = { ...detail, blocks: [userBlock('10', 1, '尾页')], olderCursor: 10 }
    const { rerender } = render(detailElement({ kind: 'ready', entry, detail: tailPage }, { scrollRef }))

    fireEvent.click(screen.getByRole('button', { name: '加载更早' }))
    rerender(detailElement({ kind: 'ready', entry, detail: tailPage }, { scrollRef, loadingOlder: true }))

    // 请求在飞时读者往下滚了 400；更早三块再让容器高 620。
    scroll.scrollTop = 880
    scroll.scrollHeight = 1620
    rerender(detailElement({
      kind: 'ready',
      entry,
      detail: { ...detail, blocks: [userBlock('7', 1, '更早一'), userBlock('8', 1, '更早二'), userBlock('9', 1, '更早三'), userBlock('10', 1, '尾页')], olderCursor: 7 },
    }, { scrollRef }))
    expect(scroll.scrollTop).toBe(1500)
  })

  it('更早一页读失败：块数没变，位置不动、补偿作废', () => {
    const scroll = { scrollHeight: 1000, scrollTop: 480 }
    const scrollRef = { current: scroll as unknown as HTMLDivElement }
    const tailPage: TrashDetailState = { kind: 'ready', entry, detail: { ...detail, blocks: [userBlock('10', 1, '尾页')], olderCursor: 10 } }
    const { rerender } = render(detailElement(tailPage, { scrollRef }))

    fireEvent.click(screen.getByRole('button', { name: '加载更早' }))
    rerender(detailElement(tailPage, { scrollRef, loadingOlder: true }))
    rerender(detailElement(tailPage, { scrollRef, olderFailure: '更早的页读不出来' }))
    expect(scroll.scrollTop).toBe(480)
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

describe('回收站详情块 · 删除时间不进详情', () => {
  it('删除于只在清单行；详情表里没有它（相对/绝对都不重复）', () => {
    at({ kind: 'ready', entry, detail })
    expect(document.querySelector('dt')?.textContent).toBe('项目')
    expect(screen.queryByText(/前（/)).not.toBeInTheDocument()
    expect(screen.queryByText('删除于')).not.toBeInTheDocument()
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
  it('有 subagents 且 detailNav.onOpenChild 在场：段标题给条数与合计，逐条画出，点一条把它交出去', () => {
    const onOpenChild = vi.fn()
    const kid2 = { ...KID, id: 'kid2', title: '孩子会话二', sizeBytes: 1024 }
    at({ kind: 'ready', entry, detail: { ...detail, subagents: [KID, kid2] } }, { detailNav: { onOpenChild } })
    // 段上的合计是这一批孩子的清册大小（与清单行同一口径）：永久删除按整组释放，删前要能核对「几个都在这儿」
    expect(screen.getByText('子会话（2） · 3.0KB，随本条一起恢复或删除')).toBeInTheDocument()
    const row = screen.getByText('孩子会话')
    fireEvent.click(row)
    expect(onOpenChild).toHaveBeenCalledWith(KID)
    // 宿主类给折叠头钉死行高并裁溢出，导航行带内边距必须放开高度按内容撑开，否则裁字；
    // 指针光标同理走内联，不借展开语义。jsdom 量不了布局，这里钉内联契约当回归哨。
    const rowButton = document.querySelector<HTMLButtonElement>('[data-dsh-session-delete="trash-subagent-row"]')
    expect(rowButton).not.toBeNull()
    expect(must(rowButton, '子会话导航行').style.height).toBe('auto')
    expect(must(rowButton, '子会话导航行').style.cursor).toBe('pointer')
  })

  it('subagents 缺席：没有子会话段', () => {
    at({ kind: 'ready', entry, detail }, { detailNav: { onOpenChild: vi.fn() } })
    expect(screen.queryByText(/^子会话（/)).not.toBeInTheDocument()
  })

  it('subagentsTotal 出线：说清只列了前几条、总数是多少', () => {
    const kid2 = { ...KID, id: 'kid2', title: '孩子会话二', sizeBytes: 1024 }
    at({ kind: 'ready', entry, detail: { ...detail, subagents: [KID, kid2], subagentsTotal: 5 } }, { detailNav: { onOpenChild: vi.fn() } })
    expect(screen.getByText('仅列出前 2 条，共 5 条')).toBeInTheDocument()
  })

  it('detailNav 不带 onOpenChild：即使有 subagents 也不画段（组件不自己造动作）', () => {
    at({ kind: 'ready', entry, detail: { ...detail, subagents: [KID] } })
    expect(screen.queryByText(/^子会话（/)).not.toBeInTheDocument()
  })

  it('孩子视图（parentContext 在场）：宽档也画「返回父会话」，点它交回 onBack', () => {
    const onBack = vi.fn()
    at({ kind: 'ready', entry: KID, detail: { ...detail, entryId: KID.id } },
      { wide: true, detailNav: { parentContext: { title: '父会话', onBack } } })
    const btn = screen.getByRole('button', { name: '← 返回父会话' })
    fireEvent.click(btn)
    expect(onBack).toHaveBeenCalled()
    // 孩子视图里不再同时画「返回清单」：一步只退一层
    expect(screen.queryByRole('button', { name: '← 返回清单' })).not.toBeInTheDocument()
  })

  // title 的兜底住视图：控制器（`detailNav`）交的是清册原文，翻译只在这一侧发生。
  it('parentContext.title 为空串：返回键的悬停兜底成未命名', () => {
    at({ kind: 'ready', entry: KID, detail: { ...detail, entryId: KID.id } },
      { wide: true, detailNav: { parentContext: { title: '', onBack: vi.fn() } } })
    expect(screen.getByRole('button', { name: '← 返回父会话' })).toHaveAttribute('title', '(无标题会话)')
  })

  it('清册标题与日志标题都为空：标题行兜底成未命名，悬停也给全称', () => {
    const { container } = at({ kind: 'ready', entry: { ...entry, title: '' }, detail: { ...detail, logTitle: '' } },
      { wide: false })
    expect(within(container).getByText('(无标题会话)')).toHaveAttribute('title', '(无标题会话)')
    expect(within(container).getByRole('button', { name: '← 返回清单' })).toBeInTheDocument()
  })

  it('parentContext 缺席且宽档：两颗返回按钮都不画（现状不变）', () => {
    at({ kind: 'ready', entry, detail }, { wide: true })
    expect(screen.queryByRole('button', { name: '← 返回父会话' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '← 返回清单' })).not.toBeInTheDocument()
  })

  // jsdom 量不了布局，钉的是 DOM 与声明契约：两颗返回互斥、共用标题那一排的右端。
  // 「右端」全靠 `flex: 1 1 auto` 那条——DOM 顺序只保证按钮紧跟标题，不保证它被推到最右。
  it('返回键住标题那一排的右端：标题在前吃满余宽、按钮在后，两颗共用同一个位置', () => {
    const headOf = (pane: HTMLElement) =>
      must(pane.querySelector<HTMLElement>('[data-dsh-session-delete="trash-detail-head"]'), '详情标题排')
    const titleRowOf = (head: HTMLElement) =>
      must(head.firstElementChild instanceof HTMLElement ? head.firstElementChild : null, '标题栏')
    const expectEllipsis = (row: HTMLElement) => {
      expect(row.style.overflow).toBe('hidden')
      expect(row.style.textOverflow).toBe('ellipsis')
      expect(row.style.whiteSpace).toBe('nowrap')
      expect(row.style.minWidth).toBe('0')
    }

    const { container: kidPane } = at({ kind: 'ready', entry: KID, detail: { ...detail, entryId: KID.id } },
      { wide: true, detailNav: { parentContext: { title: '父会话', onBack: vi.fn() } } })
    const kidHead = headOf(kidPane)
    const kidTitleRow = titleRowOf(kidHead)
    const kidTitle = within(kidPane).getByText('孩子会话')
    expect(kidTitleRow.style.flex).toBe('1 1 auto')
    expectEllipsis(kidTitleRow)
    expect(kidTitleRow.firstElementChild).toBe(kidTitle)
    // 悬停提示挂在按文字收缩的内层，热区不跟着标题行铺满整行。
    expect(kidTitleRow).not.toHaveAttribute('title')
    expect(kidTitle).toHaveAttribute('title', '孩子会话')
    expect(kidHead.lastElementChild).toBe(within(kidPane).getByRole('button', { name: '← 返回父会话' }))

    // 窄档孩子视图：返回父会话仍占同一个位置，且不与「返回清单」同屏。
    const { container: narrowKidPane } = at({ kind: 'ready', entry: KID, detail: { ...detail, entryId: KID.id } },
      { wide: false, detailNav: { parentContext: { title: '父会话', onBack: vi.fn() } } })
    const narrowKidHead = headOf(narrowKidPane)
    const narrowKidTitleRow = titleRowOf(narrowKidHead)
    expect(narrowKidTitleRow.style.flex).toBe('1 1 auto')
    expectEllipsis(narrowKidTitleRow)
    expect(narrowKidHead.lastElementChild).toBe(within(narrowKidPane).getByRole('button', { name: '← 返回父会话' }))
    expect(within(narrowKidPane).queryByRole('button', { name: '← 返回清单' })).not.toBeInTheDocument()

    const { container: listPane } = at({ kind: 'ready', entry, detail }, { wide: false })
    const listHead = headOf(listPane)
    const listTitleRow = titleRowOf(listHead)
    const listTitle = within(listPane).getByText('清册标题')
    expect(listTitleRow.style.flex).toBe('1 1 auto')
    expectEllipsis(listTitleRow)
    expect(listTitleRow.firstElementChild).toBe(listTitle)
    expect(listTitleRow).not.toHaveAttribute('title')
    expect(listTitle).toHaveAttribute('title', '清册标题')
    expect(listHead.lastElementChild).toBe(within(listPane).getByRole('button', { name: '← 返回清单' }))
  })

  // jsdom 量不了布局，钉的是声明契约：宽档父详情的标题排没有返回键、孩子视图有；
  // 标题排不按紧凑按钮（28px）预留行高时，下方会话信息会在父子切换时上下跳 6px。
  it('标题排恒定预留紧凑按钮的行高：父子视图同高、没有返回键的父详情也不塌陷', () => {
    const { container } = at({ kind: 'ready', entry, detail }, { wide: true })
    const head = must(container.querySelector<HTMLElement>('[data-dsh-session-delete="trash-detail-head"]'), '详情标题排')
    expect(head.style.minHeight).toBe('28px')
    // 只钉一侧会漏掉另一侧的回退：父子同高才是这条不变量的全部。
    const { container: kidContainer } = at(
      { kind: 'ready', entry: KID, detail: { ...detail, entryId: KID.id } },
      { wide: true, detailNav: { parentContext: { title: '父会话', onBack: vi.fn() } } },
    )
    const kidHead = must(kidContainer.querySelector<HTMLElement>('[data-dsh-session-delete="trash-detail-head"]'), '孩子详情标题排')
    expect(kidHead.style.minHeight).toBe(head.style.minHeight)
  })
})
