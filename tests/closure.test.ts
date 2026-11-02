/**
 * 会话闭包（session closure）的口径用例：bare 形状归一、传递闭包、首见去重、无主根成组。
 *
 * 这份是那套口径的**唯一**一份判据：端口的 `subagentMembersOf`（逐层问宿主要孩子）与
 * `orphanGroupsOf`（整表语料成组）都是这里的接线，行为不再各写一遍注释担保。
 */
import { describe, expect, it } from 'vitest'
import {
  bareSessionId,
  closureOf,
  firstByBare,
  orphanRootsOf,
  sessionIdShapes,
  type ClosureNode,
} from '../src/domain/closure.js'
import { pick } from './support/fixture.js'

/** 语料里的一条：闭包只认 `sessionId`，成组还要看父与 subagent 标记（与 SessionIdentity 同形）。 */
interface CorpusNode extends ClosureNode {
  readonly parentSessionId?: string
  readonly subagent: boolean
}

const n = (sessionId: string, over: Partial<CorpusNode> = {}): CorpusNode => ({
  sessionId, projectDir: '--p--', subagent: true, ...over,
})

/** 造一张 parent(bare) 到 children 的索引：键一律是去前缀后的写法（生产里逐层问宿主交回的就是这张表）。 */
function indexOf(children: Record<string, CorpusNode[]>): Map<string, CorpusNode[]> {
  return new Map(Object.entries(children))
}

describe('bareSessionId：形状归一', () => {
  it('session-x 与 x 归到同一个键', () => {
    expect(bareSessionId('session-x')).toBe('x')
    expect(bareSessionId('x')).toBe('x')
  })
})

describe('sessionIdShapes：一个 id 的全部写法', () => {
  it('原写法在前，两代写法各回两种（不重不漏）', () => {
    expect(sessionIdShapes('session-x')).toEqual(['session-x', 'x'])
    expect(sessionIdShapes('x')).toEqual(['x', 'session-x'])
  })
})

describe('closureOf：parent(bare) 到 children 索引上的传递闭包', () => {
  it('深孙代全收、深度不设上限，根自己不算在内', () => {
    const children = indexOf({
      root: [n('session-kid')],
      kid: [n('session-grand')],
      grand: [n('session-great')],
    })
    const out = closureOf(children, 'session-root')
    expect(out.map((node) => node.sessionId)).toEqual(['session-kid', 'session-grand', 'session-great'])
  })

  it('根与索引键两边写法不同也对得上（内部按 bare 比）', () => {
    const children = indexOf({ root: [n('kid')] })
    expect(closureOf(children, 'session-root').map((node) => node.sessionId)).toEqual(['kid'])
  })

  it('环不无限循环：回头路按首见去重掐掉', () => {
    const children = indexOf({
      root: [n('session-kid')],
      kid: [n('session-root'), n('session-b')],
    })
    expect(closureOf(children, 'session-root').map((node) => node.sessionId).sort())
      .toEqual(['session-b', 'session-kid'])
  })

  it('同一条记录的两代写法混在树里只收首见', () => {
    const children = indexOf({ root: [n('session-x'), n('x')] })
    const out = closureOf(children, 'session-root')
    expect(out.map((node) => node.sessionId)).toEqual(['session-x'])
  })
})

describe('firstByBare：两代写法只认第一次出现', () => {
  it('留首见、保原序', () => {
    const out = firstByBare([
      n('session-x'), n('session-y'), n('x'), n('y', { projectDir: '--q--' }),
    ])
    expect(out.map((node) => node.sessionId)).toEqual(['session-x', 'session-y'])
  })
})

describe('orphanRootsOf：父既不在 known 也不在回收站的根闭包组', () => {
  it('已知父不成组（known 里带不带前缀都是同一件事）', () => {
    const corpus = [n('session-root', { parentSessionId: 'gone' })]
    expect(orphanRootsOf(corpus, ['session-gone'])).toEqual([])
    expect(orphanRootsOf(corpus, ['gone'])).toEqual([])
  })

  it('根按传递闭包收全部后代；组序与成员序按语料原序', () => {
    const corpus = [
      n('session-root', { parentSessionId: 'session-gone' }),
      n('session-kid', { parentSessionId: 'session-root', subagent: false }),
      n('session-g1', { parentSessionId: 'session-kid', subagent: false }),
      n('session-trashed-kid', { parentSessionId: 'session-trashed' }),
    ]
    const groups = orphanRootsOf(corpus, ['session-trashed'])
    expect(groups).toHaveLength(1)
    expect(pick(groups, 0).root.sessionId).toBe('session-root')
    expect(pick(groups, 0).parentSessionId).toBe('session-gone')
    expect(pick(groups, 0).members.map((member) => member.sessionId))
      .toEqual(['session-root', 'session-kid', 'session-g1'])
  })

  it('claimed 防环：环上一条只归首见的那组，不挂死', () => {
    const corpus = [
      n('session-a', { parentSessionId: 'session-b' }),
      n('session-b', { parentSessionId: 'session-a' }),
    ]
    const groups = orphanRootsOf(corpus, [])
    expect(groups).toHaveLength(1)
    expect(pick(groups, 0).root.sessionId).toBe('session-a')
    expect(pick(groups, 0).members.map((member) => member.sessionId)).toEqual(['session-a', 'session-b'])
  })

  it('已被前面组收走的成员即使自己父未知也不再成组', () => {
    const corpus = [
      n('session-a', { parentSessionId: 'gone-0' }),
      n('gone-x', { parentSessionId: 'session-a' }),
      n('session-b', { parentSessionId: 'gone-x' }),
    ]
    const groups = orphanRootsOf(corpus, [])
    expect(groups).toHaveLength(1)
    expect(pick(groups, 0).members.map((member) => member.sessionId))
      .toEqual(['session-a', 'gone-x', 'session-b'])
  })

  it('没有父或不是 subagent 的不成组', () => {
    const corpus = [n('session-solo'), n('session-plain', { subagent: false })]
    expect(orphanRootsOf(corpus, [])).toEqual([])
  })
})
