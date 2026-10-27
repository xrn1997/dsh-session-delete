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
    expect(t('trash.summary', { count: 3, size: '22KB' })).toBe('3 个会话 · 可释放 22KB')
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
    expect(en('trash.summary', { count: 3, size: '22KB' })).toBe('3 sessions · 22KB reclaimable')
    expect(en('detail.image.alt', { alt: 'shot' })).toBe('[Image · shot]')
    const combined = en('detail.deletedAt.combined', { relative: '2d ago', absolute: '10/14/2026' })
    expect(combined).toBe('2d ago (10/14/2026)')
    expect(combined).not.toMatch(/[\u4e00-\u9fff（）]/)
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

// 附件视图与“只清 .dsh 副本”那两句：zh 是真源，en 必须逐键镜像（键集合由类型盯住，
// 这里再钉“两套都出话、en 不带中文”，免得镜像值被填成键名或原文照抄）。
describe('附件相关文案', () => {
  const ATTACHMENT_KEYS = [
    'detail.attachment.file',
    'detail.attachment.preview',
    'detail.attachment.alt',
    'detail.attachment.open',
    'detail.attachment.unavailable',
    'detail.attachment.save',
    'detail.attachment.saving',
    'detail.attachment.saveFailed',
    'trash.attachments.failed',
    'trash.attachments.skipped',
    'trash.attachments.skippedPartial',
    'trash.attachments.alsoFailed',
    'trash.confirm.body',
    'trash.orphans.body',
    'trash.orphans.cacheNote',
  ] as const

  it('zh 给出附件视图文案，确认句写明只清 .dsh 副本、原图不动', () => {
    expect(zhTranslate('detail.attachment.file')).toBe('文件')
    expect(zhTranslate('detail.attachment.preview')).toBe('附件预览')
    expect(zhTranslate('detail.attachment.alt')).toBe('附件图片')
    expect(zhTranslate('detail.attachment.open', { name: 'shot.png' })).toBe('打开图片「shot.png」')
    expect(zhTranslate('detail.attachment.unavailable')).toBe('附件不可用')
    expect(zhTranslate('detail.attachment.save')).toBe('另存为')
    expect(zhTranslate('detail.attachment.saving')).toBe('保存中…')
    expect(zhTranslate('detail.attachment.saveFailed', { message: '盘上忙' })).toBe('保存失败：盘上忙')
    expect(zhTranslate('trash.attachments.failed', { count: 2 })).toBe('已删除会话，但 2 个附件未能清理')
    expect(zhTranslate('trash.attachments.skipped', { reason: '日志读不出' })).toBe('附件未清理：日志读不出')
    // 部分清掉的那一档不能冒充"整轮没清"：`skipped` 是"没敢清的那部分"，已清掉几件要一起说出来。
    expect(zhTranslate('trash.attachments.skippedPartial', { reason: '剩余引用源读不出', removed: 4 })).toBe(
      '部分附件未清理：剩余引用源读不出（已清理 4 个）',
    )
    // skipped 与 failed 同时出现时，失败件数追加在句尾；前缀自带分隔符，拼接处不留空。
    expect(zhTranslate('trash.attachments.alsoFailed', { count: 2 })).toBe('；另有 2 个附件删除失败')
    expect(zhTranslate('trash.confirm.body', { strong: '之后没有任何副本可以恢复' })).toContain('原图不受影响')
    expect(zhTranslate('trash.orphans.body')).toContain('原图不受影响')
    // 清理不是"一定清"：剩余引用源读不出时跳过附件，但会话目录照删。
    expect(zhTranslate('trash.orphans.body')).toContain('剩余引用源读不出')
    expect(zhTranslate('trash.orphans.body')).toContain('会话目录仍会删除')
    expect(zhTranslate('trash.orphans.cacheNote')).toContain('剩余引用源读不出')
    expect(zhTranslate('trash.orphans.cacheNote')).toContain('会话目录仍会删除')
  })

  it('en 逐键镜像：不是键名、不带中文，占位符插得进去', () => {
    const service = fakeLocale()
    createTranslate(contextWith(service))
    const [, dicts] = service.register.mock.calls[0] as [
      string,
      { zh: Record<string, string>; en: Record<string, string> },
    ]
    const en: Translate = (key, params) => {
      const template = dicts.en[key]
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        params !== undefined && name in params ? String(params[name]) : match,
      )
    }

    expect(Object.keys(dicts.en).sort()).toEqual(Object.keys(dicts.zh).sort())
    for (const key of ATTACHMENT_KEYS) {
      expect(dicts.en[key], key).toBeDefined()
      expect(dicts.en[key], key).not.toBe(key)
      expect(dicts.en[key], key).not.toMatch(/[\u4e00-\u9fff]/)
    }
    expect(en('detail.attachment.open', { name: 'shot.png' })).toBe('Open image “shot.png”')
    expect(en('trash.attachments.failed', { count: 2 })).toBe(
      'Sessions were deleted, but 2 attachments could not be cleaned',
    )
    expect(en('trash.attachments.skippedPartial', { reason: 'source unreadable', removed: 4 })).toBe(
      'Some attachments were not cleaned: source unreadable (4 cleaned)',
    )
    expect(en('trash.attachments.alsoFailed', { count: 2 })).toBe('; also 2 attachment deletions failed')
    expect(en('trash.confirm.body', { strong: 'no copy remains to restore it' })).toContain(
      'your original files are untouched',
    )
    expect(en('trash.orphans.body')).toContain('your original files are untouched')
    expect(en('trash.orphans.body')).toContain('remaining reference source cannot be read')
    expect(en('trash.orphans.body')).toContain('session directories are still deleted')
    // 这句是状语从句，不能写成「cleaned along」那种未完成句；同时不能漏掉"不包含投影缓存"那半句。
    expect(en('trash.orphans.cacheNote')).toBe(
      'Session-exclusive image attachment copies inside .dsh are cleaned as well; host projection caches are not included. If a remaining reference source cannot be read, attachment cleanup is skipped for that run (session directories are still deleted).',
    )
    expect(dicts.en['trash.orphans.cacheNote']).not.toMatch(/cleaned along/)
  })
})

// 维护卡（插件设置页）：两张段的状态 / 检查 / 确认 / 清理回执。zh 是真源，en 逐键镜像；
// 这里同时钉「确认句写明只清 .dsh 副本」那条用户可见事实，免得两种语言各漂各的。
describe('维护卡文案', () => {
  const MAINTENANCE_KEYS = [
    'maintenance.title',
    'maintenance.orphans.title',
    'maintenance.orphans.hint',
    'maintenance.attachments.title',
    'maintenance.attachments.hint',
    'maintenance.scan',
    'maintenance.scanning',
    'maintenance.cleaning',
    'maintenance.checkFailed',
    'maintenance.notScanned',
    'maintenance.none',
    'maintenance.orphans.count',
    'maintenance.attachments.count',
    'maintenance.attachments.scanFailed',
    'maintenance.attachments.cleaned',
    'maintenance.attachments.cleanFailed',
    'maintenance.attachments.cleanError',
    'maintenance.attachments.confirm',
    'maintenance.attachments.body',
    'maintenance.attachments.clean',
  ] as const

  it('zh 给出维护卡的状态档与附件确认句', () => {
    expect(zhTranslate('maintenance.title')).toBe('维护')
    expect(zhTranslate('maintenance.orphans.title')).toBe('孤儿会话')
    expect(zhTranslate('maintenance.attachments.title')).toBe('孤儿附件')
    expect(zhTranslate('maintenance.scan')).toBe('检查')
    expect(zhTranslate('maintenance.scanning')).toBe('检查中…')
    // 「清理中」与「检查中」是两档：清点/删除在飞时状态行不许说假话。
    expect(zhTranslate('maintenance.cleaning')).toBe('清理中…')
    // 检查/清理失败时状态行必须能说「检查失败」，不能回落到「尚未检查」。
    expect(zhTranslate('maintenance.checkFailed')).toBe('检查失败')
    expect(zhTranslate('maintenance.notScanned')).toBe('尚未检查')
    expect(zhTranslate('maintenance.none')).toBe('没有发现')
    expect(zhTranslate('maintenance.attachments.count', { count: 106 })).toBe('106 个')
    expect(zhTranslate('maintenance.attachments.scanFailed', { message: '引用源读不出' })).toBe(
      '检查失败：引用源读不出',
    )
    // 清理顶层失败给本地化前缀，不把服务端原文裸着上屏。
    expect(zhTranslate('maintenance.attachments.cleanError', { message: '盘上忙' })).toBe(
      '附件清理失败：盘上忙',
    )
    expect(zhTranslate('maintenance.attachments.cleaned', { count: 106, size: '27.8MB' })).toBe(
      '已清理 106 个（27.8MB）',
    )
    expect(zhTranslate('maintenance.attachments.confirm', { count: 106 })).toBe('查看并清理 106 个孤儿附件？')
    // 用户点「清理这些附件」之前必须看得到这三条边界。
    expect(zhTranslate('maintenance.attachments.body')).toBe(
      '只清理 .dsh 内无引用的图片副本；源文件不受影响；共享引用保留。',
    )
    expect(zhTranslate('maintenance.attachments.previewHint')).toBe('点图片可放大；关闭这个框不会删除任何东西。')
    expect(zhTranslate('maintenance.attachments.clean')).toBe('清理这些附件')
  })

  it('en 逐键镜像：不是键名、不带中文，确认句同样写明原文件与共享引用', () => {
    const service = fakeLocale()
    createTranslate(contextWith(service))
    const [, dicts] = service.register.mock.calls[0] as [
      string,
      { zh: Record<string, string>; en: Record<string, string> },
    ]
    const en: Translate = (key, params) => {
      const template = dicts.en[key]
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        params !== undefined && name in params ? String(params[name]) : match,
      )
    }

    expect(Object.keys(dicts.en).sort()).toEqual(Object.keys(dicts.zh).sort())
    for (const key of MAINTENANCE_KEYS) {
      expect(dicts.en[key], key).toBeDefined()
      expect(dicts.en[key], key).not.toBe(key)
      expect(dicts.en[key], key).not.toMatch(/[\u4e00-\u9fff]/)
    }
    expect(en('maintenance.title')).toBe('Maintenance')
    expect(en('maintenance.notScanned')).toBe('Not checked yet')
    expect(en('maintenance.cleaning')).toBe('Cleaning…')
    expect(en('maintenance.checkFailed')).toBe('Check failed')
    expect(en('maintenance.attachments.cleanError', { message: 'disk busy' })).toBe(
      'Attachment cleanup failed: disk busy',
    )
    expect(en('maintenance.attachments.body')).toContain('.dsh')
    expect(en('maintenance.attachments.body')).toContain('source files are untouched')
    expect(en('maintenance.attachments.body')).toContain('shared references are kept')
    expect(en('maintenance.attachments.cleaned', { count: 106, size: '27.8MB' })).toBe(
      'Cleaned 106 (27.8MB)',
    )
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
