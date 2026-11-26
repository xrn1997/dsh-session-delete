// 拖到回收站入口（`docs/ui-spec.md` §1、`ADR-0071`）：
// 4 态 × ok/blk 两档 + 拒收动效（shake 不是状态）；全链红色；命中与高亮 = 整块面板行。
// 本文件钉接线：状态 attr、胶囊文案、图标开合、座位分派、勾选收缩与清场；样式源钉子单列一格。
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TrashPanelIcon } from '../../src/client/trash-entry.js'
import { UndoToast } from '../../src/client/undo-toast.js'
import { registerHostRowInfo } from '../../src/client/host-rows.js'
import { enterSelection, getPicks, togglePick } from '../../src/client/batch-selection-store.js'
import { clearUndoNotice } from '../../src/client/undo-notices.js'
import { zhTranslate } from '../../src/client/copy.js'
import { applyDeps, remoteFail, remoteOk } from './support/fake-remote.js'
import type { ApplyOutcome } from '../../src/shared/wire.js'

const okDelete = (ids: readonly string[]): Promise<ReturnType<typeof remoteOk<ApplyOutcome[]>>> =>
  Promise.resolve(remoteOk(ids.map(
    (id) => ({ id, action: 'delete', ok: true, value: { id: `entry-${id}` } }) as ApplyOutcome,
  )))

/** 仿真宿主形状：普通会话行、运行中会话行、未登记行 + 面板行按钮（整块栏目，glyph 槽里是投放标记）。 */
function mount(over: { applyOutcomes?: ReturnType<typeof vi.fn>; sessionId?: string } = {}) {
  const applyOutcomes =
    over.applyOutcomes ?? vi.fn(async (_action: string, ids: readonly string[]) => okDelete(ids))
  const deps = applyDeps(applyOutcomes as never)
  const sessionId = over.sessionId ?? 'a'
  const view = render(
    <>
      <div data-row-key={`session:${sessionId}`} data-testid="host-session-row" />
      <div data-row-key="session:ghost" data-testid="unregistered-session-row" />
      <button type="button" aria-label="回收站">
        <span style={{ display: 'inline-flex' }}>
          <TrashPanelIcon deps={deps} t={zhTranslate} />
        </span>
      </button>
      {/* 提示宿主（真机上是 `shell.overlay` 常驻）：失败原文靠它上屏。 */}
      <UndoToast deps={deps} t={zhTranslate} />
    </>,
  )
  const target = view.container.querySelector('[data-dsh-session-delete="trash-drop"]')
  const row = view.container.querySelector('button')
  if (target === null || row === null) throw new Error('投放目标没画出来')
  return {
    applyOutcomes,
    target: target as HTMLElement,
    row: row as HTMLElement,
    sessionRow: view.container.querySelector('[data-testid="host-session-row"]') as Element,
    ghostRow: view.container.querySelector('[data-testid="unregistered-session-row"]') as Element,
    state: () => target.getAttribute('data-dst-state'),
    ok: () => target.getAttribute('data-dst-ok'),
    shaking: () => target.getAttribute('data-dst-shake'),
    iconKind: () => target.querySelector('[data-dst-icon]')?.getAttribute('data-dst-icon') ?? null,
  }
}

const pill = (): Element | null => document.querySelector('.sd-drop-pill')
const pillText = (): string | null => pill()?.textContent ?? null

function drop(el: Element, payload: string | null): void {
  fireEvent.drop(el, {
    dataTransfer: { getData: (type: string) => (type === 'text/plain' ? (payload ?? '') : '') },
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('拖到回收站入口 · 状态与视觉', () => {
  it('会话行 dragStart ⇒ armed；dragEnd ⇒ idle 全收', () => {
    registerHostRowInfo('a', { title: 'A', live: false })
    const m = mount()
    expect(m.state()).toBe('idle')
    fireEvent.dragStart(m.sessionRow, { dataTransfer: {} })
    expect(m.state()).toBe('armed')
    expect(m.ok()).toBe('true')
    expect(pill()).toBeNull()
    fireEvent.dragEnd(m.sessionRow, { dataTransfer: {} })
    expect(m.state()).toBe('idle')
    expect(m.shaking()).toBeNull()
  })

  it('live 源 dragStart ⇒ ok=false（预告不撒谎）', () => {
    registerHostRowInfo('run', { title: 'R', live: true })
    const m = mount({ sessionId: 'run' })
    fireEvent.dragStart(m.sessionRow, { dataTransfer: {} })
    expect(m.state()).toBe('armed')
    expect(m.ok()).toBe('false')
  })

  it('dragover 整块面板行 ⇒ over：ok 源开盖 +「松手移入回收站」', () => {
    registerHostRowInfo('a', { title: 'A', live: false })
    const m = mount()
    fireEvent.dragStart(m.sessionRow, { dataTransfer: {} })
    fireEvent.dragOver(m.row, { dataTransfer: { dropEffect: '' } })
    expect(m.state()).toBe('over')
    expect(m.iconKind()).toBe('open')
    expect(pillText()).toBe('松手移入回收站')
  })

  it('live 源 over ⇒ 不开盖 +「运行中的会话不能移入回收站」', () => {
    registerHostRowInfo('run', { title: 'R', live: true })
    const m = mount({ sessionId: 'run' })
    fireEvent.dragStart(m.sessionRow, { dataTransfer: {} })
    fireEvent.dragOver(m.row, { dataTransfer: { dropEffect: '' } })
    expect(m.state()).toBe('over')
    expect(m.ok()).toBe('false')
    expect(m.iconKind()).toBe('closed')
    expect(pillText()).toBe('运行中的会话不能移入回收站')
  })

  it('drop ok ⇒ committing 胶囊「正在移入回收站…」→ 座位落地 ⇒ idle', async () => {
    registerHostRowInfo('a', { title: 'A', live: false })
    const m = mount()
    fireEvent.dragStart(m.sessionRow, { dataTransfer: {} })
    fireEvent.dragOver(m.row, { dataTransfer: { dropEffect: '' } })
    drop(m.row, 'a')
    expect(m.state()).toBe('committing')
    expect(pillText()).toBe('正在移入回收站…')
    expect(m.applyOutcomes).toHaveBeenCalledWith('delete', ['a'])
    await waitFor(() => {
      expect(m.state()).toBe('idle')
      expect(pill()).toBeNull()
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('拖到回收站入口 · 批量（回归）', () => {
  it('拖的行在勾选集里 ⇒ 一拖删整集，全部成功后清空勾选集', async () => {
    registerHostRowInfo('a', { title: 'A', live: false })
    registerHostRowInfo('b', { title: 'B', live: false })
    enterSelection()
    togglePick({ sessionId: 'a', title: 'A' })
    togglePick({ sessionId: 'b', title: 'B' })
    const m = mount()
    fireEvent.dragStart(m.sessionRow, { dataTransfer: {} })
    fireEvent.dragOver(m.row, { dataTransfer: { dropEffect: '' } })
    drop(m.row, 'a')
    expect(m.applyOutcomes).toHaveBeenCalledWith('delete', ['a', 'b'])
    await waitFor(() => {
      expect(m.state()).toBe('idle')
    })
    expect(getPicks()).toEqual([])
  })

  it('批量拖放部分失败 ⇒ 勾选集只留失败条、1.6s 后红胶囊自灭、失败原文立即可见于撤销横幅', async () => {
    vi.useFakeTimers()
    registerHostRowInfo('a', { title: 'A', live: false })
    registerHostRowInfo('b', { title: 'B', live: false })
    enterSelection()
    togglePick({ sessionId: 'a', title: 'A' })
    togglePick({ sessionId: 'b', title: 'B' })
    const applyOutcomes = vi.fn(async () => remoteOk<ApplyOutcome[]>([
      { id: 'a', action: 'delete', ok: true, value: { id: 'entry-a' } } as ApplyOutcome,
      { id: 'b', action: 'delete', ok: false, error: { code: 'live', message: '会话在跑' } },
    ]))
    const m = mount({ applyOutcomes: applyOutcomes as never })
    fireEvent.dragStart(m.sessionRow, { dataTransfer: {} })
    fireEvent.dragOver(m.row, { dataTransfer: { dropEffect: '' } })
    drop(m.row, 'a')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getPicks()).toEqual([{ sessionId: 'b', title: 'B' }])
    expect(m.shaking()).toBe('true')
    expect(pillText()).toBe('会话在跑')
    expect(screen.getByRole('alert')).toHaveTextContent('1 条会话已移入回收站')
    expect(screen.getByRole('alert')).toHaveTextContent('1 条未能移入回收站：会话在跑')
    act(() => { vi.advanceTimersByTime(1600) })
    expect(m.shaking()).toBeNull()
    expect(pill()).toBeNull()
    act(() => { clearUndoNotice() })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('批量拖放全失败多原因 ⇒ 原因用 · 去重拼接进胶囊与失败提示', async () => {
    vi.useFakeTimers()
    registerHostRowInfo('a', { title: 'A', live: false })
    registerHostRowInfo('b', { title: 'B', live: false })
    enterSelection()
    togglePick({ sessionId: 'a', title: 'A' })
    togglePick({ sessionId: 'b', title: 'B' })
    const applyOutcomes = vi.fn(async () => remoteOk<ApplyOutcome[]>([
      { id: 'a', action: 'delete', ok: false, error: { code: 'live', message: '会话在跑' } },
      { id: 'b', action: 'delete', ok: false, error: { code: 'io', message: '目录被占用' } },
    ]))
    const m = mount({ applyOutcomes: applyOutcomes as never })
    fireEvent.dragStart(m.sessionRow, { dataTransfer: {} })
    fireEvent.dragOver(m.row, { dataTransfer: { dropEffect: '' } })
    drop(m.row, 'a')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getPicks()).toEqual([{ sessionId: 'a', title: 'A' }, { sessionId: 'b', title: 'B' }])
    expect(pillText()).toBe('会话在跑 · 目录被占用')
    expect(screen.getByRole('alert')).toHaveTextContent('会话在跑 · 目录被占用')
    act(() => { vi.advanceTimersByTime(1600) })
    expect(m.shaking()).toBeNull()
    expect(pill()).toBeNull()
  })
})

describe('拖到回收站入口 · 拒收动效（不是状态）', () => {
  it('drop live 源 ⇒ 抖动 + 原因胶囊 + 裸失败提示、不发写入；1.6s 自灭', () => {
    vi.useFakeTimers()
    registerHostRowInfo('run', { title: 'R', live: true })
    const m = mount({ sessionId: 'run' })
    fireEvent.dragStart(m.sessionRow, { dataTransfer: {} })
    fireEvent.dragOver(m.row, { dataTransfer: { dropEffect: '' } })
    drop(m.row, 'run')
    expect(m.applyOutcomes).not.toHaveBeenCalled()
    expect(m.shaking()).toBe('true')
    expect(pillText()).toBe('运行中的会话不能移入回收站')
    expect(screen.getByRole('alert')).toHaveTextContent('运行中的会话不能移入回收站')
    // 真实序：drop 后紧随源行的 dragend——状态回 idle，拒收尾巴（胶囊 + 抖动）再挂 1.6s。
    fireEvent.dragEnd(m.sessionRow, { dataTransfer: {} })
    expect(m.state()).toBe('idle')
    expect(m.shaking()).toBe('true')
    expect(pillText()).toBe('运行中的会话不能移入回收站')
    act(() => { vi.advanceTimersByTime(1600) })
    expect(m.shaking()).toBeNull()
    expect(pill()).toBeNull()
  })

  it('写入被拒（隐藏子会话在跑一类）⇒ 抖动 + 失败原文胶囊 + 失败提示，1.6s 后自灭', async () => {
    vi.useFakeTimers()
    registerHostRowInfo('a', { title: 'A', live: false })
    const m = mount({
      applyOutcomes: vi.fn(async () => remoteFail({ code: 'io', message: '组里有会话在跑' })) as never,
    })
    fireEvent.dragStart(m.sessionRow, { dataTransfer: {} })
    fireEvent.dragOver(m.row, { dataTransfer: { dropEffect: '' } })
    drop(m.row, 'a')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(m.shaking()).toBe('true')
    expect(pillText()).toBe('组里有会话在跑')
    expect(screen.getByRole('alert')).toHaveTextContent('组里有会话在跑')
    expect(m.state()).toBe('idle')
    // gate.busy 落地后的重渲染绝不取消 1.6s 自灭定时器。
    act(() => { vi.advanceTimersByTime(1600) })
    expect(m.shaking()).toBeNull()
    expect(pill()).toBeNull()
  })

  it('dragEnd 途中取消 ⇒ 全收，不留框不留胶囊', () => {
    registerHostRowInfo('a', { title: 'A', live: false })
    const m = mount()
    fireEvent.dragStart(m.sessionRow, { dataTransfer: {} })
    fireEvent.dragOver(m.row, { dataTransfer: { dropEffect: '' } })
    fireEvent.dragEnd(m.sessionRow, { dataTransfer: {} })
    expect(m.state()).toBe('idle')
    expect(pill()).toBeNull()
    expect(m.shaking()).toBeNull()
  })
})

describe('拖到回收站入口 · 误拖、边界与闸（回归）', () => {
  it('文字拖动与未登记会话行均不启动状态机、不亮框，且 idle 态 dragover 不拦截', () => {
    const m = mount()
    const text = document.createElement('div')
    document.body.append(text)
    fireEvent.dragStart(text, { dataTransfer: {} })
    expect(m.state()).toBe('idle')
    const ev1 = new Event('dragover', { bubbles: true, cancelable: true })
    m.row.dispatchEvent(ev1)
    expect(ev1.defaultPrevented).toBe(false)
    expect(m.state()).toBe('idle')
    text.remove()

    fireEvent.dragStart(m.ghostRow, { dataTransfer: {} })
    expect(m.state()).toBe('idle')
  })

  it('宿主 preventDefault 取消 dragstart 时不滞留 armed', () => {
    registerHostRowInfo('a', { title: 'A', live: false })
    const m = mount()
    const cancelHost = (e: Event): void => { e.preventDefault() }
    m.sessionRow.addEventListener('dragstart', cancelHost)
    fireEvent.dragStart(m.sessionRow, { dataTransfer: {} })
    expect(m.state()).toBe('idle')
    m.sessionRow.removeEventListener('dragstart', cancelHost)
  })

  it('over 态下子元素间与文档无关元素 dragleave 不把 over 弹回 armed', () => {
    registerHostRowInfo('a', { title: 'A', live: false })
    const m = mount()
    const other = document.createElement('div')
    document.body.append(other)
    fireEvent.dragStart(m.sessionRow, { dataTransfer: {} })
    fireEvent.dragOver(m.row, { dataTransfer: { dropEffect: '' } })
    expect(m.state()).toBe('over')

    act(() => {
      m.row.dispatchEvent(new MouseEvent('dragleave', { bubbles: true, relatedTarget: m.target }))
    })
    expect(m.state()).toBe('over')

    act(() => {
      other.dispatchEvent(new MouseEvent('dragleave', { bubbles: true, relatedTarget: null }))
    })
    expect(m.state()).toBe('over')
    other.remove()
  })

  it('未登记 payload ⇒ 不发任何写入', () => {
    registerHostRowInfo('a', { title: 'A', live: false })
    const m = mount()
    fireEvent.dragStart(m.sessionRow, { dataTransfer: {} })
    fireEvent.dragOver(m.row, { dataTransfer: { dropEffect: '' } })
    drop(m.row, '一段随手拖的文字')
    drop(m.row, null)
    drop(m.row, '')
    expect(m.applyOutcomes).not.toHaveBeenCalled()
  })

  it('点击图标透传宿主行点击（不拦冒泡）', () => {
    const onRowClick = vi.fn()
    const view = render(
      <div onClick={onRowClick}>
        <TrashPanelIcon deps={applyDeps(vi.fn() as never)} t={zhTranslate} />
      </div>,
    )
    fireEvent.click(view.container.querySelector('[data-dsh-session-delete="trash-drop"]') as Element)
    expect(onRowClick).toHaveBeenCalledTimes(1)
  })

  it('在飞时重复 drop 被闸挡回：只发一趟写入', () => {
    registerHostRowInfo('a', { title: 'A', live: false })
    let release: (() => void) | undefined
    const applyOutcomes = vi.fn(() => new Promise((resolve) => {
      release = () => { resolve(okDelete(['a'])) }
    }))
    const m = mount({ applyOutcomes: applyOutcomes as never })
    fireEvent.dragStart(m.sessionRow, { dataTransfer: {} })
    fireEvent.dragOver(m.row, { dataTransfer: { dropEffect: '' } })
    drop(m.row, 'a')
    drop(m.row, 'a')
    expect(applyOutcomes).toHaveBeenCalledTimes(1)
    release?.()
  })
})

describe('拖放视觉素材（layout.css 钉子）', () => {
  it('layout.css 状态规则族：data-dst-* 圈宿主行 + 吞入/抖动动效 + reduced-motion + 胶囊类', () => {
    const css = readFileSync(join(process.cwd(), 'src/client/ui/layout.css'), 'utf8')
    for (const needle of [
      "button:has([data-dsh-session-delete='trash-drop'][data-dst-state='armed'])",
      "button:has([data-dsh-session-delete='trash-drop'][data-dst-state='over'])",
      "button:has([data-dsh-session-delete='trash-drop'][data-dst-state='committing'])",
      "button:has([data-dsh-session-delete='trash-drop'][data-dst-shake='true'])",
      'sd-drop-swallow',
      '--dsw-alias-state-error-primary',
      '.sd-drop-pill',
      '--dsw-alias-label-on-color',
    ]) expect(css).toContain(needle)
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*button:has\(\[data-dsh-session-delete='trash-drop'\]\[data-dst-shake='true'\]\)/)
  })

  it('文案 drop.release / drop.deleting 在位（zh）', () => {
    expect(zhTranslate('drop.release')).toBe('松手移入回收站')
    expect(zhTranslate('drop.deleting')).toBe('正在移入回收站…')
  })
})
