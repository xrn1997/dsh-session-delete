/**
 * 组语义（ADR-0001）：**接得住孩子的只有组根**。
 *
 * 这一份是那条判据唯一的测试落点。此前它写在四个文件里（`api/dispatch.ts` 的行装配、
 * `verbs/batch.ts`（当时叫 `apply.ts`）、`verbs/restore-session.ts`、`verbs/purge-trash.ts`），其中一处不认根行 ⇒
 * 嵌套组上「彻底删除」会连带删掉不属于这一组的孙代（不可恢复）。
 */
import { describe, expect, it } from 'vitest'
import type { TrashEntry } from '../src/trash/entry.js'
import { claimOf, groupOf, visibleGroups } from '../src/trash/groups.js'
import { trashEntry } from './support/world.js'

const row = (id: string, parentEntryId?: string): TrashEntry =>
  trashEntry(id, { title: id, sizeBytes: 10, ...(parentEntryId === undefined ? {} : { parentEntryId }) })

const ids = (rows: readonly TrashEntry[]): string[] => rows.map((entry) => entry.id)

describe('清单露面的一行 = 组根', () => {
  it('父 + 两个孩子 ⇒ 只露父那一行，孩子折进它的 kids', () => {
    const groups = visibleGroups([row('p'), row('k1', 'p'), row('k2', 'p')])
    expect(groups.map((group) => group.root.id)).toEqual(['p'])
    expect(ids(groups[0]!.kids)).toEqual(['k1', 'k2'])
  })

  it('父行不在 ⇒ 孩子自己占一行（既看不见也清不掉的那个问题）', () => {
    const groups = visibleGroups([row('k', 'ghost')])
    expect(groups.map((group) => group.root.id)).toEqual(['k'])
    expect(groups[0]!.kids).toEqual([])
  })

  it('父自己也是孩子 ⇒ 那一行也接不住孩子，孙代自己露面（否则字节会被数两遍）', () => {
    const groups = visibleGroups([row('top'), row('mid', 'top'), row('leaf', 'mid')])
    expect(groups.map((group) => group.root.id)).toEqual(['top', 'leaf'])
    expect(ids(groups[0]!.kids)).toEqual(['mid'])
    expect(groups[1]!.kids).toEqual([])
  })

  it('顺序跟清册一致，不重排', () => {
    const groups = visibleGroups([row('b', 'a'), row('a'), row('c')])
    expect(groups.map((group) => group.root.id)).toEqual(['a', 'c'])
  })
})

describe('一条 id 所属的整组', () => {
  const rows = [row('p'), row('k1', 'p'), row('k2', 'p'), row('solo')]

  it('组根 ⇒ 它自己 + 它接住的孩子', () => {
    expect(ids(groupOf(rows, 'p'))).toEqual(['p', 'k1', 'k2'])
  })

  it('孩子 ⇒ 只回它自己（清单不单独列它，只有手工/降级路径点得到）', () => {
    expect(ids(groupOf(rows, 'k1'))).toEqual(['k1'])
  })

  it('清册里没有这条 id、但还有孩子指向它 ⇒ 那一批孩子', () => {
    expect(ids(groupOf([row('k', 'ghost')], 'ghost'))).toEqual(['k'])
  })

  it('什么都没有 ⇒ 空数组（调用方据此报 trash-empty，不粉饰成幂等成功）', () => {
    expect(groupOf(rows, 'nope')).toEqual([])
  })

  it('嵌套组：父自己也是孩子时，它的整组只有它自己', () => {
    const nested = [row('top'), row('mid', 'top'), row('leaf', 'mid')]
    expect(ids(groupOf(nested, 'mid'))).toEqual(['mid'])
  })
})

describe('claimOf 三态', () => {
  const original = [row('p'), row('k', 'p')]

  it('原始快照认不出 ⇒ absent（没有组可带）', () => {
    expect(claimOf(original, [], 'ghost')).toEqual({ verdict: 'absent' })
  })

  it('原始快照有、当前视图空了 ⇒ carried（父与孩子同一口径）', () => {
    expect(claimOf(original, [], 'p')).toEqual({ verdict: 'carried' })
    expect(claimOf(original, [], 'k')).toEqual({ verdict: 'carried' })
  })

  it('当前视图还在 ⇒ fresh + 当前这一组', () => {
    const claim = claimOf(original, original, 'p')
    expect(claim.verdict).toBe('fresh')
    if (claim.verdict !== 'fresh') return
    expect(ids(claim.group)).toEqual(['p', 'k'])
  })
})
