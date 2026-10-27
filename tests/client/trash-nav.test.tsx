/**
 * 清单导航（`trash-nav.ts` 的 `useTrashNav`）的 interface——此前劈在面板与控制器两处的那份键盘契约。
 *
 * 这一份直接测 hook，不经过面板：它只认"屏幕上从上到下的行"（`ordered`，只含展开的组）与调用方注入的
 * 四个动作（`select` / `toggleCheck` / `exitDrill` / `focusRow`），不查自己的行、不认行选择器
 * （Esc 让路时会问 `ui/top-layer.ts` 有没有打开的浮层）。断言落在真实调用上（收到哪一条、带不带
 * `{drill:true}`、调了几次），不碰内部 state——它唯一的 state 是一笔"下钻退出后要交还焦点给哪一行"的账。
 *
 * 覆盖的五条判据（与面板里原来的函数体逐字对齐）：
 * - 方向键走环：末尾 ↓ 回第一条、未选中时 ↑ 落到最后一条、开头 ↑ 回末尾；
 * - 移动选中时顺手把 DOM 焦点交给那一行（行是 `<div>`，不靠浏览器默认行为）；
 * - Enter / Space：多选态说的是"勾上/取消这一条"，普通态是下钻；
 * - tab 落点（roving tabindex）永远有一行拿着：选中那行不在 DOM 时落到第一条可见行；
 * - Esc 只在下钻期间生效（顶层有 dialog/menu 时让路），退出一次、焦点交还一次，再按不重复交还。
 */
import { act, renderHook } from '@testing-library/react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { TrashEntryLike } from '../../src/client/remote.js'
import { useTrashNav, type TrashNavInput } from '../../src/client/trash-nav.js'
import { trashRow } from './support/outcomes.js'

const A = trashRow('a', 'session-a')
const B = trashRow('b', 'session-b')
const C = trashRow('c', 'session-c')

function harness() {
  const select = vi.fn(async (_entry: TrashEntryLike, _options?: { drill?: boolean }): Promise<void> => {})
  const toggleCheck = vi.fn()
  const exitDrill = vi.fn()
  const focusRow = vi.fn()
  const input = (over: Partial<TrashNavInput> = {}): TrashNavInput => ({
    ordered: [A, B, C],
    selectedId: null,
    selectMode: false,
    drillEnabled: true,
    drilled: false,
    select,
    toggleCheck,
    exitDrill,
    focusRow,
    ...over,
  })
  const mount = (over: Partial<TrashNavInput> = {}) =>
    renderHook((props: TrashNavInput) => useTrashNav(props), { initialProps: input(over) })
  return { select, toggleCheck, exitDrill, focusRow, input, mount }
}

/** 键盘事件只被读 `key` / `target` / `currentTarget` 与 `preventDefault`：直接给这一份窄面，
 *  不让用例背一个合成事件的构造。`target` 缺省时按清单自己的事件处理。 */
function keyDown(
  key: string,
  target?: HTMLElement | null,
): { event: ReactKeyboardEvent<HTMLElement>; prevented: () => boolean } {
  const preventDefault = vi.fn()
  return {
    event: {
      key,
      preventDefault,
      target: target ?? undefined,
      currentTarget: document.createElement('div'),
    } as unknown as ReactKeyboardEvent<HTMLElement>,
    prevented: () => preventDefault.mock.calls.length > 0,
  }
}

describe('清单导航 · 方向键走环', () => {
  it('ArrowDown 移到下一条并交还 DOM 焦点；末尾回卷到第一条', () => {
    const h = harness()
    const m = h.mount({ selectedId: 'a' })

    const second = keyDown('ArrowDown')
    act(() => { m.result.current.onListKeyDown(second.event) })
    expect(h.select).toHaveBeenCalledTimes(1)
    expect(h.select).toHaveBeenCalledWith(B)
    // 方向键只移动选中，不下钻（`{drill:true}` 归 Enter / 点行）
    expect(h.select.mock.calls[0]![1]).toBeUndefined()
    expect(h.focusRow).toHaveBeenCalledWith('b')
    expect(second.prevented()).toBe(true)

    // 选中跟着调用方落地（hook 不自己存选中）
    m.rerender(h.input({ selectedId: 'b' }))
    act(() => { m.result.current.onListKeyDown(keyDown('ArrowDown').event) })
    expect(h.select).toHaveBeenLastCalledWith(C)

    m.rerender(h.input({ selectedId: 'c' }))
    act(() => { m.result.current.onListKeyDown(keyDown('ArrowDown').event) })
    expect(h.select).toHaveBeenLastCalledWith(A)
  })

  it('ArrowUp 在未选中时落到最后一条；开头回卷到末尾', () => {
    const h = harness()
    const m = h.mount({ selectedId: null })

    act(() => { m.result.current.onListKeyDown(keyDown('ArrowUp').event) })
    expect(h.select).toHaveBeenLastCalledWith(C)

    m.rerender(h.input({ selectedId: 'a' }))
    act(() => { m.result.current.onListKeyDown(keyDown('ArrowUp').event) })
    expect(h.select).toHaveBeenLastCalledWith(C)

    // 未选中时 ↓ 落第一条，不是跳过它（与面板原有的标准语义一致）
    m.rerender(h.input({ selectedId: null }))
    act(() => { m.result.current.onListKeyDown(keyDown('ArrowDown').event) })
    expect(h.select).toHaveBeenLastCalledWith(A)
  })

  it('清单为空时方向键什么都不做（不 select、不抢焦点）', () => {
    const h = harness()
    const m = h.mount({ ordered: [] })

    act(() => { m.result.current.onListKeyDown(keyDown('ArrowDown').event) })
    expect(h.select).not.toHaveBeenCalled()
    expect(h.focusRow).not.toHaveBeenCalled()
  })
})

describe('清单导航 · Enter / Space', () => {
  it('Enter / Space 在多选态勾选，在普通态下钻', () => {
    const h = harness()

    const multi = h.mount({ selectedId: 'b', selectMode: true })
    act(() => { multi.result.current.onListKeyDown(keyDown('Enter').event) })
    act(() => { multi.result.current.onListKeyDown(keyDown(' ').event) })
    expect(h.toggleCheck).toHaveBeenNthCalledWith(1, 'b')
    expect(h.toggleCheck).toHaveBeenNthCalledWith(2, 'b')
    expect(h.select).not.toHaveBeenCalled()

    const plain = h.mount({ selectedId: 'b' })
    act(() => { plain.result.current.onListKeyDown(keyDown('Enter').event) })
    expect(h.select).toHaveBeenLastCalledWith(B, { drill: true })
    act(() => { plain.result.current.onListKeyDown(keyDown(' ').event) })
    expect(h.select).toHaveBeenLastCalledWith(B, { drill: true })
    expect(h.select).toHaveBeenCalledTimes(2)
    expect(h.toggleCheck).toHaveBeenCalledTimes(2)
  })

  it('未选中任何行时 Enter / Space 落在拿 tab 落点的第一条，不是一声不响', () => {
    const h = harness()
    const m = h.mount({ selectedId: null })

    act(() => { m.result.current.onListKeyDown(keyDown('Enter').event) })
    expect(h.select).toHaveBeenLastCalledWith(A, { drill: true })
    act(() => { m.result.current.onListKeyDown(keyDown(' ').event) })
    expect(h.select).toHaveBeenLastCalledWith(A, { drill: true })
    expect(h.select).toHaveBeenCalledTimes(2)
    expect(h.toggleCheck).not.toHaveBeenCalled()
  })

  it('选中行被折叠（不在 ordered 里）时 Enter / Space 落在第一条可见行', () => {
    const h = harness()
    const m = h.mount({ selectedId: 'b', ordered: [A, C] })

    // 这一拍 `aria-activedescendant` 为 null，第一条可见行拿 tab 落点。
    expect(m.result.current.activeDescendantId).toBeNull()
    expect(m.result.current.tabStopId).toBe('a')

    act(() => { m.result.current.onListKeyDown(keyDown('Enter').event) })
    expect(h.select).toHaveBeenLastCalledWith(A, { drill: true })
  })

  it('宽档（drillEnabled:false）Enter / Space 只选中，不下钻', () => {
    const h = harness()
    const m = h.mount({ selectedId: 'b', drillEnabled: false })

    act(() => { m.result.current.onListKeyDown(keyDown('Enter').event) })
    expect(h.select).toHaveBeenLastCalledWith(B)

    act(() => { m.result.current.onListKeyDown(keyDown(' ').event) })
    expect(h.select).toHaveBeenLastCalledWith(B)
    expect(h.select).toHaveBeenCalledTimes(2)
  })

  it('行内按钮 / 勾选框的 Enter / Space 归它们自己：清单不截键、不动作', () => {
    const h = harness()
    const m = h.mount({ selectedId: 'b' })
    const button = document.createElement('button')
    const event = keyDown('Enter', button)

    act(() => { m.result.current.onListKeyDown(event.event) })
    expect(event.prevented()).toBe(false)
    expect(h.select).not.toHaveBeenCalled()
    expect(h.toggleCheck).not.toHaveBeenCalled()

    // 事件从行（role=option）本身起来时仍归清单。
    const row = document.createElement('div')
    row.setAttribute('role', 'option')
    act(() => { m.result.current.onListKeyDown(keyDown('Enter', row).event) })
    expect(h.select).toHaveBeenLastCalledWith(B, { drill: true })
  })
})

describe('清单导航 · tab 落点', () => {
  it('tab 落点：选中行可见就用它，被折叠时落到第一条可见行', () => {
    const h = harness()
    const m = h.mount({ selectedId: 'b' })
    expect(m.result.current.activeDescendantId).toBe('b')
    expect(m.result.current.tabStopId).toBe('b')

    // 选中的那一行被折叠起来（不在 `ordered` 里）：`aria-activedescendant` 不许指一个不在 DOM 的 id
    m.rerender(h.input({ selectedId: 'b', ordered: [A, C] }))
    expect(m.result.current.activeDescendantId).toBeNull()
    expect(m.result.current.tabStopId).toBe('a')

    // 一次没点过（没有选中）：落点仍然是清单里唯一的那个 tab 巢
    m.rerender(h.input({ selectedId: null, ordered: [A, C] }))
    expect(m.result.current.activeDescendantId).toBeNull()
    expect(m.result.current.tabStopId).toBe('a')

    // 清单空：没有落点也没有 active descendant
    m.rerender(h.input({ selectedId: null, ordered: [] }))
    expect(m.result.current.activeDescendantId).toBeNull()
    expect(m.result.current.tabStopId).toBeNull()
  })
})

describe('清单导航 · Esc 交还焦点', () => {
  it('Esc 只在下钻期间生效：退出一次、焦点交还一次；再按不重复交还', () => {
    const h = harness()
    const m = h.mount({ selectedId: 'b', drilled: false })

    // 没下钻：Esc 不是给清单的（退出下钻、动焦点都不该发生）
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(h.exitDrill).not.toHaveBeenCalled()
    expect(h.focusRow).not.toHaveBeenCalled()

    // 下钻期间：Esc 退出，选中那一行记在账上——等 `drilled` 落地再交还
    m.rerender(h.input({ selectedId: 'b', drilled: true }))
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(h.exitDrill).toHaveBeenCalledTimes(1)
    expect(h.focusRow).not.toHaveBeenCalled()

    m.rerender(h.input({ selectedId: 'b', drilled: false }))
    expect(h.focusRow).toHaveBeenCalledTimes(1)
    expect(h.focusRow).toHaveBeenCalledWith('b')

    // 交完就清账：后续重渲染 / 再按 Esc 都不重复抢焦点
    m.rerender(h.input({ selectedId: 'b', drilled: false }))
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(h.focusRow).toHaveBeenCalledTimes(1)
    expect(h.exitDrill).toHaveBeenCalledTimes(1)
  })

  it('非 Esc 的键不进这条路径（下钻期间按别的键既不休假也不交还焦点）', () => {
    const h = harness()
    h.mount({ selectedId: 'b', drilled: true })

    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })) })
    expect(h.exitDrill).not.toHaveBeenCalled()
    expect(h.focusRow).not.toHaveBeenCalled()
  })

  it('宽档即使残留 drilled，Esc 也不归清单', () => {
    const h = harness()
    h.mount({ selectedId: 'b', drilled: true, drillEnabled: false })

    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(h.exitDrill).not.toHaveBeenCalled()
    expect(h.focusRow).not.toHaveBeenCalled()
  })

  it.each([
    ['模态对话框', { role: 'dialog', 'aria-modal': 'true' }],
    ['菜单', { role: 'menu' }],
  ] as const)('%s 让路：关掉后下一次 Esc 才退下钻', (_label, attrs) => {
    const h = harness()
    h.mount({ selectedId: 'b', drilled: true })
    const layer = document.createElement('div')
    for (const [key, value] of Object.entries(attrs)) layer.setAttribute(key, value)
    document.body.append(layer)
    try {
      act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
      expect(h.exitDrill).not.toHaveBeenCalled()
    } finally {
      layer.remove()
    }
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(h.exitDrill).toHaveBeenCalledTimes(1)
  })

  it('已经被前面的处理器 preventDefault 的 Esc 不再退出下钻', () => {
    const h = harness()
    h.mount({ selectedId: 'b', drilled: true })
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    event.preventDefault()
    act(() => { document.dispatchEvent(event) })
    expect(h.exitDrill).not.toHaveBeenCalled()
  })
})
