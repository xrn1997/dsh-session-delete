/**
 * 路由表（ADR-0004）：**一条记录**同时回答"用什么方法、纯不纯、要不要预读 body、怎么处理"。
 *
 * 这一份的存在理由就是"枚举整张表"：加一段而忘了声明纯度、把写动作写成纯读、或让 body 的分类漂掉，
 * 都在这里红——而不是等到真机上"删除按钮被一次探测堵在身后"或"写动作绕开了串行链"。
 */
import { describe, expect, it } from 'vitest'
import { APPLY_ACTIONS, ROUTE_TABLE, routeOf } from '../src/api/route-table.js'
import { ROUTES } from '../src/shared/wire.js'
import type { ApplyAction } from '../src/shared/wire.js'

const SEGMENTS = Object.values(ROUTES)

describe('路由表 · 九个段名各一行', () => {
  it('段名表与路由表逐键对齐（`wire.ts` 加了段名而这里没加 ⇒ 编译不过，这条是运行期的同一件事）', () => {
    expect(Object.keys(ROUTE_TABLE).sort()).toEqual([...SEGMENTS].sort())
  })

  it('方法：五个 GET 段，四个 POST 段里只有 apply / empty / attachment-clean 是写（detail 是纯读）', () => {
    expect(routeOf(ROUTES.list)?.method).toBe('GET')
    expect(routeOf(ROUTES.ping)?.method).toBe('GET')
    expect(routeOf(ROUTES.orphans)?.method).toBe('GET')
    expect(routeOf(ROUTES.attachment)?.method).toBe('GET')
    expect(routeOf(ROUTES.attachmentOrphans)?.method).toBe('GET')
    expect(routeOf(ROUTES.apply)?.method).toBe('POST')
    expect(routeOf(ROUTES.empty)?.method).toBe('POST')
    expect(routeOf(ROUTES.detail)?.method).toBe('POST')
    expect(routeOf(ROUTES.attachmentClean)?.method).toBe('POST')
  })

  it('方法：附件字节段是 GET + binary；孤儿附件报告是 GET + json，清理是 POST + json', () => {
    const attachment = routeOf(ROUTES.attachment)
    expect(attachment?.method).toBe('GET')
    expect(attachment?.body).toBe('none')
    expect(attachment?.purity).toBe('pure')
    expect(attachment?.read).toBe('none')
    expect(attachment?.response).toBe('binary')

    const report = routeOf(ROUTES.attachmentOrphans)
    expect(report?.method).toBe('GET')
    expect(report?.body).toBe('none')
    expect(report?.purity).toBe('pure')
    expect(report?.read).toBe('none')
    expect(report?.response).toBe('json')

    const clean = routeOf(ROUTES.attachmentClean)
    expect(clean?.method).toBe('POST')
    expect(clean?.body).toBe('none')
    expect(clean?.purity).toBe('chained')
    expect(clean?.read).toBe('none')
    expect(clean?.response).toBe('json')
  })

  it('response：只有附件段是 binary，其余八段都是 json', () => {
    for (const segment of SEGMENTS) {
      expect(`${segment}:${routeOf(segment)?.response}`)
        .toBe(`${segment}:${segment === ROUTES.attachment ? 'binary' : 'json'}`)
    }
  })

  it('body：只有 POST 里的 apply / detail 需要 JSON 体，GET 一律不读（流只能消费一次）', () => {
    for (const segment of SEGMENTS) {
      const expectsBody = segment === ROUTES.apply || segment === ROUTES.detail
      expect(`${segment}:${routeOf(segment)?.body}`).toBe(`${segment}:${expectsBody ? 'json' : 'none'}`)
    }
  })

  it('纯度：`list` / `empty` / `attachment-clean` 必须进到达序链（它们先对账或先扫引用源、再动盘与清册）', () => {
    expect(routeOf(ROUTES.list)?.purity).toBe('chained')
    expect(routeOf(ROUTES.empty)?.purity).toBe('chained')
    expect(routeOf(ROUTES.attachmentClean)?.purity).toBe('chained')
  })

  it('纯度：探测 / 扫描 / 详情 / 附件读取不进链（一次探测或大正文读不该把删除按钮堵在身后）', () => {
    expect(routeOf(ROUTES.ping)?.purity).toBe('pure')
    expect(routeOf(ROUTES.orphans)?.purity).toBe('pure')
    expect(routeOf(ROUTES.detail)?.purity).toBe('pure')
    expect(routeOf(ROUTES.attachment)?.purity).toBe('pure')
    expect(routeOf(ROUTES.attachmentOrphans)?.purity).toBe('pure')
  })

  it('纯度：`apply` 里只有 count 是纯读，其余四个动作都进链', () => {
    const purity = routeOf(ROUTES.apply)?.purity
    expect(typeof purity).toBe('function')
    const of = purity as (body: Record<string, unknown> | null) => string
    expect(of({ action: 'count' })).toBe('pure')
    for (const action of APPLY_ACTIONS.filter((item) => item !== 'count')) {
      expect(`${action}:${of({ action })}`).toBe(`${action}:chained`)
    }
    // 没有动作（或动作不认识）也进链：认不得的动作由处理那一步响亮拒掉，绝不"什么都不做"地插队
    expect(of(null)).toBe('chained')
    expect(of({ action: 'nope' })).toBe('chained')
  })

  it('读面：每一段声明自己该拿到的清册读面', () => {
    expect(routeOf(ROUTES.list)?.read).toBe('list')
    expect(routeOf(ROUTES.empty)?.read).toBe('list')
    expect(routeOf(ROUTES.orphans)?.read).toBe('raw')
    expect(routeOf(ROUTES.detail)?.read).toBe('raw')
    expect(routeOf(ROUTES.ping)?.read).toBe('none')
    expect(routeOf(ROUTES.apply)?.read).toBe('none')
    // 孤儿附件两段读的是引用源与附件库，不读回收站清册。
    expect(routeOf(ROUTES.attachmentOrphans)?.read).toBe('none')
    expect(routeOf(ROUTES.attachmentClean)?.read).toBe('none')
  })

  it('纯读段不拿对账读面：pure 只配 raw / none', () => {
    for (const segment of SEGMENTS) {
      const spec = routeOf(segment)
      if (spec?.purity === 'pure') expect(spec.read).not.toBe('list')
    }
  })

  it('不认识的段名回 undefined（调用方据此 404，并带出原路径）', () => {
    expect(routeOf('/nope')).toBeUndefined()
    expect(routeOf('')).toBeUndefined()
  })
})

describe('路由表 · `/apply` 的动作表由类型派生', () => {
  it('运行期那五个动作就是 `ApplyAction` 的五项（少一个编译不过，多一个也是）', () => {
    const expected: ApplyAction[] = ['delete', 'restore', 'purge', 'count', 'orphan-clean']
    expect([...APPLY_ACTIONS].sort()).toEqual(expected.sort())
  })
})
