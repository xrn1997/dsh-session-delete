/**
 * 写入进度记录器（`GET /progress` 背后那份状态）的单测。
 *
 * 为什么值得单独一份：写在飞时界面靠它报 k/N 与当前步骤，任何一格漂了（begin 不归零、
 * tick 动错格、收尾不回 idle）在界面上都是「假进度」——比没有进度更糟。这里只钉记录器
 * 自己的口径，路由与判形各归 `tests/api.test.ts` 与 `tests/wire-shape.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readWriteProgress, resetWriteProgress, writeProgress } from '../src/verbs/write-progress.js'

describe('写入进度记录器', () => {
  beforeEach(() => {
    resetWriteProgress()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('begin 后 readWriteProgress 返回 running：done 0、step 初值 checking、startedAt 取当前时刻', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_760_000_000_000)
    writeProgress.begin('purge', ['a', 'b'], 2)
    expect(readWriteProgress()).toEqual({
      status: 'running',
      action: 'purge',
      ids: ['a', 'b'],
      done: 0,
      total: 2,
      step: 'checking',
      startedAt: 1_760_000_000_000,
    })
  })

  it('step 与 advance 只动自己那格：step 后 advance 两次 ⇒ done 2、step 不变', () => {
    writeProgress.begin('purge', ['a'], 2)
    writeProgress.step('deleting')
    writeProgress.advance()
    writeProgress.advance()
    expect(readWriteProgress()).toEqual(expect.objectContaining({ done: 2, step: 'deleting' }))
  })

  it('finish 回 idle；收尾后迟到的 tick 不把记录复活', () => {
    writeProgress.begin('purge', ['a'], 1)
    writeProgress.finish()
    writeProgress.step('deleting')
    writeProgress.advance()
    expect(readWriteProgress()).toEqual({ status: 'idle' })
  })

  it('resetWriteProgress 恒回 idle（测试复位口）', () => {
    writeProgress.begin('purge', ['a'], 1)
    resetWriteProgress()
    expect(readWriteProgress()).toEqual({ status: 'idle' })
  })

  it('begin 是覆盖式：运行中再 begin ⇒ 旧记录整份换掉（done 归零、身份与总数换新）', () => {
    writeProgress.begin('purge', ['a', 'b'], 2)
    writeProgress.step('deleting')
    writeProgress.advance()
    writeProgress.begin('empty', ['c'], 1)
    // startedAt 是 begin 时刻的快照、逐次不同；它的精确钉法归第一条用例（fake timers）。
    expect(readWriteProgress()).toMatchObject({
      status: 'running',
      action: 'empty',
      ids: ['c'],
      done: 0,
      total: 1,
      step: 'checking',
    })
  })

  it('advance 不越过 total：多出来的 tick 封顶（done 永远 ≤ total，进度条不撑过头）', () => {
    writeProgress.begin('purge', ['a'], 1)
    writeProgress.advance()
    writeProgress.advance()
    writeProgress.advance()
    expect(readWriteProgress()).toEqual(expect.objectContaining({ done: 1, total: 1 }))
  })

  it('每次读都交出独立快照：两次读的 ids 不是同一个数组（快照不可变从约定变结构）', () => {
    writeProgress.begin('purge', ['a'], 1)
    const first = readWriteProgress()
    const second = readWriteProgress()
    if (first.status !== 'running' || second.status !== 'running') throw new Error('期望 running 快照')
    expect(second.ids).toEqual(['a'])
    expect(second.ids).not.toBe(first.ids)
  })
})
