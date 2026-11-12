/**
 * 行读数装配（`src/trash/session-rows.ts`）：归档清单与归档详情的子会话段共用这一份四路读面。
 *
 * 钉的是 interface 上的四条口径——**缺席**（`CorpusRead.available:false`）与**失败**（抛错）在
 * 每一格上的落点，以及「没点的格不付钱」：
 * - 标题：批量面在场照念（map 里没有 = 空串）；缺席 ⇒ 逐条回退 `titleOf`。
 * - 时间：提问时间优先；`RowTarget.createdAt` 给了才回落并标 `created`，没给就整格缺席。
 * - 大小：服务缺席 ⇒ 逐行缺；抛错按 `sizeFailure` 分两档（清单整档 `io` / 详情逐行缺）。
 * - label：只为 `wantsLabel` 那几行读一次；空串不落键。
 */
import { expect, it } from 'vitest'
import { projectSessionRows, sizeTotals, type RowTarget } from '../src/trash/session-rows.js'
import { createFakeDeps } from './support/fake-deps.js'

const targets: readonly RowTarget[] = [
  { sessionId: 'a', createdAt: 5, wantsLabel: true },
  { sessionId: 'b', createdAt: 9 },
]

it('同序同长：输出直接按 index 对齐调用方那一批行', async () => {
  const { deps } = createFakeDeps({ titles: { b: '乙的标题' }, activity: { a: 100 } })
  const facts = await projectSessionRows(deps, targets, { sizeFailure: 'throw' })
  expect(facts.map((fact) => fact.sessionId)).toEqual(['a', 'b'])
})

it('标题：批量面在场照念（map 里没有就是空串），不逐条问', async () => {
  const made = createFakeDeps({ titles: { b: '乙的标题' } })
  const facts = await projectSessionRows(made.deps, targets, { sizeFailure: 'throw' })
  expect(facts.map((fact) => fact.title)).toEqual(['', '乙的标题'])
  expect(made.host.titleOf).not.toHaveBeenCalled()
})

it('标题：批量面缺席（旧宿主没有这方法）⇒ 逐条回退 titleOf，不失败整批', async () => {
  const made = createFakeDeps({ title: '投影标题' })
  const facts = await projectSessionRows(made.deps, targets, { sizeFailure: 'throw' })
  expect(facts.map((fact) => fact.title)).toEqual(['投影标题', '投影标题'])
  expect(made.host.titleOf.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
})

it('时间：提问时间优先，读不到才回落 createdAt 并标 created', async () => {
  const made = createFakeDeps({ activity: { a: 100 } })
  const facts = await projectSessionRows(made.deps, targets, { sizeFailure: 'throw' })
  expect(facts.map((fact) => [fact.updatedAt, fact.updatedAtSource])).toEqual([[100, 'prompt'], [9, 'created']])
})

it('时间：调用方没给 createdAt ⇒ 这一格整格缺席（两个键都不落）', async () => {
  const made = createFakeDeps({})
  const facts = await projectSessionRows(made.deps, [{ sessionId: 'a' }], { sizeFailure: 'throw' })
  expect(facts.map((fact) => [Object.hasOwn(fact, 'updatedAt'), Object.hasOwn(fact, 'updatedAtSource')]))
    .toEqual([[false, false]])
})

it('大小：服务缺席 ⇒ 逐行缺大小，合计只加已知、缺席数单报', async () => {
  const made = createFakeDeps({ sizes: { a: 7 } })
  made.host.persistedSizes.mockResolvedValue({ available: false })
  const facts = await projectSessionRows(made.deps, targets, { sizeFailure: 'throw' })
  expect(facts.map((fact) => Object.hasOwn(fact, 'sizeBytes'))).toEqual([false, false])
  expect(sizeTotals(facts)).toEqual({ totalBytes: 0, missingSizeCount: 2 })
})

it('大小：读面抛错按策略分两档——清单整档 io，详情那一段折成逐行缺', async () => {
  const made = createFakeDeps({ sizes: { a: 7 } })
  made.host.persistedSizes.mockRejectedValue(new Error('宿主 storage 域没起来'))
  await expect(projectSessionRows(made.deps, targets, { sizeFailure: 'throw' })).rejects.toThrow('宿主 storage 域没起来')
  const facts = await projectSessionRows(made.deps, targets, { sizeFailure: 'absent' })
  expect(facts.map((fact) => Object.hasOwn(fact, 'sizeBytes'))).toEqual([false, false])
})

it('大小：已知的行进合计，未知的行只加计数', async () => {
  const made = createFakeDeps({ sizes: { a: 7 } })
  const facts = await projectSessionRows(made.deps, targets, { sizeFailure: 'throw' })
  expect(facts[0]?.sizeBytes).toBe(7)
  expect(sizeTotals(facts)).toEqual({ totalBytes: 7, missingSizeCount: 1 })
})

it('label：只点名的行付那一次读，空串不落键', async () => {
  const made = createFakeDeps({ label: '委派时的名字' })
  const facts = await projectSessionRows(made.deps, targets, { sizeFailure: 'throw' })
  expect(made.host.labelOf.mock.calls.map(([id]) => id)).toEqual(['a'])
  expect(facts[0]?.label).toBe('委派时的名字')
  expect(Object.hasOwn(facts[1] ?? {}, 'label')).toBe(false)
})

it('label：读了但是空串 = 没有 ⇒ 键不落（不出现过线上同义的 `label:""`）', async () => {
  const made = createFakeDeps({})
  const facts = await projectSessionRows(made.deps, targets, { sizeFailure: 'throw' })
  expect(made.host.labelOf).toHaveBeenCalledTimes(1)
  expect(Object.hasOwn(facts[0] ?? {}, 'label')).toBe(false)
})
