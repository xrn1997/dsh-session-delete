import { expect, it } from 'vitest'
import type { CoreDeps, DeleteDeps } from '../src/deps.js'

/** 少一个键就编译失败：`Record<keyof CoreDeps, true>` 的初值不允许缺格。 */
const coreKeys: Record<keyof CoreDeps, true> = { fs: true, host: true, ledger: true, home: true }
/** 多一个键也编译失败：CoreDeps 的键集必须被这四个字面量盖住。 */
const coreIsExhaustive: Exclude<keyof CoreDeps, 'fs' | 'host' | 'ledger' | 'home'> extends never ? true : false = true

/** DeleteDeps 只多一个 now；删除是唯一读时钟的动词。 */
const deleteKeys: Record<keyof DeleteDeps, true> = { fs: true, host: true, ledger: true, home: true, now: true }
const deleteIsExhaustive: Exclude<keyof DeleteDeps, 'fs' | 'host' | 'ledger' | 'home' | 'now'> extends never ? true : false = true
const deleteHasNow: 'now' extends keyof DeleteDeps ? true : false = true
const coreHasNow: 'now' extends keyof CoreDeps ? true : false = false

it('CoreDeps is the four-field base; DeleteDeps adds the delete-only clock', () => {
  expect(Object.keys(coreKeys)).toEqual(['fs', 'host', 'ledger', 'home'])
  expect(coreIsExhaustive).toBe(true)
  expect(Object.keys(deleteKeys)).toEqual(['fs', 'host', 'ledger', 'home', 'now'])
  expect(deleteIsExhaustive).toBe(true)
  expect(deleteHasNow).toBe(true)
  expect(coreHasNow).toBe(false)
})
