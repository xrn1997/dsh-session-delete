import { expect, it } from 'vitest'
import { slicesOf } from '../src/api/dispatch.js'
import type { CoreDeps, DeleteDeps, DeleteSessionDeps, RemovalDeps } from '../src/deps.js'
import { FS_CORE_METHODS, FS_REMOVAL_METHODS } from '../src/ports/fs-port.js'
import type { HostPresencePort } from '../src/ports/host-port.js'
import type { PresenceCapability } from '../src/ports/presence-port.js'
import { createMemberPresence, type MemberPresenceHost } from '../src/verbs/member-presence.js'
import { createFakeDeps } from './support/fake-deps.js'

/** 少一个键就编译失败：`Record<keyof CoreDeps, true>` 的初值不允许缺格。 */
const coreKeys: Record<keyof CoreDeps, true> = { fs: true, host: true, ledger: true, home: true, presence: true, config: true }
/** 多一个键也编译失败：CoreDeps 的键集必须被这六个字面量盖住。 */
const coreIsExhaustive: Exclude<keyof CoreDeps, 'fs' | 'host' | 'ledger' | 'home' | 'presence' | 'config'> extends never ? true : false = true

/** 会话删除只多一个 now；它是唯一读时钟的动词。 */
const deleteSessionKeys: Record<keyof DeleteSessionDeps, true> = { fs: true, host: true, ledger: true, home: true, presence: true, config: true, now: true }
const deleteSessionIsExhaustive: Exclude<keyof DeleteSessionDeps, 'fs' | 'host' | 'ledger' | 'home' | 'presence' | 'config' | 'now'> extends never ? true : false = true
const deleteSessionHasNow: 'now' extends keyof DeleteSessionDeps ? true : false = true
const coreHasNow: 'now' extends keyof CoreDeps ? true : false = false

/** 组合根的全量面 = 会话删除的时钟 + 永久删除的能力 + 附件读面；另带 `/config` 写支的两件。 */
const deleteKeys: Record<keyof DeleteDeps, true> = { fs: true, host: true, ledger: true, home: true, presence: true, config: true, now: true, attachments: true, configEditor: true, entry: true }
const deleteIsExhaustive: Exclude<keyof DeleteDeps, 'fs' | 'host' | 'ledger' | 'home' | 'presence' | 'config' | 'now' | 'attachments' | 'configEditor' | 'entry'> extends never ? true : false = true

/** 能力闸：removeDir 只在永久删除的执行面；动词的 host 面不含在场三件（它们经 PresenceCapability）。 */
type CoreFsRemoveDir = 'removeDir' extends keyof CoreDeps['fs'] ? true : false
const coreFsRemoveDir: CoreFsRemoveDir = false
type DeleteSessionFsRemoveDir = 'removeDir' extends keyof DeleteSessionDeps['fs'] ? true : false
const deleteSessionFsRemoveDir: DeleteSessionFsRemoveDir = false
type RemovalFsRemoveDir = 'removeDir' extends keyof RemovalDeps['fs'] ? true : false
const removalFsRemoveDir: RemovalFsRemoveDir = true
type DeleteFsRemoveDir = 'removeDir' extends keyof DeleteDeps['fs'] ? true : false
const deleteFsRemoveDir: DeleteFsRemoveDir = true
/** 同一条闸管单文件删除：它比 `removeDir` 更危险（附件清理只许点 `.dsh` 图片对象），基础面不许有。 */
type CoreFsRemoveFile = 'removeFile' extends keyof CoreDeps['fs'] ? true : false
const coreFsRemoveFile: CoreFsRemoveFile = false
type DeleteSessionFsRemoveFile = 'removeFile' extends keyof DeleteSessionDeps['fs'] ? true : false
const deleteSessionFsRemoveFile: DeleteSessionFsRemoveFile = false
type RemovalFsRemoveFile = 'removeFile' extends keyof RemovalDeps['fs'] ? true : false
const removalFsRemoveFile: RemovalFsRemoveFile = true
type DeleteFsRemoveFile = 'removeFile' extends keyof DeleteDeps['fs'] ? true : false
const deleteFsRemoveFile: DeleteFsRemoveFile = true
/** 按整个在场角色面拦，不列三个名字：端口将来多出第四条也不会漏进动词的 `host`。 */
type CoreHostPresence = Extract<keyof CoreDeps['host'], keyof HostPresencePort>
const coreHostHasNoPresence: CoreHostPresence extends never ? true : false = true

/** 能力面恰好三条字符串方法：少一条或多一条都编译失败。品牌键是 symbol（只用于盖章、不承载语义），
 *  不算一条能力、也不进 `Object.keys`——这条闸按字符串键数。 */
type PresenceKeys = Extract<keyof PresenceCapability, string>
type PresenceKeysExact = Exclude<PresenceKeys, 'memberGone' | 'memberBack' | 'announceRestored'> extends never
  ? Exclude<'memberGone' | 'memberBack' | 'announceRestored', PresenceKeys> extends never
    ? true
    : false
  : false
const presenceKeysExact: PresenceKeysExact = true

/** 这条类型级常量是同义反复（`createMemberPresence` 的声明返回面本就是 `PresenceCapability`），
 *  只把「仓内唯一盖章处」摆成一行可读证据；**承重的闸是下面用例里的 `@ts-expect-error` 伪造断言**——
 *  手拼的三件套形状再像也过不了品牌键，那行删掉 `pnpm typecheck` 就红。 */
type OnlyMemberPresence = ReturnType<typeof createMemberPresence> extends PresenceCapability ? true : false
const onlyMemberPresence: OnlyMemberPresence = true

/** 上面这些常量由 `tsc` 在编译期求值：真正的闸是 `pnpm typecheck`。下面的 expect 把当前形状钉成
 *  可读的运行期证据；常量本身受 `noUnusedLocals` 约束，删 expect 时要连常量一起删。 */
it('CoreDeps 是六项基础；会话删除加时钟，组合根再加永久删除能力与附件读面', () => {
  expect(Object.keys(coreKeys)).toEqual(['fs', 'host', 'ledger', 'home', 'presence', 'config'])
  expect(coreIsExhaustive).toBe(true)
  expect(Object.keys(deleteSessionKeys)).toEqual(['fs', 'host', 'ledger', 'home', 'presence', 'config', 'now'])
  expect(deleteSessionIsExhaustive).toBe(true)
  expect(deleteSessionHasNow).toBe(true)
  expect(coreHasNow).toBe(false)
  expect(Object.keys(deleteKeys)).toEqual(['fs', 'host', 'ledger', 'home', 'presence', 'config', 'now', 'attachments', 'configEditor', 'entry'])
  expect(deleteIsExhaustive).toBe(true)
  expect(coreFsRemoveDir).toBe(false)
  expect(deleteSessionFsRemoveDir).toBe(false)
  expect(removalFsRemoveDir).toBe(true)
  expect(deleteFsRemoveDir).toBe(true)
  expect(coreFsRemoveFile).toBe(false)
  expect(deleteSessionFsRemoveFile).toBe(false)
  expect(removalFsRemoveFile).toBe(true)
  expect(deleteFsRemoveFile).toBe(true)
  expect(coreHostHasNoPresence).toBe(true)
})

it('deps 切片的收窄是运行期事实：core 没有删除能力与时钟', () => {
  const { deps } = createFakeDeps()
  const slices = slicesOf(deps)
  expect(slices.core).not.toHaveProperty('now')
  expect(slices.core).not.toHaveProperty('attachments')
  expect(slices.core.fs).not.toHaveProperty('removeDir')
  expect(slices.core.fs).not.toHaveProperty('removeFile')
  // 名单是收窄的唯一依据（ADR-0032）：运行期带的方法**恰好**是 `FS_CORE_METHODS` 那一串，
  // 多给一格就是类型上说得通、盘上却递出了能力。
  expect(Object.keys(slices.core.fs).sort()).toEqual([...FS_CORE_METHODS].sort())
  expect(slices.core.config).toBe(deps.config)
  expect(slices.attachment.attachments).toBe(deps.attachments)
  expect(slices.config.config).toBe(deps.config)
  expect(slices.config).not.toHaveProperty('now')
  expect(slices.config).not.toHaveProperty('attachments')
  expect(slices.removal).not.toHaveProperty('now')
  expect(slices.removal.fs).toHaveProperty('removeDir')
  expect(slices.removal.fs).toHaveProperty('removeFile')
  // `removal` 也是**现切**的一片（ADR-0032）：恰好是基础面 + 删除能力，不是整颗 `full.fs`。
  expect(Object.keys(slices.removal.fs).sort()).toEqual(
    [...FS_CORE_METHODS, ...FS_REMOVAL_METHODS].sort(),
  )
  expect(slices.removal.fs).not.toBe(deps.fs)
  expect(slices.full).toBe(deps)
})

it('装配出的 deps 带在场能力', () => {
  const { deps } = createFakeDeps()
  expect(Object.keys(deps.presence).sort()).toEqual(['announceRestored', 'memberBack', 'memberGone'])
  expect(presenceKeysExact).toBe(true)
})

it('在场能力只认 createMemberPresence 盖过章的实现（品牌门，不再扫源码数实现）', () => {
  const host: MemberPresenceHost = {
    async evictLive() { return 'unknown' },
    async announceRemoved() {},
    async announceRestored() {},
  }
  const presence = createMemberPresence(host) satisfies PresenceCapability
  expect(onlyMemberPresence).toBe(true)
  expect(Object.keys(presence).sort()).toEqual(['announceRestored', 'memberBack', 'memberGone'])
  // 手拼的三件套形状再像也没有品牌键：这条赋值必须编译不过——`@ts-expect-error` 是闸，
  // 删了它 `pnpm typecheck` 就红。
  // @ts-expect-error 手拼的三件套没有品牌键：这条赋值必须编译不过
  const forged: PresenceCapability = {
    async memberGone() {},
    async memberBack() {},
    async announceRestored() {},
  }
  expect(Object.keys(forged).sort()).toEqual(['announceRestored', 'memberBack', 'memberGone'])
})
