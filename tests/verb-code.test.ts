import { describe, expect, it } from 'vitest'
import { VERB_CODES, isSessionDeleteCodeError, verbCodeOf } from '../src/shared/wire.js'
import { routeError, verbError } from '../src/verbs/errors.js'

describe('动词码的两条读法', () => {
  // 名单直接取 `VERB_CODES`（失败码的主人），这里不抄第二份、也不抄「几个」：多一个码就自动多钉一个。
  it('在册的每一个动词码都解得回自己', () => {
    for (const code of VERB_CODES) {
      expect(verbCodeOf(verbError(code, 'x'))).toBe(code)
    }
  })

  // 两条读法问的不是同一件事：前缀那条答「是不是本仓的失败形状」，取词那条还要求后缀在册。
  it('前缀对、后缀不在册 ⇒ 形状算、码解不出', () => {
    expect(isSessionDeleteCodeError({ code: 'sessiondelete/nope' })).toBe(true)
    expect(verbCodeOf({ code: 'sessiondelete/nope' })).toBeUndefined()
    expect(isSessionDeleteCodeError({ code: 'sessiondelete/' })).toBe(true)
    expect(verbCodeOf({ code: 'sessiondelete/' })).toBeUndefined()
  })

  it('路由自检码是同一个域、但不是动词码', () => {
    const bad = routeError('bad-request', 400, '请求体不对')
    expect(isSessionDeleteCodeError(bad)).toBe(true)
    expect(verbCodeOf(bad)).toBeUndefined()
  })

  it('宿主域与非字符串 code 两条都不算', () => {
    expect(isSessionDeleteCodeError({ code: 'dsh/xxx' })).toBe(false)
    expect(verbCodeOf({ code: 'dsh/xxx' })).toBeUndefined()
    expect(isSessionDeleteCodeError({ code: 42 })).toBe(false)
    expect(verbCodeOf({ code: 42 })).toBeUndefined()
    expect(isSessionDeleteCodeError('sessiondelete/io')).toBe(false)
    expect(verbCodeOf('sessiondelete/io')).toBeUndefined()
    expect(isSessionDeleteCodeError(undefined)).toBe(false)
    expect(verbCodeOf(null)).toBeUndefined()
  })
})
