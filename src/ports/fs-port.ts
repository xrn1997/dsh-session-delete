import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface FsPort {
  exists(p: string): Promise<boolean>
  /** 建目录（含中间层）。首删时 `~/.dsh/session-trash/` 还不存在，而 `rename` 不建父目录。 */
  ensureDir(p: string): Promise<void>
  /** 搬目录：**目标已存在一律失败**，跨卷（EXDEV）也失败并说清楚——不替换、也不偷偷改成复制。
   *  Linux 的 `rename` 会静默替代空目录而 Windows 不会，这个差别不能交给操作系统决定。 */
  rename(from: string, to: string): Promise<void>
  removeDir(p: string): Promise<void>
  sizeOfDir(p: string): Promise<number>
  /** 目录下的条目名（**不递归**）。回收站详情要用它在那条目录里挑 `*.jsonl.zstd`。 */
  listFiles(p: string): Promise<string[]>
  /** 目录下的**子目录**名（不递归；**跟随软链**）。回收站对账用它找出"清单里还没有行"的条目目录——
   *  与 `listFiles` 分开是为了让"拒收文件"发生在挑选阶段（回收站根里落进来的杂散文件当外人）。 */
  listDirs(p: string): Promise<string[]>
  /** 解析符号链接后的真实路径。递归走目录时防环用：跟随软链之后，目录图不再是树。 */
  realpath(p: string): Promise<string>
  /** 整个文件读进内存。实测本机回收站里最大单文件 4.66 MB；**内存口径由逐帧解压把住**（见 `src/log/session-log.ts`），不在这里。 */
  readFile(p: string): Promise<Buffer>
  /** 只读的单文件读数：附件渲染与独占计划都用它（不递归、不跟随目录）。 */
  statFile(p: string): Promise<{ size: number }>
  /** 删单个文件（不是目录）。危险能力，只挂到 `RemovalDeps` 上。 */
  removeFile(p: string): Promise<void>
}

/** 动词的基础面：读与搬移都有，**不拿删除**。删目录与删单文件只挂在 `RemovalDeps` 上（ADR-0006）。 */
export type CoreFsPort = Omit<FsPort, 'removeDir' | 'removeFile'>

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
    async rename(from, to) {
      // 目标已存在一律失败：Linux 的 rename 会静默替代**空目录**，Windows 不会——"搬进回收站/放回
      // 会话目录"是这里唯一的目录搬迁动作，被替代 = 数据消失。把两个平台的语义钉成同一个。
      if (existsSync(to)) throw new Error(`目标已存在，拒绝覆盖：${to}`)
      try {
        await rename(from, to)
      } catch (error) {
        // 跨卷（sessions 与 session-trash 被挂到不同挂载点）：不在这里改成"复制 + 删源"——那会把
        // 一次原子搬移换成一次可能半途而废的复制；明说，让调用方按 journal 回滚。
        if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
          throw new Error(`跨文件系统搬不动（sessions 与 session-trash 需在同一卷）：${from} → ${to}`, { cause: error })
        }
        throw error
      }
    },
    async removeDir(p) { await rm(p, { recursive: true, force: true }) },
    sizeOfDir: (p) => sizeOfDir(p),
    // readdir 返回的既可能是字符串也可能是 Dirent（取决于 encoding），这里不传 withFileTypes ⇒ 名字串
    async listFiles(p) { return readdir(p) },
    async listDirs(p) {
      const dirs: string[] = []
      for (const entry of await readdir(p, { withFileTypes: true })) {
        if (entry.isDirectory()) { dirs.push(entry.name); continue }
        // Dirent **不跟随**符号链接：Linux 上被软链的项目/会话目录会在这里隐身，引用扫描当成
        // "不存在" ⇒ 独占判断把还在用的副本误删。指坏了（断链）就当它不存在。
        if (!entry.isSymbolicLink()) continue
        try {
          if ((await stat(join(p, entry.name))).isDirectory()) dirs.push(entry.name)
        } catch { /* 断链 */ }
      }
      return dirs
    },
    async realpath(p) { return realpath(p) },
    async readFile(p) { return readFile(p) },
    async statFile(p) {
      return { size: (await stat(p)).size }
    },
    async removeFile(p) { await rm(p, { force: true }) },
  }
}
