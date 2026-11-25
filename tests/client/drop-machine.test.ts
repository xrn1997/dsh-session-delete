// 拖放状态机（`docs/ui-spec.md` §1、`ADR-0071`）：
// 4 态 × sourceOk 正交维度；拒收是动效（shake）不是状态。纯模块零 DOM。
import { describe, expect, it } from 'vitest'
import { createDropTargetMachine } from '../../src/client/drop-machine.js'

describe('drop-machine · 正常链', () => {
  it('dragStart→dragEnter→dropOk→settled 回 idle', () => {
    const m = createDropTargetMachine()
    expect(m.view().state).toBe('idle')
    m.send('dragStart')
    expect(m.view().state).toBe('armed')
    m.send('dragEnter')
    expect(m.view().state).toBe('over')
    m.send('dropOk')
    expect(m.view().state).toBe('committing')
    m.send('settled')
    expect(m.view().state).toBe('idle')
    expect(m.view().shake).toBe(false)
  })

  it('dragStart 的 ok 决定 sourceOk；其余事件不动它', () => {
    const m = createDropTargetMachine()
    m.send('dragStart', { ok: false })
    expect(m.view().sourceOk).toBe(false)
    m.send('dragEnter')
    expect(m.view().sourceOk).toBe(false)
    m.send('dragStart', { ok: true })
    expect(m.view().sourceOk).toBe(true)
    m.send('dragEnter')
    expect(m.view().sourceOk).toBe(true)
  })

  it('dragLeave 回 armed；dragEnd 从 armed/over 都回 idle', () => {
    const m = createDropTargetMachine()
    m.send('dragStart')
    m.send('dragEnter')
    m.send('dragLeave')
    expect(m.view().state).toBe('armed')
    m.send('dragEnd')
    expect(m.view().state).toBe('idle')
    m.send('dragStart')
    m.send('dragEnd')
    expect(m.view().state).toBe('idle')
  })
})

describe('drop-machine · 拒收动效（不是状态）', () => {
  it('dropBlocked 不改驻留态：留在 over 且 shake=true 带原因', () => {
    const m = createDropTargetMachine()
    m.send('dragStart', { ok: false })
    m.send('dragEnter')
    m.send('dropBlocked', { text: '运行中的会话不能删除' })
    expect(m.view().state).toBe('over')
    expect(m.view().shake).toBe(true)
    expect(m.view().shakeText).toBe('运行中的会话不能删除')
  })

  it('writeRejected 回 idle 且 shake=true 带原因', () => {
    const m = createDropTargetMachine()
    m.send('dragStart')
    m.send('dragEnter')
    m.send('dropOk')
    m.send('writeRejected', { text: '组里有会话在跑' })
    expect(m.view().state).toBe('idle')
    expect(m.view().shake).toBe(true)
    expect(m.view().shakeText).toBe('组里有会话在跑')
  })

  it('shakeEnd 清抖动；shake 期间状态照常可转', () => {
    const m = createDropTargetMachine()
    m.send('dragStart', { ok: false })
    m.send('dragEnter')
    m.send('dropBlocked', { text: 'x' })
    m.send('dragEnd')
    expect(m.view().state).toBe('idle')
    expect(m.view().shake).toBe(true)
    m.send('shakeEnd')
    expect(m.view().shake).toBe(false)
    expect(m.view().shakeText).toBe('')
  })
})

describe('drop-machine · 边界', () => {
  it('非法转移返回 false 且状态不变', () => {
    const m = createDropTargetMachine()
    expect(m.send('dropOk')).toBe(false)
    expect(m.view().state).toBe('idle')
    m.send('dragStart')
    expect(m.send('settled')).toBe(false)
    expect(m.view().state).toBe('armed')
  })

  it('committing 态收到非法 dragStart 不得篡改 sourceOk 与 shake', () => {
    const m = createDropTargetMachine()
    m.send('dragStart', { ok: true })
    m.send('dragEnter')
    m.send('dropOk')
    expect(m.send('dragStart', { ok: false })).toBe(false)
    expect(m.view()).toEqual({ state: 'committing', sourceOk: true, shake: false, shakeText: '' })
  })

  it('未处于 shake 时发送 shakeEnd 返回 false', () => {
    const m = createDropTargetMachine()
    expect(m.send('shakeEnd')).toBe(false)
  })

  it('armed / over 态漏收 dragEnd 时，新 dragStart 可自愈重置为 armed 并更新 sourceOk', () => {
    const m = createDropTargetMachine()
    m.send('dragStart', { ok: true })
    expect(m.send('dragStart', { ok: false })).toBe(true)
    expect(m.view()).toEqual({ state: 'armed', sourceOk: false, shake: false, shakeText: '' })
    m.send('dragEnter')
    expect(m.send('dragStart', { ok: true })).toBe(true)
    expect(m.view()).toEqual({ state: 'armed', sourceOk: true, shake: false, shakeText: '' })
  })
})
