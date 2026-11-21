#!/usr/bin/env node
/**
 * 打包门：`pnpm pack:dry` 的执行体；`--tarball <path>` 时校验发版 tarball（release.yml 调这一支）。
 *
 * 判据只有一份：期望树从 `package.json` 的 `files` 展开（目录整棵、glob 按段），再叠上挂载面
 * （`main` / `types` / `icon` / `exports` / patch）点名的路径；与包内实际文件**双向对账**——少一件红，
 * 多一件也红。默认支额外来两件事：`lib/` 构建树必须被 `files` 覆盖；产物冒烟（语法 + Node 半模块面）。
 *
 * 为什么不是一行 `npm pack --dry-run`：它只证明"能产出 tarball"，不证明包里的树与 `files` 对得上，
 * 也不证明产物能加载。漏一件的后果是用户装到断入口的包（客户端条目激活失败会拖死宿主进程）。
 */
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const posix = (path) => path.replaceAll('\\', '/')
/** 打包输入里永远不该被期望树展开的目录。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist'])

function fail(messages) {
  for (const message of messages) console.error(message)
  console.error(`\n打包门失败：${messages.length} 处不一致`)
  process.exit(1)
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_DIRS.has(entry.name)) return []
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [posix(relative(ROOT, path))]
  })
}

function globToRegExp(glob) {
  let source = ''
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]
    if (char === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        source += '(?:.*/)?'
        index += 2
      } else {
        source += '.*'
        index += 1
      }
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char
  }
  return new RegExp(`^${source}$`)
}

/** 期望的包内树：`files` 是唯一清单，挂载面按出口路径再叠一道。 */
function expectedFiles(pkg) {
  const expected = new Set(['package.json'])
  for (const raw of pkg.files ?? []) {
    const entry = raw.replace(/^\.\//, '')
    const segments = entry.split('/')
    const firstGlob = segments.findIndex((segment) => /[*?]/.test(segment))
    if (firstGlob === -1) {
      if (!existsSync(join(ROOT, entry))) {
        fail([`files 点名的路径不存在：${entry}`])
        continue
      }
      if (statSync(join(ROOT, entry)).isDirectory()) for (const file of walk(join(ROOT, entry))) expected.add(file)
      else expected.add(entry)
      continue
    }
    const base = segments.slice(0, firstGlob).join('/') || '.'
    if (!existsSync(join(ROOT, base))) continue
    const pattern = globToRegExp(entry)
    for (const file of walk(join(ROOT, base))) if (pattern.test(file)) expected.add(file)
  }
  const surface = []
  const collect = (value) => {
    if (typeof value === 'string') {
      if (!value.includes('*')) surface.push(value.replace(/^\.\//, ''))
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(collect)
    }
  }
  for (const value of [pkg.main, pkg.types, pkg.icon, pkg.exports, pkg.dsh?.bundle?.patch]) collect(value)
  for (const path of surface) expected.add(path)
  return expected
}

/** 双向对账 + sourcemap 兜底。 */
function compare(expected, actual) {
  const missing = [...expected].filter((path) => !actual.has(path)).sort()
  const undeclared = [...actual].filter((path) => !expected.has(path)).sort()
  const notices = []
  for (const path of missing) notices.push(`包里缺：${path}（files 或构建产物没覆盖到）`)
  for (const path of undeclared) notices.push(`包里多：${path}（契约没有点名，不该进用户机器）`)
  for (const path of actual) if (path.endsWith('.map')) notices.push(`包里混进 sourcemap：${path}`)
  if (notices.length > 0) fail(notices)
}

const [mode, argument] = process.argv.slice(2)
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const expected = expectedFiles(pkg)

if (mode === '--tarball') {
  if (argument === undefined) fail(['--tarball 需要一个 tarball 路径'])
  const actual = new Set(
    execFileSync('tar', ['-tzf', argument], { encoding: 'utf8' })
      // `tar` 在 Windows 上按 CRLF 出行；Linux runner 是 LF。包内路径两者都不带 `\r`。
      .split(/\r?\n/)
      .filter((line) => line.startsWith('package/') && !line.endsWith('/'))
      .map((line) => line.slice('package/'.length)),
  )
  compare(expected, actual)
  console.log(`打包门通过（tarball）：${actual.size} 个文件与 files 双向一致。`)
} else {
  // 构建目录单独再查一遍：`npm pack` 只装 `files` 里匹配到的文件，「构建多出一个产物而 files 忘了加」
  // 会在包对账里两边都消失、照样绿。判据只能从盘上取。
  const buildRoot = join(ROOT, 'lib')
  if (existsSync(buildRoot)) {
    const unlisted = walk(buildRoot).filter((file) => !expected.has(file))
    if (unlisted.length > 0) {
      fail(unlisted.map((file) => `构建产物不在 files 里：${file}（构建多出文件就要同步 package.json 的 files）`))
    }
  }

  let packed
  try {
    packed = JSON.parse(execSync('npm pack --dry-run --ignore-scripts --json --silent', { cwd: ROOT, encoding: 'utf8' }))
  } catch (error) {
    fail([`npm pack --dry-run 失败：${error instanceof Error ? error.message : String(error)}`])
  }
  const result = Array.isArray(packed) ? packed[0] : packed
  const actual = new Set((result?.files ?? []).map((file) => posix(file.path)))
  compare(expected, actual)

  for (const path of ['lib/index.js', 'lib/client.js']) {
    try {
      execFileSync('node', ['--check', join(ROOT, path)], { stdio: 'pipe' })
    } catch (error) {
      fail([`${path} 不能通过语法检查：${error instanceof Error ? error.message : String(error)}`])
    }
  }
  let plugin
  try {
    plugin = await import(pathToFileURL(join(ROOT, 'lib/index.js')).href)
  } catch (error) {
    fail([`lib/index.js 加载失败：${error instanceof Error ? error.message : String(error)}`])
  }
  const moduleFace = [
    ['name', typeof plugin.name === 'string' && plugin.name.length > 0],
    ['apply', typeof plugin.apply === 'function'],
    ['inject', Array.isArray(plugin.inject)],
    ['Config', typeof plugin.Config === 'object' && plugin.Config !== null],
  ]
  const broken = moduleFace.filter(([, ok]) => !ok).map(([key]) => `lib/index.js 没有导出可用的 ${key}`)
  if (broken.length > 0) fail(broken)

  console.log(`打包门通过：${actual.size} 个文件与 files 双向一致；lib/index.js 模块面可用。`)
}