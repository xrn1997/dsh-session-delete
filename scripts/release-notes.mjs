#!/usr/bin/env node
/**
 * GitHub Release 正文生成器：发版工作流（`.github/workflows/release.yml`）把它的输出交给
 * `gh release create --notes-file`。
 *
 * 为什么不是 `--generate-notes`：那条生成的是 commit / PR 列表，用户读不出「这一版能干什么、
 * 怎么装、升级注意什么」。「每个版本改了什么」的家是 `CHANGELOG.md`（发版流程第 2 步写发布记录），
 * 本脚本只做投影，一条事实一个家：
 * - 📋 版本与兼容 ← `package.json`（name / version / `engines.dsh` / 真机账本 `xrn1997.dshReleases`）
 * - ✨ 更新内容 ← `CHANGELOG.md` 该版条目原文；文中的 `ADR-NNNN` 补成 GitHub 可点链接
 * - ✅ 发布验证 ← 发版工作流实跑项；`gates` 的门链从 `scripts.gates` 原样投影，不抄第二份清单
 * - 📦 安装 ← 由 name / version 派生的安装命令；compare 链接的上一版取 CHANGELOG 的上一条目
 *
 * CHANGELOG 里查不到该版条目就红，不编正文：宁可没有 Release，正文也不许是编的。
 * 真机代次不在这里手写——真机账本 `xrn1997.dshReleases` 是唯一出处。
 *
 * 用法：node scripts/release-notes.mjs [--root <仓根>] [--version <版本>] <输出文件>
 * （缺省仓根取脚本所在仓库，版本取 `package.json` 的 `version`。）
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, version: undefined, out: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root' || arg === '--version') {
      const value = argv[index + 1]
      if (value === undefined) fail(`${arg} 缺参数`)
      index += 1
      if (arg === '--root') options.root = resolve(value)
      else options.version = value
    } else if (options.out === undefined) {
      options.out = arg
    } else {
      fail(`多余参数：${arg}`)
    }
  }
  if (options.out === undefined) fail('用法：node scripts/release-notes.mjs [--root <仓根>] [--version <版本>] <输出文件>')
  return options
}

/** CHANGELOG 版本标题形如 `## [0.9.0] - 2026-11-15`；文件顺序即从新到旧。 */
function changelogSection(markdown, version) {
  const headings = [...markdown.matchAll(/^## \[([^\]]+)\] - .*$/gm)]
  const index = headings.findIndex((match) => match[1] === version)
  if (index === -1) return undefined
  const start = headings[index].index + headings[index][0].length
  const end = index + 1 < headings.length ? headings[index + 1].index : markdown.length
  return { body: markdown.slice(start, end).trim(), previous: headings[index + 1]?.[1] }
}

/** `git+https://github.com/x/y.git` → `https://github.com/x/y`。 */
function repoWebUrl(repository) {
  return (repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '')
}

/** Release 页上把 `ADR-NNNN` 补成可点链接；docs/adr/ 里找不到对应文件就原样保留。 */
function linkifyAdr(text, root, repoUrl) {
  const adrDir = join(root, 'docs', 'adr')
  return text.replace(/\bADR-(\d{4})\b/g, (whole, num) => {
    let file
    try {
      file = readdirSync(adrDir).find((name) => name.startsWith(`${num}-`) && name.endsWith('.md'))
    } catch {
      return whole
    }
    return file ? `[${whole}](${repoUrl}/blob/main/docs/adr/${file})` : whole
  })
}

function buildNotes({ pkg, version, section, root }) {
  const repoUrl = repoWebUrl(pkg.repository)
  if (!repoUrl) fail('package.json 缺 repository.url：compare 与 ADR 链接没处可指')
  if (!pkg.engines?.dsh) fail('package.json 缺 engines.dsh：兼容窗口没处可指')
  if (!pkg.scripts?.gates) fail('package.json 缺 scripts.gates：发布验证的门链没处可指')

  const ledger = Object.keys(pkg.xrn1997?.dshReleases ?? {})
  const tarball = `${pkg.name.replace('@', '').replace('/', '-')}-${version}.tgz`
  const tag = (v) => `V${v}`

  const lines = [
    '## 📋 版本与兼容',
    '',
    `- 插件版本：\`${pkg.name}@${version}\``,
    `- DSH 兼容窗口：\`${pkg.engines.dsh}\``,
  ]
  if (ledger.length > 0) {
    lines.push(`- 真机实测：DSH Desktop ${ledger.map((v) => `\`${v}\``).join('、')}（真机账本 \`xrn1997.dshReleases\`；窗口内未列的版本没实测过）`)
  }
  lines.push(
    '',
    '## ✨ 更新内容',
    '',
    linkifyAdr(section.body, root, repoUrl),
    '',
    '## ✅ 发布验证',
    '',
    `- 本次发版工作流实跑并通过 \`pnpm gates\`（\`${pkg.scripts.gates}\`）与 Release 资产的包内树对账`,
    '- 真机验证不在 CI 内：真跑过的宿主代次见上「真机实测」',
    '',
    '## 📦 安装',
    '',
    `下载本页资产 \`${tarball}\`（免构建安装包）：`,
    '',
    '```bash',
    `dsh plugin --profile <profile> add ./${tarball}`,
    '```',
    '',
    'npm（上架后）：',
    '',
    '```bash',
    `dsh plugin --profile <profile> add ${pkg.name}@${version}`,
    '```',
    '',
    '装完重启宿主；三种装法与注意见 README「安装」。',
  )
  if (section.previous) {
    lines.push(
      '',
      `完整变更记录：[${tag(section.previous)}...${tag(version)}](${repoUrl}/compare/${tag(section.previous)}...${tag(version)})`,
    )
  }
  return `${lines.join('\n')}\n`
}

const options = parseArgs(process.argv.slice(2))
const pkg = JSON.parse(readFileSync(join(options.root, 'package.json'), 'utf8'))
const version = options.version ?? pkg.version
const changelog = readFileSync(join(options.root, 'CHANGELOG.md'), 'utf8')
const section = changelogSection(changelog, version)
if (!section) fail(`CHANGELOG.md 里没有 [${version}] 的条目；按发版流程先写发布记录（追加这一版）再发。`)

const notes = buildNotes({ pkg, version, section, root: options.root })
const out = resolve(options.out)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, notes, 'utf8')
console.log(`Release 正文已写入 ${out}（${version}${section.previous ? `，上一版 ${section.previous}` : '，首个版本无 compare 段'}）`)
