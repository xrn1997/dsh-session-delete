import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'release-notes.mjs')

interface PackageFacts {
  name: string
  version: string
  engines: { dsh: string }
  scripts: Record<string, string>
  repository: { url?: string }
  xrn1997?: { dshReleases?: Record<string, string> }
}

interface Generation {
  status: number | null
  stderr: string
  notes: string
}

const PKG: PackageFacts = {
  name: '@acme/demo',
  version: '0.2.0',
  engines: { dsh: '>=1.0.0 <2.0.0-0' },
  scripts: { gates: 'pnpm typecheck && pnpm test' },
  repository: { url: 'git+https://github.com/acme/demo.git' },
  xrn1997: { dshReleases: { '1.0.1': 'compatible' } },
}

const CHANGELOG = `# Changelog

## [0.2.0] - 2026-01-02

### 新增

- 新功能甲（ADR-0001）。

### 升级注意

- 注意甲。

## [0.1.0] - 2026-01-01

### 新增

- 老功能乙。
`

/** 合成一个最小仓根：正文只认 package.json / CHANGELOG / docs/adr 三个事实源。 */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'release-notes-'))
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return root
}

function generate(root: string, version?: string): Generation {
  // 输出落临时目录：仓上干跑不许弄脏工作区。
  const out = join(mkdtempSync(join(tmpdir(), 'release-notes-out-')), 'notes.md')
  const args = [SCRIPT, '--root', root, ...(version === undefined ? [] : ['--version', version]), out]
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' })
  return {
    status: result.status,
    stderr: result.stderr,
    notes: existsSync(out) ? readFileSync(out, 'utf8') : '',
  }
}

describe('release-notes：Release 正文从 CHANGELOG 与 package.json 投影', () => {
  it('四段结构齐、安装命令与 compare 链接派生自版本、ADR 引用补成可点链接', () => {
    const root = fixture({
      'package.json': JSON.stringify(PKG),
      'CHANGELOG.md': CHANGELOG,
      'docs/adr/0001-group-membership-has-one-home.md': '# first\n',
    })
    const { status, notes } = generate(root)
    expect(status).toBe(0)
    expect(notes).toContain('## 📋 版本与兼容')
    expect(notes).toContain('- 插件版本：`@acme/demo@0.2.0`')
    expect(notes).toContain('- DSH 兼容窗口：`>=1.0.0 <2.0.0-0`')
    expect(notes).toContain('DSH Desktop `1.0.1`')
    expect(notes).toContain('## ✨ 更新内容')
    expect(notes).toContain('### 升级注意')
    expect(notes).toContain('新功能甲')
    // 一条事实一个家：门链从 scripts.gates 原样投影，正文里没有第二份清单。
    expect(notes).toContain('`pnpm typecheck && pnpm test`')
    expect(notes).toContain('## 📦 安装')
    expect(notes).toContain('dsh plugin --profile <profile> add ./acme-demo-0.2.0.tgz')
    expect(notes).toContain('dsh plugin --profile <profile> add @acme/demo@0.2.0')
    expect(notes).toContain('[ADR-0001](https://github.com/acme/demo/blob/main/docs/adr/0001-group-membership-has-one-home.md)')
    expect(notes).toContain('[V0.1.0...V0.2.0](https://github.com/acme/demo/compare/V0.1.0...V0.2.0)')
  })

  it('首个版本没有上一版：省略 compare 段，不编造链接', () => {
    const root = fixture({
      'package.json': JSON.stringify(PKG),
      'CHANGELOG.md': '# Changelog\n\n## [0.2.0] - 2026-01-02\n\n### 新增\n\n- 甲。\n',
    })
    const { status, notes } = generate(root)
    expect(status).toBe(0)
    expect(notes).not.toContain('完整变更记录')
  })

  it('CHANGELOG 查不到该版条目就红：宁可没有 Release，正文也不许是编的', () => {
    const root = fixture({
      'package.json': JSON.stringify({ ...PKG, version: '0.3.0' }),
      'CHANGELOG.md': CHANGELOG,
    })
    const { status, stderr } = generate(root)
    expect(status).not.toBe(0)
    expect(stderr).toContain('CHANGELOG.md')
  })

  it('仓上干跑：真实 package.json 与 CHANGELOG 能出四段正文（版本读当前清单，不写死）', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as PackageFacts
    const { status, notes } = generate(ROOT)
    expect(status).toBe(0)
    for (const heading of ['## 📋 版本与兼容', '## ✨ 更新内容', '## ✅ 发布验证', '## 📦 安装']) {
      expect(notes).toContain(heading)
    }
    expect(notes).toContain(`\`${pkg.name}@${pkg.version}\``)
  })
})
