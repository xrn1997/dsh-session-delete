/**
 * 孤儿投影缓存（`src/trash/projection-cache.ts`）。
 *
 * 钉住四条判据：
 * - 保护面是「语料/持久化 ∪ 清册行 ∪ 回收站目录」，id 按 bare 归一（`session-x` 与 `x` 同一个会话）；
 * - 语料缺席或读不出、持久化服务在场但列表读不出、或缓存读面不可用 ⇒ 抛 io，不折成 0 条；
 * - 清理用同一条判据现扫（raw 行 + 目录名，不对账、不改写清册），只删扫描那一刻仍无会话痕迹的记录；
 *   删除失败回 `{removed:0, failed:N}`；
 * - 永久删除的逐会话收尾只删这一条，失败只 warning，不翻删除。
 */
import { describe, expect, it, vi } from 'vitest'
import { makeEntryId } from '../src/trash/entry.js'
import type { TrashEntry } from '../src/trash/entry.js'
import { TRASH_DIR_NAME } from '../src/shared/wire.js'
import {
  cleanProjectionCacheOrphans,
  dropDeletedSessionCache,
  reportProjectionCacheOrphans,
} from '../src/trash/projection-cache.js'
import { createLogWorld, failureOf, trashEntry } from './support/world.js'

/** 这一份用例不关心调用顺序：只要世界，不要调用日志。 */
function makeWorld(over: Omit<Parameters<typeof createLogWorld>[0], 'logMethods'>) {
  return createLogWorld({ ...over, logMethods: [] })
}

const HOME = '/h'
const TRASH_ROOT = `${HOME}/${TRASH_DIR_NAME}`

const entry = (sessionId: string): TrashEntry =>
  trashEntry(makeEntryId(1, sessionId), { sessionId })

/** 一条会话身份（语料保护面）。 */
const identity = (sessionId: string) => ({
  sessionId,
  projectDir: '--p--',
  subagent: false,
  createdAt: 1,
})

describe('孤儿投影缓存 · 报告', () => {
  it('保护面 = 语料 ∪ 清册行 ∪ 回收站目录；bare 两种写法互通', async () => {
    const rows = [entry('session-in-trash')]
    const unindexed = makeEntryId(2, 'session-unindexed')
    const { deps } = makeWorld({
      seed: rows,
      corpus: [identity('session-live'), identity('session-bare')],
      // 语料看不见的持久化会话（例如冷无 cwd）也要保护：持久化列表是第二条保护面。
      sizes: { 'session-persisted-only': 1 },
      projectionCache: [
        'session-live', 'session-bare', 'session-persisted-only',
        'session-in-trash', 'session-unindexed', 'session-orphan',
      ],
      fs: { dirs: (p: string) => (p === TRASH_ROOT ? [unindexed] : []) },
    })

    // 缓存里用 `session-` 写法、语料里只用 bare 写法：归一后仍算在册。
    await expect(reportProjectionCacheOrphans(deps, rows)).resolves.toEqual({ count: 1 })
  })

  it('语料缺席 ⇒ io：活体只有语料看得见，持久化列表不是全集，不拿它当唯一真相', async () => {
    // 就算持久化列表能读，它也只覆盖磁盘持久化：没落盘的活体会话的缓存会被误报成孤儿删掉。
    const { deps } = makeWorld({
      seed: [],
      sizes: { 'session-persisted': 1 },
      projectionCache: ['session-persisted', 'session-orphan'],
    })
    const error = await failureOf(reportProjectionCacheOrphans(deps, []))
    expect(error).toMatchObject({ code: 'sessiondelete/io' })
    expect(error.message).toMatch(/语料/)
  })

  it('语料与持久化都读不出 ⇒ io，不拿 0 条冒充"没有孤儿"', async () => {
    const missing = makeWorld({
      seed: [],
      persistedSizesAvailable: false,
      projectionCache: ['a'],
    })
    const error = await failureOf(reportProjectionCacheOrphans(missing.deps, []))
    expect(error).toMatchObject({ code: 'sessiondelete/io' })
    expect(error.message).toMatch(/语料/)
  })

  it('持久化服务在场但列表读不出 ⇒ io（可能有语料看不见的 persisted-only 会话）', async () => {
    const { deps } = makeWorld({
      seed: [],
      corpus: [identity('session-live')],
      persistedSizesAvailable: false,
      persistenceMounted: true,
      projectionCache: ['session-live', 'session-orphan'],
    })
    const error = await failureOf(reportProjectionCacheOrphans(deps, []))
    expect(error).toMatchObject({ code: 'sessiondelete/io' })
    expect(error.message).toMatch(/持久化/)
  })

  it('持久化服务确实缺席 ⇒ 没有 persisted-only 会话，语料仍是完整保护面', async () => {
    const { deps } = makeWorld({
      seed: [],
      corpus: [identity('session-live')],
      persistedSizesAvailable: false,
      persistenceMounted: false,
      projectionCache: ['session-live', 'session-orphan'],
    })
    await expect(reportProjectionCacheOrphans(deps, [])).resolves.toEqual({ count: 1 })
  })

  it('投影缓存域不可用 ⇒ io（服务缺席也不算空报告）', async () => {
    const { deps } = makeWorld({
      seed: [],
      corpus: [],
      projectionCacheAvailable: false,
    })
    const error = await failureOf(reportProjectionCacheOrphans(deps, []))
    expect(error).toMatchObject({ code: 'sessiondelete/io' })
    expect(error.message).toMatch(/投影缓存/)
  })
})

describe('孤儿投影缓存 · 清理', () => {
  it('不改写清册：用调用方交来的 raw 行 + 目录名保护幽灵行', async () => {
    const rows = [entry('session-kept')]
    const { deps } = makeWorld({
      seed: rows,
      corpus: [identity('session-live')],
      projectionCache: ['session-live', 'session-orphan-a', 'session-orphan-b'],
      dropProjectionCache: (ids) => ids.length,
    })

    const receipt = await cleanProjectionCacheOrphans(deps, rows)

    expect(receipt).toEqual({ removed: 2, failed: 0 })
    expect(deps.host.dropProjectionCache).toHaveBeenCalledWith(['session-orphan-a', 'session-orphan-b'])
  })

  it('行在、目录不在的幽灵行是保护面：报告与清理都不删它的缓存，也不摘行', async () => {
    const ghost = entry('session-ghost')
    const { deps, manifest } = makeWorld({
      seed: [ghost],
      corpus: [],
      projectionCache: ['session-ghost'],
      fs: { dirs: () => [] },
    })
    const remove = vi.spyOn(manifest, 'remove')

    await expect(reportProjectionCacheOrphans(deps, [ghost])).resolves.toEqual({ count: 0 })
    await expect(cleanProjectionCacheOrphans(deps, [ghost])).resolves.toEqual({ removed: 0, failed: 0 })
    expect(deps.host.dropProjectionCache).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    remove.mockRestore()
  })

  it('两趟之间已经不存在的记录不算失败（成功调用回的 removed 可以小于名单）', async () => {
    const { deps } = makeWorld({
      seed: [],
      corpus: [],
      projectionCache: ['a', 'b'],
      dropProjectionCache: () => 1,
    })
    await expect(cleanProjectionCacheOrphans(deps, [])).resolves.toEqual({ removed: 1, failed: 0 })
  })

  it('一条孤儿都没有 ⇒ 不发删除调用，回零', async () => {
    const { deps } = makeWorld({
      seed: [],
      corpus: [identity('session-live')],
      projectionCache: ['session-live'],
    })
    await expect(cleanProjectionCacheOrphans(deps, [])).resolves.toEqual({ removed: 0, failed: 0 })
    expect(deps.host.dropProjectionCache).not.toHaveBeenCalled()
  })

  it('逐条删除部分失败 ⇒ 端口回真实 {removed, failed}，不吞成整批失败', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { deps } = makeWorld({
      seed: [],
      corpus: [],
      projectionCache: ['a', 'b'],
      dropProjectionCache: () => ({ removed: 1, failed: 1 }),
    })

    await expect(cleanProjectionCacheOrphans(deps, [])).resolves.toEqual({ removed: 1, failed: 1 })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('删除整批失败 ⇒ {removed:0, failed:N}，不抛成顶层失败（清完重查以真实剩余量为准）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { deps } = makeWorld({
      seed: [],
      corpus: [],
      projectionCache: ['a', 'b'],
      dropProjectionCache: () => { throw new Error('domain boom') },
    })

    await expect(cleanProjectionCacheOrphans(deps, [])).resolves.toEqual({ removed: 0, failed: 2 })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('永久删除的逐会话收尾', () => {
  it('只删这一条会话的缓存；失败只 warning，不把已完成的删除翻成失败', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ok = makeWorld({ seed: [], corpus: [], projectionCache: ['session-a'], dropProjectionCache: (ids) => ids.length })
    await dropDeletedSessionCache(ok.deps, 'session-a')
    expect(ok.host.dropProjectionCache).toHaveBeenCalledWith(['session-a', 'a'])

    const failing = makeWorld({
      seed: [],
      corpus: [],
      projectionCache: ['session-a'],
      dropProjectionCache: () => { throw new Error('boom') },
    })
    await expect(dropDeletedSessionCache(failing.deps, 'session-a')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})