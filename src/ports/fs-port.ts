import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface FsPort {
  exists(p: string): Promise<boolean>
  /** 建目录（含中间层）。首删时 `~/.dsh/session-trash/` 还不存在，而 `rename` 不建父目录。 */
  ensureDir(p: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  removeDir(p: string): Promise<void>
  sizeOfDir(p: string): Promise<number>
}

/** 模块级递归：端口方法**解构出来单独调**也不能靠 `this`（`{ sizeOfDir } = port` 会让方法体的
 *  `this` 变成 undefined）。所以端口只做转发，递归在模块作用域里自调。 */
async function sizeOfDir(p: string): Promise<number> {
  let total = 0
  for (const e of await readdir(p, { withFileTypes: true })) {
    const child = join(p, e.name)
    total += e.isDirectory() ? await sizeOfDir(child) : (await stat(child)).size
  }
  return total
}

export function createFsPort(): FsPort {
  return {
    async exists(p) { return existsSync(p) },
    async ensureDir(p) { await mkdir(p, { recursive: true }) },
    async rename(from, to) { await rename(from, to) },
    async removeDir(p) { await rm(p, { recursive: true, force: true }) },
    sizeOfDir: (p) => sizeOfDir(p),
  }
}
