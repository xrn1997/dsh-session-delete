import { describe, expect, it, vi } from 'vitest'
import { MOVE_DIR_RETRY_DELAYS_MS, moveDirectoryWithRetry } from '../src/verbs/move-directory.js'

const transient = (code: string): Error => Object.assign(new Error(code), { code })

describe('会话目录搬移的瞬态重试', () => {
  it('首发成功：只搬一次、不等待', async () => {
    const rename = vi.fn(async () => {})
    const sleep = vi.fn(async () => {})
    await moveDirectoryWithRetry(rename, '/a', '/b', { sleep })
    expect(rename).toHaveBeenCalledTimes(1)
    expect(rename).toHaveBeenCalledWith('/a', '/b')
    expect(sleep).not.toHaveBeenCalled()
  })

  it('EPERM 两次后成功：按 50 / 150ms 重试，第三次落地', async () => {
    let left = 2
    const rename = vi.fn(async () => {
      if (left-- > 0) throw transient('EPERM')
    })
    const delays: number[] = []
    const sleep = vi.fn(async (ms: number) => { delays.push(ms) })
    await moveDirectoryWithRetry(rename, '/a', '/b', { sleep })
    expect(rename).toHaveBeenCalledTimes(3)
    expect(delays).toEqual([...MOVE_DIR_RETRY_DELAYS_MS])
  })

  it('EBUSY / EACCES 同属瞬态：各重试一次后落地', async () => {
    for (const code of ['EBUSY', 'EACCES']) {
      let left = 1
      const rename = vi.fn(async () => {
        if (left-- > 0) throw transient(code)
      })
      const sleep = vi.fn(async () => {})
      await moveDirectoryWithRetry(rename, '/a', '/b', { sleep })
      expect(rename, code).toHaveBeenCalledTimes(2)
      expect(sleep, code).toHaveBeenCalledTimes(1)
    }
  })

  it('三次都被占用：原样抛最后一个错误，不无限重试', async () => {
    const errors = [transient('EPERM'), transient('EPERM'), transient('EPERM')]
    let attempt = 0
    const rename = vi.fn(async () => {
      const error = errors[attempt]
      attempt += 1
      if (error === undefined) throw new Error('多出的尝试')
      throw error
    })
    const sleep = vi.fn(async () => {})
    await expect(moveDirectoryWithRetry(rename, '/a', '/b', { sleep })).rejects.toBe(errors[2])
    expect(rename).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('判据错误一次都不重试：ENOENT 与目标已存在的普通错误', async () => {
    for (const error of [transient('ENOENT'), new Error('目标已存在，拒绝覆盖：/b')]) {
      const rename = vi.fn(async () => { throw error })
      const sleep = vi.fn(async () => {})
      await expect(moveDirectoryWithRetry(rename, '/a', '/b', { sleep })).rejects.toBe(error)
      expect(rename).toHaveBeenCalledTimes(1)
      expect(sleep).not.toHaveBeenCalled()
    }
  })

  it('自定义间隔只按给定步数重试', async () => {
    const rename = vi.fn(async () => { throw transient('EBUSY') })
    const sleep = vi.fn(async () => {})
    await expect(moveDirectoryWithRetry(rename, '/a', '/b', { delaysMs: [1], sleep }))
      .rejects.toMatchObject({ code: 'EBUSY' })
    expect(rename).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(1)
  })
})