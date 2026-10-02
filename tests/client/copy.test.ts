// 文案与 locale 服务（`src/client/copy.ts`）—— 不渲染任何组件，只钉那条接线契约。
//
// 这一层为什么值得单独测：它是**唯一一处"服务可选"的接线**。写错的表现不是报错，而是
// ①整套界面变成英文键名（`trash.title` 这种字面量直接上屏，宿主 `translate` 查不到就回键名），
// 或者 ②服务缺席时整个客户端条目 pending ⇒ 宿主启动自检致命失败（`web boot: N entry did not activate`）。
import { describe, expect, it, vi } from 'vitest'
import { createTranslate, splitOn, zhTranslate, type Translate } from '../../src/client/copy.js'
import type { ClientContextLike } from '../../src/client/context.js'

/** 假 locale 服务：`bind` 直接去 `register` 收到的那份字典里查，于是"两套语言都齐、查得出话"可测。 */
function fakeLocale() {
  const dicts = new Map<string, { zh: Record<string, string>; en: Record<string, string> }>()
  const register = vi.fn((ns: string, value: { zh: Record<string, string>; en: Record<string, string> }) => {
    dicts.set(ns, value)
    return () => {
      dicts.delete(ns)
    }
  })
  const bind = vi.fn((ns: string) => (key: string, params?: Record<string, string | number>) => {
    const template = dicts.get(ns)?.zh[key]
    if (template === undefined) return key
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      params !== undefined && name in params ? String(params[name]) : match,
    )
  })
  return { register, bind, dicts }
}

function contextWith(service: unknown): ClientContextLike {
  return {
    slots: { inject: vi.fn(), register: vi.fn() },
    get: () => service,
    effect: (execute: () => unknown) => execute(),
  }
}

describe('文案接线', () => {
  it('服务在：注册字典挂进 effect，并交回宿主 bind 出来的 t', () => {
    const service = fakeLocale()
    const t = createTranslate(contextWith(service))

    expect(service.register).toHaveBeenCalledTimes(1)
    const [ns, dicts] = service.register.mock.calls[0] as [
      string,
      { zh: Record<string, string>; en: Record<string, string> },
    ]
    // 命名空间必须带插件专属前缀（宿主的公共命名空间是 common / settings / sidebar 这些）。
    expect(ns).toBe('xrn1997-session-delete')
    // 宿主 register 的**对象形式要求两套内置语言都齐**：键集合必须逐字相同，缺一个就是运行期报错。
    expect(Object.keys(dicts.en).sort()).toEqual(Object.keys(dicts.zh).sort())
    expect(Object.keys(dicts.zh).length).toBeGreaterThan(30)
    // 宿主那条路给出来的是中文原话（不是键名）。
    expect(t('trash.title')).toBe('回收站')
    expect(t('trash.summary', { count: 3, size: '22KB' })).toBe('3 个会话 · 共 22KB')
  })

  it('服务在时英文也能出话（en 不是空壳）', () => {
    const service = fakeLocale()
    createTranslate(contextWith(service))
    const [ns, dicts] = service.register.mock.calls[0] as [
      string,
      { zh: Record<string, string>; en: Record<string, string> },
    ]
    const en: Translate = (key, params) => {
      const template = dicts.en[key]
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        params !== undefined && name in params ? String(params[name]) : match,
      )
    }
    expect(en('trash.title')).toBe('Trash')
    expect(en('trash.summary', { count: 3, size: '22KB' })).toBe('3 sessions · 22KB total')
    expect(en('menu.live')).not.toBe('menu.live')
    expect(ns).toBe('xrn1997-session-delete')
  })

  it('服务缺席（或老宿主没有 ctx.get）：退回内置 zh，不抛、不进 inject', () => {
    const withoutGet: ClientContextLike = {
      slots: { inject: vi.fn(), register: vi.fn() },
      effect: vi.fn(),
    }
    expect(createTranslate(withoutGet)('trash.title')).toBe('回收站')
    // 拿不到服务时**什么都不注册**（注册表里不该出现半个命名空间）。
    expect(withoutGet.effect).not.toHaveBeenCalled()

    const withNone = createTranslate(contextWith(undefined))
    expect(withNone).toBe(zhTranslate)
    expect(withNone('menu.delete')).toBe('删除')
  })

  it('注册是 effect（卸载即摘）：`register` 交回的 disposer 真进了框架', () => {
    const service = fakeLocale()
    const dispose = vi.fn()
    service.register.mockReturnValue(dispose)
    let disposer: unknown
    const ctx: ClientContextLike = {
      slots: { inject: vi.fn(), register: vi.fn() },
      get: () => service,
      effect: (execute: () => unknown) => {
        disposer = execute()
      },
    }
    createTranslate(ctx)
    // `register` 的返回值就是那句 disposer（官方契约），没挂进 effect 的话
    // HMR 重挂会撞 "locale namespace … already has locale …"。
    expect(disposer).toBe(dispose)
  })
})

describe('splitOn（整句一个键，按内嵌段切开渲染）', () => {
  it('按内嵌的那一段切开，前后原样', () => {
    expect(splitOn('这会移除文件，之后不可恢复。', '之后不可恢复')).toEqual([
      '这会移除文件，',
      '之后不可恢复',
      '。',
    ])
  })

  it('找不到内嵌段时整句进第一段（不静默丢字）', () => {
    expect(splitOn('整句话', '不在里面')).toEqual(['整句话', '', ''])
  })
})
