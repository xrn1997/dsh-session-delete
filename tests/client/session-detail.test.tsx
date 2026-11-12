/**
 * 通用详情视图（`session-detail.tsx`）：数据面只认 `SessionDetailWire` 基座 + 三个投影口
 * （`head` / `infoRows` / `subagents`）。回收站与归档两档共用这一份，档差全在投影里；
 * `subagents` 缺席（那一条没有孩子）⇒ 子会话段**不画**，两档同一判据（段的呈现归
 * `subagent-section.tsx`，两档各自的行集与数据来源归 `trash-detail.tsx` / `archive-detail.tsx`）。
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionDetail, type DetailInfoRow, type SessionDetailProps } from '../../src/client/session-detail.js'
import { zhTranslate } from '../../src/client/copy.js'
import type { SessionDetailWire, TrashDetailBlockWire } from '../../src/shared/wire.js'

interface Row { readonly id: string }

const core = (over: Partial<SessionDetailWire> = {}): SessionDetailWire => ({
  cwd: 'C:/p', createdAt: 1, lastActivity: 2, logTitle: '', models: [],
  turnCount: 0, userMessageCount: 0, assistantMessageCount: 0, toolCallCount: 0,
  injectedCount: 0, blocks: [], olderCursor: null, ...over,
})

const userBlock = (id: string, text: string): TrashDetailBlockWire => ({
  kind: 'user', id, time: 1, text, truncated: false, attachments: [],
})

function detailElement(over: Partial<SessionDetailProps<Row, SessionDetailWire>> = {}) {
  const props: SessionDetailProps<Row, SessionDetailWire> = {
    state: { kind: 'ready', subject: { id: 'a' }, detail: core() },
    subjectId: 'a',
    head: { displayName: '会话甲', sizeText: '1 KB' },
    infoRows: [{ label: '项目', value: 'C:/p' }],
    busy: false,
    wide: true,
    onRetry: vi.fn(),
    onBack: vi.fn(),
    detailNav: {},
    pager: { loadingOlder: false, olderFailure: null, onLoadOlder: vi.fn() },
    t: zhTranslate,
    ...over,
  }
  return <SessionDetail {...props} />
}

describe('通用详情视图（SessionDetail）', () => {
  it('正文面从 SessionDetailWire 取（计量行/工作步骤/正文块都渲染；提问轨在面板层、不在这里）', () => {
    render(detailElement({
      state: {
        kind: 'ready',
        subject: { id: 'a' },
        detail: core({
          turnCount: 3,
          blocks: [userBlock('0', '先看改动')],
          prompts: [{ id: '0', at: 1, preview: '先看改动' }],
        }),
      },
    }))
    // 计量行：轮数从基座取。
    expect(screen.getByText('轮数')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    // 正文块渲染（提问轨是面板层的右槽零件，`prompts` 数据由基座过线——归面板测试）。
    expect(screen.getByText('先看改动')).toBeInTheDocument()
    // 工作步骤的档位条在场。
    expect(screen.getByRole('group', { name: '工作步骤展示' })).toBeInTheDocument()
  })

  it('infoRows 按传入渲染；subagents 缺席不画子会话段', () => {
    const infoRows: readonly DetailInfoRow[] = [
      { label: '项目', value: 'C:/p' },
      { label: '状态', value: '已归档' },
    ]
    render(detailElement({ infoRows }))
    expect(screen.getByText('项目')).toBeInTheDocument()
    expect(screen.getByText('状态')).toBeInTheDocument()
    expect(screen.getByText('已归档')).toBeInTheDocument()
    expect(document.querySelector('[data-dsh-session-delete="session-subagents"]')).toBeNull()
    expect(screen.queryByText('子会话')).not.toBeInTheDocument()
  })
})
