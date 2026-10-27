import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFsPort } from '../src/ports/fs-port.js'

const temps: string[] = []
afterEach(async () => {
  while (temps.length > 0) await rm(temps.pop() as string, { recursive: true, force: true })
})

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

  it('listFiles 只列名字（不递归）、readFile 把字节原样交回——回收站详情要的那两样', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshdel-'))
    const fs = createFsPort()
    await fs.ensureDir(join(root, 'session-trash', 'e1'))
    await writeFile(join(root, 'session-trash', 'e1', 'session.v4.jsonl.zstd'), 'bytes')
    await mkdir(join(root, 'session-trash', 'e1', 'nested'))
    // 目录里的顺序不保证（readdir 依文件系统给），所以只断言"就是这两项、不多不少、不递归"
    expect((await fs.listFiles(join(root, 'session-trash', 'e1'))).sort()).toEqual(['nested', 'session.v4.jsonl.zstd'])
    const raw = await fs.readFile(join(root, 'session-trash', 'e1', 'session.v4.jsonl.zstd'))
    expect(Buffer.isBuffer(raw) && raw.toString()).toBe('bytes')
  })
})

it('statFile 量文件、removeFile 幂等删除，且方法能解构出来单独调', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-fs-'))
  temps.push(dir)
  const file = join(dir, 'a.txt')
  await writeFile(file, 'hello')
  const port = createFsPort()
  const { statFile, removeFile } = port
  expect(await statFile(file)).toMatchObject({ size: 5 })
  await removeFile(file)
  expect(await port.exists(file)).toBe(false)
  await removeFile(file) // force：已经不在也不抛
})
