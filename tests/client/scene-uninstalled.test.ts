/**
 * 进程场景只认安装的那一份（ADR-0067）：未安装时读取直接响亮失败，不懒建第二份账。
 * `vi.resetModules()` 绕开 `support/setup.ts` 每例装入的场景，拿到一枚真正未安装的模块实例。
 */
import { describe, expect, it, vi } from 'vitest'

describe('进程场景 · 未安装', () => {
  it('`getDefaultClientScene` 抛错，不静默造第二份账', async () => {
    vi.resetModules()
    const { getDefaultClientScene } = await import('../../src/client/scene.js')
    expect(() => getDefaultClientScene()).toThrow(/尚未安装/)
  })

  it('未安装时省略候选的安装现造一份，随后读取就是那一份', async () => {
    vi.resetModules()
    const { getDefaultClientScene, installClientScene } = await import('../../src/client/scene.js')
    const installed = installClientScene()
    expect(installed).toBe(getDefaultClientScene())
  })
})
