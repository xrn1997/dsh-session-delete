/**
 * 归档详情投影（`archive-detail.tsx`）：信息表**恰五行**（项目 / 日志末条 / 会话 id / 大小 / 状态），
 * 无「回收站目录」「原本归档」；标题与大小与**选中行**配对（不重算）。
 * 子会话段走共享视图：父视图里孩子都可点开（未归档孩子由只读根校验），孩子视图里不再开下一层。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ArchiveDetail, type ArchiveDetailProps } from '../../src/client/archive-detail.js'
import { zhTranslate } from '../../src/client/copy.js'
import { fileSizeText } from '../../src/client/ui/format.js'
import type { ArchiveDetailLike } from '../../src/client/remote.js'
import type { ArchiveDetailSubject } from '../../src/client/use-archive-detail-reader.js'
import type { ArchiveRowWire } from '../../src/shared/wire.js'
import type { DetailState } from '../../src/client/use-detail-reader.js'
import { must } from '../support/fixture.js'

const row = (over: Partial<ArchiveRowWire> = {}): ArchiveRowWire => ({
  sessionId: 'session-a', projectDir: '--p--', title: '日志标题',
  updatedAt: 5, updatedAtSource: 'prompt', subagent: false, ...over,
})

const childSubject = (over: Partial<ArchiveDetailSubject> = {}): ArchiveDetailSubject => ({
  sessionId: 'kid-a', projectDir: '--p--', title: '孩子甲', label: '甲', ...over,
})

const detailOf = (over: Partial<ArchiveDetailLike> = {}): ArchiveDetailLike => ({
  sessionId: 'session-a', archived: true, cwd: 'C:/p', createdAt: 1, lastActivity: 2, logTitle: '日志标题', models: [],
  turnCount: 0, userMessageCount: 0, assistantMessageCount: 0, toolCallCount: 0,
  injectedCount: 0, blocks: [], olderCursor: null, ...over,
})

function detailElement(state: DetailState<ArchiveDetailSubject, ArchiveDetailLike>, over: Partial<ArchiveDetailProps> = {}) {
  const props: ArchiveDetailProps = {
    state,
    busy: false,
    wide: true,
    detailNav: {},
    onRetry: vi.fn(),
    onBack: vi.fn(),
    pager: { loadingOlder: false, olderFailure: null, onLoadOlder: vi.fn() },
    t: zhTranslate,
    ...over,
  }
  return <ArchiveDetail {...props} />
}

describe('归档详情投影（ArchiveDetail）', () => {
  it('信息表恰五行：项目/日志末条/会话 id/大小/状态（已归档）；无回收站目录、无原本归档', () => {
    const { container } = render(detailElement({
      kind: 'ready',
      subject: row({ sizeBytes: 2048 }),
      detail: detailOf(),
    }))
    const labels = [...container.querySelectorAll('dt')].map((dt) => dt.textContent)
    expect(labels).toEqual(['项目', '日志末条', '会话 id', '大小', '状态'])
    expect(screen.getByText('已归档')).toBeInTheDocument()
    expect(screen.queryByText('回收站目录')).not.toBeInTheDocument()
    expect(screen.queryByText('原本归档')).not.toBeInTheDocument()
    expect(container.querySelector('[data-dsh-session-delete="session-subagents"]')).toBeNull()
    // 标题与大小与选中行配对：显示名 = 行的 label/title，大小 = 行的 sizeBytes（详情不重算）。
    expect(screen.getByText('日志标题')).toBeInTheDocument()
    expect(screen.getAllByText(fileSizeText(2048)).length).toBeGreaterThanOrEqual(1)
  })

  it('sizeText 缺席 ⇒ 大小显式「—」、计量行不摆大小（详情不重算、不拿 0 冒充）', () => {
    render(detailElement({
      kind: 'ready',
      subject: row(), // 无 sizeBytes
      detail: detailOf(),
    }))
    // 信息表的「大小」行显式「—」；计量行没有「大小」那一格（没有可信读数就不摆）。
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getAllByText('大小')).toHaveLength(1)
  })

  it('sizeText 由行给 ⇒ 只有信息表那一行显示，计量行不重复', () => {
    render(detailElement({
      kind: 'ready',
      subject: row({ sizeBytes: 2048 }),
      detail: detailOf(),
    }))
    expect(screen.getAllByText('大小')).toHaveLength(1)
    expect(screen.getAllByText(fileSizeText(2048))).toHaveLength(1)
  })

  it('标题排：行 label 最优先，其次详情自己的 label（独立子会话没有父行兜底）', () => {
    render(detailElement({
      kind: 'ready',
      subject: row({ label: '行 label', title: '清单标题' }),
      detail: detailOf({ label: '详情 label', logTitle: '日志标题' }),
    }))
    expect(screen.getByText('行 label')).toBeInTheDocument()
    expect(screen.queryByText('详情 label')).not.toBeInTheDocument()
  })

  it('标题排：行没有 label 时用详情自己的 label，先于清单标题与日志标题', () => {
    render(detailElement({
      kind: 'ready',
      subject: row({ title: '清单标题' }),
      detail: detailOf({ label: '详情 label', logTitle: '日志标题' }),
    }))
    expect(screen.getByText('详情 label')).toBeInTheDocument()
    expect(screen.queryByText('清单标题')).not.toBeInTheDocument()
  })

  it('子会话段：父视图里孩子都可点；摘要条念「随父只读查看」的边界', () => {
    const onOpenChild = vi.fn()
    const childA = {
      sessionId: 'kid-a', archived: false, projectDir: '--p--', title: '孩子甲', label: '甲',
      updatedAt: 3, updatedAtSource: 'prompt' as const, sizeBytes: 10,
    }
    const childB = {
      sessionId: 'kid-b', archived: false, projectDir: '--p--', title: '孩子乙', sizeBytes: 20,
    }
    const { container } = render(detailElement({
      kind: 'ready',
      subject: row(),
      detail: detailOf({ subagents: [childA, childB], subagentsSizeBytes: 30 }),
    }, { detailNav: { onOpenChild } }))

    expect(container.querySelector('[data-dsh-session-delete="session-subagents"]')).not.toBeNull()
    fireEvent.click(must(container.querySelector('[data-dsh-session-delete="session-subagents-toggle"]'), '子会话摘要条'))
    expect(screen.getByText('甲')).toBeInTheDocument()
    expect(screen.getByText('孩子乙')).toBeInTheDocument()
    expect(screen.getByText('子会话随归档父会话只读查看；它们不会随之归档或取消归档。')).toBeInTheDocument()

    const rows = container.querySelectorAll('[data-dsh-session-delete="session-subagent-row"]')
    expect(rows).toHaveLength(2)
    expect(container.querySelector('[data-dsh-session-delete="session-subagent-row-static"]')).toBeNull()
    fireEvent.click(must(rows[0], '可点孩子行'))
    expect(onOpenChild).toHaveBeenCalledWith('kid-a')
  })

  it('孩子视图：状态行说「随归档父会话查看」，孩子段不再交出下一层入口', () => {
    const onBack = vi.fn()
    const grandchild = { sessionId: 'grand-1', archived: false, projectDir: '--p--', title: '孙辈' }
    render(detailElement({
      kind: 'ready',
      subject: childSubject(),
      detail: detailOf({ sessionId: 'kid-a', archived: false, subagents: [grandchild] }),
    }, {
      detailNav: { parentContext: { title: '父会话', onBack } },
    }))
    expect(screen.getByText('随归档父会话查看')).toBeInTheDocument()
    expect(screen.queryByText('已归档')).not.toBeInTheDocument()
    expect(document.querySelector('[data-dsh-session-delete="session-subagents"]')).toBeNull()
  })

  it('孩子视图：状态行认这一读的归档态——已归档孩子照实说「已归档」', () => {
    // 清单不可见（重读失败 / 语料缺席）时已归档孩子也会进孩子视图：状态行认 `ArchiveDetailWire.archived`
    // 这一格，不认 `parentContext` 在场与否，也不认主体上的旧快照（导航道会串，这一读的归档态不会）。
    render(detailElement({
      kind: 'ready',
      subject: childSubject(),
      detail: detailOf({ sessionId: 'kid-a', archived: true }),
    }, {
      detailNav: { parentContext: { title: '父会话', onBack: vi.fn() } },
    }))
    expect(screen.getByText('已归档')).toBeInTheDocument()
    expect(screen.queryByText('随归档父会话查看')).not.toBeInTheDocument()
  })
})
