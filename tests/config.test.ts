import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { Config, DEFAULT_CONFIG, normalizeConfig } from '../src/config.js'

describe('Config · 可调项（ADR-0037）', () => {
  it('缺省 / 空对象回默认值', () => {
    expect(normalizeConfig(undefined)).toEqual(DEFAULT_CONFIG)
    expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG)
    expect(normalizeConfig({})).toEqual(DEFAULT_CONFIG)
  })

  it('部分字段合并默认值', () => {
    expect(normalizeConfig({ orphanPreviewLimit: 10 })).toEqual({ ...DEFAULT_CONFIG, orphanPreviewLimit: 10 })
  })

  it('非法值响亮抛错：未知键 / 非对象 / 非整数 / 越界', () => {
    expect(() => normalizeConfig({ nope: 1 })).toThrow('未知配置项')
    expect(() => normalizeConfig([])).toThrow('对象')
    expect(() => normalizeConfig({ orphanPreviewLimit: 0 })).toThrow('orphanPreviewLimit')
    expect(() => normalizeConfig({ orphanPreviewLimit: 1.5 })).toThrow('orphanPreviewLimit')
    expect(() => normalizeConfig({ maxAttachmentBytes: 'x' })).toThrow('maxAttachmentBytes')
    expect(() => normalizeConfig({ maxJsonRefBytes: 100 * 1024 * 1024 + 1 })).toThrow('maxJsonRefBytes')
  })

  it('Standard Schema 的 validate 交回归一值或 issues', () => {
    expect(Config['~standard'].validate({ orphanPreviewLimit: 5 })).toEqual({
      value: { ...DEFAULT_CONFIG, orphanPreviewLimit: 5 },
    })
    const bad = Config['~standard'].validate({ orphanPreviewLimit: 0 })
    expect('issues' in bad).toBe(true)
    if ('issues' in bad) expect(bad.issues[0]?.message).toContain('orphanPreviewLimit')
  })

  it('坏配置让插件激活失败：apply 第一步就校验，不拿半套配置启动', () => {
    expect(() => apply({} as never, { nope: 1 })).toThrow('未知配置项')
    expect(() => apply({} as never, { maxAttachmentBytes: 0 })).toThrow('maxAttachmentBytes')
  })
})
