import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
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

  // Linux 上 dotfiles 管理器/独立挂载盘常把项目或会话目录做成软链。Dirent 不跟随软链，
  // 旧实现把它们从引用扫描里整个漏掉 ⇒ 独占判断把仍被引用的图片当孤儿删掉（ADR-0020 红线）。
  it('listDirs 跟随指向目录的软链；指向文件与断链都不算目录', async (ctx) => {
    const root = await mkdtemp(join(tmpdir(), 'dshdel-'))
    temps.push(root)
    const fs = createFsPort()
    await mkdir(join(root, 'plain'))
    await mkdir(join(root, 'real-project'))
    await writeFile(join(root, 'a.txt'), 'x')
    const linkDir = async (target: string, link: string) => {
      try {
        await symlink(target, link, 'dir')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EPERM' && code !== 'EACCES') throw error
        // Windows 没有建软链的特权时，junction 同样是"指向目录的链接"（Dirent 照样 isSymbolicLink）
        if (process.platform !== 'win32') throw error
        await symlink(target, link, 'junction')
      }
    }
    try {
      await linkDir(join(root, 'real-project'), join(root, 'linked-project'))
    } catch {
      ctx.skip() // 两个平台都建不了链接的环境，这条验不了
      return
    }
    // 指向文件的软链与断链只在建得了的环境里造（Windows 无特权时造不出），造不出也照样验证"不当目录"
    await symlink(join(root, 'a.txt'), join(root, 'linked-file'), 'file').catch(() => {})
    await symlink(join(root, 'gone'), join(root, 'broken-link'), 'dir').catch(() => {})
    expect((await fs.listDirs(root)).sort()).toEqual(['linked-project', 'plain', 'real-project'])
    expect(await fs.realpath(join(root, 'linked-project'))).toBe(await fs.realpath(join(root, 'real-project')))
  })

  it('rename 搬目录；目标已存在就拒绝——Linux 会静默替代空目录，两个平台必须一个语义', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshdel-'))
    temps.push(root)
    const fs = createFsPort()
    await fs.ensureDir(join(root, 'sessions', 's1'))
    await writeFile(join(root, 'sessions', 's1', 'log'), 'bytes')
    await fs.ensureDir(join(root, 'session-trash'))
    await fs.rename(join(root, 'sessions', 's1'), join(root, 'session-trash', 'e1'))
    expect(await fs.exists(join(root, 'sessions', 's1'))).toBe(false)
    expect(await fs.exists(join(root, 'session-trash', 'e1', 'log'))).toBe(true)

    await fs.ensureDir(join(root, 'session-trash', 'occupied'))
    await fs.ensureDir(join(root, 'sessions', 's2'))
    await expect(fs.rename(join(root, 'sessions', 's2'), join(root, 'session-trash', 'occupied')))
      .rejects.toThrow(/目标已存在/)
    // 拒绝之后两边都还在：源没动，目标也没被替代
    expect(await fs.exists(join(root, 'sessions', 's2'))).toBe(true)
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
