#!/usr/bin/env node
/**
 * 打包门：`pnpm pack:dry` 的执行体（`gates` 的最后一格）。
 *
 * 为什么不是一行 `npm pack --dry-run`：那条命令只证明"npm 能产出一个 tarball"，不证明包里的树
 * 与 `files` 对得上，也不证明产物能加载。构建每多出一个产物（新 chunk、新声明文件目录）而
 * `files` 忘了加，旧门全绿、用户装到断入口的包——客户端条目激活失败会拖死宿主进程。
 *
 * 三件事，判据的家仍分开放：
 * 1. 期望树**只从 `package.json` 的 `files` 展开**（目录整棵、glob 按段、其余单文件），再加 npm
 *    无条件携带的 `package.json` 与挂载面（`main` / `types` / `icon` / `exports` / patch）点名的路径。
 * 2. 与 `npm pack --dry-run --json` 报出的实际文件集**双向对账**：缺一件红、多一件也红。
 * 3. 产物本身冒烟：`node --check` 两份 JS；`import` Node 半产物，确认插件模块面（`name` / `apply`
 *    / `inject` / `Config`）真的从构建产物里拿得到。浏览器半只做语法检查——它要 `window.__ModuleLoader__`，
 *    在 Node 里加载没有意义。
 *
 * 这里不跑 build：`gates` 的顺序是 build → pack:dry，`prepack` 也会兜住发布路径；本脚本只当验尸官。
 */
import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const posix = (path) => path.replaceAll('\\', '/')

function fail(messages) {
  for (const message of messages) console.error(message)
  console.error(`\n打包门失败：${messages.length} 处不一致`)
  process.exit(1)
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
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

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// 1. 期望树：`files` 是唯一清单，脚本不写第二份。
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

// 挂载面：出口点名的路径必须真在包里（清单漏了它，宿主装上也找不到）。
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

// 构建目录单独再查一遍：`npm pack` 只会装 `files` 里匹配到的文件，所以「构建多出一个产物而
// `files` 忘了加」在包对账里两边都消失、照样绿。构建树的判据只能从盘上取——`lib/` 的每个文件
// 都必须被 `files` 覆盖（`lib/` 是 tsdown + tsc 的产物目录，agents 文档要求新增产物同步进 files）。
const buildRoot = join(ROOT, 'lib')
if (existsSync(buildRoot)) {
  const unlisted = walk(buildRoot).filter((file) => !expected.has(file))
  if (unlisted.length > 0) {
    fail(unlisted.map((file) => `构建产物不在 files 里：${file}（构建多出文件就要同步 package.json 的 files）`))
  }
}

// 2. 实际树：走与发布同一条 `npm pack`（--ignore-scripts：门不重复跑 prepack 的 build）。
let packed
try {
  packed = JSON.parse(execSync('npm pack --dry-run --ignore-scripts --json --silent', { cwd: ROOT, encoding: 'utf8' }))
} catch (error) {
  fail([`npm pack --dry-run 失败：${error instanceof Error ? error.message : String(error)}`])
}
const result = Array.isArray(packed) ? packed[0] : packed
const actual = new Set((result?.files ?? []).map((file) => posix(file.path)))

const missing = [...expected].filter((path) => !actual.has(path)).sort()
const undeclared = [...actual].filter((path) => !expected.has(path)).sort()
const notices = []
for (const path of missing) notices.push(`包里缺：${path}（files 或构建产物没覆盖到）`)
for (const path of undeclared) notices.push(`包里多：${path}（契约没有点名，不该进用户机器）`)
for (const path of actual) if (path.endsWith('.map')) notices.push(`包里混进 sourcemap：${path}`)
if (notices.length > 0) fail(notices)

// 3. 产物冒烟：语法 + Node 半的插件模块面。
const checks = ['lib/index.js', 'lib/client.js']
for (const path of checks) {
  try {
    execSync(`node --check ${JSON.stringify(join(ROOT, path))}`, { stdio: 'pipe' })
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