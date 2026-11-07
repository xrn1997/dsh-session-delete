// 回收站清单的分组：组内按删除时间倒序、组间按最新一条倒序；「未分组」永远沉底。
import { describe, expect, it } from 'vitest'
import { zhTranslate } from '../../src/client/copy.js'
import { UNGROUPED_PROJECT_DIR, groupByProject } from '../../src/client/trash-view.js'
import type { TrashEntryLike } from '../../src/client/remote.js'

function row(id: string, projectDir: string, deletedAt: number, over: Partial<TrashEntryLike> = {}): TrashEntryLike {
  return {
    id,
    sessionId: `session-${id}`,
    projectDir,
    workspaceId: 'ws',
    wasArchived: false,
    deletedAt,
    title: id,
    sizeBytes: 1,
    releaseBytes: 1,
    ...over,
  }
}

describe('groupByProject', () => {
  it('组内按删除时间倒序，组间按各组最新一条倒序', () => {
    const groups = groupByProject([
      row('a1', '--A--', 100),
      row('b1', '--B--', 300),
      row('a2', '--A--', 200),
    ], zhTranslate)

    expect(groups.map((group) => group.projectDir)).toEqual(['--B--', '--A--'])
    expect(groups.map((group) => group.title)).toEqual(['--B--', '--A--'])
    expect(groups.some((group) => group.ungrouped)).toBe(false)
    expect(groups.map((group) => group.latest)).toEqual([300, 200])
    expect(groups[1]?.entries.map((entry) => entry.id)).toEqual(['a2', 'a1'])
  })

  it('workspaceMissing 的条目合并进「未分组」，即使它是全局最新也沉底', () => {
    const groups = groupByProject([
      row('a', '--A--', 100),
      row('gone-new', '--C--', 900, { workspaceMissing: true }),
      row('gone-old', '--D--', 50, { workspaceMissing: true }),
    ], zhTranslate)

    expect(groups.map((group) => group.projectDir)).toEqual(['--A--', UNGROUPED_PROJECT_DIR])
    const ungrouped = groups[1]
    expect(ungrouped?.label).toBe('未分组')
    expect(ungrouped?.title).toBe('未分组')
    expect(ungrouped?.ungrouped).toBe(true)
    expect(groups[0]?.ungrouped).toBe(false)
    expect(ungrouped?.entries.map((entry) => entry.id)).toEqual(['gone-new', 'gone-old'])
  })

  it('空 cwd 仍是「未记录项目」组，不与「未分组」撞键', () => {
    const groups = groupByProject([
      row('empty', '', 300),
      row('gone', '--C--', 100, { workspaceMissing: true }),
    ], zhTranslate)

    expect(groups.map((group) => group.projectDir)).toEqual(['', UNGROUPED_PROJECT_DIR])
    expect(groups[0]?.label).toBe('未记录项目')
    expect(groups[1]?.label).toBe('未分组')
  })
})
