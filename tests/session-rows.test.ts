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
import {
  projectRowFacts,
  projectSessionRows,
  readRowSurfaces,
  sizeTotals,
  sizeTotalsForIds,
  type RowSurfaces,
  type RowTarget,
} from '../src/trash/session-rows.js'
import { createFakeDeps } from './support/fake-deps.js'

/** 逐行读的**并发计数**：`labelOf` 与 `titleOf` 共用一条 inFlight 计数——两路共用一份并发预算，
 *  数的是「同时挂起的逐行读总数」，不是某一路自己的窗口。每次读先挂起一轮事件循环再应答：
 *  无界实现会把整批同时挂起，`maxInFlight` 于是把放飞照出来。 */
function trackRowReads(made: ReturnType<typeof createFakeDeps>): { maxInFlight: () => number } {
  let inFlight = 0
  let max = 0
  const tracked = async (sessionId: string, read: (id: string) => string): Promise<string> => {
    inFlight += 1
    max = Math.max(max, inFlight)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    inFlight -= 1
    return read(sessionId)
  }
  made.host.labelOf.mockImplementation(async (sessionId) => tracked(sessionId, (id) => `名-${id}`))
  made.host.titleOf.mockImplementation(async (sessionId) => tracked(sessionId, (id) => `投影-${id}`))
  return { maxInFlight: () => max }
}

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

it('有界并发：40 行 label 逐行读封顶 8，输出与 targets 同序同长、逐行对得上自己的读数', async () => {
  const made = createFakeDeps({ titles: {} })
  const reads = trackRowReads(made)
  const rows: RowTarget[] = Array.from({ length: 40 }, (_, index) => ({
    sessionId: `s-${index}`,
    wantsLabel: true,
  }))
  const facts = await projectSessionRows(made.deps, rows, { sizeFailure: 'throw' })
  expect(reads.maxInFlight()).toBeLessThanOrEqual(8)
  expect(made.host.labelOf).toHaveBeenCalledTimes(40)
  expect(facts.map((fact) => fact.sessionId)).toEqual(rows.map((row) => row.sessionId))
  expect(facts.map((fact) => fact.label)).toEqual(rows.map((row) => `名-${row.sessionId}`))
})

it('有界并发：旧宿主标题回退走同一份预算——40 行 titleOf 也封顶 8、保序', async () => {
  const made = createFakeDeps({})
  const reads = trackRowReads(made)
  const rows: RowTarget[] = Array.from({ length: 40 }, (_, index) => ({ sessionId: `s-${index}` }))
  const facts = await projectSessionRows(made.deps, rows, { sizeFailure: 'throw' })
  expect(reads.maxInFlight()).toBeLessThanOrEqual(8)
  expect(made.host.titleOf).toHaveBeenCalledTimes(40)
  expect(facts.map((fact) => fact.title)).toEqual(rows.map((row) => `投影-${row.sessionId}`))
})

it('合计覆盖未投影 id：缺席按传入 id 全量计（表里没有的与显式缺席都算缺）', () => {
  const sizes: RowSurfaces['sizes'] = {
    available: true,
    value: new Map<string, number | undefined>([['a', 7], ['c', undefined]]),
  }
  expect(sizeTotalsForIds(['a', 'b', 'c'], sizes)).toEqual({ totalBytes: 7, missingSizeCount: 2 })
})

it('合计：读面抛错被策略折成 null ⇒ 全部传入 id 计缺席', () => {
  expect(sizeTotalsForIds(['a', 'b', 'c'], null)).toEqual({ totalBytes: 0, missingSizeCount: 3 })
})

it('合计：服务缺席（available 为 false）与 null 同口径 ⇒ 全部传入 id 计缺席', () => {
  expect(sizeTotalsForIds(['a', 'b', 'c'], { available: false })).toEqual({ totalBytes: 0, missingSizeCount: 3 })
})

it('三层接口：readRowSurfaces 只发批量读，projectRowFacts 只读输出那几行（按输出计划）', async () => {
  const made = createFakeDeps({ titles: { a: '甲', b: '乙', c: '丙' }, label: '委派名' })
  const surfaces = await readRowSurfaces(made.deps, ['a', 'b', 'c'], { sizeFailure: 'throw' })
  // 批量面：三个读面各一次、ids 就是调用方要显示的那批；这一层零逐行读。
  expect(made.host.titleSnapshots.mock.calls.map(([ids]) => ids)).toEqual([['a', 'b', 'c']])
  expect(made.host.titleOf).not.toHaveBeenCalled()
  expect(made.host.labelOf).not.toHaveBeenCalled()
  // 逐行面：只为输出行付逐行读。
  const facts = await projectRowFacts(made.deps, surfaces, [{ sessionId: 'b', wantsLabel: true }])
  expect(facts).toEqual([{ sessionId: 'b', title: '乙', label: '委派名' }])
  expect(made.host.labelOf.mock.calls.map(([id]) => id)).toEqual(['b'])
})

it('逐行面：首个失败原样抛出，不吞成空行、不静默跳过', async () => {
  const made = createFakeDeps({ titles: {} })
  made.host.labelOf.mockRejectedValue(new Error('label 读炸'))
  const surfaces = await readRowSurfaces(made.deps, ['a'], { sizeFailure: 'throw' })
  await expect(projectRowFacts(made.deps, surfaces, [{ sessionId: 'a', wantsLabel: true }]))
    .rejects.toThrow('label 读炸')
})
