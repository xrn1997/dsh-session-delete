// 子会话摘要的三条判据（`src/trash/subagent-summary.ts`）：条数闸、超闸才报总数、合计覆盖全部孩子。
// 回收站详情与归档详情共用这一份；这里只喂数字，两个数据源的用例留在各自的详情测试里。
import { expect, it } from 'vitest'
import {
  displayedSubagentCount,
  SUBAGENT_SUMMARY_LIMIT,
  summarizeSubagents,
  type SubagentSizes,
} from '../src/trash/subagent-summary.js'

const sizes = (over: Partial<SubagentSizes> = {}): SubagentSizes => ({ sum: 0, missing: 0, ...over })

it('缺省条数闸是 200，且不随输入漂移', () => {
  expect(SUBAGENT_SUMMARY_LIMIT).toBe(200)
})

it('条数闸判的是 min(孩子数, 闸)；未超闸与恰等于闸都不报总数', () => {
  const under = summarizeSubagents({ count: 3, limit: 10, sizes: sizes() })
  expect(under.displayed).toBe(3)
  expect(under).not.toHaveProperty('total')
  // 判的是「超过」：恰等于闸时没有显示外的孩子，不落 total。
  const atGate = summarizeSubagents({ count: 10, limit: 10, sizes: sizes() })
  expect(atGate.displayed).toBe(10)
  expect(atGate).not.toHaveProperty('total')
})

it('超闸：只列前 N 条，total 给全部孩子数', () => {
  expect(summarizeSubagents({ count: 12, limit: 10, sizes: sizes() })).toMatchObject({ displayed: 10, total: 12 })
})

it('闸缺省取 SUBAGENT_SUMMARY_LIMIT：201 条只列 200、总数 201', () => {
  expect(summarizeSubagents({ count: 201, sizes: sizes() })).toMatchObject({
    displayed: SUBAGENT_SUMMARY_LIMIT,
    total: 201,
  })
})

it('零条：一条不列、不报总数、合计不出线（0 条不是 0 字节）', () => {
  const empty = summarizeSubagents({ count: 0, sizes: sizes() })
  expect(empty).toMatchObject({ displayed: 0, sizeBytes: 0, sizeBytesIncluded: false })
  expect(empty).not.toHaveProperty('total')
})

it('闸为 0：一条不列，但显示外的孩子照报总数', () => {
  expect(summarizeSubagents({ count: 2, limit: 0, sizes: sizes() })).toMatchObject({ displayed: 0, total: 2 })
})

it('合计覆盖全部孩子（不是已列的前 N 条）', () => {
  const summary = summarizeSubagents({ count: 3, limit: 1, sizes: sizes({ sum: 60 }) })
  expect(summary).toMatchObject({ displayed: 1, total: 3, sizeBytes: 60, sizeBytesIncluded: true })
})

it('部分孩子缺大小：合计出线，只加已知的那几条', () => {
  expect(summarizeSubagents({ count: 3, sizes: sizes({ sum: 40, missing: 1 }) })).toMatchObject({
    sizeBytes: 40,
    sizeBytesIncluded: true,
  })
})

it('全部孩子都缺大小：合计不出线（0 个已知 ≠ 0 字节）', () => {
  // 归档详情：大小读面缺席 / 逐行全缺时走这一支（ADR-0064 的「并非全部孩子都缺大小才给合计」）。
  const summary = summarizeSubagents({ count: 3, sizes: sizes({ sum: 0, missing: 3 }) })
  expect(summary).toMatchObject({ sizeBytes: 0, sizeBytesIncluded: false })
})

it('回收站形态（清册大小必填，missing 恒 0）：合计恒出线', () => {
  expect(summarizeSubagents({ count: 2, sizes: sizes({ sum: 121, missing: 0 }) }).sizeBytesIncluded).toBe(true)
})

it('displayedSubagentCount：缺省闸 / 显式闸 / 0 与负数', () => {
  expect(displayedSubagentCount(201)).toBe(SUBAGENT_SUMMARY_LIMIT)
  expect(displayedSubagentCount(3, 2)).toBe(2)
  expect(displayedSubagentCount(3, 3)).toBe(3)
  expect(displayedSubagentCount(3, 0)).toBe(0)
  // 条数闸按非负整数使用；负数按「一条都不显示」收口，别让它落进 slice 的负下标语义。
  expect(displayedSubagentCount(3, -1)).toBe(0)
})
