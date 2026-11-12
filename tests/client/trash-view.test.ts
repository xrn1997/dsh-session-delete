// 回收站清单的分组：组内按删除时间倒序、组间按最新一条倒序；「未分组」永远沉底。
// 归档档同用这一层、换一套键（按 `updatedAt` 倒序、没有「未分组」）。
import { describe, expect, it } from 'vitest'
import { zhTranslate } from '../../src/client/copy.js'
import { UNGROUPED_PROJECT_DIR, groupByProject } from '../../src/client/trash-view.js'
import type { ArchiveRowWire } from '../../src/shared/wire.js'
import type { TrashEntryLike } from '../../src/client/remote.js'

/** 回收站档的分组键（删除时间 + workspaceMissing ⇒ 未分组）；归档档传自己的那套。 */
const trashKeys = {
  timeOf: (e: TrashEntryLike) => e.deletedAt,
  projectDirOf: (e: TrashEntryLike) => e.projectDir,
  ungroupedOf: (e: TrashEntryLike) => e.workspaceMissing === true,
}

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
    ], zhTranslate, trashKeys)

    expect(groups.map((group) => group.projectDir)).toEqual(['--B--', '--A--'])
    expect(groups.map((group) => group.title)).toEqual(['--B--', '--A--'])
    expect(groups.some((group) => group.ungrouped)).toBe(false)
    expect(groups.map((group) => group.latest)).toEqual([300, 200])
    expect(groups[1]?.rows.map((entry) => entry.id)).toEqual(['a2', 'a1'])
  })

  it('trash 键：workspaceMissing 仍归「未分组」并沉底，即使它是全局最新', () => {
    const groups = groupByProject([
      row('a', '--A--', 100),
      row('gone-new', '--C--', 900, { workspaceMissing: true }),
      row('gone-old', '--D--', 50, { workspaceMissing: true }),
    ], zhTranslate, trashKeys)

    expect(groups.map((group) => group.projectDir)).toEqual(['--A--', UNGROUPED_PROJECT_DIR])
    const ungrouped = groups[1]
    expect(ungrouped?.label).toBe('未分组')
    expect(ungrouped?.title).toBe('未分组')
    expect(ungrouped?.ungrouped).toBe(true)
    expect(groups[0]?.ungrouped).toBe(false)
    expect(ungrouped?.rows.map((entry) => entry.id)).toEqual(['gone-new', 'gone-old'])
  })

  it('空 cwd 仍是「未记录项目」组，不与「未分组」撞键', () => {
    const groups = groupByProject([
      row('empty', '', 300),
      row('gone', '--C--', 100, { workspaceMissing: true }),
    ], zhTranslate, trashKeys)

    expect(groups.map((group) => group.projectDir)).toEqual(['', UNGROUPED_PROJECT_DIR])
    expect(groups[0]?.label).toBe('未记录项目')
    expect(groups[1]?.label).toBe('未分组')
  })

  it('archive 键：按 updatedAt 倒序分组，没有「未分组」组', () => {
    const archiveRow = (sessionId: string, projectDir: string, updatedAt: number): ArchiveRowWire => ({
      sessionId, projectDir, title: sessionId, updatedAt, updatedAtSource: 'prompt', subagent: false,
    })
    const groups = groupByProject([
      archiveRow('session-a1', '--A--', 100),
      archiveRow('session-b1', '--B--', 300),
      archiveRow('session-a2', '--A--', 200),
    ], zhTranslate, {
      timeOf: (r) => r.updatedAt ?? 0,
      projectDirOf: (r) => r.projectDir,
    })

    expect(groups.map((group) => group.projectDir)).toEqual(['--B--', '--A--'])
    expect(groups.every((group) => !group.ungrouped)).toBe(true)
    expect(groups.map((group) => group.latest)).toEqual([300, 200])
    expect(groups[1]?.rows.map((r) => r.sessionId)).toEqual(['session-a2', 'session-a1'])
  })
})
