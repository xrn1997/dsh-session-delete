/**
 * 组语义（ADR-0001）：**接得住孩子的只有组根**。
 *
 * 这一份是那条判据唯一的测试落点。此前它写在四个文件里（`api/dispatch.ts` 的行装配、
 * `verbs/batch.ts`（当时叫 `apply.ts`）、`verbs/restore-session.ts` 与当时的 purge 动词 glue
 * （现由 `src/verbs/trash-scope.ts` 吸收）），其中一处不认根行 ⇒
 * 嵌套组上「彻底删除」会连带删掉不属于这一组的孙代（不可恢复）。
 */
import { describe, expect, it } from 'vitest'
import type { TrashEntry } from '../src/trash/entry.js'
import { claimOf, groupOf, visibleGroups, withoutGroup } from '../src/trash/groups.js'
import { trashEntry } from './support/world.js'
import { pick } from './support/fixture.js'

const row = (id: string, parentEntryId?: string): TrashEntry =>
  trashEntry(id, { title: id, sizeBytes: 10, ...(parentEntryId === undefined ? {} : { parentEntryId }) })

const ids = (rows: readonly TrashEntry[]): string[] => rows.map((entry) => entry.id)

describe('清单露面的一行 = 组根', () => {
  it('父 + 两个孩子 ⇒ 只露父那一行，孩子折进它的 kids', () => {
    const groups = visibleGroups([row('p'), row('k1', 'p'), row('k2', 'p')])
    expect(groups.map((group) => group.root.id)).toEqual(['p'])
    expect(ids(pick(groups, 0).kids)).toEqual(['k1', 'k2'])
  })

  it('父行不在 ⇒ 孩子自己占一行（既看不见也清不掉的那个问题）', () => {
    const groups = visibleGroups([row('k', 'ghost')])
    expect(groups.map((group) => group.root.id)).toEqual(['k'])
    expect(pick(groups, 0).kids).toEqual([])
  })

  it('父自己也是孩子 ⇒ 那一行也接不住孩子，孙代自己露面（否则字节会被数两遍）', () => {
    const groups = visibleGroups([row('top'), row('mid', 'top'), row('leaf', 'mid')])
    expect(groups.map((group) => group.root.id)).toEqual(['top', 'leaf'])
    expect(ids(pick(groups, 0).kids)).toEqual(['mid'])
    expect(pick(groups, 1).kids).toEqual([])
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

describe('按组收缩（restore 与 purge 共用这一条判据，两边各存自己的视图）', () => {
  const rows = [row('p'), row('k1', 'p'), row('k2', 'p'), row('solo')]

  it('组根 ⇒ 整组移出，其余行保持清册原序', () => {
    expect(ids(withoutGroup(rows, 'p'))).toEqual(['solo'])
  })

  it('孩子 ⇒ 只摘它自己，不动兄弟与父（组语义与 groupOf 同一条口径）', () => {
    expect(ids(withoutGroup(rows, 'k1'))).toEqual(['p', 'k2', 'solo'])
  })

  it('嵌套组：收缩 `mid` 不许把孙代 `leaf` 一起带走（当年不可恢复的那条）', () => {
    const nested = [row('top'), row('mid', 'top'), row('leaf', 'mid')]
    expect(ids(withoutGroup(nested, 'mid'))).toEqual(['top', 'leaf'])
  })

  it('父行已被别的路径摘掉 ⇒ 跟着收掉指向它的那批孩子', () => {
    const orphanedKids = [row('k1', 'p'), row('k2', 'p'), row('solo')]
    expect(ids(withoutGroup(orphanedKids, 'p'))).toEqual(['solo'])
  })

  it('清册里没有这条 id ⇒ 视图一条不少（调用方据此分 absent，不静默当成幂等成功）', () => {
    expect(ids(withoutGroup(rows, 'nope'))).toEqual(['p', 'k1', 'k2', 'solo'])
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
