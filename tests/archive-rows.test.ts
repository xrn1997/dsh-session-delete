/**
 * 归档清单装配（`GET /archive-list` 的服务端一次算）：归档 ∩ 语料交集、标题/label、
 * 最后活动、大小的口径与三条**互不相同**的缺席/失败降级。
 *
 * 判据逐条来自 ADR-0060 的决定与边界：ghost 交集宁可少显示、缺席不拿 0 冒充、
 * 标题问题永不失败整档、持久化字节服务缺席逐行缺大小、只有 `list()` 抛错才是整档 `io`。
 */
import { describe, expect, it } from 'vitest'
import { assembleArchiveRows } from '../src/api/archive-rows.js'
import type { SessionIdentity } from '../src/ports/host-port.js'
import { createFakeDeps } from './support/fake-deps.js'

const s = (sessionId: string, over: Partial<SessionIdentity> = {}): SessionIdentity => ({
  sessionId, projectDir: '--p--', subagent: false, ...over,
})

describe('归档清单装配（assembleArchiveRows）', () => {
  it('归档 ∩ listSessions：ghost id（盘上已无记录）不显示', async () => {
    const made = createFakeDeps({
      archivedIds: ['session-a', 'session-ghost'],
      corpus: [s('session-a', { createdAt: 10 })],
    })
    const wire = await assembleArchiveRows(made.deps)
    expect(wire).toMatchObject({ available: true, missingSizeCount: 1 })
    if (!wire.available) throw new Error('语料在场时不该缺席')
    expect(wire.rows.map((row) => row.sessionId)).toEqual(['session-a'])
  })

  it('回收站里的会话（删除后不在语料）不进归档清单——归档集含它也没用', async () => {
    // 删除不改 archivedSessionIds（ADR-0008）：会话离开语料后，归档档靠同一道 ghost 交集把它滤掉。
    const made = createFakeDeps({
      archivedIds: ['session-deleted'],
      corpus: [],
    })
    const wire = await assembleArchiveRows(made.deps)
    if (!wire.available) throw new Error('语料在场时不该缺席')
    expect(wire.rows).toEqual([])
  })

  it('title：readTitleSnapshots 折日志标题；单条 rejected 只空该行', async () => {
    const made = createFakeDeps({
      archivedIds: ['session-a', 'session-b'],
      corpus: [s('session-a', { createdAt: 10 }), s('session-b', { createdAt: 20 })],
      titles: { 'session-a': '甲' },
    })
    const wire = await assembleArchiveRows(made.deps)
    if (!wire.available) throw new Error('语料在场时不该缺席')
    expect(wire.rows.map((row) => [row.sessionId, row.title])).toEqual([
      ['session-a', '甲'],
      ['session-b', ''],
    ])
  })

  it('label：subagent 行带投影 label，其余行不带', async () => {
    const made = createFakeDeps({
      archivedIds: ['session-kid', 'session-main'],
      corpus: [s('session-kid', { subagent: true, createdAt: 10 }), s('session-main', { createdAt: 20 })],
      titles: { 'session-kid': '日志标题', 'session-main': '主标题' },
      label: '子任务名',
    })
    const wire = await assembleArchiveRows(made.deps)
    if (!wire.available) throw new Error('语料在场时不该缺席')
    const kid = wire.rows.find((row) => row.sessionId === 'session-kid')
    const main = wire.rows.find((row) => row.sessionId === 'session-main')
    expect(kid).toMatchObject({ label: '子任务名', title: '日志标题', subagent: true })
    // 非 subagent 行不问 labelOf：这一格缺席 = 没有，不是空串冒充。
    expect(main && Object.hasOwn(main, 'label')).toBe(false)
  })

  it('updatedAt：sessionController 给 updatedAt 时 updatedAtSource=prompt；缺席/跳过的行回退 createdAt 并标 created', async () => {
    const made = createFakeDeps({
      archivedIds: ['session-a', 'session-b'],
      corpus: [s('session-a', { createdAt: 10 }), s('session-b', { createdAt: 20 })],
      activity: { 'session-a': 111 },
    })
    const wire = await assembleArchiveRows(made.deps)
    if (!wire.available) throw new Error('语料在场时不该缺席')
    expect(wire.rows.map((row) => [row.sessionId, row.updatedAt, row.updatedAtSource])).toEqual([
      ['session-a', 111, 'prompt'],
      ['session-b', 20, 'created'],
    ])

    // sessionController 缺席/抛错：整档回退 createdAt（不是 0、不是失败）。
    const fallback = createFakeDeps({
      archivedIds: ['session-a'],
      corpus: [s('session-a', { createdAt: 33 })],
    })
    fallback.host.sessionActivity.mockResolvedValue({ available: false })
    const wire2 = await assembleArchiveRows(fallback.deps)
    if (!wire2.available) throw new Error('语料在场时不该缺席')
    expect(wire2.rows[0]).toMatchObject({ updatedAt: 33, updatedAtSource: 'created' })
  })

  it('createdAt 缺席或非正数 ⇒ 行不带 updatedAt/updatedAtSource（不拿 0 冒充 1970）', async () => {
    const made = createFakeDeps({
      archivedIds: ['session-a', 'session-b'],
      corpus: [s('session-a'), s('session-b', { createdAt: 0 })],
    })
    const wire = await assembleArchiveRows(made.deps)
    if (!wire.available) throw new Error('语料在场时不该缺席')
    for (const row of wire.rows) {
      expect(Object.hasOwn(row, 'updatedAt')).toBe(false)
      expect(Object.hasOwn(row, 'updatedAtSource')).toBe(false)
    }
  })

  it('sizeBytes 缺席不拿 0 冒充：行不带字段、totalBytes 只加已知、missingSizeCount 计数', async () => {
    const made = createFakeDeps({
      archivedIds: ['session-a', 'session-b'],
      corpus: [s('session-a', { createdAt: 10 }), s('session-b', { createdAt: 20 })],
      sizes: { 'session-a': 10 },
    })
    const wire = await assembleArchiveRows(made.deps)
    if (!wire.available) throw new Error('语料在场时不该缺席')
    const a = wire.rows.find((row) => row.sessionId === 'session-a')
    const b = wire.rows.find((row) => row.sessionId === 'session-b')
    expect(a).toMatchObject({ sizeBytes: 10 })
    expect(b && Object.hasOwn(b, 'sizeBytes')).toBe(false)
    expect(wire.totalBytes).toBe(10)
    expect(wire.missingSizeCount).toBe(1)
  })

  it('sessionPersistence 服务缺席 ⇒ 逐行缺大小、整档照常（不拿空表冒充"没有大小"）', async () => {
    const made = createFakeDeps({
      archivedIds: ['session-a', 'session-b'],
      corpus: [s('session-a', { createdAt: 10 }), s('session-b', { createdAt: 20 })],
    })
    made.host.persistedSizes.mockResolvedValue({ available: false })
    const wire = await assembleArchiveRows(made.deps)
    if (!wire.available) throw new Error('语料在场时不该缺席')
    expect(wire.rows.map((row) => Object.hasOwn(row, 'sizeBytes'))).toEqual([false, false])
    expect(wire.totalBytes).toBe(0)
    expect(wire.missingSizeCount).toBe(2)
  })

  it('sessionPersistence.list() 抛错 ⇒ 整档 io（抛出原样上抛）', async () => {
    const made = createFakeDeps({
      archivedIds: ['session-a'],
      corpus: [s('session-a', { createdAt: 10 })],
    })
    made.host.persistedSizes.mockRejectedValue(new Error('boom'))
    await expect(assembleArchiveRows(made.deps)).rejects.toThrow('boom')
  })

  it('sessionQuery 缺席 ⇒ { available: false }（不是空列表）', async () => {
    const made = createFakeDeps({ archivedIds: ['session-a'] })
    await expect(assembleArchiveRows(made.deps)).resolves.toEqual({ available: false })
  })

  it('标题方法缺席（旧宿主）⇒ 逐条回退 titleOf 投影标题或空串，不失败整档', async () => {
    const made = createFakeDeps({
      archivedIds: ['session-a'],
      corpus: [s('session-a', { createdAt: 10 })],
      title: '投影标题',
    })
    made.host.titleSnapshots.mockResolvedValue({ available: false })
    const wire = await assembleArchiveRows(made.deps)
    if (!wire.available) throw new Error('语料在场时不该缺席')
    expect(wire.rows[0]).toMatchObject({ title: '投影标题' })
  })
})
