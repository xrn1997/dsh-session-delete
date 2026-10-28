import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 语料遍历（三份文档门共用一份）：递归收集带指定扩展名的文件，交绝对路径。
 * skipDirs 只按目录名挡一层；skipFiles 按绝对路径排除单个文件——
 * 文档门的「自排除不是白名单」就是这一档，调用方自证理由。
 */
export function collectFiles(
  dir: string,
  extensions: RegExp,
  skipDirs: readonly string[] = [],
  skipFiles: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (!skipDirs.includes(e.name)) walk(p)
      } else if (extensions.test(e.name) && !skipFiles.has(p)) {
        out.push(p)
      }
    }
  }
  walk(dir)
  return out
}
