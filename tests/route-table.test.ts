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

describe('路由表 · 六个段名各一行', () => {
  it('段名表与路由表逐键对齐（`wire.ts` 加了段名而这里没加 ⇒ 编译不过，这条是运行期的同一件事）', () => {
    expect(Object.keys(ROUTE_TABLE).sort()).toEqual([...SEGMENTS].sort())
  })

  it('方法：三个纯读段是 GET，三个 POST 段里只有 apply / empty 是写（detail 是纯读）', () => {
    expect(routeOf(ROUTES.list)?.method).toBe('GET')
    expect(routeOf(ROUTES.ping)?.method).toBe('GET')
    expect(routeOf(ROUTES.orphans)?.method).toBe('GET')
    expect(routeOf(ROUTES.apply)?.method).toBe('POST')
    expect(routeOf(ROUTES.empty)?.method).toBe('POST')
    expect(routeOf(ROUTES.detail)?.method).toBe('POST')
  })

  it('body：只有 POST 里的 apply / detail 需要 JSON 体，GET 一律不读（流只能消费一次）', () => {
    for (const segment of SEGMENTS) {
      const expectsBody = segment === ROUTES.apply || segment === ROUTES.detail
      expect(`${segment}:${routeOf(segment)?.body}`).toBe(`${segment}:${expectsBody ? 'json' : 'none'}`)
    }
  })

  it('纯度：`list` 与 `empty` 必须进到达序链（它们先对账、再动盘与清册）', () => {
    expect(routeOf(ROUTES.list)?.purity).toBe('chained')
    expect(routeOf(ROUTES.empty)?.purity).toBe('chained')
  })

  it('纯度：探测 / 扫描 / 详情不进链（一次探测或大正文读不该把删除按钮堵在身后）', () => {
    expect(routeOf(ROUTES.ping)?.purity).toBe('pure')
    expect(routeOf(ROUTES.orphans)?.purity).toBe('pure')
    expect(routeOf(ROUTES.detail)?.purity).toBe('pure')
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
