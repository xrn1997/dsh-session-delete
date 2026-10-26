import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type { CoreDeps, DeleteDeps, DeleteSessionDeps, RemovalDeps } from '../src/deps.js'
import type { HostPresencePort } from '../src/ports/host-port.js'
import type { PresenceCapability } from '../src/ports/presence-port.js'
import { createFakeDeps } from './support/fake-deps.js'

/** 少一个键就编译失败：`Record<keyof CoreDeps, true>` 的初值不允许缺格。 */
const coreKeys: Record<keyof CoreDeps, true> = { fs: true, host: true, ledger: true, home: true, presence: true }
/** 多一个键也编译失败：CoreDeps 的键集必须被这五个字面量盖住。 */
const coreIsExhaustive: Exclude<keyof CoreDeps, 'fs' | 'host' | 'ledger' | 'home' | 'presence'> extends never ? true : false = true

/** 会话删除只多一个 now；它是唯一读时钟的动词。 */
const deleteSessionKeys: Record<keyof DeleteSessionDeps, true> = { fs: true, host: true, ledger: true, home: true, presence: true, now: true }
const deleteSessionIsExhaustive: Exclude<keyof DeleteSessionDeps, 'fs' | 'host' | 'ledger' | 'home' | 'presence' | 'now'> extends never ? true : false = true
const deleteSessionHasNow: 'now' extends keyof DeleteSessionDeps ? true : false = true
const coreHasNow: 'now' extends keyof CoreDeps ? true : false = false

/** 组合根的全量面 = 会话删除的时钟 + 永久删除的能力；键集与 DeleteSessionDeps 相同。 */
const deleteKeys: Record<keyof DeleteDeps, true> = { fs: true, host: true, ledger: true, home: true, presence: true, now: true }
const deleteIsExhaustive: Exclude<keyof DeleteDeps, 'fs' | 'host' | 'ledger' | 'home' | 'presence' | 'now'> extends never ? true : false = true

/** 能力闸：removeDir 只在永久删除的执行面；动词的 host 面不含在场三件（它们经 PresenceCapability）。 */
type CoreFsRemoveDir = 'removeDir' extends keyof CoreDeps['fs'] ? true : false
const coreFsRemoveDir: CoreFsRemoveDir = false
type DeleteSessionFsRemoveDir = 'removeDir' extends keyof DeleteSessionDeps['fs'] ? true : false
const deleteSessionFsRemoveDir: DeleteSessionFsRemoveDir = false
type RemovalFsRemoveDir = 'removeDir' extends keyof RemovalDeps['fs'] ? true : false
const removalFsRemoveDir: RemovalFsRemoveDir = true
type DeleteFsRemoveDir = 'removeDir' extends keyof DeleteDeps['fs'] ? true : false
const deleteFsRemoveDir: DeleteFsRemoveDir = true
/** 按整个在场角色面拦，不列三个名字：端口将来多出第四条也不会漏进动词的 `host`。 */
type CoreHostPresence = Extract<keyof CoreDeps['host'], keyof HostPresencePort>
const coreHostHasNoPresence: CoreHostPresence extends never ? true : false = true

/** 能力面恰好三条：少一条或多一条都编译失败。 */
type PresenceKeys = keyof PresenceCapability
type PresenceKeysExact = Exclude<PresenceKeys, 'memberGone' | 'memberBack' | 'announceRestored'> extends never
  ? Exclude<'memberGone' | 'memberBack' | 'announceRestored', PresenceKeys> extends never
    ? true
    : false
  : false
const presenceKeysExact: PresenceKeysExact = true

const SRC = fileURLToPath(new URL('../src', import.meta.url))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name)
    if (item.isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(item.name) ? [path] : []
  })
}

it('CoreDeps 是五项基础；会话删除加时钟，组合根再加永久删除能力', () => {
  expect(Object.keys(coreKeys)).toEqual(['fs', 'host', 'ledger', 'home', 'presence'])
  expect(coreIsExhaustive).toBe(true)
  expect(Object.keys(deleteSessionKeys)).toEqual(['fs', 'host', 'ledger', 'home', 'presence', 'now'])
  expect(deleteSessionIsExhaustive).toBe(true)
  expect(deleteSessionHasNow).toBe(true)
  expect(coreHasNow).toBe(false)
  expect(Object.keys(deleteKeys)).toEqual(['fs', 'host', 'ledger', 'home', 'presence', 'now'])
  expect(deleteIsExhaustive).toBe(true)
  expect(coreFsRemoveDir).toBe(false)
  expect(deleteSessionFsRemoveDir).toBe(false)
  expect(removalFsRemoveDir).toBe(true)
  expect(deleteFsRemoveDir).toBe(true)
  expect(coreHostHasNoPresence).toBe(true)
})

it('装配出的 deps 带在场能力', () => {
  const { deps } = createFakeDeps()
  expect(Object.keys(deps.presence).sort()).toEqual(['announceRestored', 'memberBack', 'memberGone'])
  expect(presenceKeysExact).toBe(true)
})

it('在场能力只有一个实现：createMemberPresence 只定义在 member-presence.ts', () => {
  const owners = sourceFiles(SRC)
    .filter((file) => readFileSync(file, 'utf8').includes('export function createMemberPresence'))
    .map((file) => relative(SRC, file).replaceAll('\\', '/'))
  expect(owners).toEqual(['verbs/member-presence.ts'])
})
