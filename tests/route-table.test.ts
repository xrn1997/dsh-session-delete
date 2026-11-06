/**
 * 路由表（ADR-0004）：**一条记录**同时回答"用什么方法、纯不纯、要不要预读 body、怎么处理"。
 *
 * 这一份的存在理由就是"枚举整张表"：加一段而忘了声明纯度、把写动作写成纯读、或让 body 的分类漂掉，
 * 都在这里红——而不是等到真机上"删除按钮被一次探测堵在身后"或"写动作绕开了串行链"。
 */
import { describe, expect, it } from 'vitest'
import { APPLY_ACTIONS, ROUTE_TABLE, routeOf, type JsonRouteSpec, type SliceDeps } from '../src/api/route-table.js'
import { ROUTES } from '../src/shared/wire.js'
import type { ApplyAction } from '../src/shared/wire.js'

/** 段名表的十个路径（`ROUTES` 每项 `{ path, method }`，键集比对只认 path 这一格）。 */
const SEGMENTS = Object.values(ROUTES).map((seg) => seg.path)

/**
 * 只跑 `/apply` 行的栅栏：deps 与 read 都递替身——动作 / ids 栅栏在替身被碰到之前就抛，
 * 所以这里接住的是**栅栏自己的**错误。`run` 是 async，栅栏里的同步抛也会变成拒约，必须 await。
 */
async function runApply(body: Record<string, unknown>): Promise<unknown> {
  try {
    await (routeOf(ROUTES.apply.path) as JsonRouteSpec<'full'> | undefined)?.run(
      // @ts-expect-error  空替身：这条用例只验动作栅栏，deps 不会被消费
      {},
      body,
      { rows: async () => [] },
    )
    return undefined
  } catch (error) {
    return error
  }
}

describe('路由表 · 十个段名各一行', () => {
  it('段名表与路由表逐键对齐（`wire.ts` 加了段名而这里没加 ⇒ 编译不过，这条是运行期的同一件事）', () => {
    expect(Object.keys(ROUTE_TABLE).sort()).toEqual([...SEGMENTS].sort())
  })

  it('方法：十段的 method 逐条投影自 `wire.ts` 的段名表（方法字面量只住那一处，路由记录不再自写）', () => {
    for (const [name, seg] of Object.entries(ROUTES)) {
      const method = routeOf(seg.path)?.method
      // 先钉「这一段有路由行、方法在场」：段名表未结构化时 `seg.path` 掉成 undefined，
      // 下面那句相等会两边一起掉成 undefined 假绿——不加这句就从来没真验过投影。
      expect(`${name}:${method}`).not.toBe(`${name}:undefined`)
      // 逐段比对而不是抄一份「这段该是什么方法」的断言：判据在段名表里，测试只验投影没走样。
      expect(`${name}:${method}`).toBe(`${name}:${seg.method}`)
    }
  })

  it('方法：附件字节段是 GET + binary；孤儿附件报告是 GET + json，清理是 POST + json', () => {
    const attachment = routeOf(ROUTES.attachment.path)
    expect(attachment?.method).toBe('GET')
    expect(attachment?.body).toBe('none')
    expect(attachment?.purity).toBe('pure')
    expect(attachment?.read).toBe('none')
    expect(attachment?.response).toBe('binary')

    const report = routeOf(ROUTES.attachmentOrphans.path)
    expect(report?.method).toBe('GET')
    expect(report?.body).toBe('none')
    expect(report?.purity).toBe('pure')
    expect(report?.read).toBe('none')
    expect(report?.response).toBe('json')

    const clean = routeOf(ROUTES.attachmentClean.path)
    expect(clean?.method).toBe('POST')
    expect(clean?.body).toBe('none')
    expect(clean?.purity).toBe('chained')
    expect(clean?.read).toBe('none')
    expect(clean?.response).toBe('json')
  })

  it('response：只有附件段是 binary，其余九段都是 json', () => {
    for (const segment of SEGMENTS) {
      expect(`${segment}:${routeOf(segment)?.response}`)
        .toBe(`${segment}:${segment === ROUTES.attachment.path ? 'binary' : 'json'}`)
    }
  })

  it('body：POST 里的 apply / detail / config 需要 JSON 体，GET 一律不读（流只能消费一次）', () => {
    for (const segment of SEGMENTS) {
      const expectsBody = segment === ROUTES.apply.path || segment === ROUTES.detail.path || segment === ROUTES.config.path
      expect(`${segment}:${routeOf(segment)?.body}`).toBe(`${segment}:${expectsBody ? 'json' : 'none'}`)
    }
  })

  it('纯度：`list` / `empty` / `attachment-clean` 必须进到达序链（它们先对账或先扫引用源、再动盘与清册）', () => {
    expect(routeOf(ROUTES.list.path)?.purity).toBe('chained')
    expect(routeOf(ROUTES.empty.path)?.purity).toBe('chained')
    expect(routeOf(ROUTES.attachmentClean.path)?.purity).toBe('chained')
  })

  it('纯度：探测 / 扫描 / 详情 / 附件读取不进链（一次探测或大正文读不该把删除按钮堵在身后）', () => {
    expect(routeOf(ROUTES.ping.path)?.purity).toBe('pure')
    expect(routeOf(ROUTES.orphans.path)?.purity).toBe('pure')
    expect(routeOf(ROUTES.detail.path)?.purity).toBe('pure')
    expect(routeOf(ROUTES.attachment.path)?.purity).toBe('pure')
    expect(routeOf(ROUTES.attachmentOrphans.path)?.purity).toBe('pure')
  })

  it('纯度：`apply` 里只有 count 是纯读，其余四个动作都进链', () => {
    const purity = routeOf(ROUTES.apply.path)?.purity
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

  it('纯度：`/config` 空体是读、带字段是写——写进链（configEditor.edit 会重启这一行）', () => {
    const purity = routeOf(ROUTES.config.path)?.purity
    expect(typeof purity).toBe('function')
    const of = purity as (body: Record<string, unknown> | null) => string
    expect(of(null)).toBe('pure')
    expect(of({})).toBe('pure')
    expect(of({ orphanPreviewLimit: 1 })).toBe('chained')
  })

  it('读面：每一段声明自己该拿到的清册读面', () => {
    expect(routeOf(ROUTES.list.path)?.read).toBe('list')
    expect(routeOf(ROUTES.empty.path)?.read).toBe('list')
    expect(routeOf(ROUTES.orphans.path)?.read).toBe('raw')
    expect(routeOf(ROUTES.detail.path)?.read).toBe('raw')
    expect(routeOf(ROUTES.ping.path)?.read).toBe('none')
    expect(routeOf(ROUTES.config.path)?.read).toBe('none')
    expect(routeOf(ROUTES.apply.path)?.read).toBe('none')
    // 孤儿附件两段读的是引用源与附件库，不读回收站清册。
    expect(routeOf(ROUTES.attachmentOrphans.path)?.read).toBe('none')
    expect(routeOf(ROUTES.attachmentClean.path)?.read).toBe('none')
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

  it('纯度与动作拒否是同一个识别器：每个动作一份判据，不认识的动作两处同一句话', async () => {
    const purity = routeOf(ROUTES.apply.path)?.purity
    expect(typeof purity).toBe('function')
    const of = purity as (body: Record<string, unknown> | null) => string
    // 拒否原文从同一份名单（APPLY_ACTIONS）长出：测试不另抄一份动作名单，抄了就是第二份判据。
    const reject = `批量动作不认识：需是 ${APPLY_ACTIONS.join(' / ')} 之一`
    // 逐动作两侧对齐：纯度说 count 是纯读、其余进链；run 那一侧认得同一个动作——
    // 它拒的不是「动作不认识」那句（下一档栅栏 ids 接住了它，说明动作已经过了识别器）。
    // 这个推断有前提：路由行把 `requireAction` 排在 `requireIdArray` **之前**求值（参数从左到右）；
    // 顺序反过来，ids 栅栏会先抛、本用例照样绿却不再证明「已过识别器」——改那行 run 时先回来核这句。
    for (const action of APPLY_ACTIONS) {
      expect(`${action}:${of({ action })}`).toBe(`${action}:${action === 'count' ? 'pure' : 'chained'}`)
      const error = await runApply({ action })
      expect(error, `${action} 应被 run 的识别器认下`).toBeInstanceOf(Error)
      expect((error as Error).message).not.toBe(reject)
    }
    // 不认识的动作（含没有动作）：纯度判 chained（不许插队先跑），run 响亮拒掉——
    // 两侧必须是同一句话，不然「纯度认得、拒否不认得」（或反过来）就会在真机上以奇怪的形态冒出来。
    expect(of(null)).toBe('chained')
    expect(of({ action: 'nope' })).toBe('chained')
    const error = (await runApply({ action: 'nope', ids: ['s-1'] })) as Error & { httpStatus?: number }
    expect(error.message).toBe(reject)
    expect(error.httpStatus).toBe(400)
  })
})

describe('路由表 · 按段声明 deps 切片', () => {
  it('读与探测五段声明 core：它们只要基础面（不删盘、不读时钟）', () => {
    const core: readonly string[] = [ROUTES.list.path, ROUTES.ping.path, ROUTES.attachmentOrphans.path, ROUTES.orphans.path, ROUTES.detail.path]
    for (const segment of core) {
      expect(`${segment}:${routeOf(segment)?.slice}`).toBe(`${segment}:core`)
    }
  })

  it('attachment 段声明 attachment：它多一条宿主 attachments 读面，不拿删除能力', () => {
    expect(routeOf(ROUTES.attachment.path)?.slice).toBe('attachment')
  })

  it('两个删盘段声明 removal：只多删除能力（removeDir / removeFile），仍不读时钟', () => {
    const removal: readonly string[] = [ROUTES.attachmentClean.path, ROUTES.empty.path]
    for (const segment of removal) {
      expect(`${segment}:${routeOf(segment)?.slice}`).toBe(`${segment}:removal`)
    }
  })

  it('apply 声明 full：全仓唯一既读时钟又删盘的行', () => {
    expect(routeOf(ROUTES.apply.path)?.slice).toBe('full')
  })

  it('config 声明 config：只多 configEditor + entry，不拿删除能力与清册读面', () => {
    expect(routeOf(ROUTES.config.path)?.slice).toBe('config')
  })

  /** 切片闸的类型面：删目录 / 删单文件是永久删除的执行能力，只许出现在 removal / full 两格上。 */
  const coreSliceHasNoRemoveDir: 'removeDir' extends keyof SliceDeps['core']['fs'] ? false : true = true
  const removalSliceHasRemoveDir: 'removeDir' extends keyof SliceDeps['removal']['fs'] ? true : false = true

  it('core 切片不含删除能力；core 段的 run 传不进比它更宽的面', () => {
    expect(coreSliceHasNoRemoveDir).toBe(true)
    expect(removalSliceHasRemoveDir).toBe(true)
    // core 段的 run 只吃自己那一格：`{}` 连 fs / host 都没有，十格里没有一格满足得了。
    // 闭包只作类型证据、不真跑（真跑要一组假端口，那归 `tests/api.test.ts`）。
    const callWithEmptyDeps = (): unknown =>
      // @ts-expect-error core 段的 run 只吃自己那一格：空 deps 必须编译不过
      (routeOf(ROUTES.list.path) as JsonRouteSpec<'core'> | undefined)?.run({}, null, { rows: async () => [] })
    expect(callWithEmptyDeps).toBeTypeOf('function')
  })

  it('run 是函数属性而不是方法：显式标注更宽的 deps 也过不了切片闸', () => {
    // 方法签名是双变的——把 run 写成方法时，这条宽参写法能编译；改成函数属性后按逆变拒绝。
    const wideRun: JsonRouteSpec<'core'> = {
      ...(routeOf(ROUTES.list.path) as JsonRouteSpec<'core'>),
      // @ts-expect-error core 段的 run 不接受 full 面（DeleteDeps）
      run: async (deps: SliceDeps['full']) => { void deps.now() },
    }
    expect(wideRun.slice).toBe('core')
  })
})
