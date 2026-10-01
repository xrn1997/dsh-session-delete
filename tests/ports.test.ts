import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFsPort } from '../src/ports/fs-port.js'

describe('文件层端口', () => {
  it('exists 对不存在的路径返回 false，不抛错', async () => {
    expect(await createFsPort().exists('C:/definitely/not/here')).toBe(false)
  })

  it('sizeOfDir 累加目录内文件字节（多个文件 + 子目录）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshdel-'))
    const d = join(root, 'd'); await mkdir(d)
    const sub = join(d, 'sub'); await mkdir(sub)
    const deep = join(sub, 'deep'); await mkdir(deep)
    await writeFile(join(d, 'a'), 'hello') // 5
    await writeFile(join(d, 'b'), 'hi') // 2
    await writeFile(join(sub, 'c'), 'world!') // 6
    await writeFile(join(deep, 'e'), '1234567') // 7
    expect(await createFsPort().sizeOfDir(d)).toBe(20)
  })

  it('sizeOfDir 解构后照样能调（不依赖 this 绑定）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshdel-'))
    const d = join(root, 'd'); await mkdir(d)
    const sub = join(d, 'sub'); await mkdir(sub)
    await writeFile(join(d, 'a'), 'hello') // 5
    await writeFile(join(sub, 'c'), 'world!') // 6
    const { sizeOfDir } = createFsPort()
    expect(await sizeOfDir(d)).toBe(11)
  })

  it('ensureDir 把不存在的多级路径建出来（首删时回收站目录还没有）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshdel-'))
    const p = join(root, 'session-trash', '20260930T130500Z-session-abc')
    const fs = createFsPort()
    expect(await fs.exists(p)).toBe(false)
    await fs.ensureDir(p)
    expect(await fs.exists(p)).toBe(true)
  })
})
