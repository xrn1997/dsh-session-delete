/**
 * 通用详情壳（`session-detail.tsx`）的**接口级用例**：壳自己拥有的判据——状态壳与标题排、
 * 工作步骤四档与折叠、分页（按钮 / 在飞 / 失败 / 简洁档连翻预算）、子会话投影槽的读数呈现。
 *
 * 档差只在三个投影口（`head` / `infoRows` / `subagents`）里：本文件只交最小投影；两档包装
 * 「投影对不对」的用例住 `trash-detail.test.tsx` / `archive-detail.test.tsx`。
 * 分页器的滚动锚点与连翻预算同时在 `use-detail-pager.test.tsx` 的 hook 接口上直接钉——这里
 * 只验壳把动作与读数接对了（用户点得到、看得见）。
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  SessionDetail,
  type DetailInfoRow,
  type SessionDetailProps,
  type SubagentSectionProps,
} from '../../src/client/session-detail.js'
import { zhTranslate, type Translate } from '../../src/client/copy.js'
import type { DetailPager } from '../../src/client/use-detail-frame.js'
import type { DetailState } from '../../src/client/use-detail-reader.js'
import {
  useSubagentSection,
  type SubagentSectionInput,
} from '../../src/client/subagent-section.js'
import { AUTO_OLDER_PAGE_LIMIT } from '../../src/client/use-detail-pager.js'
import type {
  SessionDetailWire,
  TrashDetailBlockWire,
  TrashDetailInjectionBlockWire,
  TrashDetailTextBlockWire,
  TrashDetailToolBlockWire,
} from '../../src/shared/wire.js'
import { must } from '../support/fixture.js'

interface Row { readonly id: string }

type State = DetailState<Row, SessionDetailWire>
type ShellOver = Partial<SessionDetailProps<Row, SessionDetailWire>>

const core = (over: Partial<SessionDetailWire> = {}): SessionDetailWire => ({
  cwd: 'C:/p', createdAt: 1, lastActivity: 2, logTitle: '', models: [],
  turnCount: 0, userMessageCount: 0, assistantMessageCount: 0, toolCallCount: 0,
  injectedCount: 0, blocks: [], olderCursor: null, ...over,
})

const userBlock = (id: string, text: string, truncated = false): TrashDetailTextBlockWire => ({
  kind: 'user', id, time: 1, text, truncated, attachments: [],
})
const assistantBlock = (id: string, text: string, truncated = false): TrashDetailTextBlockWire => ({
  kind: 'assistant', id, time: 2, text, truncated, attachments: [],
})
const reasoningBlock = (id: string, text: string, truncated = false): TrashDetailTextBlockWire => ({
  kind: 'reasoning', id, time: 1, text, truncated, attachments: [],
})
const toolBlock = (id: string, over: Partial<{ name: string; status: 'ok' | 'error' | 'unfinished'; args: string; result: string }> = {}): TrashDetailToolBlockWire => ({
  kind: 'tool', id, time: 1, callId: `call-${id}`, name: 'read', status: 'ok',
  args: '{"file_path":"a.ts"}', argsTruncated: false, result: '文件内容', resultTruncated: false, attachments: [],
  ...over,
})
const injectionBlock = (id: string, sourceKind: string, text: string): TrashDetailInjectionBlockWire => ({
  kind: 'injection', id, time: 1, sourceKind, text, truncated: false, attachments: [],
})
const systemBlock = (id: string, text: string): TrashDetailTextBlockWire => ({
  kind: 'system', id, time: 1, text, truncated: false, attachments: [],
})
const compactionBlock = (id: string, text: string): TrashDetailTextBlockWire => ({
  kind: 'compaction', id, time: 1, text, truncated: false, attachments: [],
})

const pagerOf = (over: Partial<DetailPager> = {}): DetailPager => ({
  loadingOlder: false, olderFailure: null, onLoadOlder: vi.fn(), ...over,
})

interface ShellOptions {
  state?: State
  /** ready 态正文的覆盖（最常用）。 */
  detail?: Partial<SessionDetailWire>
  pager?: Partial<DetailPager>
  /** 其余 props 的覆盖（head / infoRows / subagents / wide / detailNav / t 等）。 */
  props?: ShellOver
  /** 子会话段的投影槽（两种写法与 `props.subagents` 等价，给 harness 用）。 */
  subagents?: SubagentSectionProps
}

function shellProps(options: ShellOptions = {}): SessionDetailProps<Row, SessionDetailWire> {
  const state: State = options.state ?? { kind: 'ready', subject: { id: 'a' }, detail: core(options.detail) }
  return {
    frame: { state, pager: pagerOf(options.pager) },
    subjectId: 'a',
    head: { displayName: '会话甲', sizeText: '1 KB' },
    infoRows: [{ label: '项目', value: 'C:/p' }],
    busy: false,
    wide: true,
    onRetry: vi.fn(),
    onBack: vi.fn(),
    detailNav: {},
    t: zhTranslate,
    ...(options.subagents === undefined ? {} : { subagents: options.subagents }),
    ...options.props,
  }
}

function shellElement(options: ShellOptions = {}) {
  return <SessionDetail {...shellProps(options)} />
}

function at(options: ShellOptions = {}) {
  return render(shellElement(options))
}

/** 逐块折叠的判据住在「详细」档：默认「标准」把连续的过程块收成一组（`docs/ui-spec.md` §2 ⑥）。 */
function detailedMode(): void {
  fireEvent.click(screen.getByRole('button', { name: '详细' }))
}

/** 子会话段的真实接线：`useSubagentSection` 的输入由用例给，壳只画投影槽——读数由段自己算。 */
function SubagentProbe({ input }: { input: SubagentSectionInput }) {
  const section = useSubagentSection(input)
  return shellElement(section === undefined ? {} : { subagents: section })
}

/** 一帧详情里最常用的子会话段输入（两档包装各自把行投影好后交进来，这里直接用原始事实）。 */
const subagentInput = (over: Partial<SubagentSectionInput> = {}): SubagentSectionInput => ({
  subjectId: 'a',
  children: [{ id: 'kid', name: '孩子会话', sizeBytes: 2048, at: undefined, navigable: true }],
  total: undefined,
  totalSizeBytes: 2048,
  note: '随本条一起恢复或删除',
  onOpenChild: vi.fn(),
  t: zhTranslate,
  ...over,
})

describe('通用详情壳 · 状态壳与标题排', () => {
  it('未选中：只有引导句，没有任何动作按钮', () => {
    at({ state: { kind: 'idle' } })
    expect(screen.getByText('选中一条会话，看它讲了什么')).toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('读数中：只有「正在读…」与骨架；骨架按内容形状画、不标 aria-busy', () => {
    const { container } = at({ state: { kind: 'loading', subject: { id: 'a' } } })
    expect(screen.getByText('正在读这条会话…')).toBeInTheDocument()
    expect(container.querySelectorAll('.sd-skeleton-bar').length).toBeGreaterThanOrEqual(6)
    expect(container.querySelector('[aria-busy]')).toBeNull()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('读数失败：原文上屏 + 重试，且这块是 role="status"', () => {
    const onRetry = vi.fn()
    at({ state: { kind: 'failed', subject: { id: 'a' }, message: '读会话日志失败：第 2 帧解压失败' }, props: { onRetry } })
    const block = screen.getByRole('status')
    expect(block).toHaveTextContent('这条会话的正文读不出来')
    expect(block).toHaveTextContent('读会话日志失败：第 2 帧解压失败')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('保持：画上一条的正文（aria-busy + inert），先不出提示也不出骨架', () => {
    const { container } = at({ state: { kind: 'holding', subject: { id: 'a' }, detail: core() } })
    const body = container.querySelector('[data-dsh-session-delete="session-detail-hold-body"]')
    expect(body).toHaveAttribute('aria-busy', 'true')
    expect(container.querySelector('[inert]')).not.toBeNull()
    expect(screen.queryByText('正在读这条会话…')).not.toBeInTheDocument()
    expect(container.querySelectorAll('.sd-skeleton-bar')).toHaveLength(0)
  })

  // 保持对象从 A 换到 B：那一句「正在读…」说的是 A，不许跟着搬给 B；B 得从自己的静默窗口重新计时。
  it('holdId A→B：先收掉 A 的提示，再从 B 的 300ms 窗口后重出', () => {
    vi.useFakeTimers()
    try {
      const holding = (id: string): State => ({ kind: 'holding', subject: { id }, detail: core() })
      const { rerender } = render(shellElement({ state: holding('a') }))
      act(() => { vi.advanceTimersByTime(300) })
      expect(screen.getByText('正在读这条会话…')).toBeInTheDocument()
      expect(document.querySelectorAll('.sd-skeleton-bar')).toHaveLength(0)

      rerender(shellElement({ state: holding('b'), props: { subjectId: 'b' } }))
      expect(screen.queryByText('正在读这条会话…')).not.toBeInTheDocument()

      act(() => { vi.advanceTimersByTime(300) })
      expect(screen.getByText('正在读这条会话…')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('换到另一条已就绪详情：滚动容器回到顶部', () => {
    const scrollRef = { current: null as HTMLDivElement | null }
    const detail = core()
    const view = render(
      <div ref={scrollRef}>{shellElement({ state: { kind: 'ready', subject: { id: 'a' }, detail }, pager: { scrollRef } })}</div>,
    )
    if (scrollRef.current !== null) scrollRef.current.scrollTop = 120

    view.rerender(
      <div ref={scrollRef}>
        {shellElement({ state: { kind: 'ready', subject: { id: 'b' }, detail }, props: { subjectId: 'b' }, pager: { scrollRef } })}
      </div>,
    )
    expect(scrollRef.current?.scrollTop).toBe(0)
  })

  it('窄档下钻时顶部有「返回清单」，宽档没有；读失败时窄档也给返回', () => {
    const first = at({ props: { wide: false } })
    expect(within(first.container).getByRole('button', { name: '← 返回清单' })).toBeInTheDocument()
    expect(first.container.querySelector('[data-dsh-session-delete="session-detail-head"]')).not.toBeNull()

    const second = at({ props: { wide: true } })
    expect(within(second.container).queryByRole('button', { name: '← 返回清单' })).not.toBeInTheDocument()

    const failed = at({ state: { kind: 'failed', subject: { id: 'a' }, message: 'io' }, props: { wide: false } })
    expect(within(failed.container).getByRole('button', { name: '← 返回清单' })).toBeInTheDocument()
    expect(within(failed.container).getByRole('status')).toBeInTheDocument()
  })

  it('孩子视图（parentContext 在场）：宽档也画「返回父会话」，点它交回 onBack', () => {
    const onBack = vi.fn()
    at({ props: { wide: true, detailNav: { parentContext: { title: '父会话', onBack } } } })
    fireEvent.click(screen.getByRole('button', { name: '← 返回父会话' }))
    expect(onBack).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '← 返回清单' })).not.toBeInTheDocument()
  })

  // title 的兜底住壳：控制器（`detailNav`）交的是原文，翻译只在这一侧发生。
  it('parentContext.title 为空串：返回键的悬停兜底成未命名', () => {
    at({ props: { detailNav: { parentContext: { title: '', onBack: vi.fn() } } } })
    expect(screen.getByRole('button', { name: '← 返回父会话' })).toHaveAttribute('title', '(无标题会话)')
  })

  it('parentContext 缺席且宽档：两颗返回按钮都不画', () => {
    at({ props: { wide: true } })
    expect(screen.queryByRole('button', { name: '← 返回父会话' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '← 返回清单' })).not.toBeInTheDocument()
  })

  // jsdom 量不了布局，钉的是 DOM 与声明契约：两颗返回互斥、共用标题那一排的右端。
  // 「右端」全靠 `flex: 1 1 auto` 那条——DOM 顺序只保证按钮紧跟标题，不保证它被推到最右。
  it('返回键住标题那一排的右端：标题在前吃满余宽、按钮在后，两颗共用同一个位置', () => {
    const headOf = (pane: HTMLElement) =>
      must(pane.querySelector<HTMLElement>('[data-dsh-session-delete="session-detail-head"]'), '详情标题排')
    const titleRowOf = (head: HTMLElement) =>
      must(head.firstElementChild instanceof HTMLElement ? head.firstElementChild : null, '标题栏')
    const expectEllipsis = (row: HTMLElement) => {
      expect(row.style.overflow).toBe('hidden')
      expect(row.style.textOverflow).toBe('ellipsis')
      expect(row.style.whiteSpace).toBe('nowrap')
      expect(row.style.minWidth).toBe('0')
    }

    const kid = at({ props: { wide: true, head: { displayName: '孩子会话', sizeText: null }, detailNav: { parentContext: { title: '父会话', onBack: vi.fn() } } } })
    const kidHead = headOf(kid.container)
    const kidTitleRow = titleRowOf(kidHead)
    const kidTitle = within(kid.container).getByText('孩子会话')
    expect(kidTitleRow.style.flex).toBe('1 1 auto')
    expectEllipsis(kidTitleRow)
    expect(kidTitleRow.firstElementChild).toBe(kidTitle)
    // 悬停提示挂在按文字收缩的内层，热区不跟着标题行铺满整行。
    expect(kidTitleRow).not.toHaveAttribute('title')
    expect(kidTitle).toHaveAttribute('title', '孩子会话')
    expect(kidHead.lastElementChild).toBe(within(kid.container).getByRole('button', { name: '← 返回父会话' }))

    const list = at({ props: { wide: false } })
    const listHead = headOf(list.container)
    const listTitleRow = titleRowOf(listHead)
    const listTitle = within(list.container).getByText('会话甲')
    expect(listTitleRow.style.flex).toBe('1 1 auto')
    expectEllipsis(listTitleRow)
    expect(listTitleRow.firstElementChild).toBe(listTitle)
    expect(listTitleRow).not.toHaveAttribute('title')
    expect(listTitle).toHaveAttribute('title', '会话甲')
    expect(listHead.lastElementChild).toBe(within(list.container).getByRole('button', { name: '← 返回清单' }))
  })

  // jsdom 量不了布局，钉的是声明契约：宽档父详情的标题排没有返回键、孩子视图有；
  // 标题排不按紧凑按钮（28px）预留行高时，下方会话信息会在父子切换时上下跳 6px。
  it('标题排恒定预留紧凑按钮的行高：父子视图同高、没有返回键的父详情也不塌陷', () => {
    const plain = at()
    const head = must(plain.container.querySelector<HTMLElement>('[data-dsh-session-delete="session-detail-head"]'), '详情标题排')
    expect(head.style.minHeight).toBe('28px')

    const kid = at({ props: { detailNav: { parentContext: { title: '父会话', onBack: vi.fn() } } } })
    const kidHead = must(kid.container.querySelector<HTMLElement>('[data-dsh-session-delete="session-detail-head"]'), '孩子详情标题排')
    expect(kidHead.style.minHeight).toBe(head.style.minHeight)
  })
})

describe('通用详情壳 · 正文面', () => {
  it('正文面从 SessionDetailWire 取：计量行、工作步骤档位与正文块都渲染；提问轨在面板层、不在这里', () => {
    at({
      detail: {
        turnCount: 3,
        blocks: [userBlock('0', '先看改动')],
        prompts: [{ id: '0', at: 1, preview: '先看改动' }],
      },
    })
    expect(screen.getByText('轮数')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('先看改动')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '工作步骤展示' })).toBeInTheDocument()
    expect(document.querySelector('.sd-prompt-rail')).toBeNull()
  })

  it('infoRows 按传入渲染；subagents 缺席不画子会话段', () => {
    const infoRows: readonly DetailInfoRow[] = [
      { label: '项目', value: 'C:/p' },
      { label: '状态', value: '已归档' },
    ]
    at({ props: { infoRows } })
    expect(screen.getByText('项目')).toBeInTheDocument()
    expect(screen.getByText('状态')).toBeInTheDocument()
    expect(screen.getByText('已归档')).toBeInTheDocument()
    expect(document.querySelector('[data-dsh-session-delete="session-subagents"]')).toBeNull()
    expect(screen.queryByText('子会话')).not.toBeInTheDocument()
  })

  it('一条正文都没有 ⇒ 明说「没有可显示的内容」，不装作还在读', () => {
    at()
    expect(screen.getByText('这条会话没有可显示的内容')).toBeInTheDocument()
  })
})

describe('通用详情壳 · 折叠', () => {
  it('思考默认折叠：折叠头给摘要，点开才出现正文', () => {
    at({ detail: { blocks: [reasoningBlock('r1', '先分析需求\n正文里的独有句子')] } })
    detailedMode()
    const header = screen.getByRole('button', { name: /思考/ })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('正文里的独有句子')).not.toBeInTheDocument()
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/正文里的独有句子/)).toBeInTheDocument()
  })

  it('工具调用默认折叠：折叠头给工具名与状态，展开才有参数和结果', () => {
    at({ detail: { blocks: [toolBlock('t1')] } })
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
    at({
      detail: {
        blocks: [
          toolBlock('t1', { name: 'bash', status: 'error', result: '炸了' }),
          toolBlock('t2', { name: 'write', status: 'unfinished', args: '{}', result: '' }),
        ],
      },
    })
    detailedMode()
    expect(screen.getByRole('button', { name: /bash/ })).toHaveTextContent('失败')
    expect(screen.getByRole('button', { name: /write/ })).toHaveTextContent('未完成')
  })

  it('注入上下文默认折叠：折叠头给来源标签，展开才出现原文', () => {
    at({ detail: { blocks: [injectionBlock('i1', 'runtime-context', '摘要行\n上下文正文独有')] } })
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
    at({ detail: { blocks: [injectionBlock('i1', kind, '正文')] } })
    detailedMode()
    const header = screen.getByRole('button', { name: /上下文注入/ })
    expect(header).toHaveTextContent(label)
    expect(header).not.toHaveTextContent(kind)
  })

  it('认不出的注入来源落「其他上下文」，原串只留在 title', () => {
    at({ detail: { blocks: [injectionBlock('i1', 'future-kind', '正文')] } })
    detailedMode()
    const header = screen.getByRole('button', { name: /上下文注入/ })
    expect(header).toHaveTextContent('其他上下文')
    expect(header).not.toHaveTextContent('future-kind')
    expect(screen.getByTitle('上下文注入 · future-kind')).toBeInTheDocument()
  })

  it('系统消息与压缩摘要也默认折叠', () => {
    at({ detail: { blocks: [systemBlock('s1', '系统摘要\n系统正文独有'), compactionBlock('c1', '压缩摘要\n压缩正文独有')] } })
    detailedMode()
    expect(screen.getByRole('button', { name: /系统消息/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: /上下文已压缩/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('系统正文独有')).not.toBeInTheDocument()
    expect(screen.queryByText('压缩正文独有')).not.toBeInTheDocument()
  })

  it('截断过的块在展开体里标「已截断」，不把少掉的字说成完整', () => {
    at({ detail: { blocks: [reasoningBlock('r1', '只剩这一段', true)] } })
    detailedMode()
    fireEvent.click(screen.getByRole('button', { name: /思考/ }))
    expect(screen.getByText('已截断')).toBeInTheDocument()
  })

  it('用户与助手块截断时也标「已截断」，不只画省略号', () => {
    const { container } = at({
      detail: { blocks: [userBlock('u1', '只剩这一段', true), assistantBlock('a1', '只剩这一段', true)] },
    })
    expect(screen.getAllByText('已截断')).toHaveLength(2)
    const rows = [...container.querySelectorAll('[data-sd-msg]')]
    // Element.textContent 在 lib.dom 里就是 string（不会是 null）；断言「没有省略号」不变。
    expect(rows.every((row) => !row.textContent.includes('…'))).toBe(true)
  })

  it('折叠头摘要只给 Markdown 块去粗体星号；工具与注入照原样', () => {
    at({
      detail: {
        blocks: [
          reasoningBlock('r1', '**想**'),
          toolBlock('t1', { result: 'a ** b' }),
          injectionBlock('i1', 'time-context', '**注入**'),
        ],
      },
    })
    detailedMode()
    expect(screen.getByRole('button', { name: /思考/ })).not.toHaveTextContent('**')
    expect(screen.getByRole('button', { name: /read/ })).toHaveTextContent('a ** b')
    expect(screen.getByRole('button', { name: /上下文注入/ })).toHaveTextContent('**注入**')
  })

  it('prepend 更早一页保留已展开的块：开合挂在块 id 上，不随页重排', () => {
    const tail = [toolBlock('10'), reasoningBlock('11', '思考摘要\n思考正文独有')]
    const detailOf = (blocks: TrashDetailBlockWire[], olderCursor: number | null): ShellOptions =>
      ({ detail: { blocks, olderCursor } })
    const view = at(detailOf(tail, 10))
    detailedMode()
    fireEvent.click(screen.getByRole('button', { name: /read/ }))
    expect(screen.getByRole('button', { name: /read/ })).toHaveAttribute('aria-expanded', 'true')

    view.rerender(shellElement(detailOf([reasoningBlock('7', '更早的思考\n更早正文独有'), ...tail], 7)))
    expect(screen.getByRole('button', { name: /read/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('参数')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /思考/ })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /思考/ }).every((fold) => fold.getAttribute('aria-expanded') === 'false')).toBe(true)
  })
})

describe('通用详情壳 · 工作步骤四档', () => {
  const processBlocks = (): readonly TrashDetailBlockWire[] => [
    reasoningBlock('r1', '思考摘要\n思考正文独有'),
    toolBlock('t1'),
    injectionBlock('i1', 'time-context', '时间摘要\n时间正文独有'),
  ]

  it('标准收组、简洁只看对话、详细逐条、完全展开一次铺开', () => {
    at({ detail: { blocks: [...processBlocks(), userBlock('u1', '用户的提问')] } })
    // 默认「标准」：连续过程块收成一组，块本身不直接出场；点开组才逐条出现（仍各自折叠）。
    expect(screen.getByRole('button', { name: /工作步骤/ })).toHaveTextContent('3 步')
    fireEvent.click(screen.getByRole('button', { name: /工作步骤/ }))
    expect(screen.getByRole('button', { name: /思考/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('思考正文独有')).not.toBeInTheDocument()
    // 详细：过程块逐条列出（各自折叠）。
    fireEvent.click(screen.getByRole('button', { name: '详细' }))
    expect(screen.getByRole('button', { name: /思考/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('思考正文独有')).not.toBeInTheDocument()
    // 简洁：过程块整段不出现，只留对话。
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))
    expect(screen.queryByRole('button', { name: /思考/ })).not.toBeInTheDocument()
    expect(screen.getByText('用户的提问')).toBeInTheDocument()
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
    at({ detail: { blocks: [reasoningBlock('r1', '思考正文独有')] } })
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
    at({ detail: { blocks: [reasoningBlock('r1', '思考正文独有'), toolBlock('t1')] } })
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
    at({ detail: { blocks: [toolBlock('t1')] }, props: { t } })
    expect(screen.getByRole('button', { name: /工作步骤/ })).toHaveTextContent('1 step')
  })

  it('默认「标准」档：过程组展开后工具头仍带状态、仍各自折叠', () => {
    at({ detail: { blocks: [toolBlock('t1', { name: 'read', status: 'error', result: '炸了' })] } })
    fireEvent.click(screen.getByRole('button', { name: /工作步骤/ }))
    const header = screen.getByRole('button', { name: /read/ })
    expect(header).toHaveTextContent('失败')
    expect(header).toHaveAttribute('aria-expanded', 'false')
  })

  it('标准档 prepend 更早过程块合并进同一组：已展开的组不收回', () => {
    const tail = [toolBlock('9')]
    const view = at({ detail: { blocks: tail, olderCursor: 9 } })
    fireEvent.click(screen.getByRole('button', { name: /工作步骤/ }))
    expect(screen.getByRole('button', { name: /read/ })).toHaveAttribute('aria-expanded', 'false')

    // 更早一页带来同样属于过程内容的块，两页合并成同一组；组的键取组后那条对话，不随 prepend 改动。
    view.rerender(shellElement({ detail: { blocks: [toolBlock('8'), ...tail], olderCursor: 8 } }))
    expect(screen.getAllByRole('button', { name: /read/ })).toHaveLength(2)
  })
})

describe('通用详情壳 · 简洁档的内容提示', () => {
  it('遇到只有过程内容的会话：明说去哪看，不留一块空白', () => {
    at({ detail: { blocks: [reasoningBlock('r1', '只有过程')] } })
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))
    expect(screen.getByText('这段会话只有过程内容；切到「标准」可以看到。')).toBeInTheDocument()
  })

  it('还有更早页时只说这一页只有过程内容，不冒充整条会话', () => {
    at({ detail: { blocks: [reasoningBlock('r1', '只有过程')], olderCursor: 1 } })
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))
    expect(screen.getByText('这一页只有过程内容；点「加载更早」继续往前看。')).toBeInTheDocument()
    expect(screen.queryByText('这段会话只有过程内容；切到「标准」可以看到。')).not.toBeInTheDocument()
  })

  it('自动连翻在飞时不再说「这一页只有过程内容」', () => {
    at({
      detail: { blocks: [toolBlock('9')], olderCursor: 9 },
      pager: { loadingOlder: true },
    })
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))
    expect(screen.queryByText('这一页只有过程内容；点「加载更早」继续往前看。')).not.toBeInTheDocument()
  })
})

describe('通用详情壳 · 分页（ADR-0057）', () => {
  it('有 olderCursor 才出「加载更早」；点了把意图交给帧的分页读面', () => {
    const first = at()
    expect(within(first.container).queryByRole('button', { name: '加载更早' })).not.toBeInTheDocument()

    const onLoadOlder = vi.fn()
    at({ detail: { blocks: [userBlock('10', '尾页')], olderCursor: 10 }, pager: { onLoadOlder } })
    fireEvent.click(screen.getByRole('button', { name: '加载更早' }))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
  })

  it('在飞时按钮改说「正在加载更早…」并禁用', () => {
    at({ detail: { blocks: [userBlock('10', '尾页')], olderCursor: 10 }, pager: { loadingOlder: true } })
    expect(screen.getByRole('button', { name: '正在加载更早…' })).toBeDisabled()
  })

  it('加载失败原文单独上屏，已有正文不按掉（失败只坏分页）', () => {
    at({
      detail: { blocks: [userBlock('10', '尾页')], olderCursor: 10 },
      pager: { olderFailure: '更早的页读不出来' },
    })
    expect(screen.getByRole('status')).toHaveTextContent('更早的页读不出来')
    expect(screen.getByText('尾页')).toBeInTheDocument()
  })

  it('切到简洁档时当前页全是过程块：自动连翻一页，不用读者先点「加载更早」', () => {
    const onLoadOlder = vi.fn()
    at({ detail: { blocks: [toolBlock('9')], olderCursor: 9 }, pager: { onLoadOlder } })
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
  })

  it('切到简洁档时当前页有对话：不自动请求更早页', () => {
    const onLoadOlder = vi.fn()
    at({
      detail: { blocks: [userBlock('10', '尾页'), toolBlock('9')], olderCursor: 9 },
      pager: { onLoadOlder },
    })
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))
    expect(onLoadOlder).not.toHaveBeenCalled()
  })

  it(`自动连翻有上限：到 AUTO_OLDER_PAGE_LIMIT（${AUTO_OLDER_PAGE_LIMIT}）页就停，之后的新页不再请求`, () => {
    const onLoadOlder = vi.fn()
    let blocks: TrashDetailBlockWire[] = [toolBlock('100')]
    let cursor: number | null = 99
    const view = at({ detail: { blocks, olderCursor: 100 }, pager: { onLoadOlder } })
    // 切到简洁档时当前页全是过程块 ⇒ 首屏就自动连翻，不要求先点按钮。
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    // 连续 11 页都只有过程块：前 10 页自动请求，第 11 页落地时预算已尽。
    for (let page = 0; page < 11; page += 1) {
      blocks = [toolBlock(String(90 - page)), ...blocks]
      view.rerender(shellElement({ detail: { blocks, olderCursor: cursor }, pager: { onLoadOlder } }))
      cursor = cursor === null ? null : cursor - 1
    }
    expect(onLoadOlder).toHaveBeenCalledTimes(AUTO_OLDER_PAGE_LIMIT + 1)
    expect(screen.getByText('这一页只有过程内容；点「加载更早」继续往前看。')).toBeInTheDocument()
  })

  it('自动连翻遇到游标耗尽就停，并改说整条会话只有过程内容', () => {
    const onLoadOlder = vi.fn()
    const tail = [toolBlock('10')]
    const view = at({ detail: { blocks: tail, olderCursor: 10 }, pager: { onLoadOlder } })
    fireEvent.click(screen.getByRole('button', { name: '简洁' }))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)

    view.rerender(shellElement({
      detail: { blocks: [toolBlock('9'), ...tail], olderCursor: null },
      pager: { onLoadOlder },
    }))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
    expect(screen.getByText('这段会话只有过程内容；切到「标准」可以看到。')).toBeInTheDocument()
  })
})

describe('通用详情壳 · 子会话投影槽的读数', () => {
  const strip = (container: HTMLElement): HTMLButtonElement =>
    must(container.querySelector<HTMLButtonElement>('[data-dsh-session-delete="session-subagents-toggle"]'), '子会话摘要条')

  it('默认收起：只有一行摘要条（计数徽标 + 合计）与标题排徽标，不画孩子行', () => {
    const { container } = render(<SubagentProbe input={subagentInput()} />)
    expect(strip(container).getAttribute('aria-expanded')).toBe('false')
    expect(strip(container).textContent).toContain('子会话')
    expect(strip(container).textContent).toContain('1')
    expect(strip(container).textContent).toContain('2.0KB')
    expect(container.querySelector('[data-dsh-session-delete="session-subagent-row"]')).toBeNull()
    expect(screen.queryByText('孩子会话')).not.toBeInTheDocument()
    // 标题排徽标说的是同一个数（滚进正文后的常驻入口，ADR-0055）。
    const jump = must(container.querySelector<HTMLButtonElement>('[data-dsh-session-delete="session-subagents-jump"]'), '子会话跳转徽标')
    expect(jump.textContent).toContain('1')
  })

  it('点摘要条原地展开：逐条画出、段内写「随谁走」，点一条把它交出去；导航行不借折叠头的类与 chevron', () => {
    const onOpenChild = vi.fn()
    const kidB = { id: 'kid-b', name: '孩子会话二', sizeBytes: 1024, at: undefined, navigable: true }
    const { container } = render(<SubagentProbe input={subagentInput({
      children: [{ id: 'kid', name: '孩子会话', sizeBytes: 2048, at: undefined, navigable: true }, kidB],
      totalSizeBytes: 3072,
      onOpenChild,
    })} />)
    expect(strip(container).textContent).toContain('3.0KB')
    fireEvent.click(strip(container))
    expect(strip(container).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('随本条一起恢复或删除')).toBeInTheDocument()
    const rowButton = must(container.querySelector<HTMLButtonElement>('[data-dsh-session-delete="session-subagent-row"]'), '子会话导航行')
    // 语法分清：导航行不套折叠头那套类（chevron 只留给原地展开）。
    expect(rowButton.className).not.toContain('sd-disclosure-row')
    expect(rowButton.style.cursor).toBe('pointer')
    expect(rowButton.style.height).toBe('')
    expect(rowButton.style.background).toBe('')
    fireEvent.click(screen.getByText('孩子会话'))
    expect(onOpenChild).toHaveBeenCalledWith('kid')
  })

  it('标题排徽标：点它展开子会话段并滚过去，段顶让开 sticky 标题排', () => {
    const { container } = render(<SubagentProbe input={subagentInput()} />)
    const section = must(container.querySelector<HTMLDivElement>('[data-dsh-session-delete="session-subagents"]'), '子会话段')
    const scroll = vi.fn<(options?: ScrollIntoViewOptions | boolean) => void>()
    section.scrollIntoView = scroll
    const jump = must(container.querySelector<HTMLButtonElement>('[data-dsh-session-delete="session-subagents-jump"]'), '子会话跳转徽标')
    fireEvent.click(jump)
    expect(scroll).toHaveBeenCalledWith({ block: 'start' })
    expect(section.style.scrollMarginTop).toBe('34px')
    expect(strip(container).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('孩子会话')).toBeInTheDocument()
  })

  it('孩子行 hover / focus 150ms 后才预取；提前移开不读', () => {
    vi.useFakeTimers()
    try {
      const onPrefetchChild = vi.fn()
      const { container } = render(<SubagentProbe input={subagentInput({ onPrefetchChild })} />)
      fireEvent.click(strip(container))
      const row = screen.getByRole('button', { name: /孩子会话/ })

      fireEvent.pointerOver(row)
      act(() => { vi.advanceTimersByTime(149) })
      expect(onPrefetchChild).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(1) })
      expect(onPrefetchChild).toHaveBeenCalledWith('kid')

      onPrefetchChild.mockClear()
      fireEvent.pointerOut(row)
      fireEvent.pointerOver(row)
      fireEvent.pointerOut(row)
      act(() => { vi.advanceTimersByTime(150) })
      expect(onPrefetchChild).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('total 出线：摘要条徽标给总数，展开后说清只列了前几条', () => {
    const { container } = render(<SubagentProbe input={subagentInput({
      children: [
        { id: 'kid', name: '孩子会话', sizeBytes: 2048, at: undefined, navigable: true },
        { id: 'kid2', name: '孩子会话二', sizeBytes: 1024, at: undefined, navigable: true },
      ],
      total: 5,
    })} />)
    expect(strip(container).textContent).toContain('5')
    fireEvent.click(strip(container))
    expect(screen.getByText('仅列出前 2 条，共 5 条')).toBeInTheDocument()
  })

  it('totalSizeBytes 出线：摘要条大小按全量合计，不按已列行', () => {
    const { container } = render(<SubagentProbe input={subagentInput({
      children: [
        { id: 'kid', name: '孩子会话', sizeBytes: 2048, at: undefined, navigable: true },
        { id: 'kid2', name: '孩子会话二', sizeBytes: 1024, at: undefined, navigable: true },
      ],
      total: 5,
      totalSizeBytes: 10 * 1024,
    })} />)
    expect(strip(container).textContent).toContain('10KB')
  })

  // 合计的家在 Node 半：客户端不拿**已列的前 N 条**求和冒充全量——那是少报（ADR-0055）。
  it('totalSizeBytes 缺席 ⇒ 摘要条不摆大小格：不拿已列的行求和顶上那一格', () => {
    const { container } = render(<SubagentProbe input={subagentInput({
      children: [
        { id: 'kid', name: '孩子会话', sizeBytes: 2048, at: undefined, navigable: true },
        { id: 'kid2', name: '孩子会话二', sizeBytes: 1024, at: undefined, navigable: true },
      ],
      total: 5,
      totalSizeBytes: undefined,
    })} />)
    // 已列两行的和是 3.0KB：它不是全量合计，不许顶上摘要条那一格。
    expect(strip(container).textContent).not.toContain('KB')
    fireEvent.click(strip(container))
    // 展开体里逐行的大小照旧：那才是每行自己的读数。
    expect(screen.getByText('孩子会话二')).toBeInTheDocument()
    expect(screen.getAllByText('1.0KB').length).toBeGreaterThan(0)
  })

  it('换到另一条会话：子会话段回到默认收起', () => {
    const { container, rerender } = render(<SubagentProbe input={subagentInput()} />)
    fireEvent.click(strip(container))
    expect(screen.getByText('孩子会话')).toBeInTheDocument()

    rerender(<SubagentProbe input={subagentInput({ subjectId: 'b' })} />)
    expect(strip(container).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('孩子会话')).not.toBeInTheDocument()
  })

  it('孩子视图（父视图中不再交出 onOpenChild）：有孩子也不画这一段', () => {
    const input: SubagentSectionInput = {
      subjectId: 'a', children: [], total: undefined, totalSizeBytes: 2048,
      note: '随本条一起恢复或删除', t: zhTranslate,
    }
    const { container } = render(<SubagentProbe input={input} />)
    expect(container.querySelector('[data-dsh-session-delete="session-subagents"]')).toBeNull()
    expect(container.querySelector('[data-dsh-session-delete="session-subagents-jump"]')).toBeNull()
  })
})
