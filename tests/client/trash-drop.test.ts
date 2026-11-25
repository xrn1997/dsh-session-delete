// 拖放判定（2026-11-25）：投放 payload → 四支计划。判据只读默认场景的自由函数
// （host-rows 登记表 + 批量选中集），不引 React、不碰 DOM。
import { beforeEach, describe, expect, it } from 'vitest'
import { resolveDropPlan } from '../../src/client/trash-drop.js'
import { registerHostRowInfo } from '../../src/client/host-rows.js'
import { enterSelection, togglePick } from '../../src/client/batch-selection-store.js'

describe('resolveDropPlan', () => {
  beforeEach(() => {
    registerHostRowInfo('a', { title: 'A', live: false })
    registerHostRowInfo('b', { title: 'B', live: false })
    registerHostRowInfo('run', { title: 'R', live: true })
  })

  it('空 payload ⇒ ignore', () => {
    expect(resolveDropPlan(null)).toEqual({ kind: 'ignore' })
    expect(resolveDropPlan('')).toEqual({ kind: 'ignore' })
  })

  it('未登记 id（随手拖的文字）⇒ ignore：任何文本拖放都不许变成删除', () => {
    expect(resolveDropPlan('一段随手拖的文字')).toEqual({ kind: 'ignore' })
  })

  it('登记但运行中 ⇒ refuse-live', () => {
    expect(resolveDropPlan('run')).toEqual({ kind: 'refuse-live' })
  })

  it('普通单条 ⇒ single（title 取登记表）', () => {
    expect(resolveDropPlan('a')).toEqual({ kind: 'single', item: { sessionId: 'a', title: 'A' } })
  })

  it('多选态且拖的行在勾选集里 ⇒ batch（一拖删整集）', () => {
    enterSelection()
    togglePick({ sessionId: 'a', title: 'A' })
    togglePick({ sessionId: 'b', title: 'B' })
    expect(resolveDropPlan('a')).toEqual({
      kind: 'batch',
      items: [{ sessionId: 'a', title: 'A' }, { sessionId: 'b', title: 'B' }],
    })
  })

  it('多选态但拖的行不在勾选集里 ⇒ single', () => {
    enterSelection()
    togglePick({ sessionId: 'b', title: 'B' })
    expect(resolveDropPlan('a')).toEqual({ kind: 'single', item: { sessionId: 'a', title: 'A' } })
  })
})
