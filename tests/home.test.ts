import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveHome } from '../src/ports/home.js'

/**
 * 假 home：绝对且与 cwd 无关的字符串。`resolveHome` 只把它当"用户主目录"来拼路径，
 * 不碰真实 `homedir()`——这样期望值全是 `join`/`resolve` 算出来的，Windows/POSIX 都成立。
 */
const HOME = resolve(process.cwd(), 'fake-home')

describe('resolveHome（宿主数据根）', () => {
  it('绝对 DSH_HOME ⇒ resolve(raw)', () => {
    const raw = join(HOME, 'abs-dsh')
    expect(resolveHome({ DSH_HOME: raw }, HOME)).toBe(resolve(raw))
  })

  // 空白视为未设（免得非法覆盖把 home 解析成当前工作目录）——官方 `resolveDshHome` 的判据。
  it('空白 DSH_HOME ⇒ join(home, ".dsh")', () => {
    for (const blank of ['', '   ', '\t\n']) {
      expect(resolveHome({ DSH_HOME: blank }, HOME)).toBe(join(HOME, '.dsh'))
    }
  })

  it('DSH_HOME 缺席 ⇒ join(home, ".dsh")', () => {
    expect(resolveHome({}, HOME)).toBe(join(HOME, '.dsh'))
  })

  it('"~/dsh" ⇒ resolve(join(home, "dsh"))', () => {
    expect(resolveHome({ DSH_HOME: '~/dsh' }, HOME)).toBe(resolve(join(HOME, 'dsh')))
  })

  it('"~" ⇒ home 本身', () => {
    expect(resolveHome({ DSH_HOME: '~' }, HOME)).toBe(HOME)
  })

  it('相对 DSH_HOME ⇒ resolve(raw)（相对 cwd）', () => {
    expect(resolveHome({ DSH_HOME: 'rel-home' }, HOME)).toBe(resolve('rel-home'))
  })

  it('不传 env/home 时仍返回字符串（冒烟）', () => {
    const home = resolveHome()
    expect(typeof home).toBe('string')
    expect(home.length).toBeGreaterThan(0)
  })
})
